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
                 "todo.theme.v1", "todo.tab.v1", "expenses.tab.v1", "expenses.month.v1", "expenses.group.v1", "house.installHintDismissed.v1"];
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
  check("the Withdrawal tab sits between Expenses and Settings", [...doc.querySelectorAll("[data-tab]")].map(b => b.textContent).join() === "Overview,Expenses,Withdrawal,Settings");
  check("...and opens, with the month switcher", !wd().hidden && !doc.getElementById("monthBar").hidden);
  // A £ one with no rate yet: kept out of the peso total, and said so.
  doc.getElementById("fab").click();
  doc.querySelector('.cur-pick [data-cur="GBP"]').click();
  doc.getElementById("wdAmount").value = "250";
  doc.querySelector('#wdKinds [data-kind="wu"]').click();
  doc.getElementById("wdNote").value = "To Mum";
  doc.getElementById("wdSheet").dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  let stored = page.get("expenses.withdrawals.v1") || [];
  check("+ Add on this tab adds a withdrawal, kept in pence", stored.length === 1 && stored[0].amount === 25000 && stored[0].currency === "GBP" && stored[0].kind === "wu");
  check("without a rate, £ isn't guessed into the total", /₱0\.00/.test(doc.getElementById("wdTotal").textContent) && /£250/.test(doc.getElementById("wdWarn").textContent) && !doc.getElementById("wdWarn").hidden);
  const rateIn = doc.getElementById("rateInput");
  rateIn.value = "76.25"; rateIn.dispatchEvent(new page.w.Event("change"));
  check("setting £1 = ₱76.25 converts it", doc.getElementById("wdTotal").textContent === "₱19,062.50" && doc.getElementById("wdWarn").hidden, doc.getElementById("wdTotal").textContent);
  check("...the row shows both: £250 and ≈ ₱19,062.50", /£250≈ ₱19,062\.50/.test(doc.getElementById("wdList").textContent), doc.getElementById("wdList").textContent);
  // Pesos straight in, then the total adds both.
  doc.getElementById("fab").click();
  check("the next one starts like the last: pounds, Western Union", doc.querySelector('.cur-pick [data-cur="GBP"]').classList.contains("on") && doc.querySelector('#wdKinds [data-kind="wu"]').classList.contains("on"));
  doc.querySelector('.cur-pick [data-cur="PHP"]').click();
  doc.querySelector('#wdKinds [data-kind="atm"]').click();
  doc.getElementById("wdAmount").value = "5,000";
  doc.getElementById("wdSheet").dispatchEvent(new page.w.Event("submit", { cancelable: true, bubbles: true }));
  check("₱ and £ withdrawals add up to one peso total", doc.getElementById("wdTotal").textContent === "₱24,062.50", doc.getElementById("wdTotal").textContent);
  check("by type, in pesos", /Western Union1₱19,062\.50/.test(doc.getElementById("wdTypes").textContent) && /ATM1₱5,000/.test(doc.getElementById("wdTypes").textContent), doc.getElementById("wdTypes").textContent);
  check("withdrawals don't count as spending", !/24,062/.test(doc.getElementById("heroTotal").textContent));
  await page.sync();
  check("withdrawals and the rate are uploaded", [...srv.rows.keys()].filter(k => k.startsWith("expenses.withdrawals.v1|")).length === 2 && srv.rows.get("expenses.settings.v1|_").data.gbpRate === 76.25);
  srv.put("expenses.settings.v1", "_", Object.assign({}, srv.rows.get("expenses.settings.v1|_").data, { gbpRate: 80 }));
  srv.put("expenses.withdrawals.v1", "w9", { id: "w9", date: today(), kind: "bank", note: "Remote transfer", amount: 10000, currency: "GBP", createdAt: 1 });
  await page.sync();
  check("a withdrawal and a new rate from another device arrive and re-total", /Remote transfer/.test(wd().textContent) && doc.getElementById("wdTotal").textContent === "₱33,000.00", doc.getElementById("wdTotal").textContent);
  check("...without disturbing anything else", [...srv.rows.values()].every(r => !r.deleted));

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
