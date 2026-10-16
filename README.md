# House App

An installable PWA: an iPhone-style home screen (`index.html`) that launches a
growing set of household tools:

- **Energy Tracker** (`energy-tracker.html`) — monthly electricity bills, kWh,
  ₱/kWh rate and forecasts from meter readings.
- **Oni Orders** (`oni-orders.html`) — build and email orders to ONI / Bukiya
  from a saved item catalog, with JSON-file backups. Brought in from the
  standalone Oni Inventory App. **Invoices** bills your own customers: items
  carry a selling price in ₱ (set on the Items tab), each invoice has a
  customer, an order number (counts up from the highest used, e.g. `INV-0024`),
  a status (Unpaid, Paid, Awaiting delivery, Sent, Completed), shipping and
  discount. **Preview invoice** shows it full-screen on light "paper", shrunk
  to fit one phone screen so a single screenshot can be sent to the customer.
  Invoices ride in the same **Save backup** file as everything else.
  **Vouchers** generates an *Oni Philippines* discount voucher: enter a code,
  an Instagram/Facebook handle, a value in ₱ and an expiry date, and it draws
  an Oni-branded voucher (real logo, black/red theme) on a canvas to download
  as a PNG. Each generated voucher is kept in a records list and can be marked
  **Claimed** or **Expired** (a past expiry shows as Expired automatically);
  vouchers ride in the same backup file too.
- **Grocery Planner** (`grocery.html`) — an Item Manager of groceries with
  peso prices, and a Planner that builds a shopping list with quantities,
  line totals and a running total. Can show everything in British pounds
  using an editable exchange rate (prices are always stored in pesos).
  Item Manager → **Import items / Export items** reads and writes a JSON list:

  ```json
  { "kind": "grocery-items", "version": 1, "currency": "PHP",
    "items": [ { "name": "Eden Cheese 160g", "price": 55.00 } ] }
  ```

  A bare `[{ "name", "price" }]` array or `[["name", price]]` pairs also work.
  Import adds new names and (optionally) updates prices of existing ones,
  matched by name ignoring case; it never deletes. Undo is offered after.
- **To Do** (`todo.html`) — a simple to-do list. Tap a to do to add
  multi-line notes; web addresses in notes (`https://…`, `www.…`, or
  `amazon.com/…`) become links that open in the device's browser. Ticking a
  to do moves it to **Completed**, where it can be moved back or deleted.
- **Expenses** (`expenses.html`) — a monthly expenses tracker in a light,
  watercolour style. **Overview** shows the month's total (with an optional
  monthly budget and the change vs the previous month), a category breakdown
  and spending by week (1–7, 8–14, …). **Breakdown** lists the month's expenses grouped by
  category or by date; tap one to edit. **Pots** tracks withdrawals: money taken out
  or sent, each typed with one of the Breakdown categories
  (`kind: "cat:<id>"`; older ones may carry a retired fixed type), in ₱ or £; the
  month's total is always in pesos, with £ entries converted at the one
  exchange rate set on that tab (`£1 = ₱…`, stored in settings and synced), so
  changing the rate re-totals every month; the card also shows the total in £.
  Pots group withdrawals ("House build"), each showing this month's and its
  all-time total in ₱ and ≈ £; tap one to narrow the list. Withdrawals are not counted as
  spending unless their pot has **Show in Breakdown** on (`inBreakdown`): then
  they count on Overview and in Breakdown under their type's category (`potSpending()`,
  rows made on the fly, never stored). **Settings** holds the budget, the
  categories (emoji, name, colour) and the data tools. **Import CSV** reads a
  sheet like this, skipping subtotal and grand-total rows and checking the rows
  add up to the grand total:

  ```csv
  Category,Item,Amount (PHP)
  FOOD & DINING,Monthly grocery,22579
  FOOD & DINING Subtotal,,22579
  GRAND TOTAL,,22579
  ```

  An optional `Date` column (`YYYY-MM-DD`) is used when present; otherwise
  you pick one date for the whole file. Categories are matched by name ignoring
  case and punctuation; unknown ones are created. Rows already added (same date,
  category, item and amount) are skipped by default. **Export CSV** writes
  `Date,Category,Item,Amount (PHP)`, which imports back cleanly.

- **PowerPass** (`powerpass.html`) — your logins from a 1Password export: load
  the file (`.json` / `.1pif`; identical logins are skipped), search, copy usernames
  and passwords, add (with a password generator), delete, and **Export** a JSON
  backup. Brought in from the standalone PowerPass app. Unlike the other tools
  it is **personal and end-to-end encrypted**: it needs you signed in (on
  Account) and on the access list, asks for a **master password** (created on
  first use, never stored or sent), and encrypts every login on the device
  (AES-GCM, key from PBKDF2-SHA256 × 600,000) before saving or syncing it. Its
  rows belong to one account, so nobody else in the household, the owner
  included, can read them. **Lock**, a reload or five minutes in the
  background forgets the key. A forgotten master password can't be recovered:
  **Forgot it?** deletes that person's vault so they can start again.
  The same logins are in the standalone PowerPass app (its own repo), which
  signs in to this same Supabase project.
- **Color Grading** (`grade.html`) — a library of Adobe Premiere Mobile colour
  grades (Adjust presets): Gym, Boat, Movie, iPhone and Afternoon looks, brought in
  from the standalone *Frame & Tone Studio* dashboard. Each preset shows its Light and
  Color sliders as bars, its Grading as colour wheels, its Mix (HSL per colour),
  Vignette and Grain, a tip, and a palette preview (or your reference photo, from
  `grade-refs/`). **Copy all settings** (or one section) puts the numbers on the
  clipboard to dial in on the phone; **Compare** lists the differences against any
  other preset. The presets are built into the page; what you add is per preset:
  a new **name**, a **favourite** star and **My notes**. On a phone the list and a
  preset are separate screens (the back gesture returns to the list); from 900px
  wide they sit side by side.

No build step and no server of our own. Data lives in `localStorage` on the
device; signed in, it also syncs through Supabase (see *Accounts + sync*).

## Files

| File | Purpose |
|---|---|
| `index.html` | House App home screen: calendar widget, live Energy widget, tool icons. PWA `start_url`. |
| `energy-tracker.html` | Energy Tracker tool. Home button top-left returns to the home screen. |
| `oni-orders.html` | Oni Orders tool (ONI / Bukiya order builder). Home button top-left. |
| `grocery.html` | Grocery Planner tool (Planner / Item Manager / Settings tabs). Home button top-left. |
| `todo.html` | To Do tool (To Do / Completed tabs, detail sheet with notes). Home button top-left. |
| `expenses.html` | Expenses tool (Overview / Breakdown / Pots / Settings tabs, month switcher). Home button top-left. |
| `grade.html` | Color Grading tool (preset library + preset detail). Home button top-left. Presets live in the page (`PRESETS`). |
| `grade-refs/` | Reference photos shown on the Afternoon presets. |
| `powerpass.html` | PowerPass: sign-in check, master password, the logins. Home button top-left. Does **not** load `cloud.js`: see *PowerPass* below. |
| `powerpass.js`, `powerpass.css` | PowerPass's code and styles. Shared byte-identical with the standalone PowerPass repo: change them here (where the tests are), then copy them over. |
| `vendor/supabase.js` | Supabase JS, the same pinned version as `cloud.js` loads, served from this site for PowerPass (shared with the standalone repo too). |
| `account.html` | Account & sync: sign in by emailed code, sync status, the people-with-access list. |
| `cloud.js` | Accounts + shared sync, loaded by every page. Holds the Supabase project URL + publishable key. |
| `supabase/schema.sql` | The database: tables and the row-level security that enforces the access list. Re-runnable. |
| `test-cloud.js`, `test-tools.js` | Node tests (`npm install`, then `npm test`). |
| `manifest.webmanifest` | PWA metadata (name, icons, standalone display, app shortcuts). |
| `sw.js` | Service worker: network-first for HTML, cache-first for icons. Works offline after the first online visit. |
| `icons/` | Generated by `node make-icons.js` (`house-*` = the app icon, `energy-*` / `oni-*` / `grocery-*` / `todo-*` / `expenses-*` / `powerpass-*` / `grade-*` / `cloud-*` = the tool tiles). |
| `.nojekyll` | Tells GitHub Pages to serve files as-is (no Jekyll processing). |

## Install on iPhone

A PWA must be served over **https** (a service worker can't run from a file
opened directly). Push this folder to a GitHub Pages repo (root of `main`), then:

1. Open the Pages URL in **Safari** (not Chrome — only Safari can add PWAs on iOS).
2. Tap **Share → Add to Home Screen**.
3. Launch it from the new "House" icon — it runs full-screen and works offline.

Data is stored per web address: anything entered in a local copy, or in the
old standalone Oni app, won't appear on the hosted copy automatically. Carry it
over with each tool's backup: Energy Tracker **Export backup / Import backup**;
Oni Orders **Backup → Save backup (.json)**, then **Import & replace all**;
Grocery Planner and Expenses **Settings → Export backup / Import backup**.

## Accounts + sync (Supabase)

localStorage stays the working copy, so every tool works offline exactly as
before. Signed in, `cloud.js` uploads each change and pulls everyone else's.

- **One shared household.** Everyone on the access list sees and edits all the
  data. The owner (an email set by a private script kept outside this repo)
  is the only one who adds or removes people, under **Account → People with
  access**. Sign-ups are open, but an account that isn't on the list can read
  and write nothing: that is enforced by row-level security in
  `supabase/schema.sql`, not by the app. Never put the secret key or the
  owner's email in this repo.
- **One row per record** in `house_items` (`store` = the localStorage key, `id`
  = the record's id; `_` for a settings object, `_order` for a list's saved
  order), so two people changing different things never collide. The same
  record changed twice: the later upload wins. Deletes are flagged, not removed.
- **What syncs** is the `STORES` table at the top of `cloud.js`. Themes, the
  last-open tab and the like stay per device (`local` fields, or simply not
  listed). `test-tools.js` fails if a page gains a store that is in neither list.
- **How pages take part:** `safeWrite()` calls `HouseCloud.dirty(key)`, and the
  page's existing `storage` listener (written for "another tab changed this")
  reloads when `cloud.js` applies a change from the server. A page must reload
  **every** synced store it holds in memory there, or its next save would
  overwrite what arrived.
- **First sync on a device** (Account page): an empty cloud takes the device's
  data; otherwise the user picks *Use the shared data* or *Add this device's
  data* (records that are "the same thing" by `natural` key are not
  duplicated). The device's own copy is kept in `house.preCloudBackup.v1` first.
- **Changing the database:** edit `supabase/schema.sql` (keep it re-runnable),
  run `npm test`, and have the owner paste it into Supabase **before**
  deploying app code that needs it.
- `CLOUD_URL` / `CLOUD_KEY` empty in `cloud.js` = sync switched off; the app is
  device-only and loads nothing from the internet.

## PowerPass

PowerPass doesn't use `cloud.js` or `house_items`: passwords aren't household data.

- **Tables:** `powerpass_vaults` (one per person: salt, rounds, and a known text
  encrypted with their key, so a wrong master password is caught) and
  `powerpass_items` (one row per login: `iv` + `data`, the encrypted login; deletes
  are flagged). Row-level security: your own rows, and only while you're on the
  access list. A vault can't be edited in place, only deleted (with its logins).
- **Sign-in:** the page reuses House App's session (`house.auth`). Signed out, it
  points to Account.
- **Sync:** `powerpass.js` keeps the same ciphertext in `powerpass.cache.v1.<account id>`,
  so it opens and takes changes offline; changes wait in `pending` and upload
  later, and a pull never overwrites a login with a change still waiting.
- **Face ID (optional, per device):** a passkey with the WebAuthn PRF extension.
  Its secret, released only after Face ID / Touch ID / Windows Hello passes, seals
  a copy of the vault key, kept as `bio` in the cache above; the master password
  still works. Offered once after a master-password unlock; the face button in
  the toolbar turns it on or off. Tested with a fake authenticator in `test-tools.js`.
- **Locked down:** the page's Content-Security-Policy runs only this site's own
  scripts (hence `vendor/supabase.js` instead of the CDN) and can only connect to
  the House App Supabase project. If the project changes, update `connect-src` and
  the `data-cloud-*` attributes in `powerpass.html` (and in the standalone repo).
- **Same site as the standalone app:** both may be served from
  `emm-strength-gh.github.io`, which is one origin, so they use different
  storage keys, and each service worker clears only its own caches.

## Adding a tool

1. Add the page (e.g. `new-tool.html`) to this folder. Copy the `<head>` PWA
   tags and the Home button from `energy-tracker.html` so it installs and
   navigates back consistently.
2. Add an entry to the `APPS` array near the top of the script in `index.html`
   (and an icon in `make-icons.js` if it needs one).
3. Add the page (and its icon) to `SHELL_ASSETS` in `sw.js` and bump `CACHE_VERSION`.
4. Prefix its `localStorage` keys with the tool name (e.g. `water.readings.v1`) —
   every tool shares one origin, so keys must not collide.
5. To sync it: load `cloud.js`, call `HouseCloud.dirty(key)` from its
   `safeWrite()`, reload on the `storage` event, and list its stores in
   `STORES` in `cloud.js` (records need an `id`). Then `npm test`.

## Storage keys

Energy Tracker: `energy.bills.v1`, `energy.forecast.v1`, `energy.groups.v1`,
`energy.theme.v1`, `energy.savedAt.v1`, `energy.summary.v1` (snapshot the home
widget reads). Oni Orders: `oni.catalog.v1` (item `price` in ₱ is optional), `oni.orders.v1`,
`oni.invoices.v1`, `oni.vouchers.v1`, `oni.settings.v1` (also shop name/handle,
invoice number prefix and the last invoice message). Grocery Planner:
`grocery.items.v1`, `grocery.plan.v1`, `grocery.settings.v1`, `grocery.theme.v1`,
`grocery.tab.v1`. To Do: `todo.items.v1`, `todo.theme.v1`, `todo.tab.v1`.
Expenses: `expenses.items.v1` (amounts in centavos), `expenses.categories.v1`,
`expenses.settings.v1` (also `gbpRate`, pesos per £1), `expenses.withdrawals.v1` (amount in centavos or pence by `currency`, optional `pot`),
`expenses.pots.v1`,
`expenses.tab.v1`, `expenses.month.v1`, `expenses.group.v1`, `expenses.byType.v1` (Pots' By type folded, per device).
Color Grading: `grade.prefs.v1` (one record per personalised preset: `{ id: preset id, name?, fav?, notes? }`;
a record left empty is removed), `grade.theme.v1`, `grade.last.v1` (last preset opened, per device).
PowerPass: `powerpass.cache.v1.<account id>` (this device's encrypted copy, ciphertext only),
`powerpass.cache.v1.user` (the last account, for opening offline); deleted on this page when signed out.
Home screen: `house.installHintDismissed.v1`. Cloud: `house.cloud.v1` (who is
signed in, what the server last held, sync position), `house.auth` (the
Supabase session), `house.preCloudBackup.v1` (the device's data before it
first joined).
