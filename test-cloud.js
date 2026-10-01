/* House App cloud: the database rules and the sync engine, end to end.
 * Run: node test-cloud.js   (npm install once first)
 *
 * supabase/schema.sql runs on a real Postgres in memory (PGlite) with a
 * stand-in for Supabase's auth schema, and every call a "device" makes runs as
 * that signed-in user, so the row-level security rules are the real ones.
 * Each device is a jsdom window with its own localStorage running the real
 * cloud.js, talking to that database through window.__houseCloud.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JSDOM } = require("jsdom");

const OWNER_EMAIL = "owner@test.invalid";
const GOOD_CODE = "123456";
const CLOUD_SRC = fs.readFileSync(path.join(__dirname, "cloud.js"), "utf8");
const SCHEMA = fs.readFileSync(path.join(__dirname, "supabase", "schema.sql"), "utf8");

let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant anon, authenticated to postgres;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create publication supabase_realtime;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

async function pgServer() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(SCHEMA);
  await db.exec(`insert into private.settings (owner_email) values ('${OWNER_EMAIL}')`);

  const listeners = new Set();
  const ident = s => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error("bad identifier " + s); return s; };
  // PostgREST hands timestamps back as ISO strings.
  const plain = rows => rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  });
  const param = v => (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
  const asUser = (uid, fn) => db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await tx.query("set local role authenticated");
    return fn(tx);
  });
  async function userFor(email, confirmed = true) {
    const found = await db.query("select id from auth.users where email = $1", [email]);
    if (found.rows.length) return found.rows[0].id;
    const id = crypto.randomUUID();
    await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)", [id, email, confirmed ? new Date() : null]);
    return id;
  }

  function device(label, opts = {}) {
    let user = null;
    const state = { offline: false, requests: 0, upserts: 0 };
    const sessionFns = [];
    const online = () => {
      state.requests++;
      return state.offline ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve();
    };
    const me = () => { if (!user) throw new Error("not signed in"); return user.id; };
    const changed = () => { for (const l of listeners) if (l.from !== api) setTimeout(() => l.fn("change"), 0); };
    const api = {
      state, label,
      session: async () => user,
      onSessionChange(fn) { sessionFns.push(fn); },
      sendCode: async email => { await online(); if (!/@/.test(email)) throw new Error("invalid email"); },
      verifyCode: async (email, code) => {
        await online();
        if (code !== GOOD_CODE) throw new Error("Token has expired or is invalid");
        user = { id: await userFor(email.toLowerCase(), opts.confirmed !== false), email: email.toLowerCase() };
        return user;
      },
      signOut: async () => { user = null; sessionFns.forEach(f => f(null, "SIGNED_OUT")); },
      async fetch(table, o = {}) {
        await online();
        const where = [], args = [];
        if (o.since) { args.push(o.since); where.push(`updated_at > $${args.length}`); }
        const sql = `select * from public.${ident(table)}${where.length ? " where " + where.join(" and ") : ""} order by ${ident(o.orderBy || "updated_at")}`;
        return asUser(me(), async tx => plain((await tx.query(sql, args)).rows));
      },
      async upsert(table, rows, onConflict) {
        await online();
        state.upserts += rows.length;
        const keys = onConflict.split(",").map(ident);
        await asUser(me(), async tx => {
          for (const row of rows) {
            const cols = Object.keys(row).map(ident);
            const set = cols.filter(c => !keys.includes(c)).map(c => `${c} = excluded.${c}`);
            await tx.query(`insert into public.${ident(table)} (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})
              on conflict (${keys.join(", ")}) do ${set.length ? "update set " + set.join(", ") : "nothing"}`, cols.map(c => param(row[c])));
          }
        });
        changed();
      },
      async remove(table, col, val) {
        await online();
        await asUser(me(), tx => tx.query(`delete from public.${ident(table)} where ${ident(col)} = $1`, [val]));
        changed();
      },
      async rpc(fn) {
        await online();
        const r = await asUser(me(), tx => tx.query(`select public.${ident(fn)}() as r`));
        return r.rows[0].r;
      },
      listen(fn) {
        if (!opts.live) return () => {};
        const l = { from: api, fn };
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    return api;
  }
  const sql = async (q, args) => plain((await db.query(q, args)).rows);
  return { db, device, sql, userFor };
}

// A browser on some device: its own localStorage, the real cloud.js.
async function browser(server, label, seed = {}, opts = {}) {
  const dom = new JSDOM("<!doctype html><html><body><input id='field'></body></html>",
    { url: "https://house.test/" + label + ".html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, JSON.stringify(v));
  w.__houseCloud = server.device(label, opts);
  const events = [];
  w.addEventListener("storage", e => events.push(e.key));
  w.eval(CLOUD_SRC);
  await sleep(5);
  const HC = w.HouseCloud;
  return {
    w, HC, events, api: w.__houseCloud,
    get: k => JSON.parse(w.localStorage.getItem(k)),
    // What a tool's safeWrite() does.
    set(k, v) { w.localStorage.setItem(k, JSON.stringify(v)); HC.dirty(k); },
    async signIn(email, mode) {
      const st = await HC.verifyCode(email, GOOD_CODE);
      if (!st.member) return st;
      const info = await HC.joinInfo();
      await HC.join(mode || "merge", info.rows);
      return Object.assign(HC.status(), { info });
    },
    sync: () => HC.syncNow(),
  };
}
const names = list => (list || []).map(r => r.title || r.name || r.item || r.date).join(",");

(async () => {
  const server = await pgServer();
  const { db, sql } = server;

  console.log("\nThe database rules");
  let again = null;
  try { await db.exec(SCHEMA); } catch (e) { again = e.message; }
  check("the schema runs a second time cleanly", again === null, again);
  check("no email address in the public schema file", !/[a-z0-9._-]+@(?!test\.invalid)[a-z0-9-]+\.[a-z]{2,}/i.test(SCHEMA.replace(/--[^\n]*/g, "")));

  let anon = null;
  try { await db.transaction(async tx => { await tx.query("set local role anon"); await tx.query("select * from public.house_items"); }); }
  catch (e) { anon = e.message; }
  check("signed out: no data at all", /permission denied/.test(anon || ""), anon);
  anon = null;
  try { await db.transaction(async tx => { await tx.query("set local role anon"); await tx.query("select public.house_whoami()"); }); }
  catch (e) { anon = e.message; }
  check("signed out: no actions either", /permission denied/.test(anon || ""), anon);

  const owner = server.device("owner"), mum = server.device("mum"), stranger = server.device("stranger");
  await owner.verifyCode(OWNER_EMAIL, GOOD_CODE);
  await mum.verifyCode("mum@test.invalid", GOOD_CODE);
  await stranger.verifyCode("stranger@test.invalid", GOOD_CODE);
  const refused = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };

  let who = await owner.rpc("house_whoami");
  check("the email in the private settings is the owner", who.owner === true && who.member === true && who.email === OWNER_EMAIL, JSON.stringify(who));
  who = await stranger.rpc("house_whoami");
  check("having an account is not access", who.owner === false && who.member === false, JSON.stringify(who));

  const row = { store: "todo.items.v1", id: "t1", data: { id: "t1", title: "Buy rice" }, deleted: false };
  check("the owner can add data", (await refused(() => owner.upsert("house_items", [row], "store,id"))) === null);
  check("someone not on the list sees nothing", (await stranger.fetch("house_items")).length === 0);
  let r = await refused(() => stranger.upsert("house_items", [{ ...row, id: "evil" }], "store,id"));
  check("...and can add nothing", /row-level security/.test(r || ""), r);
  r = await refused(() => stranger.upsert("house_items", [{ ...row, data: { id: "t1", title: "hacked" } }], "store,id"));
  check("...and can change nothing", /row-level security/.test(r || "") && (await sql("select data->>'title' t from house_items where id = 't1'"))[0].t === "Buy rice", r);
  check("...and can't see who has access", (await stranger.fetch("house_members", { orderBy: "created_at" })).length === 0);
  r = await refused(() => stranger.upsert("house_members", [{ email: "stranger@test.invalid" }], "email"));
  check("...and can't add themselves to the list", /row-level security/.test(r || ""), r);

  check("the owner adds someone by email", (await refused(() => owner.upsert("house_members", [{ email: "  Mum@Test.Invalid ", label: "Mum" }], "email"))) === null);
  check("...stored trimmed and lower-case", (await sql("select email from house_members"))[0].email === "mum@test.invalid");
  who = await mum.rpc("house_whoami");
  check("that person now has access, but isn't the owner", who.member === true && who.owner === false, JSON.stringify(who));
  check("a member sees everything", (await mum.fetch("house_items")).length === 1);
  check("a member edits anything", (await refused(() => mum.upsert("house_items", [{ ...row, data: { id: "t1", title: "Buy rice and eggs" } }], "store,id"))) === null);
  check("a member adds anything", (await refused(() => mum.upsert("house_items", [{ ...row, id: "t2", data: { id: "t2", title: "Call plumber" } }], "store,id"))) === null);
  const stamped = (await sql("select updated_by, updated_at from house_items where id = 't2'"))[0];
  check("the server records who changed it, and when", stamped.updated_by === (await server.userFor("mum@test.invalid")) && !!stamped.updated_at);
  r = await refused(() => mum.upsert("house_items", [{ ...row, id: "t3", updated_by: "00000000-0000-4000-8000-000000000000", updated_at: "2001-01-01" }], "store,id"));
  const forged = (await sql("select updated_by, updated_at from house_items where id = 't3'"))[0];
  check("...whatever the app claims", r === null && forged.updated_by === (await server.userFor("mum@test.invalid")) && forged.updated_at > "2020");
  r = await refused(() => mum.remove("house_items", "id", "t1"));
  check("rows are never hard-deleted (other devices must see the removal)", /permission denied/.test(r || "") && (await sql("select count(*)::int n from house_items"))[0].n === 3, r);
  check("a member sees who has access", (await mum.fetch("house_members", { orderBy: "created_at" })).length === 1);
  r = await refused(() => mum.upsert("house_members", [{ email: "friend@test.invalid" }], "email"));
  check("only the owner adds people", /row-level security/.test(r || ""), r);
  await mum.remove("house_members", "email", "mum@test.invalid");
  check("only the owner removes people", (await sql("select count(*)::int n from house_members"))[0].n === 1);
  r = await refused(() => owner.upsert("house_items", [{ ...row, store: "../etc", id: "x" }], "store,id"));
  check("only real store names are accepted", /check constraint/.test(r || ""), r);

  const unconfirmed = server.device("unconfirmed", { confirmed: false });
  await owner.upsert("house_members", [{ email: "typed@test.invalid" }], "email");
  await unconfirmed.verifyCode("typed@test.invalid", GOOD_CODE);
  who = await unconfirmed.rpc("house_whoami");
  check("an email nobody has proved they own gets nothing", who.member === false && (await unconfirmed.fetch("house_items")).length === 0, JSON.stringify(who));

  await owner.remove("house_members", "email", "mum@test.invalid");
  who = await mum.rpc("house_whoami");
  check("removed from the list: access ends at once", who.member === false && (await mum.fetch("house_items")).length === 0);
  await db.exec("delete from house_items; delete from house_members;");
  await owner.upsert("house_members", [{ email: "mum@test.invalid", label: "Mum" }], "email");

  console.log("\nFirst device: its data becomes the shared data");
  const phone = await browser(server, "phone", {
    "todo.items.v1": [{ id: "a", title: "Buy rice", doneAt: null }, { id: "b", title: "Call plumber", doneAt: null }],
    "expenses.items.v1": [{ id: "e1", date: "2026-10-01", cat: "food", item: "Groceries", amount: 250000 }],
    "expenses.categories.v1": [{ id: "food", name: "Food" }, { id: "other", name: "Other" }],
    "expenses.settings.v1": { budget: 5000000, lastCat: "food" },
    "oni.settings.v1": { theme: "dark", shopName: "My Shop", invPrefix: "INV-" },
    "todo.theme.v1": "dark",
  });
  check("signed out, nothing leaves the device", phone.HC.status().user === null && phone.api.state.upserts === 0);
  let st = await phone.signIn(OWNER_EMAIL);
  check("the owner signs in and is recognised", st.owner && st.member && st.joined, JSON.stringify(st));
  check("an empty cloud takes this device's data", st.info.cloud === 0 && (await sql("select count(*)::int n from house_items where not deleted and id not in ('_','_order')"))[0].n === 5);
  check("one row per record, plus settings and saved orders", (await sql("select count(*)::int n from house_items"))[0].n === 9, String((await sql("select count(*)::int n from house_items"))[0].n));
  check("themes and other per-device choices aren't uploaded", (await sql("select count(*)::int n from house_items where store like '%theme%'"))[0].n === 0
    && (await sql("select data from house_items where store = 'oni.settings.v1'"))[0].data.theme === undefined
    && (await sql("select data from house_items where store = 'expenses.settings.v1'"))[0].data.lastCat === undefined);
  check("the device's own copy is backed up first", !!phone.get("house.preCloudBackup.v1").stores["todo.items.v1"]);
  const before = phone.api.state.upserts;
  await phone.sync();
  check("syncing again uploads nothing", phone.api.state.upserts === before);

  console.log("\nSecond device: takes the shared data");
  const laptop = await browser(server, "laptop", {
    "todo.items.v1": [{ id: "old", title: "Stale test item", doneAt: null }],
    "oni.settings.v1": { theme: "light", shopName: "" },
  });
  st = await laptop.signIn("mum@test.invalid", "cloud");
  check("a member signs in", st.member && !st.owner && st.joined);
  check("it's told the cloud already has data (so the app can ask)", st.info.cloud === 5 && st.info.local === 1);
  check("\"use the shared data\" replaces what was there", names(laptop.get("todo.items.v1")) === "Buy rice,Call plumber", names(laptop.get("todo.items.v1")));
  check("...in the same order", laptop.get("todo.items.v1")[0].id === "a");
  check("...and nothing stale is uploaded", (await sql("select count(*)::int n from house_items where id = 'old'"))[0].n === 0);
  check("shared settings arrive; this device's theme stays", laptop.get("oni.settings.v1").shopName === "My Shop" && laptop.get("oni.settings.v1").theme === "light");
  check("tools never opened here get an empty list, not their starter data", JSON.stringify(laptop.get("energy.bills.v1")) === "[]");
  check("the page is told which data changed", laptop.events.includes("todo.items.v1") && laptop.events.includes("oni.settings.v1"), laptop.events.join());

  console.log("\nDay to day");
  laptop.events.length = 0;
  let todos = phone.get("todo.items.v1");
  todos[0].title = "Buy rice and eggs"; todos.unshift({ id: "c", title: "Pay internet", doneAt: null });
  phone.set("todo.items.v1", todos);
  await phone.sync(); await laptop.sync();
  check("an edit and a new item reach the other device", names(laptop.get("todo.items.v1")) === "Pay internet,Buy rice and eggs,Call plumber", names(laptop.get("todo.items.v1")));
  check("...announced to the open page", laptop.events.join() === "todo.items.v1", laptop.events.join());
  check("only what changed was uploaded", phone.api.state.upserts - before === 3, String(phone.api.state.upserts - before));

  todos = laptop.get("todo.items.v1").filter(t => t.id !== "b");
  laptop.set("todo.items.v1", todos);
  await laptop.sync(); await phone.sync();
  check("a delete reaches the other device", names(phone.get("todo.items.v1")) === "Pay internet,Buy rice and eggs", names(phone.get("todo.items.v1")));
  check("...and is kept as a flagged row, not removed", (await sql("select deleted from house_items where id = 'b'"))[0].deleted === true);

  // Both edit before either syncs: different records.
  let p = phone.get("todo.items.v1"), l = laptop.get("todo.items.v1");
  p.find(t => t.id === "a").doneAt = "2026-10-01T10:00:00Z"; phone.set("todo.items.v1", p);
  l.find(t => t.id === "c").title = "Pay internet bill"; laptop.set("todo.items.v1", l);
  await phone.sync(); await laptop.sync(); await phone.sync();
  const both = d => d.get("todo.items.v1").find(t => t.id === "a").doneAt && d.get("todo.items.v1").find(t => t.id === "c").title === "Pay internet bill";
  check("two people changing different things: both changes survive", both(phone) && both(laptop));

  // Both edit the same record: the later upload wins, everywhere.
  p = phone.get("todo.items.v1"); l = laptop.get("todo.items.v1");
  p.find(t => t.id === "c").title = "Phone says"; phone.set("todo.items.v1", p);
  l.find(t => t.id === "c").title = "Laptop says"; laptop.set("todo.items.v1", l);
  await phone.sync(); await laptop.sync(); await phone.sync();
  check("the same thing changed twice: the later one wins on both", phone.get("todo.items.v1").find(t => t.id === "c").title === "Laptop says"
    && laptop.get("todo.items.v1").find(t => t.id === "c").title === "Laptop says");

  p = phone.get("todo.items.v1"); p.reverse(); phone.set("todo.items.v1", p);
  await phone.sync(); await laptop.sync();
  check("re-ordering a list syncs", laptop.get("todo.items.v1").map(t => t.id).join() === p.map(t => t.id).join());

  const set = laptop.get("oni.settings.v1"); set.shopName = "Mum's Shop"; set.theme = "light"; laptop.set("oni.settings.v1", set);
  await laptop.sync(); await phone.sync();
  check("a settings change syncs; each device keeps its own theme", phone.get("oni.settings.v1").shopName === "Mum's Shop" && phone.get("oni.settings.v1").theme === "dark");

  console.log("\nSafety");
  let n0 = (await sql("select count(*)::int n from house_items where deleted"))[0].n;
  laptop.w.localStorage.removeItem("expenses.items.v1");
  await laptop.sync();
  check("a missing store is never read as \"everything was deleted\"", (await sql("select count(*)::int n from house_items where deleted"))[0].n === n0);
  laptop.w.localStorage.setItem("expenses.categories.v1", "{not json");
  await laptop.sync();
  check("...nor is one that can't be read", (await sql("select count(*)::int n from house_items where deleted"))[0].n === n0);
  laptop.w.localStorage.setItem("expenses.categories.v1", JSON.stringify(phone.get("expenses.categories.v1")));

  phone.api.state.offline = true;
  p = phone.get("todo.items.v1"); p.push({ id: "off", title: "Added offline", doneAt: null }); phone.set("todo.items.v1", p);
  await phone.sync();
  check("offline: the change stays on the device, with a plain message", /Offline/.test(phone.HC.status().lastError) && phone.get("todo.items.v1").some(t => t.id === "off"), phone.HC.status().lastError);
  phone.api.state.offline = false;
  await phone.sync(); await laptop.sync();
  check("...and uploads once back online", phone.HC.status().lastError === "" && laptop.get("todo.items.v1").some(t => t.id === "off"));

  laptop.w.document.getElementById("field").focus();
  p = phone.get("todo.items.v1"); p[0].title = "Changed while mum was typing"; phone.set("todo.items.v1", p);
  await phone.sync();
  laptop.events.length = 0;
  laptop.w.document.dispatchEvent(new laptop.w.Event("visibilitychange"));
  await sleep(350);
  check("mid-typing, incoming changes wait rather than redraw the page", laptop.events.length === 0);
  laptop.w.document.getElementById("field").blur();
  await laptop.sync();
  check("...and arrive once typing stops", laptop.get("todo.items.v1")[0].title === "Changed while mum was typing");

  console.log("\nA device with its own copy of the same things");
  await phone.sync();
  phone.set("oni.catalog.v1", [{ id: "p1", name: "Shinobi Singlet", sizes: ["M"], colours: [], price: 3450 }, { id: "p2", name: "Wrist Wraps", sizes: [], colours: [] }]);
  phone.set("grocery.items.v1", [{ id: "g1", name: "Eggs", php: 120 }]);
  phone.set("grocery.plan.v1", [{ id: "pl1", itemId: "g1", qty: 2 }]);
  phone.set("energy.bills.v1", [{ id: "bill1", date: "2026-09-24", php: 16547.84, kwh: 986 }]);
  await phone.sync();
  const tablet = await browser(server, "tablet", {
    "oni.catalog.v1": [{ id: "x1", name: "shinobi singlet", sizes: [], colours: [] }, { id: "x2", name: "Deadlift Socks", sizes: ["S"], colours: [] }],
    "grocery.items.v1": [{ id: "y1", name: "EGGS", php: 99 }, { id: "y2", name: "Milk", php: 80 }],
    "grocery.plan.v1": [{ id: "z1", itemId: "y1", qty: 5 }, { id: "z2", itemId: "y2", qty: 1 }],
    "energy.bills.v1": [{ id: "seed1", date: "2026-09-24", php: 16547.84, kwh: 986 }, { id: "seed2", date: "2026-08-24", php: 13415.27, kwh: 788 }],
    "todo.items.v1": [{ id: "mine", title: "Tablet's own to-do", doneAt: null }],
  });
  await tablet.signIn(OWNER_EMAIL, "merge");
  await phone.sync();
  const cat = tablet.get("oni.catalog.v1");
  check("merge: the same item on both devices isn't duplicated", cat.filter(c => /shinobi/i.test(c.name)).length === 1 && cat.find(c => /shinobi/i.test(c.name)).id === "p1", JSON.stringify(cat.map(c => c.id)));
  check("...the shared copy (with its price) is the one kept", cat.find(c => c.id === "p1").price === 3450);
  check("...and what only this device had is added for everyone", phone.get("oni.catalog.v1").some(c => c.name === "Deadlift Socks") && phone.get("todo.items.v1").some(t => t.id === "mine"));
  const plan = tablet.get("grocery.plan.v1");
  check("a list line pointing at a merged item follows it", !plan.some(x => x.itemId === "y1") && plan.filter(x => x.itemId === "g1").length === 1, JSON.stringify(plan));
  check("...and the item only this device had keeps its line", plan.some(x => x.itemId === "y2") && phone.get("grocery.items.v1").some(g => g.name === "Milk"));
  check("the same bill typed on both devices is one bill", tablet.get("energy.bills.v1").filter(b => b.date === "2026-09-24").length === 1 && phone.get("energy.bills.v1").length === 2,
    JSON.stringify(phone.get("energy.bills.v1").map(b => b.date)));
  check("nothing of the device's own was lost before merging", tablet.get("house.preCloudBackup.v1").stores["oni.catalog.v1"].includes("x1"));

  console.log("\nPeople");
  const guest = await browser(server, "guest", { "todo.items.v1": [{ id: "g", title: "Guest's private note", doneAt: null }] });
  st = await guest.signIn("stranger@test.invalid");
  check("an account that isn't on the list: signed in, no access", !!st.user && st.member === false && st.joined === false);
  await guest.sync();
  check("...nothing of theirs is uploaded, nothing of yours arrives", guest.api.state.upserts === 0 && names(guest.get("todo.items.v1")) === "Guest's private note");
  let bad = await guest.HC.addMember("stranger@test.invalid", "me").then(() => null, e => e.message);
  check("...and the app can't add them either", /row-level security/.test(bad || ""), bad);

  await phone.HC.addMember(" Friend@Test.Invalid ", "Friend");
  check("the owner adds a person from the app", (await phone.HC.members()).some(m => m.email === "friend@test.invalid" && m.label === "Friend"));
  check("a member sees the list but can't change it", (await laptop.HC.members()).length >= 2 && /row-level security/.test(await laptop.HC.addMember("x@test.invalid").then(() => "", e => e.message)));
  await phone.HC.removeMember("mum@test.invalid");
  l = laptop.get("todo.items.v1"); l.push({ id: "late", title: "After removal", doneAt: null }); laptop.set("todo.items.v1", l);
  await laptop.sync(); await sleep(20);
  check("someone removed from the list stops syncing, and is told why", laptop.HC.status().member === false && /no longer has access/.test(laptop.HC.status().lastError)
    && (await sql("select count(*)::int n from house_items where id = 'late'"))[0].n === 0, JSON.stringify(laptop.HC.status()));
  check("...their device keeps its own copy", laptop.get("todo.items.v1").some(t => t.id === "late"));

  await phone.HC.signOut();
  p = phone.get("todo.items.v1"); p.push({ id: "so", title: "While signed out", doneAt: null }); phone.set("todo.items.v1", p);
  const ups = phone.api.state.upserts;
  await phone.sync();
  check("signed out: the app keeps working on the device, nothing uploads", phone.api.state.upserts === ups && phone.HC.status().user === null);
  await phone.HC.verifyCode(OWNER_EMAIL, GOOD_CODE); await phone.sync(); await tablet.sync();
  check("signing back in picks up where it left off", tablet.get("todo.items.v1").some(t => t.id === "so"));

  console.log("\nLive updates");
  const a = await browser(server, "live-a", {}, { live: true }), b = await browser(server, "live-b", {}, { live: true });
  await a.signIn(OWNER_EMAIL, "cloud"); await b.signIn(OWNER_EMAIL, "cloud");
  const t = a.get("todo.items.v1"); t.push({ id: "live", title: "Seen without refreshing", doneAt: null }); a.set("todo.items.v1", t);
  await sleep(2600);
  check("a change shows up on another open device by itself", b.get("todo.items.v1").some(x => x.id === "live"));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
