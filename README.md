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
| `account.html` | Account & sync: sign in by emailed code, sync status, the people-with-access list. |
| `cloud.js` | Accounts + shared sync, loaded by every page. Holds the Supabase project URL + publishable key. |
| `supabase/schema.sql` | The database: tables and the row-level security that enforces the access list. Re-runnable. |
| `test-cloud.js`, `test-tools.js` | Node tests (`npm install`, then `npm test`). |
| `manifest.webmanifest` | PWA metadata (name, icons, standalone display, app shortcuts). |
| `sw.js` | Service worker: network-first for HTML, cache-first for icons. Works offline after the first online visit. |
| `icons/` | Generated by `node make-icons.js` (`house-*` = the app icon, `energy-*` / `oni-*` / `grocery-*` / `todo-*` / `expenses-*` / `cloud-*` = the tool tiles). |
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
`oni.invoices.v1`, `oni.settings.v1` (also shop name/handle, invoice number
prefix and the last invoice message). Grocery Planner:
`grocery.items.v1`, `grocery.plan.v1`, `grocery.settings.v1`, `grocery.theme.v1`,
`grocery.tab.v1`. To Do: `todo.items.v1`, `todo.theme.v1`, `todo.tab.v1`.
Expenses: `expenses.items.v1` (amounts in centavos), `expenses.categories.v1`,
`expenses.settings.v1` (also `gbpRate`, pesos per £1), `expenses.withdrawals.v1` (amount in centavos or pence by `currency`, optional `pot`),
`expenses.pots.v1`,
`expenses.tab.v1`, `expenses.month.v1`, `expenses.group.v1`, `expenses.byType.v1` (Pots' By type folded, per device).
Home screen: `house.installHintDismissed.v1`. Cloud: `house.cloud.v1` (who is
signed in, what the server last held, sync position), `house.auth` (the
Supabase session), `house.preCloudBackup.v1` (the device's data before it
first joined).
