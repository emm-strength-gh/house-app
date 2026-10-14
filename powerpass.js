/* PowerPass: logins from a 1Password export, kept in the cloud and encrypted
 * on the device with a master password.
 *
 * One file, two homes, kept byte-identical (with powerpass.css):
 *   House App        powerpass.html   reuses House App's sign-in (Account page)
 *   PowerPass repo   index.html       signs in by itself (email + code)
 * Both talk to the same Supabase project, so the same account sees the same
 * logins in either. The page says which home it is on <html>:
 *   data-mode         "house" | "standalone"
 *   data-cloud-url    the House App Supabase project URL
 *   data-cloud-key    its publishable key (public by design)
 *   data-auth-key     localStorage key holding the Supabase session
 *   data-cache-key    prefix of this device's encrypted copy
 *
 * What leaves the device is ciphertext only (supabase/schema.sql, the
 * powerpass_* tables): a vault row per person (salt + a check value) and one
 * row per login, each sealed with AES-GCM under a key derived from the master
 * password (PBKDF2-SHA256, 600,000 rounds). The master password and the key
 * stay in this page's memory, gone on Lock, reload or after five minutes in
 * the background. Rows belong to one account: not shared with the household.
 *
 * Face ID (optional, per device; Touch ID or Windows Hello elsewhere): a
 * passkey with the WebAuthn PRF extension hands back the same secret each
 * time the person passes the check. That secret, never stored, seals a copy
 * of the vault key kept with this device's copy. See "Face ID" below.
 *
 * Offline: localStorage holds the same ciphertext as a working copy, so the
 * vault opens and takes changes offline. Changes wait in `pending` and are
 * uploaded later; a pull never overwrites a login with a change still waiting.
 *
 * Tests swap the cloud for a stand-in with the same shape: window.__powerpassCloud.
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const CFG = {
    mode: root.dataset.mode === 'house' ? 'house' : 'standalone',
    url: root.dataset.cloudUrl || '',
    key: root.dataset.cloudKey || '',
    authKey: root.dataset.authKey || 'powerpass.auth',
    cachePrefix: root.dataset.cacheKey || 'powerpass.cache.v1',
  };
  const KDF = 'PBKDF2-SHA256';
  const ITERATIONS = 600000;
  const MIN_LENGTH = 8;
  const MAX_TRIES = 5;            // failed master passwords before a pause
  const PAUSE_SECONDS = 30;
  const RESEND_SECONDS = 30;
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  const CURSOR_OVERLAP_MS = 60000; // each pull re-reads the last minute: a slow commit can land "in the past"
  const CHUNK = 200;
  const CHECK_TEXT = 'powerpass-check-v1';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const $ = id => document.getElementById(id);

  /* ================================================================ model */
  // A Login:
  //   { id, title, label, url, username, password, source: 'import'|'manual', createdAt, updatedAt }

  // The fields that make two logins "identical": duplicates are skipped on import and Add.
  const IDENTITY_FIELDS = ['title', 'label', 'url', 'username', 'password'];

  function uuid() {
    if (crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (_) { /* not a secure context */ }
    }
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function toURL(raw) {
    if (!raw) return null;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (_) { return null; }
  }

  function hostOf(raw) {
    const u = toURL(raw);
    return u ? u.hostname.replace(/^www\./, '') : '';
  }

  function toISO(v) {
    if (typeof v === 'number' && isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString(); // epoch s or ms
    if (typeof v === 'string' && !isNaN(Date.parse(v))) return new Date(v).toISOString();
    return new Date().toISOString();
  }

  // Every text field is trimmed except the password, where spaces can be intentional.
  function createLogin(fields, opts = {}) {
    const str = v => (v == null ? '' : String(v));
    const url = str(fields.url).trim();
    const createdAt = toISO(opts.createdAt);
    return {
      id: opts.id || uuid(),
      title: str(fields.title).trim() || hostOf(url) || 'Untitled',
      label: str(fields.label).trim(),
      url,
      username: str(fields.username).trim(),
      password: str(fields.password),
      source: opts.source || 'manual',
      createdAt,
      updatedAt: opts.updatedAt ? toISO(opts.updatedAt) : createdAt,
    };
  }

  function fingerprint(login) {
    return IDENTITY_FIELDS.map(f => login[f]).join('\u0001');
  }

  // Split `logins` into ones not already present and a skipped count. Duplicates
  // inside `logins` itself are skipped too.
  function dedupe(logins, existing = []) {
    const seen = new Set(existing.map(fingerprint));
    const fresh = [];
    for (const l of logins) {
      const k = fingerprint(l);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(l);
    }
    return { fresh, skipped: logins.length - fresh.length };
  }

  // A Login in 1Password's web-form shape, so exported files load again.
  function toExportRecord(l) {
    const sec = iso => Math.floor(Date.parse(iso) / 1000);
    return {
      uuid: l.id.replace(/-/g, ''),
      updatedAt: sec(l.updatedAt),
      createdAt: sec(l.createdAt),
      locationKey: hostOf(l.url),
      title: l.title,
      location: l.url,
      typeName: 'webforms.WebForm',
      secureContents: {
        URLs: l.url || l.label ? [{ label: l.label, url: l.url }] : [],
        fields: [
          { value: l.username, name: 'username', type: 'T', designation: 'username' },
          { value: l.password, name: 'password', type: 'P', designation: 'password' },
        ],
      },
    };
  }

  function generatePassword(len = 20) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
    const limit = 256 - (256 % chars.length); // reject to avoid modulo bias
    let out = '';
    while (out.length < len) {
      for (const v of crypto.getRandomValues(new Uint8Array(len * 2))) {
        if (v < limit && out.length < len) out += chars[v % chars.length];
      }
    }
    return out;
  }

  /* ================================================================ importer */
  // 1Password export text -> Login[]. Throws if the text can't be parsed at all.

  function parseText(text) {
    text = text.replace(/^﻿/, '').trim();
    try {
      return JSON.parse(text);
    } catch (_) { /* fall through to the lenient formats below */ }

    // Legacy 1PIF: one JSON object per record, separated by ***uuid*** lines.
    const sep = /^\*{3}[^\n]*\*{3}\s*$/m;
    if (sep.test(text)) {
      return text.split(sep).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
    }

    // A pasted fragment: loose objects with trailing commas.
    let t = text.replace(/,\s*$/, '');
    if (!t.startsWith('[')) t = '[' + t + ']';
    t = t.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(t);
  }

  function collect(node, out) {
    if (Array.isArray(node)) {
      for (const n of node) collect(n, out);
    } else if (node && typeof node === 'object') {
      if (node.secureContents && typeof node.secureContents === 'object') {
        const e = fromWebForm(node);
        if (e) out.push(e);
      } else if (node.overview && node.details && typeof node.details === 'object') {
        const e = from1pux(node);
        if (e) out.push(e);
      } else {
        for (const v of Object.values(node)) collect(v, out);
      }
    }
  }

  const firstUrl = list => (Array.isArray(list) ? list.find(u => u && (u.url || u.label)) : null) || {};

  // 1PIF / web-form records: { title, location, secureContents: { URLs, fields } }
  function fromWebForm(o) {
    const sc = o.secureContents;
    const fields = Array.isArray(sc.fields) ? sc.fields.filter(f => f && f.value) : [];
    const u = firstUrl(sc.URLs);
    const username =
      (fields.find(f => f.designation === 'username') ||
       fields.find(f => f.type === 'E' || (f.type === 'T' && /user|email|login/i.test(f.name || ''))) ||
       {}).value || '';
    const password =
      (fields.find(f => f.designation === 'password') ||
       fields.find(f => f.type === 'P') ||
       {}).value || sc.password || '';
    return build(o.title, u.label, u.url || sc.URL || o.location, username, password, o.createdAt, o.updatedAt);
  }

  // 1PUX export.data items: { overview: { title, urls }, details: { loginFields } }
  function from1pux(o) {
    const fields = Array.isArray(o.details.loginFields) ? o.details.loginFields.filter(f => f && f.value) : [];
    const u = firstUrl(o.overview.urls);
    const username = (fields.find(f => f.designation === 'username') || {}).value || '';
    const password = (fields.find(f => f.designation === 'password') || {}).value || o.details.password || '';
    return build(o.overview.title, u.label, u.url || o.overview.url, username, password, o.createdAt, o.updatedAt);
  }

  function build(title, label, url, username, password, createdAt, updatedAt) {
    if (!username && !password) return null; // notes, cards, etc.
    return createLogin({ title, label, url, username, password }, { source: 'import', createdAt, updatedAt });
  }

  function parseExport(text) {
    const out = [];
    collect(parseText(text), out);
    return out;
  }

  /* ================================================================ crypto */

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const b64 = {
    encode(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); },
    decode: str => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
  };

  function subtle() {
    if (!window.crypto || !crypto.subtle) {
      throw new Error('This browser blocks secure cryptography on this page. Open PowerPass over https.');
    }
    return crypto.subtle;
  }

  // Extractable so Face ID can seal a copy of it. No weaker: while unlocked it
  // sits in this page's memory, which can decrypt every login anyway.
  async function deriveKey(password, vault) {
    const base = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64.decode(vault.salt), iterations: vault.iterations },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  // `aad` ties a ciphertext to its place (e.g. its row id), so rows can't be swapped around.
  async function seal(key, text, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(text));
    return { iv: b64.encode(iv), data: b64.encode(new Uint8Array(ct)) };
  }
  async function unseal(key, box, aad) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64.decode(box.iv), additionalData: encoder.encode(aad) }, key, b64.decode(box.data));
    return decoder.decode(pt);
  }
  const itemAad = id => 'login:' + id;

  /* ================================================================ Face ID */
  // A passkey on this device (Face ID, Touch ID, Windows Hello) whose PRF
  // extension returns 32 secret bytes for a given salt, only after the person
  // passes the check. HKDF turns them into a key that seals the vault key; the
  // sealed copy is `cache.bio`, bound to this account and vault. The device
  // never holds anything that opens the vault on its own, and the copy goes
  // when the vault is reset, on sign-out, or when turned off.
  //   cache.bio = { cred, salt, iv, data }   (base64)

  const isCancel = e => !!e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
  const bioAad = () => 'bio:' + me.id + ':' + cache.vault.check_data;

  // A user-verifying authenticator built into this device, and PRF unless the
  // browser says outright it has none (older ones can't say; creating tells).
  async function bioAvailable() {
    const PKC = window.PublicKeyCredential;
    if (!PKC || !navigator.credentials || !PKC.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    try {
      if (PKC.getClientCapabilities) {
        const caps = await PKC.getClientCapabilities();
        if (caps && caps['extension:prf'] === false) return false;
      }
      return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (_) { return false; }
  }

  function bioName() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'Face ID';
    if (/Macintosh/.test(ua)) return 'Touch ID';
    if (/Windows/.test(ua)) return 'Windows Hello';
    return 'fingerprint or face';
  }

  async function bioWrapKey(secret) {
    const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('powerpass-bio-v1') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Asks for Face ID and returns the passkey's secret for `salt`.
  async function bioSecret(credId, salt) {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    } });
    const r = (a.getClientExtensionResults().prf || {}).results;
    if (!r || !r.first) throw Object.assign(new Error('No PRF result'), { code: 'unsupported' });
    return new Uint8Array(r.first);
  }

  // Makes the passkey and seals `key` (the vault key) with its secret.
  async function bioCreate(key) {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'PowerPass' },
      // Per home: both share this site, and one handle would replace the other's passkey.
      user: { id: encoder.encode(CFG.mode + ':' + me.id), name: me.email || 'PowerPass',
              displayName: CFG.mode === 'house' ? 'PowerPass (House App)' : 'PowerPass' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    } });
    const credId = new Uint8Array(cred.rawId);
    const prf = cred.getClientExtensionResults().prf || {};
    let secret = prf.results && prf.results.first ? new Uint8Array(prf.results.first) : null;
    if (!secret && !prf.enabled) throw Object.assign(new Error('No PRF'), { code: 'unsupported' });
    // Some browsers only give the secret on use, not on creation: a second check.
    if (!secret) secret = await bioSecret(credId, salt);
    const raw = new Uint8Array(await subtle().exportKey('raw', key));
    const box = await seal(await bioWrapKey(secret), b64.encode(raw), bioAad());
    return { cred: b64.encode(credId), salt: b64.encode(salt), iv: box.iv, data: box.data };
  }

  // Face ID -> the vault key, checked against the vault like a master password.
  async function bioOpen(b) {
    const secret = await bioSecret(b64.decode(b.cred), b64.decode(b.salt));
    const raw = b64.decode(await unseal(await bioWrapKey(secret), b, bioAad()));
    const key = await subtle().importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
    if (await unseal(key, { iv: cache.vault.check_iv, data: cache.vault.check_data }, 'check') !== CHECK_TEXT) {
      throw new Error('Not this vault’s key');
    }
    return key;
  }

  /* ================================================================ cloud */

  let apiCache = null;
  function api() {
    if (apiCache) return apiCache;
    if (window.__powerpassCloud) return (apiCache = window.__powerpassCloud);
    if (!window.supabase || !window.supabase.createClient || !CFG.url || !CFG.key) {
      throw new Error('The cloud library didn’t load. Check your connection and reload.');
    }
    // Same options (and session key) as House App's cloud.js, so in House App the session is shared.
    const sb = window.supabase.createClient(CFG.url, CFG.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: CFG.authKey },
    });
    return (apiCache = supabaseApi(sb));
  }

  function supabaseApi(sb) {
    const data = res => {
      if (res && res.error) throw res.error instanceof Error ? res.error : new Error(res.error.message || 'Request failed');
      return res ? res.data : null;
    };
    const who = s => (s && s.user ? { id: s.user.id, email: String(s.user.email || '').toLowerCase() } : null);
    const COLS = 'id,iv,data,deleted,updated_at';
    return {
      session: () => sb.auth.getSession().then(r => who(data(r).session)),
      sendCode: email => sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }).then(data),
      verifyCode: (email, code) => sb.auth.verifyOtp({ email, token: code, type: 'email' }).then(r => who(data(r).session)),
      signOut: () => sb.auth.signOut({ scope: 'local' }).then(data),
      whoami: () => sb.rpc('house_whoami').then(data),
      getVault: () => sb.from('powerpass_vaults').select('kdf,iterations,salt,check_iv,check_data').maybeSingle().then(data),
      createVault: vault => sb.from('powerpass_vaults').insert(vault).then(data),
      // Logins first: a vault left without them is harmless, logins without their vault are not.
      eraseVault: userId => sb.from('powerpass_items').delete().eq('user_id', userId).then(data)
        .then(() => sb.from('powerpass_vaults').delete().eq('user_id', userId).then(data)),
      // Every row changed after `since` (all of them without), oldest change first, paged.
      fetchItems(since) {
        const out = [], PAGE = 1000;
        const page = from => {
          let q = sb.from('powerpass_items').select(COLS);
          if (since) q = q.gt('updated_at', since);
          return q.order('updated_at', { ascending: true }).range(from, from + PAGE - 1).then(data).then(rows => {
            rows = rows || [];
            out.push(...rows);
            return rows.length === PAGE ? page(from + PAGE) : out;
          });
        };
        return page(0);
      },
      upsertItems: rows => sb.from('powerpass_items').upsert(rows, { onConflict: 'user_id,id' }).then(data),
    };
  }

  const isNetworkError = e => /Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(String((e && e.message) || e));
  function friendly(e) {
    const m = String((e && e.message) || e || '');
    if (isNetworkError(e)) return 'Offline';
    if (/row-level security|permission denied/i.test(m)) return 'This account no longer has access';
    if (/JWT|refresh token|not authenticated/i.test(m)) return 'Signed out: sign in again to sync';
    return m || 'Sync failed';
  }

  /* ================================================================ this device's copy */
  // { user, member, vault, rows: { id: { iv, data, deleted } }, pending: { id: 1 }, cursor, lastSync, lastError, bio, bioAsked }
  // Ciphertext only, like the server. One per account, so two people on one
  // device never see each other's.

  const cacheKey = id => CFG.cachePrefix + '.' + id;
  const lastUserKey = () => CFG.cachePrefix + '.user';

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function emptyCache(user) {
    return { user, member: false, vault: null, rows: {}, pending: {}, cursor: '', lastSync: '', lastError: '', bio: null, bioAsked: false };
  }
  function loadCache(user) {
    const c = readJson(cacheKey(user.id));
    if (!c || typeof c !== 'object' || !c.rows) return emptyCache(user);
    return Object.assign(emptyCache(user), c, { user });
  }
  function saveCache() {
    if (!cache) return true;
    const ok = writeJson(cacheKey(cache.user.id), cache);
    if (!ok) toast('This device is out of storage: changes can’t be kept offline', { error: true, ms: 4000 });
    return ok;
  }
  const sameVault = (a, b) => !!a && !!b && a.salt === b.salt && a.check_data === b.check_data;
  // Signed out for good: drop every encrypted copy this page made on this device.
  function forgetDevice() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(CFG.cachePrefix + '.') === 0) localStorage.removeItem(k);
      }
    } catch (_) { /* storage blocked: nothing kept anyway */ }
  }
  function hasStoredSession() {
    try { return localStorage.getItem(CFG.authKey) != null; } catch (_) { return false; }
  }

  /* ================================================================ state */

  let me = null;         // { id, email }
  let cache = null;      // see above
  let vaultKey = null;   // CryptoKey while unlocked; never stored
  let items = new Map(); // id -> Login, decrypted, while unlocked
  let hiddenAt = 0;
  let bioOk = false;     // this device can do Face ID with PRF, as far as it can tell
  const state = {
    revealed: new Set(),
    query: '',
    flashId: null,
    sync: 'idle',       // idle | syncing | ok | offline | error
  };

  /* ================================================================ helpers (UI) */

  const ICONS = {
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>',
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>',
    external: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    dice: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
    face: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5V13h-1"/><path d="M9.5 16a4 4 0 0 0 5 0"/></svg>',
    alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function hue(s) {
    let h = 0;
    for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return h % 360;
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconBtn(icon, title, extra) {
    const b = el('button', 'icon-btn' + (extra ? ' ' + extra : ''));
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = ICONS[icon];
    return b;
  }
  function avatar(title) {
    const av = el('div', 'avatar', (title.trim()[0] || '?').toUpperCase());
    av.style.setProperty('--h', hue(title.toLowerCase()));
    av.setAttribute('aria-hidden', 'true');
    return av;
  }

  let toastTimer;
  function toast(msg, { error = false, ms = 1800 } = {}) {
    const t = $('toast');
    t.innerHTML = error ? ICONS.alert : ICONS.check;
    t.append(' ' + msg);
    t.classList.toggle('error', error);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function copy(text, what, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = el('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(what + ' copied');
    btn.innerHTML = ICONS.check;
    btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = ICONS.copy; btn.classList.remove('done'); }, 1200);
  }

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }
  function setError(id, msg) {
    const n = $(id);
    n.textContent = msg || '';
    n.classList.toggle('hidden', !msg);
  }

  /* ================================================================ screens */
  // The gate (one centred card) shows one step at a time; the app shows once unlocked.

  const STEPS = ['gLoading', 'gHouse', 'gEmail', 'gCode', 'gNoAccess', 'gOffline', 'gLock'];
  function showStep(step) {
    for (const id of STEPS) { const n = $(id); if (n) n.classList.toggle('hidden', id !== step); }
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    let focus = { gEmail: 'email', gCode: 'code', gLock: 'pw' }[step];
    if (step === 'gLock' && !$('bioBtn').classList.contains('hidden')) focus = 'bioBtn'; // no keyboard popping up
    if (focus) setTimeout(() => $(focus) && $(focus).focus(), 30);
  }
  function setGateText(heading, lead) {
    $('gHeading').textContent = heading;
    $('gLead').textContent = lead || '';
    $('gLead').classList.toggle('hidden', !lead);
  }
  const whoText = () => (me && me.email ? me.email : 'this account');

  function showLoading() {
    setGateText('PowerPass', '');
    showStep('gLoading');
  }
  function showSignIn() {
    if (CFG.mode === 'house') {
      setGateText('PowerPass', 'Sign in to House App to use PowerPass. Your logins are kept in the cloud, encrypted with a master password only you know.');
      return showStep('gHouse');
    }
    setGateText('PowerPass', 'Enter your email and we’ll send you a sign-in code.');
    showStep('gEmail');
  }
  function showNoAccess() {
    setGateText('No access', `${whoText()} isn’t on the House App access list, so it can’t keep logins here. Ask the owner to add it.`);
    showStep('gNoAccess');
  }
  function showOffline(msg) {
    setGateText('Can’t reach your vault', msg || 'Connect to the internet to open PowerPass on this device for the first time. After that it works offline too.');
    showStep('gOffline');
  }

  /* ---------------------------------------------------------------- sign-in (standalone) */

  let signInEmail = '';
  let resendTimer = null;

  function startResendCountdown() {
    const btn = $('resendBtn');
    let left = RESEND_SECONDS;
    clearInterval(resendTimer);
    btn.disabled = true;
    btn.textContent = `Resend code (${left}s)`;
    resendTimer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        btn.textContent = `Resend code (${left}s)`;
      } else {
        clearInterval(resendTimer);
        btn.disabled = false;
        btn.textContent = 'Resend code';
      }
    }, 1000);
  }

  async function sendCode() {
    await api().sendCode(signInEmail);
    $('sentTo').textContent = signInEmail;
    $('code').value = '';
    setError('codeError', '');
    setGateText('PowerPass', '');
    showStep('gCode');
    startResendCountdown();
  }

  async function submitEmail(e) {
    e.preventDefault();
    signInEmail = $('email').value.trim().toLowerCase();
    if (!EMAIL_RE.test(signInEmail)) return setError('emailError', 'Enter a valid email address.');
    setError('emailError', '');
    setBusy($('sendBtn'), true);
    try {
      await sendCode();
    } catch (err) {
      setError('emailError', 'Couldn’t send the code: ' + friendlyAuth(err));
    } finally {
      setBusy($('sendBtn'), false);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    const code = $('code').value.replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(code)) return setError('codeError', 'Enter the code from the email.');
    setBusy($('verifyBtn'), true);
    let user;
    try {
      user = await api().verifyCode(signInEmail, code);
    } catch (err) {
      setBusy($('verifyBtn'), false);
      return setError('codeError', isNetworkError(err) ? 'You’re offline. Try again when you’re connected.' : 'That code didn’t work. Check it, or request a new one.');
    }
    setBusy($('verifyBtn'), false);
    clearInterval(resendTimer);
    await enter(user, false);
  }
  const friendlyAuth = err => (isNetworkError(err) ? 'you’re offline.' : String((err && err.message) || err));

  async function signOut() {
    lock(false);
    try { await api().signOut(); } catch (_) { /* still forget this device */ }
    forgetDevice();
    me = null; cache = null;
    showSignIn();
  }

  /* ---------------------------------------------------------------- boot + enter */

  async function boot() {
    bindEvents();
    showLoading();
    try { subtle(); } catch (err) { return showOffline(err.message); }

    let user = null, offline = false;
    const bioCheck = bioAvailable();
    try {
      user = await api().session();
    } catch (err) {
      offline = true;
    }
    bioOk = await bioCheck;
    // Offline with an expired token can come back empty: use the last account
    // here while its session is still stored, and sync once it can refresh.
    if (!user && hasStoredSession()) {
      const last = readJson(lastUserKey());
      if (last && last.id) { user = last; offline = true; }
    }
    if (!user) { forgetDevice(); return showSignIn(); }
    await enter(user, offline);
  }

  async function enter(user, offline) {
    me = user;
    writeJson(lastUserKey(), { id: user.id, email: user.email });
    cache = loadCache(user);
    showLoading();

    if (!offline) {
      try {
        const w = await api().whoami();
        cache.member = !!(w && w.member);
        if (!cache.member) { saveCache(); return showNoAccess(); }
        const vault = await api().getVault();
        // A different (or no) vault on the server: it was reset elsewhere, so
        // what this device holds is under the old key. Start from the server's.
        if (!sameVault(vault, cache.vault)) {
          cache = emptyCache(user);
          cache.member = true;
          cache.vault = vault || null;
        }
        saveCache();
      } catch (err) {
        if (!isNetworkError(err) && !cache.vault) return showOffline('Couldn’t open your vault: ' + friendly(err));
        offline = true;
      }
    }
    if (!cache.vault) return offline ? showOffline() : showLock('create');
    showLock('unlock');
  }

  /* ---------------------------------------------------------------- master password */

  let lockMode = 'unlock'; // 'unlock' | 'create'
  let failures = 0;

  function setLockError(msg) {
    setError('lockError', msg);
    $('pwBox').classList.toggle('invalid', !!msg);
  }
  function setLockBusy(busy) {
    setBusy($('unlockBtn'), busy);
    $('pw').disabled = busy;
    $('pwConfirm').disabled = busy;
  }
  function shake() {
    const card = $('gateCard');
    card.classList.remove('shake');
    void card.offsetWidth; // restart the animation
    card.classList.add('shake');
  }
  function setReveal(show) {
    for (const id of ['pw', 'pwConfirm']) $(id).type = show ? 'text' : 'password';
    const b = $('pwReveal');
    b.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
    b.title = show ? 'Hide password' : 'Show password';
    b.setAttribute('aria-label', b.title);
  }

  function showLock(mode) {
    lockMode = mode;
    const creating = mode === 'create';
    setGateText(creating ? 'Create a master password' : 'Master password',
      creating
        ? 'It encrypts your logins on this device before they’re saved, so only you can read them. It can’t be recovered, so pick one you’ll remember.'
        : 'Enter your master password to unlock PowerPass.');
    $('pwLabel').textContent = creating ? 'New master password' : 'Master password';
    $('pw').autocomplete = creating ? 'new-password' : 'current-password';
    $('pw').value = '';
    $('pwConfirm').value = '';
    $('confirmRow').classList.toggle('hidden', !creating);
    $('createHint').classList.toggle('hidden', !creating);
    $('createHint').textContent = `At least ${MIN_LENGTH} characters. A short sentence works well.`;
    $('unlockLabel').textContent = creating ? 'Create and unlock' : 'Unlock';
    $('forgotBtn').classList.toggle('hidden', creating);
    $('lockWho').textContent = me ? me.email : '';
    const bio = !creating && bioOk && !!(cache && cache.bio);
    $('bioBtn').classList.toggle('hidden', !bio);
    $('bioLabel').textContent = 'Unlock with ' + bioName();
    setBusy($('bioBtn'), false);
    setReveal(false);
    setLockError('');
    setLockBusy(false);
    showStep('gLock');
  }

  function pause(seconds) {
    let left = seconds;
    setLockBusy(true);
    $('unlockBtn').classList.remove('busy');
    const tick = () => {
      if (left <= 0) {
        clearInterval(timer);
        setLockBusy(false);
        setLockError('');
        $('pw').focus();
        return;
      }
      setLockError(`Too many attempts. Try again in ${left}s.`);
      left -= 1;
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  async function submitLock(e) {
    e.preventDefault();
    if ($('unlockBtn').disabled) return;
    setLockError('');
    setLockBusy(true);
    const pw = $('pw').value;
    try {
      if (lockMode === 'create') await submitCreate(pw);
      else await submitUnlock(pw);
    } catch (err) {
      setLockBusy(false);
      setLockError(err.message);
    }
  }

  async function submitUnlock(pw) {
    if (!pw) { setLockBusy(false); return setLockError('Enter your master password.'); }
    const key = await deriveKey(pw, cache.vault);
    let ok = false;
    try {
      ok = (await unseal(key, { iv: cache.vault.check_iv, data: cache.vault.check_data }, 'check')) === CHECK_TEXT;
    } catch (_) { /* wrong key: the check doesn't decrypt */ }
    if (ok) {
      failures = 0;
      await openVault(key);
      return offerBio();
    }
    failures += 1;
    setLockBusy(false);
    $('pw').value = '';
    shake();
    if (failures >= MAX_TRIES) {
      failures = 0;
      return pause(PAUSE_SECONDS);
    }
    setLockError('That master password isn’t right.');
    $('pw').focus();
  }

  async function submitCreate(pw) {
    if (pw.length < MIN_LENGTH) { setLockBusy(false); return setLockError(`Use at least ${MIN_LENGTH} characters.`); }
    if (pw !== $('pwConfirm').value) { setLockBusy(false); return setLockError('The two passwords don’t match.'); }
    const vault = { kdf: KDF, iterations: ITERATIONS, salt: b64.encode(crypto.getRandomValues(new Uint8Array(16))) };
    const key = await deriveKey(pw, vault);
    const box = await seal(key, CHECK_TEXT, 'check');
    vault.check_iv = box.iv;
    vault.check_data = box.data;
    try {
      await api().createVault(Object.assign({ user_id: me.id }, vault));
    } catch (err) {
      setLockBusy(false);
      if (isNetworkError(err)) return setLockError('You’re offline. Creating a master password needs the internet once.');
      // Most likely set on another device a moment ago: use that one.
      const existing = await api().getVault().catch(() => null);
      if (existing) {
        cache.vault = existing; saveCache();
        showLock('unlock');
        return setLockError('A master password was already set for this account. Enter it to unlock.');
      }
      return setLockError('Couldn’t save your master password: ' + friendly(err));
    }
    cache.vault = vault;
    saveCache();
    await openVault(key);
    return offerBio();
  }

  async function forgot() {
    const ok = await confirmDialog({
      title: 'Start again with a new master password?',
      text: 'Without the master password nobody can decrypt your logins, so this deletes all of them, on every device, for good.',
      details: [el('p', 'fine', 'If you have an exported file, you can load it again afterwards.')],
      confirmLabel: 'Delete my logins',
    });
    if (!ok) return;
    try {
      await api().eraseVault(me.id);
    } catch (err) {
      return setLockError(isNetworkError(err) ? 'You’re offline. Try again when you’re connected.' : 'Couldn’t delete: ' + friendly(err));
    }
    cache = emptyCache(me);
    cache.member = true;
    saveCache();
    showLock('create');
  }

  async function unlockWithBio() {
    if (!cache || !cache.bio || $('bioBtn').disabled) return;
    const name = bioName();
    setLockError('');
    setBusy($('bioBtn'), true);
    let key;
    try {
      key = await bioOpen(cache.bio);
    } catch (err) {
      setBusy($('bioBtn'), false);
      if (isCancel(err)) return; // cancelled, or the passkey is gone: the master password still works
      cache.bio = null;
      saveCache();
      $('bioBtn').classList.add('hidden');
      return setLockError(`${name} couldn’t unlock PowerPass on this device. Use your master password, then turn ${name} on again.`);
    }
    failures = 0;
    setBusy($('bioBtn'), false);
    return openVault(key);
  }

  /* ---------------------------------------------------------------- Face ID on this device */

  // Asked once per device, right after the master password opens the vault.
  async function offerBio() {
    if (!bioOk || !cache || cache.bio || cache.bioAsked || !vaultKey) return;
    const name = bioName(), mine = cache;
    const yes = await confirmDialog({
      title: `Unlock with ${name}?`,
      text: `Open PowerPass on this device with ${name} instead of typing your master password.`,
      details: [el('p', 'fine', 'Your master password still works, and other devices still need it. You can turn this off from the toolbar.')],
      confirmLabel: 'Use ' + name, cancelLabel: 'Not now', icon: 'face', danger: false,
    });
    if (cache !== mine) return; // signed out meanwhile
    cache.bioAsked = true;
    saveCache();
    if (yes && vaultKey) await enableBio();
  }

  async function enableBio() {
    const name = bioName(), mine = cache, key = vaultKey;
    if (!key) return;
    try {
      const bio = await bioCreate(key);
      if (cache !== mine || vaultKey !== key) return; // locked or signed out meanwhile
      cache.bio = bio;
      cache.bioAsked = true;
      saveCache();
      paintBio();
      toast(`${name} is on for this device`);
    } catch (err) {
      if (isCancel(err)) return;
      toast(err && err.code === 'unsupported'
        ? `This browser can’t unlock PowerPass with ${name} yet`
        : `Couldn’t turn on ${name}: ${(err && err.message) || err}`, { error: true, ms: 4000 });
    }
  }

  async function toggleBio() {
    if (!cache || !vaultKey) return;
    if (!cache.bio) return enableBio();
    const name = bioName();
    const ok = await confirmDialog({
      title: `Turn off ${name}?`,
      text: 'PowerPass will ask for your master password on this device again.',
      details: [el('p', 'fine', 'To remove the passkey too, delete “PowerPass” from this device’s saved passwords.')],
      confirmLabel: 'Turn off', icon: 'face', danger: false,
    });
    if (!ok || !cache) return;
    cache.bio = null;
    saveCache();
    paintBio();
    toast(`${name} is off for this device`);
  }

  function paintBio() {
    const b = $('bioToggle');
    const on = !!(cache && cache.bio);
    b.classList.toggle('hidden', !bioOk);
    b.classList.toggle('on', on);
    b.title = on ? `${bioName()} is on: tap to turn off` : `Unlock with ${bioName()}`;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(on));
  }

  /* ---------------------------------------------------------------- unlocked */

  async function decryptAll() {
    const next = new Map();
    let bad = 0;
    for (const [id, row] of Object.entries(cache.rows)) {
      if (row.deleted) continue;
      try { next.set(id, JSON.parse(await unseal(vaultKey, row, itemAad(id)))); } catch (_) { bad++; }
    }
    items = next;
    return bad;
  }

  async function openVault(key) {
    vaultKey = key;
    const bad = await decryptAll();
    state.revealed = new Set();
    state.query = '';
    $('search').value = '';
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('pw').value = '';
    $('pwConfirm').value = '';
    setLockBusy(false);
    render();
    if (bad) toast(`${plural(bad, 'login')} couldn’t be decrypted`, { error: true, ms: 4000 });
    sync();
  }

  // Forget the key and everything decrypted. `show` false when leaving for sign-in.
  function lock(show = true) {
    vaultKey = null;
    items = new Map();
    state.revealed = new Set();
    $('list').replaceChildren();
    clearTimeout(syncTimer);
    if (show && cache && cache.vault) showLock('unlock');
  }

  /* ---------------------------------------------------------------- changes */

  async function putLogins(logins) {
    const key = vaultKey;
    for (const l of logins) {
      const box = await seal(key, JSON.stringify(l), itemAad(l.id));
      if (vaultKey !== key) return; // locked meanwhile
      cache.rows[l.id] = { iv: box.iv, data: box.data, deleted: false };
      cache.pending[l.id] = 1;
      items.set(l.id, l);
    }
    saveCache();
    syncSoon();
  }

  function removeLogin(id) {
    cache.rows[id] = { iv: '', data: '', deleted: true };
    cache.pending[id] = 1;
    items.delete(id);
    saveCache();
    syncSoon();
  }

  /* ---------------------------------------------------------------- sync */

  let syncing = null, syncAgain = false, syncTimer = null;

  function syncSoon(ms = 800) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, ms);
  }

  function sync() {
    if (!vaultKey || !cache) return Promise.resolve(false);
    if (syncing) { syncAgain = true; return syncing; }
    const mine = cache;
    paintSync('syncing');
    syncing = pull(mine).then(() => push(mine)).then(() => {
      mine.lastSync = new Date().toISOString();
      mine.lastError = '';
    }, err => {
      mine.lastError = friendly(err);
    }).then(() => {
      syncing = null;
      if (mine !== cache) return false; // signed out or reset meanwhile
      saveCache();
      paintSync();
      if (syncAgain) { syncAgain = false; syncSoon(300); }
      return !mine.lastError;
    });
    return syncing;
  }

  async function pull(c) {
    const since = c.cursor ? new Date(Date.parse(c.cursor) - CURSOR_OVERLAP_MS).toISOString() : null;
    const rows = await api().fetchItems(since);
    const key = vaultKey;
    let changed = false;
    for (const r of rows) {
      if (r.updated_at && r.updated_at > c.cursor) c.cursor = r.updated_at;
      if (c.pending[r.id]) continue; // a change made here is still waiting: it wins
      const had = c.rows[r.id];
      if (had && had.iv === r.iv && had.data === r.data && !!had.deleted === !!r.deleted) continue;
      c.rows[r.id] = { iv: r.iv, data: r.data, deleted: !!r.deleted };
      if (r.deleted) {
        if (items.delete(r.id)) changed = true;
        continue;
      }
      try {
        const login = JSON.parse(await unseal(key, r, itemAad(r.id)));
        if (vaultKey !== key) return;
        items.set(r.id, login);
        changed = true;
      } catch (_) { /* not sealed with this key; leave it */ }
    }
    if (changed && vaultKey && c === cache) render();
  }

  async function push(c) {
    const sent = Object.keys(c.pending).map(id => ({ id, row: c.rows[id] })).filter(s => s.row);
    for (let i = 0; i < sent.length; i += CHUNK) {
      await api().upsertItems(sent.slice(i, i + CHUNK).map(s => ({
        user_id: c.user.id, id: s.id, iv: s.row.iv, data: s.row.data, deleted: !!s.row.deleted,
      })));
    }
    // Changed again while uploading: still waiting.
    for (const s of sent) if (c.rows[s.id] === s.row) delete c.pending[s.id];
  }

  function paintSync(now) {
    const n = $('syncState');
    if (!cache) return;
    const waiting = Object.keys(cache.pending).length;
    let text, cls = '';
    if (now === 'syncing') {
      text = 'Syncing…';
    } else if (cache.lastError === 'Offline') {
      text = waiting ? `Offline · ${plural(waiting, 'change')} waiting` : 'Offline';
      cls = 'warn';
    } else if (cache.lastError) {
      text = cache.lastError;
      cls = 'warn';
    } else if (cache.lastSync) {
      text = 'Synced';
      cls = 'ok';
    } else {
      text = 'Not synced yet';
    }
    n.textContent = text;
    n.className = 'sync ' + cls;
    n.title = cache.lastSync ? 'Last synced ' + new Date(cache.lastSync).toLocaleString() : '';
  }

  /* ================================================================ the list */

  function sortedItems() {
    return [...items.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }

  function confirmDialog({ title, text, details, confirmLabel, cancelLabel = 'Cancel', icon = 'warn', danger = true }) {
    const dlg = $('confirmDlg');
    $('cIcon').innerHTML = ICONS[icon];
    $('cIcon').classList.toggle('danger', danger);
    $('cTitle').textContent = title;
    $('cText').textContent = text;
    $('cDetails').replaceChildren(...(details || []));
    $('cOk').textContent = confirmLabel;
    $('cOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    $('cCancel').textContent = cancelLabel;
    return new Promise(resolve => {
      const done = ok => {
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(ok);
      };
      const onClose = () => done(false);
      $('cOk').onclick = () => done(true);
      $('cCancel').onclick = () => done(false);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      $('cCancel').focus(); // safe default
    });
  }

  function render() {
    const all = sortedItems();
    const empty = !all.length;
    $('empty').classList.toggle('hidden', !empty);
    $('results').classList.toggle('hidden', empty);
    $('searchBox').classList.toggle('hidden', empty);
    $('openBtn2').classList.toggle('hidden', empty);
    paintSync();
    paintBio();
    if (empty) { $('list').replaceChildren(); return; }

    const list = $('list');
    const q = state.query.trim().toLowerCase();
    const shown = q
      ? all.filter(it => [it.title, it.label, it.url, it.username].some(v => v.toLowerCase().includes(q)))
      : all;

    $('count').textContent = q ? `${shown.length} of ${all.length}` : all.length;
    $('countLabel').textContent = all.length === 1 ? 'login' : 'logins';

    const frag = document.createDocumentFragment();
    const head = el('div', 'row head');
    head.append(el('div', null, 'Website'), el('div', null, 'Username'), el('div', null, 'Password'), el('div'));
    frag.append(head);

    if (!shown.length) frag.append(el('div', 'no-results', 'No logins match “' + state.query.trim() + '”'));

    let flashRow = null;
    for (const it of shown) {
      const row = el('div', 'row');
      row.dataset.id = it.id;
      if (it.id === state.flashId) { row.classList.add('flash'); flashRow = row; }

      // Website column
      const site = el('div', 'site');
      const st = el('div', 'site-text');
      const tl = el('div', 'title-line');
      tl.append(el('span', 'title', it.title));
      if (it.label) tl.append(el('span', 'tag', it.label));
      st.append(tl);
      if (it.url) {
        const u = toURL(it.url);
        const link = el(u ? 'a' : 'span', 'url');
        if (u) {
          link.href = u.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        link.append(el('span', null, it.url));
        if (u) link.insertAdjacentHTML('beforeend', ICONS.external);
        st.append(link);
      }
      site.append(avatar(it.title), st);

      // Username column
      const user = el('div', 'field');
      user.append(el('span', 'field-label', 'Username'));
      if (it.username) {
        user.append(el('span', 'value', it.username));
        const cb = iconBtn('copy', 'Copy username');
        cb.onclick = () => copy(it.username, 'Username', cb);
        user.append(cb);
      } else {
        user.append(el('span', 'value empty', 'none'));
      }

      // Password column
      const pw = el('div', 'field');
      pw.append(el('span', 'field-label', 'Password'));
      if (it.password) {
        const shownPw = state.revealed.has(it.id);
        const v = el('span', 'value pw' + (shownPw ? '' : ' masked'), shownPw ? it.password : '••••••••••');
        const eb = iconBtn(shownPw ? 'eyeOff' : 'eye', shownPw ? 'Hide password' : 'Show password');
        eb.onclick = () => {
          const now = !state.revealed.has(it.id);
          now ? state.revealed.add(it.id) : state.revealed.delete(it.id);
          v.textContent = now ? it.password : '••••••••••';
          v.classList.toggle('masked', !now);
          eb.innerHTML = ICONS[now ? 'eyeOff' : 'eye'];
          eb.title = now ? 'Hide password' : 'Show password';
          eb.setAttribute('aria-label', eb.title);
        };
        const cb = iconBtn('copy', 'Copy password');
        cb.onclick = () => copy(it.password, 'Password', cb);
        pw.append(v, eb, cb);
      } else {
        pw.append(el('span', 'value empty', 'none'));
      }

      // Actions column
      const actions = el('div', 'actions');
      const del = iconBtn('trash', 'Delete ' + it.title, 'del');
      del.onclick = () => deleteItem(it);
      actions.append(del);

      row.append(site, user, pw, actions);
      frag.append(row);
    }

    list.replaceChildren(frag);
    if (flashRow) {
      if (flashRow.scrollIntoView) flashRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.flashId = null;
    }
  }

  /* ---------------------------------------------------------------- import (Load file) */

  function importFailed(msg) {
    if ($('empty').classList.contains('hidden')) {
      toast(msg, { error: true, ms: 4000 });
    } else {
      const e = $('error');
      e.textContent = msg;
      e.classList.remove('hidden');
    }
  }

  // Adds every login from `text` that isn't already in the vault; identical ones are skipped.
  async function importText(text) {
    let logins;
    try {
      logins = parseExport(text);
    } catch (_) {
      return importFailed('This file couldn’t be read as JSON. Make sure it’s an unencrypted 1Password export.');
    }
    if (!logins.length) return importFailed('No logins with a username or password were found in this file.');

    const hadItems = items.size > 0;
    const { fresh, skipped } = dedupe(logins, [...items.values()]);
    await putLogins(fresh);
    $('error').classList.add('hidden');
    render();

    if (!fresh.length) {
      toast(`No new logins: all ${logins.length} are already in your vault`, { ms: 3500 });
    } else if (!hadItems) {
      toast(`Loaded ${plural(fresh.length, 'login')}` + (skipped ? ` · ${plural(skipped, 'duplicate')} skipped` : ''), { ms: 3000 });
    } else {
      toast(`Added ${plural(fresh.length, 'new login')}` + (skipped ? ` · ${plural(skipped, 'duplicate')} skipped` : ''), { ms: 3500 });
    }
    return { added: fresh, skipped };
  }

  function loadFile(file) {
    if (!file || !vaultKey) return;
    const r = new FileReader();
    r.onload = () => importText(String(r.result));
    r.onerror = () => importFailed('The file couldn’t be opened.');
    r.readAsText(file);
  }

  /* ---------------------------------------------------------------- delete */

  async function deleteItem(it) {
    const summary = el('div', 'summary');
    const st = el('div', 'site-text');
    st.append(el('div', 'title', it.title), el('div', null, it.username || it.url || ''));
    summary.append(avatar(it.title), st);

    const ok = await confirmDialog({
      title: 'Delete this login?',
      text: 'Are you sure you want to proceed? This login will be removed from your vault.',
      details: [summary, el('p', 'fine', 'It’s deleted on every device you use PowerPass on, and can’t be undone.')],
      confirmLabel: 'Delete login',
    });
    if (!ok || !vaultKey) return;
    state.revealed.delete(it.id);
    removeLogin(it.id);
    render();
    toast('Login deleted');
  }

  /* ---------------------------------------------------------------- add */

  let titleTouched = false;

  function setRevealField(show) {
    $('fPass').type = show ? 'text' : 'password';
    const b = $('fReveal');
    b.innerHTML = ICONS[show ? 'eyeOff' : 'eye'];
    b.title = show ? 'Hide password' : 'Show password';
    b.setAttribute('aria-label', b.title);
  }

  function formError(msg) {
    const err = $('fError');
    err.textContent = msg;
    err.classList.remove('hidden');
  }

  function openAdd() {
    $('addForm').reset();
    $('fLabel').value = 'website';
    $('fError').classList.add('hidden');
    titleTouched = false;
    setRevealField(false);
    $('addDlg').showModal();
    $('fUrl').focus();
  }

  async function submitAdd(e) {
    e.preventDefault();
    const url = $('fUrl').value.trim();
    const title = $('fTitle').value.trim();
    const username = $('fUser').value.trim();
    const password = $('fPass').value;

    if (!title && !url) return formError('Add a website URL or a name.');
    if (!username && !password) return formError('Add a username or a password.');

    const login = createLogin({ title, label: $('fLabel').value, url, username, password }, { source: 'manual' });
    if (!dedupe([login], [...items.values()]).fresh.length) return formError('This exact login is already in your vault.');
    await putLogins([login]);

    state.query = '';
    $('search').value = '';
    state.flashId = login.id;
    $('addDlg').close();
    render();
    toast('Login added');
  }

  /* ---------------------------------------------------------------- export */

  function exportFile() {
    const data = sortedItems().map(toExportRecord);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `powerpass-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Saved ' + a.download);
  }

  /* ================================================================ wiring */

  function on(id, ev, fn) { const n = $(id); if (n) n.addEventListener(ev, fn); }

  function bindEvents() {
    // Gate
    on('emailForm', 'submit', submitEmail);
    on('codeForm', 'submit', submitCode);
    on('resendBtn', 'click', async () => {
      try { await sendCode(); } catch (err) { setError('codeError', 'Couldn’t resend the code: ' + friendlyAuth(err)); }
    });
    on('changeEmailBtn', 'click', () => { clearInterval(resendTimer); showSignIn(); });
    on('lockForm', 'submit', submitLock);
    on('pwReveal', 'click', () => setReveal($('pw').type === 'password'));
    on('pw', 'input', () => { if (!$('unlockBtn').disabled) setLockError(''); });
    on('forgotBtn', 'click', forgot);
    on('bioBtn', 'click', unlockWithBio);
    on('retryBtn', 'click', () => location.reload());
    for (const id of ['signOutLock', 'signOutNoAccess', 'signOutApp']) on(id, 'click', signOut);

    // App
    $('openBtn').onclick = $('openBtn2').onclick = () => $('fileInput').click();
    $('addBtn').onclick = openAdd;
    $('saveBtn').onclick = exportFile;
    $('lockBtn').onclick = () => lock();
    $('bioToggle').onclick = toggleBio;
    $('fileInput').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
    $('search').oninput = e => { state.query = e.target.value; render(); };

    $('addForm').addEventListener('submit', submitAdd);
    $('addDlg').querySelector('[data-close]').onclick = () => $('addDlg').close();
    $('fGen').innerHTML = ICONS.dice;
    $('fGen').onclick = () => {
      $('fPass').value = generatePassword();
      setRevealField(true);
    };
    $('fReveal').onclick = () => setRevealField($('fPass').type === 'password');
    $('fTitle').oninput = () => { titleTouched = $('fTitle').value.trim() !== ''; };
    $('fUrl').oninput = () => {
      // Suggest a name from the domain until the user types their own.
      if (titleTouched) return;
      const h = hostOf($('fUrl').value.trim());
      const base = h.split('.').slice(-2, -1)[0] || h;
      $('fTitle').value = base ? base[0].toUpperCase() + base.slice(1) : '';
    };

    // Clicking the dimmed backdrop closes a dialog.
    for (const d of document.querySelectorAll('dialog')) {
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
    }

    let dragDepth = 0;
    addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => {
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragging');
      loadFile(e.dataTransfer.files[0]);
    });

    addEventListener('keydown', e => {
      const s = $('search');
      if (document.querySelector('dialog[open]') || !vaultKey) return;
      if (e.key === '/' && document.activeElement !== s && !$('searchBox').classList.contains('hidden')) {
        e.preventDefault();
        s.focus();
      } else if (e.key === 'Escape' && document.activeElement === s) {
        s.value = '';
        state.query = '';
        render();
        s.blur();
      }
    });

    addEventListener('scroll', () => $('header').classList.toggle('scrolled', scrollY > 4), { passive: true });

    // Lock after a while in the background; sync on the way back.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (vaultKey && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) lock();
      else if (vaultKey) syncSoon(200);
      hiddenAt = 0;
    });
    addEventListener('online', () => { if (vaultKey) syncSoon(200); });
    setInterval(() => { if (vaultKey && !document.hidden) sync(); }, 60000);

    // Another tab (this app or the other one on the same site) changed this account's copy.
    addEventListener('storage', async e => {
      if (!cache || !me || e.key !== cacheKey(me.id) || e.storageArea !== localStorage) return;
      const next = loadCache(me);
      if (!sameVault(next.vault, cache.vault)) { cache = next; lock(false); return next.vault ? showLock('unlock') : showLock('create'); }
      cache = next;
      if (!vaultKey) return;
      await decryptAll();
      render();
    });
  }

  // For tests and the console, e.g. PowerPass.importText(json).
  window.PowerPass = { importText, sync: () => sync(), lock: () => lock(), state: () => ({ me, cache, unlocked: !!vaultKey, count: items.size }) };

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
