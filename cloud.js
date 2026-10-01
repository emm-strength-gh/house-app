/* House App cloud: accounts + shared sync. Loaded by every page.
 *
 * localStorage stays the working copy: every tool saves to the device first,
 * exactly as before, and works offline. Signed in (and on the access list),
 * syncNow() compares each synced store with `shadow` (what the server last
 * held) and uploads only the differences, one small row per record. A pull
 * applies server rows unless the same record has an unsent change here, so
 * whichever change reaches the server last wins.
 *
 * Everyone on the access list shares ONE set of data. Who is on the list, and
 * that nobody else can read or write, is enforced by the database's row-level
 * security (supabase/schema.sql); this file only decides what to show.
 *
 * Pages need no knowledge of any of this beyond two things:
 *   - their safeWrite() calls HouseCloud.dirty(key) after saving;
 *   - they already reload on a "storage" event (another tab changed the
 *     data). Changes arriving from the cloud are announced the same way.
 */
(function () {
  "use strict";

  // The House App's own Supabase project. Empty = cloud switched off and the
  // app is device-only.
  var CLOUD_URL = "https://nmukdaojabgozomkaeuw.supabase.co";
  // Publishable key: public by design, it only reaches what the rules allow.
  var CLOUD_KEY = "sb_publishable_F5mlTgUuqPFiEW0z_EJsVQ_DdLfjQGA";

  var STORE_CLOUD  = "house.cloud.v1";
  var STORE_BACKUP = "house.preCloudBackup.v1";
  var TABLE = "house_items";
  // Each pull re-reads the last minute too: a slow commit can land "in the past".
  var CURSOR_OVERLAP_MS = 60000;
  var CHUNK = 200;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function lowerName(r) { return r && typeof r.name === "string" ? r.name.trim().toLowerCase() : null; }

  // What syncs. Anything not listed (themes, last-open tab, collapsed groups,
  // the home widget's snapshot) stays per-device.
  //   list     an array of records, each with its own `id`  -> one row each
  //   doc      one settings object                          -> one row, id "_"
  //   ordered  the array's order is the user's, so it syncs too (row "_order")
  //   local    fields of a doc that stay on the device
  //   natural  what makes two records "the same thing" when a device's own
  //            data is first merged in (two phones both seeded the same items)
  //   refs     fields holding ids of another store, re-pointed after such a merge
  // Order matters: a store must come before the stores that refer to it.
  var STORES = {
    "energy.bills.v1":        { kind: "list", natural: function (r) { return r.date || null; } },
    "energy.forecast.v1":     { kind: "doc" },
    "oni.catalog.v1":         { kind: "list", natural: lowerName },
    "oni.orders.v1":          { kind: "list", ordered: true },
    "oni.invoices.v1":        { kind: "list" },
    "oni.settings.v1":        { kind: "doc", local: ["theme"] },
    "grocery.items.v1":       { kind: "list", natural: lowerName },
    "grocery.plan.v1":        { kind: "list", ordered: true, refs: { itemId: "grocery.items.v1" },
                                natural: function (r) { return r.itemId || null; } },
    "grocery.settings.v1":    { kind: "doc", local: ["currency"] },
    "todo.items.v1":          { kind: "list", ordered: true },
    "expenses.categories.v1": { kind: "list", ordered: true },
    "expenses.items.v1":      { kind: "list", refs: { cat: "expenses.categories.v1" } },
    "expenses.settings.v1":   { kind: "doc", local: ["lastCat"] }
  };
  var STORE_KEYS = Object.keys(STORES);

  // ---------------------------------------------------------------- state
  function defaults() {
    return { user: null, member: false, owner: false, joined: false,
             shadow: {}, cursor: "", lastSync: "", lastError: "" };
  }
  var CLOUD = defaults();
  var apiCache = null, syncing = null, syncAgain = false, syncTimer = null, postponed = 0;
  var stopListening = null, listeners = [], started = false, booted = false;

  function loadCloud() {
    var d = defaults();
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_CLOUD) || "null");
      if (saved && typeof saved === "object") Object.keys(d).forEach(function (k) { if (saved[k] !== undefined) d[k] = saved[k]; });
    } catch (e) {}
    CLOUD = d;
  }
  function saveCloud() { try { localStorage.setItem(STORE_CLOUD, JSON.stringify(CLOUD)); } catch (e) {} }
  function changed() {
    saveCloud();
    listeners.forEach(function (fn) { try { fn(status()); } catch (e) {} });
  }
  function status() {
    // configured: the project details are in this file. ready: the library loaded too.
    // booting: still fetching the library, so `ready` can't be judged yet.
    return { configured: !!((CLOUD_URL && CLOUD_KEY) || window.__houseCloud), ready: !!api(), booting: !booted, user: CLOUD.user, member: CLOUD.member, owner: CLOUD.owner, joined: CLOUD.joined,
             lastSync: CLOUD.lastSync, lastError: CLOUD.lastError, syncing: !!syncing };
  }

  // ---------------------------------------------------------------- the Supabase client
  // Behind the handful of calls this file makes. Tests swap in a stand-in with
  // the same shape via window.__houseCloud.
  function api() {
    if (apiCache) return apiCache;
    if (window.__houseCloud) return (apiCache = window.__houseCloud);
    if (!CLOUD_URL || !CLOUD_KEY) return null;
    if (!window.supabase || !window.supabase.createClient) return null;   // library didn't load: stay local
    try {
      apiCache = supabaseApi(window.supabase.createClient(CLOUD_URL, CLOUD_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "house.auth" }
      }));
    } catch (e) { return null; }
    return apiCache;
  }
  function supabaseApi(sb) {
    function data(res) {
      if (res && res.error) throw new Error(res.error.message || "Request failed");
      return res ? res.data : null;
    }
    function who(session) {
      return session && session.user ? { id: session.user.id, email: String(session.user.email || "").toLowerCase() } : null;
    }
    return {
      session: function () { return sb.auth.getSession().then(function (r) { return who(data(r).session); }); },
      onSessionChange: function (fn) { sb.auth.onAuthStateChange(function (ev, s) { fn(who(s), ev); }); },
      sendCode: function (email) {
        return sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(data);
      },
      verifyCode: function (email, code) {
        return sb.auth.verifyOtp({ email: email, token: code, type: "email" }).then(function (r) { return who(data(r).session); });
      },
      signOut: function () { return sb.auth.signOut({ scope: "local" }).then(data); },
      // Every visible row, oldest change first, paged.
      fetch: function (table, o) {
        o = o || {};
        var out = [], PAGE = 1000, by = o.orderBy || "updated_at";
        function page(from) {
          var q = sb.from(table).select("*");
          if (o.since) q = q.gt("updated_at", o.since);
          q = q.order(by, { ascending: true }).range(from, from + PAGE - 1);
          return q.then(data).then(function (rows) {
            rows = rows || [];
            out = out.concat(rows);
            return rows.length === PAGE ? page(from + PAGE) : out;
          });
        }
        return page(0);
      },
      upsert: function (table, rows, onConflict) { return sb.from(table).upsert(rows, { onConflict: onConflict }).then(data); },
      remove: function (table, col, val) { return sb.from(table).delete().eq(col, val).then(data); },
      rpc: function (fn, args) { return sb.rpc(fn, args || {}).then(data); },
      // Any change another device makes, as it happens. The rows themselves
      // are fetched by the next sync; this only says "something changed".
      listen: function (fn) {
        var ch = sb.channel("house-sync");
        [TABLE, "house_members"].forEach(function (t) {
          ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () { fn(t); });
        });
        ch.subscribe();
        return function () { try { sb.removeChannel(ch); } catch (e) {} };
      }
    };
  }

  // ---------------------------------------------------------------- local stores
  // Canonical JSON (sorted keys): the server's jsonb hands keys back in its
  // own order, so a plain stringify would make every record look changed.
  function stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}";
  }
  // cyrb53: 53 bits is plenty to tell "changed" from "same" per record.
  function hash(v) {
    var s = stable(v), h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // null = "this device has never had that store" (or it can't be read):
  // never treated as "everything was deleted".
  function readRaw(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function readList(key) {
    try { var v = JSON.parse(readRaw(key)); return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  function readDoc(key) {
    try { var v = JSON.parse(readRaw(key)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  var announce = [];
  function writeStore(key, value) {
    var s = JSON.stringify(value);
    localStorage.setItem(key, s);
    if (announce.indexOf(key) < 0) announce.push(key);
  }
  // Tell the page its data changed underneath it, the way the browser does
  // when another tab writes: every tool already reloads on this.
  function flushAnnounce() {
    var keys = announce; announce = [];
    keys.forEach(function (key) {
      var ev;
      try { ev = new StorageEvent("storage", { key: key, newValue: readRaw(key), storageArea: localStorage }); }
      catch (e) {
        ev = document.createEvent("Event"); ev.initEvent("storage", false, false);
        try { Object.defineProperty(ev, "key", { value: key }); } catch (e2) {}
      }
      window.dispatchEvent(ev);
    });
  }
  function docBody(key, doc) {
    var skip = STORES[key].local || [], out = {};
    Object.keys(doc).forEach(function (k) { if (skip.indexOf(k) < 0) out[k] = doc[k]; });
    return out;
  }
  function shadowOf(key) { return CLOUD.shadow[key] || (CLOUD.shadow[key] = {}); }
  function idsOf(list) { return list.filter(function (r) { return r && r.id != null; }).map(function (r) { return String(r.id); }); }
  function sortByIds(list, ids) {
    var at = {};
    ids.forEach(function (id, i) { at[id] = i; });
    // Records the saved order doesn't know yet keep their place among themselves, after the rest.
    return list.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      var x = at[String(a.r.id)], y = at[String(b.r.id)];
      if (x == null && y == null) return a.i - b.i;
      if (x == null) return 1;
      if (y == null) return -1;
      return x - y;
    }).map(function (o) { return o.r; });
  }

  // ---------------------------------------------------------------- pull
  // serverWins: the first merge of a device's own data, where the shared copy
  // is the established one. Afterwards an unsent local change is kept instead.
  function applyRows(rows, serverWins) {
    var byStore = {};
    rows.forEach(function (row) {
      if (!STORES[row.store]) return;   // a store this version doesn't know
      (byStore[row.store] = byStore[row.store] || []).push(row);
    });
    Object.keys(byStore).forEach(function (key) {
      var def = STORES[key], sh = shadowOf(key);
      if (def.kind === "doc") {
        byStore[key].forEach(function (row) {
          if (row.id !== "_" || row.deleted) return;
          var sHash = hash(row.data), local = readDoc(key);
          if (sHash === sh._) return;
          var lHash = local ? hash(docBody(key, local)) : null;
          if (serverWins || lHash === (sh._ || null) || lHash === null) {
            if (lHash !== sHash) {
              var next = {}, keep = def.local || [];
              Object.keys(row.data || {}).forEach(function (k) { next[k] = row.data[k]; });
              keep.forEach(function (k) { if (local && local[k] !== undefined) next[k] = local[k]; });
              writeStore(key, next);
            }
          }
          sh._ = sHash;
        });
        return;
      }
      var list = readList(key) || [], touched = false, order = null;
      var index = {};
      list.forEach(function (r, i) { if (r && r.id != null) index[String(r.id)] = i; });
      byStore[key].forEach(function (row) {
        if (row.id === "_order") { order = row; return; }
        var id = String(row.id);
        var sHash = row.deleted ? null : hash(row.data);
        var shHash = sh[id] || null;
        if (sHash === shHash) return;                       // nothing new from the server
        var at = index[id], lHash = at != null ? hash(list[at]) : null;
        if (serverWins || lHash === shHash || lHash === sHash) {
          if (lHash !== sHash) {
            if (sHash === null) { list[at] = null; delete index[id]; }
            else if (at != null) list[at] = row.data;
            else { index[id] = list.length; list.push(row.data); }
            touched = true;
          }
        }
        if (sHash === null) delete sh[id]; else sh[id] = sHash;
      });
      if (touched) list = list.filter(function (r) { return r !== null; });
      if (order && def.ordered && order.data && Array.isArray(order.data.ids)) {
        var oHash = hash(order.data.ids);
        if (oHash !== sh._order) {
          var mine = hash(idsOf(list));
          if (serverWins || mine === (sh._order || null) || touched) {
            var sorted = sortByIds(list, order.data.ids);
            if (hash(idsOf(sorted)) !== hash(idsOf(list))) { list = sorted; touched = true; }
          }
          sh._order = oHash;
        }
      }
      if (touched) writeStore(key, list);
    });
  }

  function cursorSince() {
    if (!CLOUD.cursor) return null;
    return new Date(new Date(CLOUD.cursor).getTime() - CURSOR_OVERLAP_MS).toISOString();
  }
  function advanceCursor(rows) {
    rows.forEach(function (r) { if (r.updated_at && r.updated_at > CLOUD.cursor) CLOUD.cursor = r.updated_at; });
  }
  function pull() {
    return api().fetch(TABLE, { since: cursorSince() }).then(function (rows) {
      applyRows(rows, false);
      advanceCursor(rows);
      saveCloud();
      // Now, in the same tick as the writes, not after the upload: until the
      // page has reloaded, its in-memory copy is stale, and a save from that
      // copy would read as "these records were deleted".
      flushAnnounce();
    });
  }

  // ---------------------------------------------------------------- push
  function localChanges() {
    var rows = [], after = [];
    STORE_KEYS.forEach(function (key) {
      var def = STORES[key], sh = shadowOf(key);
      if (def.kind === "doc") {
        var doc = readDoc(key);
        if (!doc) return;
        var body = docBody(key, doc), h = hash(body);
        if (h !== sh._) { rows.push({ store: key, id: "_", data: body, deleted: false }); after.push(function () { sh._ = h; }); }
        return;
      }
      var list = readList(key);
      if (!list) return;
      var seen = {};
      list.forEach(function (rec) {
        if (!rec || rec.id == null) return;
        var id = String(rec.id), hh = hash(rec);
        seen[id] = true;
        if (hh !== sh[id]) { rows.push({ store: key, id: id, data: rec, deleted: false }); after.push(function () { sh[id] = hh; }); }
      });
      Object.keys(sh).forEach(function (id) {
        if (id === "_order" || seen[id]) return;
        rows.push({ store: key, id: id, data: {}, deleted: true });
        after.push(function () { delete sh[id]; });
      });
      if (def.ordered) {
        var ids = idsOf(list), oh = hash(ids);
        if (oh !== sh._order) { rows.push({ store: key, id: "_order", data: { ids: ids }, deleted: false }); after.push(function () { sh._order = oh; }); }
      }
    });
    return { rows: rows, after: after };
  }
  function push() {
    var ch = localChanges();
    if (!ch.rows.length) return Promise.resolve();
    var chain = Promise.resolve();
    for (var i = 0; i < ch.rows.length; i += CHUNK) {
      (function (part) { chain = chain.then(function () { return api().upsert(TABLE, part, "store,id"); }); })(ch.rows.slice(i, i + CHUNK));
    }
    return chain.then(function () { ch.after.forEach(function (fn) { fn(); }); });
  }

  // ---------------------------------------------------------------- sync
  function canSync() { return !!(api() && CLOUD.user && CLOUD.member && CLOUD.joined); }
  // Mid-typing, a list re-rendering underneath would be jarring; wait a moment.
  function isTyping() {
    var a = document.activeElement, t = a && a.tagName;
    if (t === "TEXTAREA" || t === "SELECT") return true;
    return t === "INPUT" && !/^(checkbox|radio|button|submit|file|range)$/i.test(a.type || "");
  }
  function friendly(e) {
    var m = String((e && e.message) || e || "");
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "Offline: changes are saved here and will sync when you're back online.";
    if (/row-level security|permission denied/i.test(m)) return "This account no longer has access.";
    return m || "Sync failed";
  }
  function syncNow(force) {
    if (!canSync()) return Promise.resolve(false);
    if (syncing) { syncAgain = true; return syncing; }
    if (!force && isTyping() && postponed < 8) { postponed++; schedule(3000); return Promise.resolve(false); }
    postponed = 0;
    syncing = pull().then(push).then(function () {
      CLOUD.lastSync = new Date().toISOString(); CLOUD.lastError = "";
    }, function (e) {
      CLOUD.lastError = friendly(e);
      if (/no longer has access/.test(CLOUD.lastError)) refreshAccess();
    }).then(function () {
      syncing = null;
      changed();
      if (syncAgain) { syncAgain = false; schedule(300); }
      return !CLOUD.lastError;
    });
    changed();
    return syncing;
  }
  function schedule(ms) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(); }, ms == null ? 1200 : ms);
  }
  // Called by each tool's safeWrite().
  function dirty(key) { if (STORES[key] && canSync()) schedule(); }

  // ---------------------------------------------------------------- account
  function refreshAccess() {
    if (!api() || !CLOUD.user) return Promise.resolve(status());
    return api().rpc("house_whoami").then(function (w) {
      CLOUD.member = !!(w && w.member); CLOUD.owner = !!(w && w.owner);
      changed();
      return status();
    }, function () { return status(); });   // offline: keep what we knew
  }
  function setUser(user) {
    var was = CLOUD.user && CLOUD.user.id;
    CLOUD.user = user || null;
    if (!user) { CLOUD.member = false; CLOUD.owner = false; }
    if ((user && user.id) !== was) changed();
  }
  function sendCode(email) {
    email = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return Promise.reject(new Error("Enter your email address"));
    if (!api()) return Promise.reject(new Error("Cloud sync isn't set up yet"));
    return api().sendCode(email);
  }
  function verifyCode(email, code) {
    email = String(email || "").trim().toLowerCase();
    code = String(code || "").replace(/\D/g, "");
    if (code.length < 6) return Promise.reject(new Error("Enter the code from the email"));
    return api().verifyCode(email, code).then(function (user) {
      setUser(user);
      return refreshAccess();
    }).then(function (st) {
      if (st.member && st.joined) { listen(); syncNow(true); }
      return st;
    });
  }
  function signOut() {
    var a = api();
    if (stopListening) { stopListening(); stopListening = null; }
    setUser(null);
    changed();
    return a ? a.signOut().then(function () { return status(); }, function () { return status(); }) : Promise.resolve(status());
  }

  // ---------------------------------------------------------------- joining (first sync on a device)
  function liveCount(rows) {
    return rows.filter(function (r) { return STORES[r.store] && !r.deleted && r.id !== "_order" && r.id !== "_"; }).length;
  }
  function localCount() {
    var n = 0;
    STORE_KEYS.forEach(function (key) { if (STORES[key].kind === "list") n += (readList(key) || []).length; });
    return n;
  }
  // What the account page needs to decide whether to ask "merge or replace?".
  function joinInfo() {
    return api().fetch(TABLE, {}).then(function (rows) {
      return { cloud: liveCount(rows), local: localCount(), rows: rows };
    });
  }
  function backupLocal() {
    var stores = {};
    STORE_KEYS.forEach(function (key) { var raw = readRaw(key); if (raw != null) stores[key] = raw; });
    try { localStorage.setItem(STORE_BACKUP, JSON.stringify({ at: new Date().toISOString(), stores: stores })); } catch (e) {}
  }
  // Two devices each made "the same" record with their own id (both seeded the
  // Oni items, both typed the September bill). Keep the shared one, drop this
  // device's twin, and re-point anything that referred to it.
  function adoptTwins(rows) {
    STORE_KEYS.forEach(function (key) {
      var def = STORES[key];
      if (def.kind !== "list" || !def.natural) return;
      var list = readList(key);
      if (!list || !list.length) return;
      var cloudIds = {}, byNat = {};
      rows.forEach(function (r) {
        if (r.store !== key || r.id === "_order") return;
        cloudIds[r.id] = true;
        if (r.deleted) return;
        var n = def.natural(r.data || {});
        if (n != null && byNat[n] == null) byNat[n] = r.id;
      });
      var map = {}, any = false;
      var kept = list.filter(function (rec) {
        if (!rec || rec.id == null || cloudIds[String(rec.id)]) return true;
        var n = def.natural(rec);
        if (n == null || byNat[n] == null) return true;
        map[String(rec.id)] = byNat[n]; any = true;
        return false;
      });
      if (!any) return;
      writeStore(key, kept);
      STORE_KEYS.forEach(function (other) {
        var refs = STORES[other].refs;
        if (!refs) return;
        var olist = readList(other), hit = false;
        if (!olist) return;
        Object.keys(refs).forEach(function (field) {
          if (refs[field] !== key) return;
          olist.forEach(function (rec) {
            if (rec && map[String(rec[field])] != null) { rec[field] = map[String(rec[field])]; hit = true; }
          });
        });
        if (hit) writeStore(other, olist);
      });
    });
  }
  // mode "merge": this device's data is added to the shared data.
  // mode "cloud": this device's data is replaced by the shared data.
  // Either way the device's own copy is kept in house.preCloudBackup.v1 first.
  function join(mode, rows) {
    backupLocal();
    CLOUD.shadow = {}; CLOUD.cursor = "";
    if (mode === "cloud") {
      STORE_KEYS.forEach(function (key) {
        // An empty list, not a missing key: a tool finding no key at all would
        // seed its starter data and upload it over everyone's.
        if (STORES[key].kind === "list") writeStore(key, []);
      });
    } else {
      adoptTwins(rows);
    }
    applyRows(rows, true);
    advanceCursor(rows);
    CLOUD.joined = true;
    changed();
    flushAnnounce();
    listen();
    return syncNow(true);
  }

  // ---------------------------------------------------------------- people with access
  function members() { return api().fetch("house_members", { orderBy: "created_at" }); }
  function addMember(email, label) {
    email = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return Promise.reject(new Error("Enter an email address"));
    return api().upsert("house_members", [{ email: email, label: String(label || "").trim().slice(0, 80) }], "email");
  }
  function removeMember(email) { return api().remove("house_members", "email", email); }

  // ---------------------------------------------------------------- start
  function listen() {
    if (stopListening || !canSync() || !api().listen) return;
    stopListening = api().listen(function () { schedule(600); });
  }
  // The Supabase library is only fetched once there is a project to talk to,
  // so pages stay dependency-free until then. sw.js caches it for offline use;
  // if it can't load, the app simply stays local for this visit.
  var LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
  function withLibrary(fn) {
    if (window.__houseCloud || !CLOUD_URL || !CLOUD_KEY || window.supabase) { fn(); return; }
    var s = document.createElement("script");
    s.src = LIB; s.onload = fn; s.onerror = fn;
    document.head.appendChild(s);
  }
  function start() {
    if (started) return;
    started = true;
    loadCloud();
    withLibrary(begin);
  }
  function begin() {
    booted = true;
    var a = api();
    if (!a) { changed(); return; }
    a.session().then(function (user) {
      setUser(user);
      if (!user) { changed(); return; }
      return refreshAccess().then(function () { listen(); return syncNow(); });
    }, function () { if (canSync()) { listen(); syncNow(); } });   // offline: carry on with what we knew
    if (a.onSessionChange) a.onSessionChange(function (user, ev) {
      if (ev === "SIGNED_OUT") setUser(null);
      else if (user && (!CLOUD.user || CLOUD.user.id !== user.id)) { setUser(user); refreshAccess(); }
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) schedule(200); });
    window.addEventListener("online", function () { schedule(200); });
    window.addEventListener("focusout", function () { if (localChanges().rows.length) schedule(400); });
    // Another tab (or another House App page) signed in, out or joined.
    window.addEventListener("storage", function (e) {
      if (e.key === STORE_CLOUD && e.storageArea === localStorage && e.isTrusted) { loadCloud(); listeners.forEach(function (fn) { fn(status()); }); }
    });
    setInterval(function () { if (!document.hidden) syncNow(); }, 60000);
  }

  window.HouseCloud = {
    start: start, status: status, onChange: function (fn) { listeners.push(fn); },
    dirty: dirty, syncNow: function () { return syncNow(true); },
    sendCode: sendCode, verifyCode: verifyCode, signOut: signOut, refreshAccess: refreshAccess,
    joinInfo: joinInfo, join: join,
    members: members, addMember: addMember, removeMember: removeMember,
    STORES: STORES
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
