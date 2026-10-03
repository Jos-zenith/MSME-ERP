# MSME Builder

A low-code / no-code platform that lets a small business build and change its own billing, stock, orders and
service-job apps with visual tools, on a cheap phone or an entry-level laptop, **with or without internet**.

No frameworks, no build step, no runtime dependencies. The whole app (all languages, builder included) is about 130 KB over the wire (gzipped; 420 KB unminified) and is cached after the first visit.

```
npm start          # http://localhost:8080  (and your Wi-Fi address, so staff phones can open it)
npm test           # 29 unit tests  (engine, rules, sync server, CSV, translations)
npm run test:e2e   # 15 browser tests in real Chrome/Edge (needs `npm install` once for puppeteer-core)
```

Open it, pick a language, type your shop's name, choose **Shop: billing + stock** (or **Service jobs**), and you have
a working app with sample data in under a minute. Nothing is sent to any server unless you turn sync on.

---

## What it does

| Requirement | How it is met |
|---|---|
| **Drag-and-drop forms, lists, databases** | *App builder → Tables & forms*: a palette of 11 field types (text, number, money, date, choice, yes/no, phone, email, link to another table, **line items**) that you click or drag onto a form. Reorder by dragging or ▲▼, live *Preview form* tab, per-field settings, calculated fields, auto-numbering, auto-fill from linked records. |
| **Workflows: approvals, notifications, tasks, reminders** | *App builder → Workflows*: **When** (record added / changed / deleted / a field changes / before saving / every day) → **Only if** (visual conditions) → **Do this** (send WhatsApp/SMS/email/in-app alert, change a field, add a record such as a task, ask the owner to approve, add/remove stock, call a webhook, stop a save with a message). Five one-click "start from an idea" recipes. |
| **If–then rules for validation and automatic actions** | Conditions compare a field with a value *or another field* (e.g. `stock ≤ reorder level`), across linked records (`customer › city`) and line items. A safe formula language (no `eval`) powers calculated fields. |
| **Dashboards** | *App builder → Dashboards*: number tiles, charts and lists over any table, including line items (best-selling items, money received by payment mode). Live preview while you build. Charts have hover/keyboard tooltips and a "show as table" view. |
| **Low-cost hardware, poor connectivity** | Local-first: all data lives in IndexedDB on the device and the app is precached by a service worker. Measured on 3,000 bills / 2,000 items: **0.7 ms** to save a bill with all workflows, 1.4 ms per item search, 36 ms for the whole dashboard. Off-canvas menu and card-style tables on phones; no sideways scrolling at 375 px. |
| **Offline capture and later sync** | Work offline, edits queue up, and the optional sync server merges devices when they reconnect (see *Sync*). |
| **Local languages** | English, Hindi (all everyday screens), Tamil and Telugu (navigation, billing, dashboards, customer messages). Templates are built *in the chosen language*, so a Hindi user's fields and WhatsApp messages start in Hindi. |
| **Minimal setup, low cost** | Three onboarding steps. The whole platform is free to self-host: one small Node file, no database, no accounts. |
| **Simple, reliable security and backup** | Optional owner PIN and staff PIN (salted PBKDF2), staff role limits, one-tap backup file, **passphrase-encrypted backup** (AES-GCM), weekly backup reminder, daily server-side copies when sync is on. |
| **Connectors** | CSV/Excel/Google-Sheets paste **import** with automatic column mapping (Zoho Books, Vyapar, Tally and plain spreadsheet headers), **export** including Zoho Books item / contact / invoice layouts, a **webhook** action (Zoho Flow, Zapier, Make, your own server), `wa.me` WhatsApp, `sms:` and `mailto:` links. |
| **Extensible without adding complexity** | Everything the builder makes is plain JSON (`Advanced: edit as JSON` on any table or field). Sector templates are ~150-line JS files ([retail.js](public/js/templates/retail.js), [service.js](public/js/templates/service.js)). |

---

## The six Vyapar complaints, and what was done about each

Each one is reproduced with real keystrokes in [tests/e2e/run.mjs](tests/e2e/run.mjs) and at the logic level in
[tests/unit/core.test.mjs](tests/unit/core.test.mjs).

1. **"WhatsApp sends the invoice the second you click create, before you can mark it paid, so the customer sees a false *Balance due*."**
   Nothing is ever sent automatically. A saved bill queues a message in the **Outbox** *as a template*, and it is written
   **when you tap Send**, from the bill's latest data. Record the payment first (one tap: *Cash received / UPI received*,
   on the form or on the saved bill) and the message reads *"Payment received in full. Thank you!"*. If the payment
   comes after, the **receipt replaces the unsent bill message** instead of adding a second one. The text is editable
   before sending. → [store.js](public/js/store.js) `queueOutbox` / `renderOutbox`, [logic.js](public/js/logic.js) templates.
2. **"You can't press Enter to select an item code; you must click it."**
   Typing highlights the best match automatically (an **exact code or barcode always ranks first**); **Enter** picks it and
   the cursor jumps to Qty. Tab also picks. ↑/↓ change the highlight. → [combobox.js](public/js/ui/combobox.js), `searchRecords` in [schema.js](public/js/schema.js).
3. **"No keyboard shortcut to add the next item row."**
   **Enter** on the last cell opens the next row with the cursor in it. **Alt+N / Insert** adds a row, **Alt+D / Ctrl+Delete**
   removes one, **↑/↓** move between rows, **Ctrl+S** saves, **Ctrl+Enter** saves and opens print/share. Enter on an empty item
   cell leaves the grid instead of creating blank rows. Press **?** anywhere for the cheat sheet. → [lines.js](public/js/ui/lines.js).
4. **"You can't add a customer with the same name as another, even with a different phone number."**
   Names are never unique. Every customer picker shows **name · phone** (and city), so two "Ravi Kumar"s are always distinguishable.
   A repeated *phone* only asks "Save anyway?", never blocks. (Item codes stay unique on purpose: exact-code entry depends on it.)
   You choose per field in the builder: *never allow* / *just warn* / *nothing*.
5. **"You can't print a sale invoice with a UPI QR code; you must create a Sale Order first."**
   Any invoice prints straight away with a **UPI QR for the balance due** (set your UPI ID once), or a **PAID** stamp when
   settled. A4 or 80 mm receipt paper; "Save as PDF" from the print window shares a PDF. → [print.js](public/js/print.js).
6. **"Quick entry lists items bottom to top."**
   Rows always appear **top to bottom in the order you entered them**, on screen, in print, in the customer message and in
   the saved record. Scan the same item twice and its quantity goes up rather than adding a duplicate row. Quick entry
   is a bar above the grid: scan a barcode, or type `SUG1*3` and press Enter.

### For shops already on Zoho

There is no live Zoho login (that needs OAuth and a server-side app registration; see *Not built yet*). What works today:
import your Zoho Books item and contact exports (headers like *Item Name, SKU, Rate, Purchase Rate, Opening Stock,
Usage unit, Display Name, MobilePhone, EmailID* are mapped automatically, and existing items are **updated by item code**
instead of duplicated); export items, contacts and invoices in Zoho-style column layouts; push any record to **Zoho Flow**
through a webhook action. Header names follow Zoho's templates as closely as we could without their live docs, and Zoho's
own import wizard lets you re-map any column that differs.

---

## Sync, backup and security: what to expect

* **Where data lives.** In the browser's IndexedDB on each device. Ask the browser to protect it from cleanup under
  *Settings → This device*, and install the app to the home screen.
* **Sync** (optional): run `npm start` on any always-on machine (an old laptop, a cheap VPS), then *Settings → Sync* on each
  device with a workspace name and passphrase. Devices exchange changes whenever they are online. **Conflict rule: per record,
  the most recent edit wins** (device clocks are trusted, so keep them on automatic time). Deletions sync. The server stores a
  scrypt hash of the passphrase, rate-limits guessing, and keeps 14 daily copies in `data/backups/`. The server is plain HTTP: put it
  behind HTTPS (Caddy, nginx, Cloudflare Tunnel) before exposing it to the internet.
* **Invoice numbers across devices.** Give each device a *device tag* (A, B) so offline devices never issue the same number.
* **The PIN** keeps casual users out on a shared device and separates owner from staff. It is **not** disk encryption: stored data is
  readable by anyone with the unlocked device, so also use the phone/laptop screen lock. Use *encrypted backup* for copies that leave the device.
* **Backups** are a single JSON file (`Settings → Backup & restore`). Restoring replaces everything on that device.

---

## Project layout

```
public/                     the whole app (static files; works from any web server)
  js/formula.js             safe expression language          js/logic.js     conditions + message templates
  js/schema.js              field types, formulas, validation, search
  js/rules.js               workflow engine                   js/analytics.js dashboard queries
  js/store.js  db.js        records, outbox, approvals; IndexedDB / memory adapters
  js/sync.js   security.js  sync client; PIN + encrypted backups
  js/csv.js                 CSV parse/write, Zoho/Vyapar header aliases
  js/ui/                    combobox, line-item grid, form, charts, conditions editor
  js/views/                 home, lists, record, print, inbox, reports, builder, workflows, dashboards, settings
  js/templates/             sector starters (retail, service, blank)
  js/lang/                  hi.js ta.js te.js
  sw.js                     offline service worker (file list generated by `npm run build:sw`)
server/server.js            static hosting + sync + daily backups (zero dependencies)
scripts/                    icon generator, service-worker list builder, translation extractor
tests/unit  tests/e2e       node:test unit tests; Chrome-driven end-to-end tests
```

**Add a sector template:** copy [service.js](public/js/templates/service.js), define tables / rules / dashboards as plain
objects (wrap every visible string in `t()`), register it in [templates/index.js](public/js/templates/index.js).
A unit test checks every formula, link and rule condition in every template.
**Add a language:** create `public/js/lang/xx.js` (`export default { 'English text': 'translation' }`), add it to `LANGS` in
[i18n.js](public/js/i18n.js), run `npm run build:sw`. `npm run i18n:missing -- xx` lists what is untranslated;
a test fails if a translation drops a `{{placeholder}}`. Missing keys fall back to English.

---

## Honest limits (read before you rely on it)

* **WhatsApp/SMS/email are one tap, not fully automatic.** They open the user's own WhatsApp/SMS/email app with the message
  filled in (`wa.me` links: free, no account). Sending with nobody at the screen needs the paid WhatsApp Business Cloud API
  and a server holding the credentials; the **webhook** action is the bridge for that.
* **Scheduled workflows** (payment reminders, late-job alerts) run when the app is opened and about hourly while it stays open. There is no
  background job on a closed phone; they create reminders in the Outbox, they do not send.
* **Translations are first drafts.** Hindi is complete for everyday screens; Tamil and Telugu cover navigation, billing, dashboards and
  customer messages. The owner-side screens (App builder, Settings, Import) are English for now. **Have native speakers review before release.**
* **Tax is simple**: a tax % per line. There is no CGST/SGST/IGST split, HSN codes, e-invoicing or GSTR export yet.
* **Barcodes** work with USB/Bluetooth scanners (they type the code and press Enter). Camera scanning is not built in.
* **Not built yet:** live Zoho/Google Sheets API connections, import of line-item tables (bills), per-field permissions, audit log,
  multi-branch stock transfer, and proper end-to-end encryption of synced data on the server.
* Tested in Chrome (desktop, phone-sized viewport). Please try it on the actual low-end Android phones and browsers your users have.
