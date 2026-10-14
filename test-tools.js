/* Each real tool page, wired to the cloud.
 * Run: node test-tools.js   (npm install once first)
 *
 * test-cloud.js proves the sync engine and the database rules. This proves the
 * pages hold up their end: every save reaches cloud.js, and a change arriving
 * from another device shows up in the open page (and is not then overwritten
 * by the page's own stale copy). Pages run in jsdom with their real scripts;
 * the "server" is a tiny in-memory stand-in for the house_items table.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = f => fs.readFileSync(path.join(__dirname, f), "utf8");
const CLOUD_SRC = read("cloud.js");
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@test.invalid" };

// One shared table; every "device" reads and writes it as an allowed member.
function server() {
  const rows = new Map();
  let clock = Date.parse("2026-10-01T00:00:00Z");
  return {
    rows,
    api() {
      const state = { upserts: 0 };
      return {
        state,
        session: async () => USER,
        onSessionChange() {},
        signOut: async () => {},
        rpc: async () => ({ email: USER.email, owner: true, member: true }),
        fetch: async (table, o = {}) => [...rows.values()].filter(r => !o.since || r.updated_at > o.since)
          .sort((a, b) => a.updated_at < b.updated_at ? -1 : 1).map(r => JSON.parse(JSON.stringify(r))),
        upsert: async (table, list) => {
          state.upserts += list.length;
          list.forEach(r => rows.set(r.store + "|" + r.id, Object.assign(JSON.parse(JSON.stringify(r)), { updated_at: new Date(clock += 1000).toISOString() })));
        },
        listen: () => () => {},
      };
    },
    // Another device changing something, straight on the server.
    put(store, id, data) {
      rows.set(store + "|" + id, { store, id, data, deleted: false, updated_at: new Date(clock += 1000).toISOString() });
    },
  };
}

// Open a tool page already signed in and joined, with `seed` in localStorage.
async function open(file, srv, seed) {
  const html = read(file).replace('<script defer src="cloud.js"></script>', "");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(String(e && e.message))) errors.push(String(e && (e.detail && e.detail.stack || e.stack || e.message))); });
  const api = srv.api();
  const dom = new JSDOM(html, {
    url: "https://house.test/" + file, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(seed || {})) w.localStorage.setItem(k, JSON.stringify(v));
      w.localStorage.setItem("house.cloud.v1", JSON.stringify({ user: USER, member: true, owner: true, joined: true, shadow: {}, cursor: "" }));
      w.__houseCloud = api;
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.confirm = () => true;
      if (w.HTMLDialogElement) {
        w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
        w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
      }
      w.eval(CLOUD_SRC);   // what the deferred <script src="cloud.js"> does
    },
  });
  const w = dom.window;
  await sleep(30);
  await w.HouseCloud.syncNow();
  return { w, api, errors, text: () => w.document.body.textContent, get: k => JSON.parse(w.localStorage.getItem(k)),
           sync: () => w.HouseCloud.syncNow() };
}
// PowerPass: the powerpass_* tables, in memory, per account. Same shape as the
// thin layer powerpass.js puts over Supabase (window.__powerpassCloud).
function ppServer() {
  const vaults = new Map(), rows = new Map();
  let clock = Date.parse("2026-10-01T00:00:00Z");
  return {
    vaults, rows,
    api(user) {
      const st = { offline: false, member: true };
      const net = () => st.offline ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve();
      return {
        st,
        session: async () => { await net(); return user; },
        sendCode: async () => { await net(); },
        verifyCode: async () => { await net(); return user; },
        signOut: async () => {},
        whoami: async () => { await net(); return { member: st.member }; },
        getVault: async () => { await net(); return vaults.get(user.id) || null; },
        createVault: async v => { await net(); if (vaults.has(user.id)) throw new Error("duplicate key"); const { user_id, ...rest } = v; vaults.set(user.id, rest); },
        eraseVault: async () => { await net(); for (const k of [...rows.keys()]) if (k.startsWith(user.id + "|")) rows.delete(k); vaults.delete(user.id); },
        fetchItems: async since => { await net(); return [...rows.values()].filter(r => r.user_id === user.id && (!since || r.updated_at > since))
          .sort((a, b) => a.updated_at < b.updated_at ? -1 : 1).map(({ user_id, ...r }) => ({ ...r })); },
        upsertItems: async list => { await net(); list.forEach(r => rows.set(user.id + "|" + r.id, { ...r, user_id: user.id, updated_at: new Date(clock += 1000).toISOString() })); },
      };
    },
  };
}
// A device's built-in authenticator (Face ID and the like) as WebAuthn sees it:
// each passkey keeps a secret, and PRF answers HMAC(secret, salt) once the
// person passes. `dev.cancel` is the person cancelling; `dev.prf` false is a
// browser without PRF. Passkeys live in `dev.creds`, so they outlast a reload.
function fakeAuthenticator(w, dev) {
  const nc = require("crypto");
  const no = msg => new w.DOMException(msg, "NotAllowedError");
  w.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true };
  Object.defineProperty(w.navigator, "credentials", { configurable: true, value: {
    async create({ publicKey: o }) {
      if (dev.cancel) throw no("cancelled");
      const id = nc.randomBytes(16);
      dev.creds.set(id.toString("base64"), nc.randomBytes(32));
      dev.created = o;
      return { rawId: new Uint8Array(id).buffer, getClientExtensionResults: () => ({ prf: dev.prf === false ? {} : { enabled: true } }) };
    },
    async get({ publicKey: o }) {
      if (dev.cancel) throw no("cancelled");
      const secret = dev.creds.get(Buffer.from(o.allowCredentials[0].id).toString("base64"));
      if (!secret) throw no("no passkey on this device");
      dev.uses = (dev.uses || 0) + 1;
      const first = new Uint8Array(nc.createHmac("sha256", secret).update(Buffer.from(o.extensions.prf.eval.first)).digest()).buffer;
      return { getClientExtensionResults: () => ({ prf: { results: { first } } }) };
    },
  } });
}
// powerpass.html on a device: its own localStorage (kept across reopen), the real powerpass.js, real Web Crypto.
// `opts.device` gives it a Face ID authenticator (see fakeAuthenticator).
async function openPP(srv, user, storage = {}, opts = {}) {
  const html = read("powerpass.html")
    .replace('<script src="vendor/supabase.js"></script>', "")
    .replace('<script src="powerpass.js"></script>', () => "<script>" + read("powerpass.js") + "</script>");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(String(e && e.message))) errors.push(String(e && (e.stack || e.message))); });
  const api = user ? srv.api(user) : null;
  if (api) { api.st.offline = !!opts.offline; if (opts.member === false) api.st.member = false; }
  const dom = new JSDOM(html, {
    url: "https://house.test/powerpass.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      Object.defineProperty(w.crypto, "subtle", { value: require("crypto").webcrypto.subtle });
      w.__powerpassCloud = api || { session: async () => null };
      if (opts.device) fakeAuthenticator(w, opts.device);
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
      w.HTMLDialogElement.prototype.close = function () { if (this.hasAttribute("open")) { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); } };
    },
  });
  const w = dom.window, d = w.document;
  const visible = id => !d.getElementById(id).closest(".hidden");
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await sleep(20); } return true; };
  const submit = id => d.getElementById(id).dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  const storageNow = () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; };
  async function master(pw, confirm) {
    d.getElementById("pw").value = pw;
    if (confirm != null) d.getElementById("pwConfirm").value = confirm;
    submit("lockForm");
    await until(() => !d.getElementById("unlockBtn").disabled || visible("app"));
  }
  await until(() => !visible("gLoading"));
  return { w, d, api, errors, visible, until, submit, storageNow, master, pp: w.PowerPass,
           rows: () => d.querySelectorAll("#list .row:not(.head)").length, text: () => d.body.textContent };
}
const EXPORT_1P = JSON.stringify([
  { title: "Bank", location: "https://bank.example", secureContents: { URLs: [{ label: "website", url: "https://bank.example" }],
    fields: [{ designation: "username", value: "emm" }, { designation: "password", value: "Sup3r-Secret-Bank!" }] } },
  { title: "Mail", location: "mail.example", secureContents: { fields: [{ designation: "username", value: "emm@mail" }, { designation: "password", value: "Mail-Pass-42" }] } },
  { title: "Mail", location: "mail.example", secureContents: { fields: [{ designation: "username", value: "emm@mail" }, { designation: "password", value: "Mail-Pass-42" }] } },
]);
const today = () => { const d = new Date(), p = n => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };

(async () => {
  console.log("\nEvery page is wired in");
  const PAGES = ["index.html", "account.html", "energy-tracker.html", "oni-orders.html", "grocery.html", "todo.html", "expenses.html"];
  PAGES.forEach(f => check(f + " loads cloud.js", /<script defer src="cloud\.js"><\/script>/.test(read(f))));
  ["energy-tracker.html", "oni-orders.html", "grocery.html", "todo.html", "expenses.html"].forEach(f => {
    const src = read(f), m = /function safeWrite\([^)]*\)\s*\{[\s\S]*?\n  \}/.exec(src);
    check(f + ": every save is reported to cloud.js", !!m && /HouseCloud\.dirty\(key\)/.test(m[0]));
    check(f + ": no save bypasses safeWrite", (src.match(/localStorage\.setItem\(/g) || []).length <= 2, String((src.match(/localStorage\.setItem\(/g) || []).length));
  });
  const stores = Object.keys(new JSDOM("", { url: "https://house.test/", runScripts: "outside-only" }).window.eval(CLOUD_SRC + ";window.HouseCloud.STORES"));
  const used = new Set();
  PAGES.forEach(f => (read(f).match(/"[a-z]+\.[A-Za-z]+\.v\d+"/g) || []).forEach(k => used.add(k.slice(1, -1))));
  check("every synced store is one a page really uses", stores.every(k => used.has(k)), stores.filter(k => !used.has(k)).join());
  const LOCAL = ["energy.theme.v1", "energy.savedAt.v1", "energy.groups.v1", "energy.summary.v1", "grocery.theme.v1", "grocery.tab.v1",
                 "todo.theme.v1", "todo.tab.v1", "expenses.tab.v1", "expenses.month.v1", "expenses.group.v1", "expenses.byType.v1", "house.installHintDismissed.v1"];
  const unknown = [...used].filter(k => !stores.includes(k) && !LOCAL.includes(k));
  check("every other store is knowingly per-device", unknown.length === 0, "decide: synced or local? " + unknown.join());

  console.log("\nTo Do");
  let srv = server();
  let page = await open("todo.html", srv, { "todo.items.v1": [{ id: "a", title: "Buy rice", notes: "", createdAt: "2026-10-01T00:00:00Z", doneAt: null }] });
  check("the page boots signed in, without errors", page.errors.length === 0, page.errors.join("\n"));
  check("its data is uploaded", srv.rows.has("todo.items.v1|a"));
  srv.put("todo.items.v1", "r", { id: "r", title: "From the other phone", notes: "", createdAt: "2026-10-01T01:00:00Z", doneAt: null });
  await page.sync();
  check("a to-do added elsewhere appears in the open page", /From the other phone/.test(page.text()));
  let n = page.api.state.upserts;
  const input = page.w.document.querySelector("form input[type=text], form input:not([type])");
  input.value = "Typed here"; input.form.dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  await page.sync();
  check("adding one here uploads it", srv.rows.has("todo.items.v1|" + (page.get("todo.items.v1").find(t => t.title === "Typed here") || {}).id) && page.api.state.upserts > n);
  check("...and the one from elsewhere is still there (the page's copy wasn't stale)", page.get("todo.items.v1").some(t => t.id === "r") && !srv.rows.get("todo.items.v1|r").deleted);

  console.log("\nGrocery");
  srv = server();
  page = await open("grocery.html", srv, { "grocery.items.v1": [{ id: "g1", name: "Eggs", php: 120 }], "grocery.plan.v1": [{ id: "p1", itemId: "g1", qty: 2 }],
                                           "grocery.settings.v1": { currency: "PHP", rate: 76 } });
  check("the page boots signed in, without errors", page.errors.length === 0, page.errors.join("\n"));
  srv.put("grocery.items.v1", "g2", { id: "g2", name: "Remote Milk", php: 80 });
  srv.put("grocery.plan.v1", "p2", { id: "p2", itemId: "g2", qty: 3 });
  srv.put("grocery.settings.v1", "_", { rate: 80 });
  await page.sync();
  check("an item and a list line added elsewhere appear", /Remote Milk/.test(page.w.document.getElementById("lines").textContent) && /Remote Milk/.test(page.w.document.getElementById("itemList").textContent));
  check("the new total includes it", /480/.test(page.w.document.getElementById("totalMain").textContent), page.w.document.getElementById("totalMain").textContent);
  check("the exchange rate set elsewhere arrives; this device's currency choice stays", page.get("grocery.settings.v1").rate === 80 && page.get("grocery.settings.v1").currency === "PHP");
  page.w.document.querySelector("#lines .stepper button:last-child").click();
  await page.sync();
  check("changing a quantity here uploads just that line, and keeps the other", srv.rows.get("grocery.plan.v1|p1").data.qty === 3 && !srv.rows.get("grocery.plan.v1|p2").deleted);

  console.log("\nExpenses");
  srv = server();
  page = await open("expenses.html", srv, { "expenses.items.v1": [{ id: "e1", date: today(), cat: "food", item: "Groceries", amount: 250000, createdAt: "2026-10-01T00:00:00Z" }] });
  check("the page boots signed in, without errors", page.errors.length === 0, page.errors.join("\n"));
  check("its expenses are uploaded", srv.rows.has("expenses.items.v1|e1"));
  // Built-in categories exist on every device and are only saved once changed, so there is nothing to send.
  check("untouched built-in categories aren't uploaded", ![...srv.rows.keys()].some(k => k.startsWith("expenses.categories.v1|")));
  srv.put("expenses.items.v1", "e2", { id: "e2", date: today(), cat: "food", item: "Remote dinner", amount: 99900, createdAt: "2026-10-01T02:00:00Z" });
  srv.put("expenses.settings.v1", "_", { budget: 7777700 });
  srv.put("expenses.categories.v1", "trips", { id: "trips", name: "Remote Trips", emoji: "✈️", color: "#88aadd" });
  await page.sync();
  check("an expense added elsewhere appears", /Remote dinner/.test(page.text()));
  check("the budget set elsewhere arrives", page.get("expenses.settings.v1").budget === 7777700);
  check("a category added elsewhere arrives", /Remote Trips/.test(page.text()));
  check("...and nothing was wrongly flagged as deleted", [...srv.rows.values()].every(r => !r.deleted));

  console.log("\nExpenses: withdrawals");
  const doc = page.w.document, wd = () => doc.getElementById("view-wd");
  doc.querySelector('[data-tab="wd"]').click();
  check("the tabs read Overview, Breakdown, Pots, Settings", [...doc.querySelectorAll("[data-tab]")].map(b => b.textContent).join() === "Overview,Breakdown,Pots,Settings");
  check("...and opens, with the month switcher", !wd().hidden && !doc.getElementById("monthBar").hidden);
  // A £ one with no rate yet: kept out of the peso total, and said so.
  doc.getElementById("fab").click();
  doc.querySelector('.cur-pick [data-cur="GBP"]').click();
  doc.getElementById("wdAmount").value = "250";
  doc.querySelector('#wdKinds [data-kind="cat:medical"]').click();
  doc.getElementById("wdNote").value = "To Mum";
  doc.getElementById("wdSheet").dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  let stored = page.get("expenses.withdrawals.v1") || [];
  check("+ Add on this tab adds a withdrawal, kept in pence", stored.length === 1 && stored[0].amount === 25000 && stored[0].currency === "GBP" && stored[0].kind === "cat:medical");
  check("without a rate, £ isn't guessed into the total", /₱0\.00/.test(doc.getElementById("wdTotal").textContent) && /£250/.test(doc.getElementById("wdWarn").textContent) && !doc.getElementById("wdWarn").hidden);
  const rateIn = doc.getElementById("rateInput");
  rateIn.value = "76.25"; rateIn.dispatchEvent(new page.w.Event("change"));
  check("setting £1 = ₱76.25 converts it", doc.getElementById("wdTotal").textContent === "₱19,062.50" && doc.getElementById("wdWarn").hidden, doc.getElementById("wdTotal").textContent);
  check("...the row shows both: £250 and ≈ ₱19,062.50", /£250≈ ₱19,062\.50/.test(doc.getElementById("wdList").textContent), doc.getElementById("wdList").textContent);
  // Pesos straight in, then the total adds both.
  doc.getElementById("fab").click();
  check("the next one starts like the last: pounds, Medical", doc.querySelector('.cur-pick [data-cur="GBP"]').classList.contains("on") && doc.querySelector('#wdKinds [data-kind="cat:medical"]').classList.contains("on"));
  doc.querySelector('.cur-pick [data-cur="PHP"]').click();
  doc.querySelector('#wdKinds [data-kind="cat:education"]').click();
  doc.getElementById("wdAmount").value = "5,000";
  doc.getElementById("wdSheet").dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  check("₱ and £ withdrawals add up to one peso total", doc.getElementById("wdTotal").textContent === "₱24,062.50", doc.getElementById("wdTotal").textContent);
  check("by type, in pesos", /Medical1₱19,062\.50/.test(doc.getElementById("wdTypes").textContent) && /Education1₱5,000/.test(doc.getElementById("wdTypes").textContent), doc.getElementById("wdTypes").textContent);
  check("withdrawals don't count as spending", !/24,062/.test(doc.getElementById("heroTotal").textContent));
  const typesToggle = doc.getElementById("wdTypesToggle");
  typesToggle.click();
  check("tapping By type folds it away, leaving a count", doc.getElementById("wdTypesCard").hidden && typesToggle.getAttribute("aria-expanded") === "false"
    && doc.getElementById("wdTypesNote").textContent === "2 types" && !doc.getElementById("wdTypesNote").hidden);
  doc.getElementById("nextMonth").click(); doc.getElementById("prevMonth").click();
  check("...and it stays folded (remembered on this device)", doc.getElementById("wdTypesCard").hidden && page.w.localStorage.getItem("expenses.byType.v1") === "closed");
  typesToggle.click();
  check("tapping again opens it", !doc.getElementById("wdTypesCard").hidden && doc.getElementById("wdTypesNote").hidden);
  await page.sync();
  check("withdrawals and the rate are uploaded", [...srv.rows.keys()].filter(k => k.startsWith("expenses.withdrawals.v1|")).length === 2 && srv.rows.get("expenses.settings.v1|_").data.gbpRate === 76.25);
  srv.put("expenses.settings.v1", "_", Object.assign({}, srv.rows.get("expenses.settings.v1|_").data, { gbpRate: 80 }));
  srv.put("expenses.withdrawals.v1", "w9", { id: "w9", date: today(), kind: "bank", note: "Remote transfer", amount: 10000, currency: "GBP", createdAt: 1 });
  await page.sync();
  check("a withdrawal and a new rate from another device arrive and re-total", /Remote transfer/.test(wd().textContent) && doc.getElementById("wdTotal").textContent === "₱33,000.00", doc.getElementById("wdTotal").textContent);
  check("...without disturbing anything else", [...srv.rows.values()].every(r => !r.deleted));
  const gbpTag = doc.getElementById("wdGbp");
  check("the card also shows the total in pounds, at the same rate", !gbpTag.hidden && gbpTag.textContent === "≈ £412.50", gbpTag.textContent);
  rateIn.value = ""; rateIn.dispatchEvent(new page.w.Event("change"));
  check("...and hides it while there's no rate", gbpTag.hidden);
  rateIn.value = "80"; rateIn.dispatchEvent(new page.w.Event("change"));

  console.log("\nExpenses: pots");
  const submit = id => doc.getElementById(id).dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  const potRows = () => [...doc.querySelectorAll("#potList .pot-row:not(.add)")];
  check("no pots yet: the card says what they're for", /Group withdrawals into pots/.test(doc.getElementById("potList").textContent));
  doc.querySelector('#potList [data-pot=""]').click();
  check("+ New pot opens the pot sheet", doc.getElementById("catTitle").textContent === "New pot" && doc.getElementById("catScrim").classList.contains("on"));
  doc.getElementById("catName").value = "House build"; doc.getElementById("catEmoji").value = "🏠"; submit("catSheet");
  doc.querySelector('#potList [data-pot=""]').click();
  doc.getElementById("catName").value = "Mum"; submit("catSheet");
  const pots = page.get("expenses.pots.v1") || [];
  check("two pots made, and the categories untouched", pots.map(p => p.name).join() === "House build,Mum" && !(page.get("expenses.categories.v1") || []).some(c => c.name === "Mum"));
  const house = pots[0].id;
  // The existing £250 "To Mum" one goes into Mum, a new one into House build.
  const toMum = page.get("expenses.withdrawals.v1").find(w => w.note === "To Mum");
  doc.querySelector('#wdList [data-id="' + toMum.id + '"]').click();
  doc.querySelector('#wdPots [data-wdpot="' + pots[1].id + '"]').click();
  submit("wdSheet");
  potRows()[0].click();   // look at House build, then add: it lands in that pot
  doc.getElementById("fab").click();
  check("adding while a pot is picked puts it in that pot", doc.querySelector('#wdPots [data-wdpot="' + house + '"]').classList.contains("on"));
  doc.querySelector('.cur-pick [data-cur="PHP"]').click();
  doc.getElementById("wdAmount").value = "12000"; submit("wdSheet");
  check("each pot shows its own total for the month", /₱12,000/.test(potRows()[0].textContent) && /₱20,000/.test(potRows()[1].textContent), potRows().map(r => r.textContent).join(" | "));
  check("...and its all-time total, in pesos and pounds, with its count", /House build1All time ₱12,000≈ £150.00/.test(potRows()[0].textContent), potRows()[0].textContent);
  check("this month in pounds too", /₱20,000≈ £250.00 in /.test(potRows()[1].textContent), potRows()[1].textContent);
  check("the list narrows to the picked pot", doc.querySelectorAll("#wdList .wd-row").length === 1 && /House build · 1 · ₱12,000/.test(doc.getElementById("wdCount").textContent), doc.getElementById("wdCount").textContent);
  check("...while the month's total still covers everything", doc.getElementById("wdTotal").textContent === "₱45,000.00", doc.getElementById("wdTotal").textContent);
  potRows()[0].click();
  check("tapping the pot again shows everything", doc.querySelectorAll("#wdList .wd-row").length === 4);
  check("rows say which pot they're in", /🏠 House build/.test(doc.getElementById("wdList").textContent));
  await page.sync();
  check("pots and the withdrawals' pots are uploaded", [...srv.rows.keys()].filter(k => k.startsWith("expenses.pots.v1|")).length === 3
    && srv.rows.get("expenses.withdrawals.v1|" + toMum.id).data.pot === pots[1].id);

  console.log("\nExpenses: a pot shown in Breakdown");
  const spent = () => +doc.getElementById("heroTotal").textContent.replace(/[^\d.]/g, "");
  const spentBefore = spent();
  potRows()[1].querySelector(".edit").click();
  check("the pot sheet has a Show in Breakdown switch, off to start", !doc.getElementById("potBdWrap").hidden && !doc.getElementById("potBd").checked);
  doc.getElementById("potBd").checked = true; submit("catSheet");
  check("switched on, the pot is marked", /In Breakdown/.test(potRows()[1].textContent) && page.get("expenses.pots.v1")[1].inBreakdown === true);
  check("its £250 (at ₱80) now counts as spending on Overview", spent() === spentBefore + 20000, spentBefore + " -> " + spent());
  const listText = () => doc.getElementById("listCard").textContent;
  check("...and is listed in Breakdown under its type's category, saying which pot", /Medical/.test(listText()) && /To Mum/.test(listText()) && /👵|Mum/.test(listText()) && /£250/.test(listText()), listText());
  doc.querySelector('#listCard [data-id="wd:' + toMum.id + '"]').click();
  check("tapping it there opens the withdrawal itself", doc.getElementById("wdScrim").classList.contains("on") && doc.getElementById("wdAmount").value === "250");
  doc.getElementById("wdScrim").click();
  check("the category sheet doesn't show the switch", (doc.querySelector('[data-tab="settings"]').click(), doc.querySelector("#catSettings [data-cat]").click(), doc.getElementById("potBdWrap").hidden));
  doc.getElementById("catCancel").click();
  doc.querySelector('[data-tab="wd"]').click();
  potRows()[1].querySelector(".edit").click();
  doc.getElementById("potBd").checked = false; submit("catSheet");
  check("switched off, it stops counting", spent() === spentBefore && !/To Mum/.test(listText()));
  potRows()[1].querySelector(".edit").click();
  check("the pencil opens the pot to edit", doc.getElementById("catTitle").textContent === "Edit pot" && doc.getElementById("catName").value === "Mum");
  doc.getElementById("catDelete").click();
  check("deleting a pot keeps its withdrawals, just without a pot", !(page.get("expenses.pots.v1") || []).some(p => p.name === "Mum")
    && page.get("expenses.withdrawals.v1").find(w => w.id === toMum.id).pot === null && page.get("expenses.withdrawals.v1").length === 4);

  console.log("\nExpenses: categories as pot types");
  doc.getElementById("fab").click();
  const types = [...doc.querySelectorAll("#wdKinds [data-kind]")].map(b => b.textContent);
  // This page's categories, whatever earlier checks left them as.
  const pageCats = page.get("expenses.categories.v1");
  check("the types are just the Breakdown categories", types.join() === pageCats.map(c => c.emoji + c.name).join(), types.join());
  check("...none of the old fixed ones", !types.some(x => /ATM|Western Union|Bank transfer/.test(x)));
  doc.querySelector('#wdKinds [data-kind="cat:therapy"]').click();
  doc.querySelector('.cur-pick [data-cur="PHP"]').click();
  doc.getElementById("wdAmount").value = "1500"; doc.getElementById("wdNote").value = "Session cash"; submit("wdSheet");
  const g = page.get("expenses.withdrawals.v1").find(w => w.note === "Session cash");
  check("a withdrawal can be typed with a category", g && g.kind === "cat:therapy");
  check("...and By type shows it under that category", /🌱Therapy1₱1,500/.test(doc.getElementById("wdTypes").textContent), doc.getElementById("wdTypes").textContent);
  // Renaming the category shows up in Pots; deleting it moves the withdrawal like its expenses.
  doc.querySelector('[data-tab="settings"]').click();
  doc.querySelector('#catSettings [data-cat="therapy"]').click();
  doc.getElementById("catName").value = "Counselling"; submit("catSheet");
  doc.querySelector('[data-tab="wd"]').click();
  check("renaming the category renames the type", /Counselling1/.test(doc.getElementById("wdTypes").textContent));
  const before = page.get("expenses.categories.v1");
  const dest = before.some(c => c.id === "other") ? "other" : before.filter(c => c.id !== "therapy")[0].id;
  doc.querySelector('[data-tab="settings"]').click();
  doc.querySelector('#catSettings [data-cat="therapy"]').click();
  doc.getElementById("catDelete").click();
  check("deleting it moves the withdrawal where its expenses go", page.get("expenses.withdrawals.v1").find(w => w.id === g.id).kind === "cat:" + dest,
    page.get("expenses.withdrawals.v1").find(w => w.id === g.id).kind);
  doc.querySelector('[data-tab="wd"]').click();
  // One saved before the fixed types went (e.g. arriving from an older device).
  const old = page.get("expenses.withdrawals.v1");
  old.push({ id: "old1", date: today(), kind: "wu", note: "Old remittance", amount: 20000, currency: "PHP", pot: null, createdAt: 9 });
  page.w.localStorage.setItem("expenses.withdrawals.v1", JSON.stringify(old));
  page.w.dispatchEvent(new page.w.StorageEvent("storage", { key: "expenses.withdrawals.v1" }));
  check("a withdrawal saved with an old type still shows it", /Old remittance/.test(doc.getElementById("wdList").textContent) && /Western Union1₱200/.test(doc.getElementById("wdTypes").textContent), doc.getElementById("wdTypes").textContent);
  doc.querySelector('#wdList [data-id="old1"]').click();
  const shownTypes = [...doc.querySelectorAll("#wdKinds [data-kind]")];
  check("...editing it shows that type picked, ahead of the categories", shownTypes[0].getAttribute("data-kind") === "wu" && shownTypes[0].classList.contains("on") && shownTypes.length === pageCats.length);
  doc.querySelector('#wdKinds [data-kind="cat:education"]').click();
  submit("wdSheet");
  check("...and picking a category replaces it", page.get("expenses.withdrawals.v1").find(w => w.id === "old1").kind === "cat:education");
  doc.getElementById("fab").click();
  check("new ones never offer the old types", ![...doc.querySelectorAll("#wdKinds [data-kind]")].some(b => !/^cat:/.test(b.getAttribute("data-kind"))));
  page.w.document.getElementById("wdCancel").click();

  console.log("\nEnergy Tracker");
  srv = server();
  page = await open("energy-tracker.html", srv, { "energy.bills.v1": [{ id: "b1", date: "2026-08-24", php: 13415.27, kwh: 788, meter: null, note: "", kwhManual: true }] });
  check("the page boots signed in, without errors", page.errors.length === 0, page.errors.join("\n"));
  srv.put("energy.bills.v1", "b2", { id: "b2", date: "2026-09-24", php: 16547.84, kwh: 986, meter: null, note: "Remote bill note", kwhManual: true });
  srv.put("energy.forecast.v1", "_", { now: "12345", date: "2026-10-01", rate: "latest" });
  await page.sync();
  check("a bill added elsewhere appears", /Remote bill note/.test(page.text()));
  check("the forecast reading typed elsewhere arrives", page.get("energy.forecast.v1").now === "12345");
  check("...and nothing was wrongly flagged as deleted", [...srv.rows.values()].every(r => !r.deleted));

  console.log("\nOni Orders");
  srv = server();
  page = await open("oni-orders.html", srv, {
    "oni.catalog.v1": [{ id: "c1", name: "Shinobi Singlet", category: "Singlets", sizes: ["M"], colours: ["Black"], price: 3450 }],
    "oni.orders.v1": [], "oni.invoices.v1": [], "oni.settings.v1": { theme: "light", toEmail: "a@test.invalid", ccEmail: "", fromName: "" },
  });
  check("the page boots signed in, without errors", page.errors.length === 0, page.errors.join("\n"));
  check("the theme isn't uploaded", srv.rows.get("oni.settings.v1|_").data.theme === undefined);
  srv.put("oni.catalog.v1", "c2", { id: "c2", name: "Remote Wraps", category: "", sizes: [], colours: [], price: 1250 });
  srv.put("oni.invoices.v1", "i1", { id: "i1", no: "INV-0007", customer: "Remote Customer", date: today(), status: "paid", lines: [{ name: "Remote Wraps", size: "", colour: "", qty: 2, price: 1250 }], shipping: 0, discount: 0, message: "" });
  srv.put("oni.settings.v1", "_", Object.assign({}, srv.rows.get("oni.settings.v1|_").data, { shopName: "Shop set elsewhere", theme: "dark" }));
  await page.sync();
  const d = page.w.document;
  check("an item added elsewhere is in the order and catalog lists", /Remote Wraps/.test(d.getElementById("selItem").textContent));
  check("an invoice made elsewhere is in the list, with its total", /Remote Customer/.test(d.getElementById("invList").textContent) && /2,500/.test(d.getElementById("invList").textContent));
  check("the next invoice number carries on from it", (d.getElementById("newInvBtn").click(), d.getElementById("ivNo").value) === "INV-0008", d.getElementById("ivNo").value);
  check("the shop name set elsewhere arrives; this device keeps its theme", d.getElementById("setShop").value === "Shop set elsewhere" && page.get("oni.settings.v1").theme === "light"
    && d.documentElement.getAttribute("data-theme") === "light");
  check("...and nothing was wrongly flagged as deleted", [...srv.rows.values()].every(r => !r.deleted));

  console.log("\nPowerPass");
  const ppSrc = read("powerpass.html");
  check("powerpass.html deliberately doesn't load cloud.js (no third-party script on a password page)", !/<script[^>]*cloud\.js/.test(ppSrc));
  check("...its only scripts are this site's own", [...ppSrc.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).join() === "vendor/supabase.js,powerpass.js");
  check("...and it can only talk to the House App project", /connect-src https:\/\/nmukdaojabgozomkaeuw\.supabase\.co;/.test(ppSrc) && /script-src 'self';/.test(ppSrc));
  const cloudUrl = /var CLOUD_URL = "([^"]*)"/.exec(CLOUD_SRC)[1], cloudKey = /var CLOUD_KEY = "([^"]*)"/.exec(CLOUD_SRC)[1];
  check("...the same project and session as cloud.js", ppSrc.includes('data-cloud-url="' + cloudUrl + '"') && ppSrc.includes('data-cloud-key="' + cloudKey + '"') && /storageKey: "house\.auth"/.test(CLOUD_SRC) && ppSrc.includes('data-auth-key="house.auth"'));
  const libVersion = /supabase-js@(\d+\.\d+\.\d+)/.exec(CLOUD_SRC)[1];
  check("the vendored Supabase library is the version cloud.js pins", read("vendor/supabase.js").includes(libVersion));
  check("sw.js caches PowerPass for offline", ["./powerpass.html", "./powerpass.js", "./powerpass.css", "./vendor/supabase.js"].every(f => read("sw.js").includes('"' + f + '"')));
  check("no inline styles or scripts for the CSP to block", !/style="/.test(ppSrc) && !/<script>/.test(ppSrc));

  const PP_ME = { id: "22222222-2222-4222-8222-222222222222", email: "me@test.invalid" };
  const pps = ppServer();
  let pg = await openPP(pps, null, { "powerpass.cache.v1.old": "{}" });
  check("signed out: it sends you to House App's Account page", pg.visible("gHouse") && !pg.visible("app"));
  check("...and drops any encrypted copy left on the device", !Object.keys(pg.storageNow()).some(k => k.startsWith("powerpass.cache")));

  pg = await openPP(pps, PP_ME);
  check("signed in, first time: asked to create a master password", pg.visible("gLock") && pg.visible("confirmRow") && /Create/.test(pg.d.getElementById("gHeading").textContent));
  await pg.master("short", "short");
  check("...at least 8 characters", /at least 8/.test(pg.d.getElementById("lockError").textContent));
  await pg.master("correct horse battery", "correct horse batteries");
  check("...typed the same twice", /don’t match/.test(pg.d.getElementById("lockError").textContent));
  await pg.master("correct horse battery", "correct horse battery");
  check("...then it opens, and the vault is saved to the cloud", pg.visible("app") && pps.vaults.has(PP_ME.id));
  check("...holding no password, only a salt and a check value", !JSON.stringify(pps.vaults.get(PP_ME.id)).includes("correct horse"));
  await pg.pp.importText(EXPORT_1P);
  check("loading a 1Password export adds its logins, skipping the duplicate", pg.rows() === 2 && /Bank/.test(pg.text()), String(pg.rows()));
  await pg.pp.sync();
  const serverRows = [...pps.rows.values()];
  check("...they're uploaded, one row each", serverRows.length === 2 && serverRows.every(r => r.iv && r.data && !r.deleted));
  check("...as ciphertext only: no password, username or site on the server", !/Sup3r-Secret-Bank|Mail-Pass|emm@mail|bank\.example/.test(JSON.stringify(serverRows)));
  check("...or in this device's storage", !/Sup3r-Secret-Bank|Mail-Pass|emm@mail|bank\.example|correct horse/.test(JSON.stringify(pg.storageNow())));
  check("synced, and says so", /Synced/.test(pg.d.getElementById("syncState").textContent));
  check("no errors so far", pg.errors.length === 0, pg.errors.join("\n"));

  pg.d.getElementById("lockBtn").click();
  check("Lock forgets everything decrypted", pg.visible("gLock") && pg.rows() === 0 && !/Sup3r-Secret-Bank/.test(pg.d.body.innerHTML));
  await pg.master("wrong password!");
  check("a wrong master password is refused", pg.visible("gLock") && /isn’t right/.test(pg.d.getElementById("lockError").textContent));
  await pg.master("correct horse battery");
  check("the right one opens it again", pg.visible("app") && pg.rows() === 2);

  // A second device: nothing on it yet, same account.
  let pg2 = await openPP(pps, PP_ME);
  check("another device asks for the master password (not to create one)", pg2.visible("gLock") && pg2.d.getElementById("confirmRow").classList.contains("hidden"));
  await pg2.master("correct horse battery");
  await pg2.until(() => pg2.rows() === 2);
  check("...and shows the same logins, from the cloud", pg2.rows() === 2 && /Mail/.test(pg2.text()));
  const bankId = [...pg2.d.querySelectorAll("#list .row:not(.head)")].find(r => /Bank/.test(r.textContent)).dataset.id;
  pg2.d.querySelector('#list .row[data-id="' + bankId + '"] .del').click();
  await sleep(0);
  pg2.d.getElementById("cOk").click();
  await sleep(0);
  pg2.d.getElementById("addBtn").click();
  pg2.d.getElementById("fUrl").value = "shop.example"; pg2.d.getElementById("fUser").value = "emm"; pg2.d.getElementById("fPass").value = "Shop-Pass-7";
  pg2.submit("addForm");
  await pg2.until(() => pg2.rows() === 2 && /shop\.example/.test(pg2.text()));
  await pg2.pp.sync();
  await pg.pp.sync();
  check("a delete and an add on one device reach the other", pg.rows() === 2 && /shop\.example/.test(pg.text()) && !/Bank/.test(pg.text()), pg.text().slice(0, 300));
  check("...the deleted one is flagged on the server, emptied", (() => { const r = pps.rows.get(PP_ME.id + "|" + bankId); return r && r.deleted && r.data === ""; })());

  // Offline: changes wait on the device, and go up later.
  pg.api.st.offline = true;
  pg.d.getElementById("addBtn").click();
  pg.d.getElementById("fUrl").value = "offline.example"; pg.d.getElementById("fUser").value = "emm"; pg.d.getElementById("fPass").value = "Off-1";
  pg.submit("addForm");
  await pg.until(() => pg.rows() === 3);
  await pg.pp.sync();
  check("offline, an added login is kept and waits", pg.rows() === 3 && /Offline · 1 change waiting/.test(pg.d.getElementById("syncState").textContent), pg.d.getElementById("syncState").textContent);
  pg.api.st.offline = false;
  await pg.pp.sync();
  await pg2.pp.sync();
  check("...back online, it's uploaded and reaches the other device", /offline\.example/.test(pg2.text()) && /Synced/.test(pg.d.getElementById("syncState").textContent));

  // Reopened with no connection at all: it opens from this device's copy.
  const kept = pg.storageNow();
  pg = await openPP(pps, PP_ME, Object.assign(kept, { "house.auth": "{}" }), { offline: true });
  check("reopened offline: still asks for the master password", pg.visible("gLock"));
  await pg.master("correct horse battery");
  check("...and opens this device's copy", pg.visible("app") && pg.rows() === 3);

  // Forgot it: start again, which empties the vault everywhere.
  pg = await openPP(pps, PP_ME, pg.storageNow());
  pg.d.getElementById("forgotBtn").click();
  await sleep(0);
  pg.d.getElementById("cOk").click();
  await pg.until(() => /Create/.test(pg.d.getElementById("gHeading").textContent));
  check("Forgot it? deletes the vault and its logins on the server, then asks for a new one",
    !pps.vaults.has(PP_ME.id) && ![...pps.rows.keys()].some(k => k.startsWith(PP_ME.id)) && /Create/.test(pg.d.getElementById("gHeading").textContent));
  pg2.d.getElementById("lockBtn").click();
  pg2 = await openPP(pps, PP_ME, pg2.storageNow());
  check("...and the other device, reopened, drops its old copy and asks to create one too", /Create/.test(pg2.d.getElementById("gHeading").textContent)
    && !/Shop|offline/.test(JSON.stringify(Object.values(pg2.storageNow()))));

  console.log("\nPowerPass: Face ID");
  const fsrv = ppServer(), FACE = { id: "33333333-3333-4333-8333-333333333333", email: "face@test.invalid" };
  const phone = { creds: new Map() };
  const dlgOpen = p => p.d.getElementById("confirmDlg").hasAttribute("open");
  const toastText = p => p.d.getElementById("toast").textContent;
  const bioCopy = p => JSON.parse(p.storageNow()["powerpass.cache.v1." + FACE.id] || "{}").bio;
  check("no authenticator: Face ID never shows", !pg.visible("bioBtn") && pg.d.getElementById("bioToggle").classList.contains("hidden"));
  let fp = await openPP(fsrv, FACE, {}, { device: phone });
  check("with one, there's still no Face ID button before it's turned on", fp.visible("gLock") && !fp.visible("bioBtn"));
  await fp.master("face id master pw", "face id master pw");
  await fp.until(() => dlgOpen(fp));
  check("after the master password opens the vault, it offers Face ID", fp.visible("app") && dlgOpen(fp) && /Unlock with/.test(fp.d.getElementById("cTitle").textContent));
  fp.d.getElementById("cOk").click();
  await fp.until(() => /is on for this device/.test(toastText(fp)));
  check("...turned on: a passkey that needs the person (user verification), with PRF", phone.creds.size === 1
    && phone.created.authenticatorSelection.userVerification === "required" && !!phone.created.extensions.prf);
  check("...this device keeps a sealed copy of the vault key, never the password", !!(bioCopy(fp) && bioCopy(fp).data) && !/face id master pw/.test(JSON.stringify(fp.storageNow())));
  check("...and the toolbar shows it's on", fp.visible("bioToggle") && fp.d.getElementById("bioToggle").classList.contains("on"));
  await fp.pp.importText(EXPORT_1P);
  fp.d.getElementById("lockBtn").click();
  check("locked: Unlock with Face ID is offered", fp.visible("gLock") && fp.visible("bioBtn") && fp.rows() === 0);
  phone.cancel = true;
  fp.d.getElementById("bioBtn").click();
  await sleep(50);
  check("cancelling Face ID leaves it locked, quietly, button still there", fp.visible("gLock") && fp.visible("bioBtn") && fp.d.getElementById("lockError").classList.contains("hidden"));
  phone.cancel = false;
  fp.d.getElementById("bioBtn").click();
  await fp.until(() => fp.visible("app"));
  check("Face ID opens the vault, every login there", fp.visible("app") && fp.rows() === 2);
  await fp.pp.sync();

  fp = await openPP(fsrv, FACE, fp.storageNow(), { device: phone });
  check("reopened: Face ID is on the lock screen", fp.visible("bioBtn"));
  fp.d.getElementById("bioBtn").click();
  await fp.until(() => fp.visible("app"));
  check("...and opens it", fp.visible("app") && fp.rows() === 2);
  fp.d.getElementById("lockBtn").click();
  await fp.master("face id master pw");
  await sleep(50);
  check("the master password still works, and Face ID isn't offered again", fp.visible("app") && !dlgOpen(fp));

  const stolen = await openPP(fsrv, FACE, fp.storageNow(), { device: { creds: new Map() } });
  stolen.d.getElementById("bioBtn").click();
  await sleep(100);
  check("this device's storage, copied elsewhere, can't be opened without its passkey", stolen.visible("gLock") && !stolen.visible("app"));

  fp.d.getElementById("bioToggle").click();
  await sleep(0);
  fp.d.getElementById("cOk").click();
  await fp.until(() => /is off/.test(toastText(fp)));
  fp.d.getElementById("lockBtn").click();
  check("turned off from the toolbar: the sealed key is gone, the lock screen asks for the password only", !bioCopy(fp) && fp.visible("gLock") && !fp.visible("bioBtn"));

  const laptop = { creds: new Map() };
  const lp = await openPP(fsrv, FACE, {}, { device: laptop });
  await lp.master("face id master pw");
  await lp.until(() => dlgOpen(lp));
  lp.d.getElementById("cCancel").click();
  lp.d.getElementById("lockBtn").click();
  await lp.master("face id master pw");
  await sleep(50);
  check("Not now: no passkey made, and not asked again on that device", laptop.creds.size === 0 && lp.visible("app") && !dlgOpen(lp));

  const noPrf = { creds: new Map(), prf: false };
  const op = await openPP(fsrv, FACE, {}, { device: noPrf });
  await op.master("face id master pw");
  await op.until(() => dlgOpen(op));
  op.d.getElementById("cOk").click();
  await op.until(() => /can’t unlock/.test(toastText(op)));
  check("a browser without PRF says it can't, and keeps nothing", /can’t unlock/.test(toastText(op)) && !bioCopy(op));
  check("Face ID: no errors", [fp, stolen, lp, op].every(p => p.errors.length === 0), [fp, stolen, lp, op].flatMap(p => p.errors).join("\n"));

  pg = await openPP(ppServer(), PP_ME, {}, { member: false });
  check("an account not on the access list is told so", pg.visible("gNoAccess") && /access list/.test(pg.text()));
  check("no errors in any of it", pg.errors.length === 0 && pg2.errors.length === 0, pg.errors.concat(pg2.errors).join("\n"));

  console.log("\nSigned out");
  const dom = new JSDOM(read("todo.html").replace('<script defer src="cloud.js"></script>', ""), {
    url: "https://house.test/todo.html", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) { w.scrollTo = () => {}; w.eval(CLOUD_SRC); },
  });
  await sleep(20);
  const st = dom.window.HouseCloud.status();
  check("signed out, the app is device-only, as before", st.configured === true && st.user === null && st.joined === false);
  const libs = [...dom.window.document.querySelectorAll("script[src]")].map(s => s.src);
  check("...and the only thing it loads from the internet is the pinned sign-in library", libs.length === 1 && /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\//.test(libs[0]), libs.join());
  check("...the same file sw.js caches for offline", read("sw.js").includes(libs[0]));
  check("no secret key in the app", !/sb_secret_|service_role/.test(CLOUD_SRC));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
