# Vina

**Billing, stock and GST for Indian small businesses, with UPI that confirms itself and a credit passport built from
the shop's own books.** Runs on a cheap phone or an entry-level laptop, **with or without internet**.

Vina is a low-code / no-code platform. A kirana shop, a wholesaler or a repair business can build and change its own
billing, stock, orders and service-job apps with visual tools. On top of that sits a money layer:

- **Smart Collect.** Every bill's UPI QR carries its own reference. When the customer pays, the bank's confirmation
  marks that bill paid by itself, with the UTR, on every device. No screenshots to trust, no matching in the evening.
- **Credit Passport.** A loan-readiness score, an indicative working-capital limit and a consented data pack, all read
  from the bills and payments the shop already records.

No frameworks, no build step, no runtime dependencies. The whole app (all languages, builder included) is about 130 KB
over the wire (gzipped) and is cached after the first visit. *Formerly "MSME Builder": see [Renamed from MSME
Builder](#renamed-from-msme-builder).*

```
npm start          # http://localhost:8080  (and your Wi-Fi address, so staff phones can open it)
npm test           # 127 unit tests: engine, rules, GST, memory, counter, sync + live feed, sync accounts, payments and stock across devices, Smart Collect, credit passport, CSV, translations
npm run test:e2e   # 30 browser scenarios in real Chrome/Edge (needs `npm install` once for puppeteer-core)
```

Open it, pick a language, type your shop's name, choose **Shop: billing + stock**, **Shop with GST invoices** or
**Service jobs**, and you have a working app with sample data in under a minute. Nothing is sent to any server unless
you turn sync on.

**Product docs** (strategy memo, PRDs, technical design): [docs/](docs/README.md)

---

## Contents

- [At a glance](#at-a-glance)
- [A five-minute demo](#a-five-minute-demo)
- [Smart Collect: UPI that marks bills paid](#smart-collect-upi-that-marks-bills-paid)
- [Credit Passport: loan readiness from your own books](#credit-passport-loan-readiness-from-your-own-books)
- [The platform: forms, workflows, dashboards](#the-platform-forms-workflows-dashboards)
- [Type it once: the app remembers](#type-it-once-the-app-remembers)
- [At the counter](#at-the-counter)
- [GST](#gst)
- [The six Vyapar complaints, and what was done about each](#the-six-vyapar-complaints-and-what-was-done-about-each)
- [Sync, backup and security](#sync-backup-and-security)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Project layout](#project-layout)
- [Extending Vina](#extending-vina)
- [Tests](#tests)
- [Renamed from MSME Builder](#renamed-from-msme-builder)
- [Honest limits](#honest-limits)
- [Roadmap](#roadmap)

---

## At a glance

| Area | What you get |
|---|---|
| **Billing counter** | One screen per sale: scan, F1/F2/F3 for Cash/UPI/Card, Enter saves and prints. UPI shows a QR for the exact amount. |
| **Smart Collect** | Per-bill UPI reference; signed payment webhook; bill marked paid with the bank's UTR within seconds; owner queue for anything uncertain; fake-screenshot check. |
| **Credit Passport** | 0–100 readiness score across 8 explainable factors, top-3 improvements, indicative limit on the 20%-of-turnover norm, B2B invoices fit for discounting, consented JSON export with no personal data. |
| **GST** | CGST/SGST/IGST split live, HSN, FY-wise numbering, tax invoice / bill of supply / credit and debit notes, GSTR-1 JSON + CSV, GSTR-3B with ITC set-off, e-way bill JSON, receivables ageing. |
| **Low-code builder** | 11 field types including line items, calculated fields, workflows (when → only if → do this), dashboards, all stored as plain JSON. |
| **Offline-first** | All data in IndexedDB on the device; service worker precaches the app; edits queue and sync later. |
| **Multi-device** | Optional self-hosted sync server; live feed so a bill saved at the counter appears on the owner's screen in about a second. |
| **Roles** | Owner PIN and staff PIN; staff can bill but never see cost prices, the builder, settings or the credit passport. |
| **Languages** | English, Hindi (all everyday screens), Tamil and Telugu (navigation, billing, dashboards, customer messages). |
| **Connectors** | CSV/Excel paste import with Zoho Books / Vyapar / Tally header mapping, Zoho-style exports, webhooks, WhatsApp / SMS / email links. |
| **Footprint** | One small Node file for the server, zero dependencies, no database, no accounts. Free to self-host. |

---

## A five-minute demo

1. `npm start`, open http://localhost:8080, onboard with **Shop: billing + stock** and sample data.
2. **Settings → Your business:** set a UPI ID (any `name@bank` works in sandbox).
3. **Settings → Sync between devices:** server = this address, a workspace name, *Suggest one* for the passphrase, and
   the **setup code** the server printed when it started → *Connect*.
4. **Settings → Smart Collect:** tick *Turn on Smart Collect* and *Sandbox*. *Show webhook URL & secret* shows what a
   provider would be given.
5. Press **N** (billing counter). Type `oil1` + Enter, press **F2**. The QR shows *"Waiting for the payment…"*.
6. Click **Simulate payment (sandbox)**. The server receives it through the real webhook path, and the counter shows
   **"₹149.10 received · confirmed by the bank · UTR SIM…"**. Press **Enter** to save: the bill is Paid with the UTR.
7. A credit customer paying later: *Settings → Smart Collect → Simulate a payment* pays the most recent unpaid bill
   through its reference. Open that bill first and watch it turn Paid live; a toast appears and the WhatsApp receipt
   is queued.
8. **Messages & approvals → Payments:** the owner queue, the *"Marked UPI, not confirmed by the bank"* list and the
   audit trail.
9. **Credit passport** (owner menu): score, factors, what would help most, limit, *Download passport*.

The same flows run automatically in `npm run test:e2e` (the last three scenarios). Add `SHOTS_DIR=./shots` for screenshots.

---

## Smart Collect: UPI that marks bills paid

**The problem.** With a plain UPI QR the payment confirmation lands on the *customer's* phone. The cashier judges a
screenshot, and someone matches bank credits to bills by hand at night. Khata customers who pay round sums against
several bills make it guesswork.

**How it works.**

```
 counter / bill                customer's UPI app       provider (e.g. Decentro)        Vina sync server                every device
 QR: upi://pay?pa=<VPA>        scans, pays ──────────►  credit confirmed
     &am=<balance>                                       POST /api/collect/hook/<id> ──► check HMAC signature
     &tr=MB4K2P9X7Q1Z                                     {utr, amount, reference, …}     store event, keyed by UTR ───► live feed → pull
     (the bill's own ref)                                                                (retry? → "duplicate")          match → bill Paid + UTR
                                                                                                                         receipt queued
```

- The QR is generated **on the device**, so billing works offline. Only the confirmation needs a connection, and it
  catches up when the device comes back.
- The bill's id is fixed when the bill *starts*, so a counter bill has its reference before it is saved.
- The server never reads or writes bills. It authenticates the provider, stores the bank's facts and announces them.
  Matching runs on the devices, against whatever table the shop built.

**Where it shows up.**

| Screen | What you see |
|---|---|
| Billing counter, F2 | *"Waiting for the payment… it is confirmed here by itself"*, then *"₹X received · confirmed by the bank · UTR …"*, or *"₹X received, ₹Y still to pay"* |
| Saved bill | QR card: *"Marked paid by itself when the bank confirms"*. The bill turns Paid live when the money lands. Payments list shows *UTR / ref* |
| Toast | *"₹546.00 received by UPI · INV-0011 marked paid"*, or *"Bank confirmed ₹X by UPI"* when it verifies a cashier's entry |
| Messages & approvals → **Payments** | *Payments to match* (Apply suggestion / Choose bill… / Not a sale), *Marked UPI, not confirmed by the bank* (bill, date, amount, who marked it), *Recently confirmed* (UTR audit trail) |
| Home → Needs attention | *Payments to check* count; the bell badge includes it |
| Settings → **Smart Collect** | On/off, sandbox, webhook URL + signing secret (copy, rotate), *Simulate a payment*, 30-day stats (*"42 payments matched by themselves (₹38,400) · 95% automatic"*) |

**Matching rules** (`matchPayment` in [collect.js](public/js/collect.js), a pure function). Only the first four rows
and the payer-phone row apply money automatically; everything else asks the owner.

| # | Situation | Result |
|---|---|---|
| 1 | A bill already has a payment row with this UTR (webhook retried, another device was first) | Filed as matched; nothing changes |
| 2 | The referenced bill has a UPI row with this amount and no UTR (cashier pressed F2 / *UPI received*) | **Verify**: the UTR is attached to that row, no second payment |
| 3 | The referenced bill is open | Paid; any surplus goes to the same customer's other open bills, oldest first |
| 4 | Surplus remains after that (paid twice, or more than owed) | Owner decides (shown as an advance) |
| 5 | The reference is ours but the bill isn't on this device yet (still on the counter, or on an offline device) | **Waits** up to 12 h for its bill, then goes to the owner. It never lands on an older bill of the same amount |
| 6 | No reference; the payer's mobile (from the VPA or phone) matches a customer with exactly one open bill of that exact balance | Paid |
| 7 | Known payer, several open bills | Suggestion: oldest first |
| 8 | Exactly one open bill from the last 45 days has this balance | Suggestion |
| 9 | Nothing fits | Owner chooses a bill or marks *Not a sale* |

**Guarantees, each covered by a test.**

| Guarantee | How |
|---|---|
| A retried or replayed webhook changes nothing | Event id = hash of the UTR; a repeat returns `duplicate: true` |
| The same bank payment is never counted twice | A bill never gets a second row with the same UTR, on one device or merged from two |
| Different payments recorded on two offline devices both survive | Payments are a ledger that merges on sync; see [Sync, backup and security](#sync-backup-and-security) |
| Unsigned or mis-signed calls are refused | HMAC-SHA256 over the raw body, constant-time compare, rate-limited per IP |
| A device cannot forge or alter a bank confirmation | `/api/sync` refuses device-created payment events and restores the bank's fields from the server copy |
| Failed or pending payments are not money | Only success statuses are stored |
| Rotating the secret retires the old URL | New hook id + secret |

**Going live** with a real provider: map its payload in `normalizeEvent` and its signature header in
`handleCollectHook` ([server.js](server/server.js)), set the shop's UPI ID to the provider-issued merchant VPA, put
the server behind HTTPS, and set `COLLECT_SANDBOX=false`. Details: [technical design](docs/tech/smart-collect-design.md),
[PRD-01](docs/prd/01-smart-collect.md).

---

## Credit Passport: loan readiness from your own books

Owner menu → **Credit passport**. Computed on the device by [credit.js](public/js/credit.js) (pure, unit-tested) from the
bills table and its payments. It updates as you bill.

**The score (0–100).**

| Factor | Measures | Points | Full marks at |
|---|---|---|---|
| Trading history | Full months of billing (up to 12 read) | 10 | ≥ 12 months |
| Steady sales | Month-to-month swing (coefficient of variation, last ≤ 6 full months) | 15 | ≤ 20% |
| Sales growth | Last 3 full months vs the 3 before | 10 | ≥ +10% |
| Money received digitally | Non-cash share of collections, last 90 days | 20 | ≥ 60% |
| Collection speed | Days sales outstanding = receivables ÷ billed in 90 days × 90 | 20 | ≤ 15 days |
| Overdue dues | Overdue share of what you are owed (due date passed, or 30 days with none) | 10 | ≤ 10% |
| Customer spread | Largest customer's share of 90-day sales | 10 | ≤ 20% |
| GST registration | Valid GSTIN (checksum verified) | 5 | Present |

**Bands:** Strong ≥ 75 · Good ≥ 60 · Fair ≥ 40 · Building < 40. Under 3 full months of bills, the screen says it is
an early picture.

**Indicative working-capital limit** = 20% of annualised turnover (the Nayak Committee norm Indian banks use for
micro and small business working capital) × 1.0 / 0.75 / 0.5 / 0.25 by band, rounded down to ₹1,000. Annualised
turnover = average of the last 3 full months × 12.

**Also on the screen:** the three changes that would add the most points (with the points each could add), sales by
month (chart or table), money received per month split by provenance (digital, *reference only*, and **bank-confirmed**:
only payments the provider confirmed through the server's signed webhook, applied to that bill, up to the amount the bank
reported; a typed or copied UTR or a sandbox payment never counts), and unpaid bills to GST-registered buyers under 90 days late that could be discounted (for example on TReDS).

**Download passport** writes `vina-credit-passport-YYYY-MM-DD.json` with score, factors, metrics, limit, monthly
series and a **consent block** (purpose, valid until, what it contains). It never includes customer names, phone
numbers, bill numbers or individual bills. Credit notes reduce sales; proformas and delivery challans are ignored.

*Indicative only: not a credit score and not a loan offer.* Details and phases (Account Aggregator, signed export,
lender handoff): [PRD-02](docs/prd/02-credit-passport.md).

---

## The platform: forms, workflows, dashboards

| Requirement | How it is met |
|---|---|
| **Drag-and-drop forms, lists, databases** | *App builder → Tables & forms*: a palette of 11 field types (text, number, money, date, choice, yes/no, phone, email, link to another table, **line items**) that you click or drag onto a form. Reorder by dragging or ▲▼, live *Preview form* tab, per-field settings, calculated fields, auto-numbering, auto-fill from linked records. |
| **Workflows: approvals, notifications, tasks, reminders** | *App builder → Workflows*: **When** (record added / changed / deleted / a field changes / before saving / every day) → **Only if** (visual conditions) → **Do this** (send WhatsApp/SMS/email/in-app alert, change a field, add a record such as a task, ask the owner to approve, add/remove stock, call a webhook, stop a save with a message). Five one-click "start from an idea" recipes. |
| **If–then rules for validation and automatic actions** | Conditions compare a field with a value *or another field* (e.g. `stock ≤ reorder level`), across linked records (`customer › city`) and line items. A safe formula language (no `eval`) powers calculated fields. |
| **Dashboards** | *App builder → Dashboards*: number tiles, charts and lists over any table, including line items (best-selling items, money received by payment mode). Live preview while you build. Charts have hover/keyboard tooltips and a "show as table" view. |
| **Low-cost hardware, poor connectivity** | Local-first: all data lives in IndexedDB on the device and the app is precached by a service worker. Measured on 3,000 bills / 2,000 items: **0.7 ms** to save a bill with all workflows, 1.4 ms per item search, 36 ms for the whole dashboard. Off-canvas menu and card-style tables on phones; no sideways scrolling at 375 px. |
| **Offline capture and later sync** | Work offline, edits queue up, and the optional sync server merges devices when they reconnect. While online, devices are **live**: a bill saved at the counter appears on the owner's open screen in about a second, and the top bar shows *Live / Syncing / Offline · n to sync*. |
| **Local languages** | English, Hindi (all everyday screens), Tamil and Telugu (navigation, billing, dashboards, customer messages). Templates are built *in the chosen language*, so a Hindi user's fields and WhatsApp messages start in Hindi. |
| **Minimal setup, low cost** | Three onboarding steps. Free to self-host: one small Node file, no database, no accounts. |
| **Simple, reliable security and backup** | Optional owner PIN and staff PIN (salted PBKDF2), staff role limits, one-tap backup file, **passphrase-encrypted backup** (AES-GCM), weekly backup reminder, daily server-side copies when sync is on. |
| **Connectors** | CSV/Excel/Google-Sheets paste **import** with automatic column mapping (Zoho Books, Vyapar, Tally and plain spreadsheet headers), **export** including Zoho Books item / contact / invoice layouts, a **webhook** action (Zoho Flow, Zapier, Make, your own server), `wa.me` WhatsApp, `sms:` and `mailto:` links. |
| **Extensible without adding complexity** | Everything the builder makes is plain JSON (`Advanced: edit as JSON` on any table or field). Sector templates are ~150-line JS files ([retail.js](public/js/templates/retail.js), [service.js](public/js/templates/service.js), [gst.js](public/js/templates/gst.js)). |

**Templates**

| Template | Tables | Built-in workflows | Dashboard |
|---|---|---|---|
| Shop: billing + stock | Sales invoices, Customers, Items & stock, Purchases, Tasks | stock out/in, low-stock alert, WhatsApp bill, receipt when paid, overdue reminders, follow-up task for credit sales, owner approval for big discounts, discount check | collected today, billed today, payments pending, low stock, sales trend, best sellers, money by mode, unpaid bills |
| Shop with GST invoices | the same, with GST invoices and GST purchases | the same, plus credit notes put stock back | the same, plus GST collected, sales by GST rate |
| Service jobs | Service requests, Customers, Tasks | job received and job ready messages, late-job alerts, task for urgent jobs, owner approval for expensive repairs, no delivery while money is due | open jobs, ready for pickup, money to collect, earned this month, jobs by status, jobs received, late jobs |

---

## Type it once: the app remembers

Every picker, form and bill learns from what the shop has already saved. Nothing here is template-specific: it works on
any table built in the App builder.

* **Regulars first.** Click into a customer or item box without typing and the ones you use most (weighted to recent
  use) are listed; typed searches also rank regulars higher. Nothing is pre-selected, so Enter still moves on. → `Store.usage`
* **New customer in one go.** Type `Ravi 98765 43210` in the customer box and press Enter: the customer is created with
  name *and* phone and picked, no popup (Undo in the toast). Without a phone the popup opens with the name already filled
  and the cursor on the next empty field. → `parseQuickCreate` in [schema.js](public/js/schema.js)
* **A known phone picks the customer.** Type a saved number into *Customer phone* (with or without spaces / +91) and
  the customer is recognised and filled in. Phone search ignores formatting everywhere.
* **Their usual items, one tap.** Once a customer is chosen, the bill shows what they usually buy (with their usual
  quantity) and **↻ Repeat last bill**; for a walk-in it shows the shop's best sellers. → `Store.usualLines`, [lines.js](public/js/ui/lines.js)
* **↻ Repeat** on any saved record opens a new one with the same customer and lines, today's date, a fresh number,
  current prices and no payments. → `repeatData`
* **No made-up codes.** Leave *Item code* empty and one is made from the name (`Sugar 1kg` → `SUG1`, then `SUG2`); the
  form previews it as you type. → `suggestCode`, field option `autoCode`
* **Remembered answers.** Plain text fields (city, area, supplier…) suggest what was typed before, most used first.
* **GSTIN once.** A GSTIN fills in the state for your business, your customers and suppliers; the place of supply and
  the CGST/SGST vs IGST split follow by themselves (see [GST](#gst)).

---

## At the counter

* **Billing counter (`#/pos`): one screen per sale.** Scan on the left; customer, total and payment on the right.
  **Enter** on the empty scan bar saves and prints the receipt in place, and the counter is clean for the next
  customer. No page changes. A bill in progress survives a refresh, and *Full form* carries it to the full invoice form
  (due date, notes). **N** opens it from anywhere; staff land on it after unlocking. The app is light by default
  (counters are brightly lit); dark is a choice in Settings.
* **Walk-in sales in four keys.** Press **N** anywhere for a new bill, scan or type the items, **Enter** on the empty
  scan bar jumps to Save, **Enter** saves. A bill with no customer is a walk-in counter sale: it is saved as paid in
  full in Cash (the form says so next to Save). Paid by UPI or card? Tap *UPI received* first. Credit needs a customer
  to collect from, so a named customer's bill is never auto-paid. One switch per table in the App builder (`walkIn`);
  GST credit notes are excluded.
* **Closing the galla.** The home screen shows **Collected today** (money received today on any bill, old dues
  included, split Cash / UPI / Card) next to **Billed today (cash + credit)**. The cash figure is what the drawer should
  hold. *Payments pending* is labelled as covering all dates.
* **Hand over to staff.** The owner taps *🧾 Hand over to staff*: the owner screens lock and the cashier unlocks with the
  staff PIN (both PINs are needed: Settings → Team & security). Staff can bill, take payments and add customers, but
  never see the App builder, Settings, owner dashboards, GST returns, the credit passport, **purchases or suppliers**
  (cost prices), and can look items up but **not add or reprice them**. Each table's access is one setting in the App
  builder: *Add and edit / Only look / Not see this table*. The lock keeps people out of screens; it is not encryption.
* **Scanning.** USB/Bluetooth scanners type the code and press Enter. On phones, the 📷 button in the quick-entry bar
  scans with the camera continuously (each item added once per 1.5 s, exact code/barcode match only, so a misread never
  adds the wrong item). It uses the browser's built-in BarcodeDetector (Chrome / Edge on Android) and is hidden where
  that is missing. A code that is not in your items offers *New item with code …* with the code already filled in, and
  the new item goes straight onto the bill (owner only).
* **Typos still find the item.** `suagr`, `biscut`, `basmti` find Sugar, Biscuit, Basmati when nothing matches exactly.
* **💬 Remind** sits next to every unpaid bill that has a phone number (in the list and on the bill). One tap opens
  WhatsApp with the reminder written from the bill's current balance and your UPI ID, and remembers when you last
  reminded them.

**Keyboard shortcuts** (press **?** anywhere for the cheat sheet)

| Where | Keys |
|---|---|
| Anywhere | **N** new bill / new record · **/** search · **?** help |
| Billing counter | **F1 / F2 / F3** Cash / UPI / Card · **F4** discount · **F8** customer · **F9** credit · **Enter** on the empty scan bar saves · **Esc** clears |
| Forms | **Enter** next field · **Ctrl+S** save · **Ctrl+Enter** save and print / share |
| Item lines | code + **Enter** picks · **↑ ↓** change highlight · **Enter** after qty adds the next row · **Alt+N / Insert** add row · **Alt+D / Ctrl+Delete** delete row · `CODE*3` + Enter adds 3 |

---

## GST

The GST engine in [public/gst/js](public/gst/js) (tax split, GSTIN checksum, FY numbering, GSTR-1/3B, receivables,
e-way bill) is connected through table hooks ([hooks.js](public/gst/js/hooks.js)) and used by the **Shop with GST
invoices** template ([templates/gst.js](public/js/templates/gst.js)):

* Onboarding asks for your GSTIN, checks it live and shows the state and PAN it reads from it.
* The bill shows the split as you type (*Within Maharashtra: CGST + SGST* / *Maharashtra → Delhi: IGST*), only the tax
  lines that apply, HSN and GST % from the item, round-off, GST-inclusive prices, tax invoice / bill of supply / credit
  and debit notes / proforma / delivery challan, each numbered per financial year (`INV/26-27/0001`) with no gaps from
  failed saves. Credit notes put stock back. B2B invoices require HSN codes; credit notes must name the invoice they are against.
* Print is a proper tax invoice: both GSTINs, place of supply, reverse charge, HSN, tax breakup by rate, amount in
  words, and a UPI QR for the balance (with the Smart Collect reference when it is on).
* **GST returns** (owner menu): filing deadlines, GSTR-1 tables + JSON for the offline tool + CSV, GSTR-3B with input
  credit from purchases set off in the legal order, receivables ageing. Home shows *GST this month*. Saved invoices
  have an **E-way bill** button (JSON for bulk upload).
* Purchases record supplier GSTIN and GST so the input credit is real. Settings has a GST card (GSTIN, state, PIN code,
  prices include GST, round-off, composition dealer).

---

## The six Vyapar complaints, and what was done about each

Each one is reproduced with real keystrokes in [tests/e2e/run.mjs](tests/e2e/run.mjs) and at the logic level in
[tests/unit/core.test.mjs](tests/unit/core.test.mjs).

1. **"WhatsApp sends the invoice the second you click create, before you can mark it paid, so the customer sees a false *Balance due*."**
   Nothing is ever sent automatically. A saved bill queues a message in the **Outbox** *as a template*, and it is written
   **when you tap Send**, from the bill's latest data. Record the payment first (one tap: *Cash received / UPI received*,
   on the form or on the saved bill) and the message reads *"Payment received in full. Thank you!"*. If the payment
   comes after, the **receipt replaces the unsent bill message** instead of adding a second one. With Smart Collect on,
   the payment is recorded by itself when the bank confirms it. → [store.js](public/js/store.js) `queueOutbox` / `renderOutbox`, [logic.js](public/js/logic.js) templates.
2. **"You can't press Enter to select an item code; you must click it."**
   Typing highlights the best match automatically (an **exact code or barcode always ranks first**); **Enter** picks it and
   the cursor jumps to Qty. Tab also picks. ↑/↓ change the highlight. → [combobox.js](public/js/ui/combobox.js), `searchRecords` in [schema.js](public/js/schema.js).
3. **"No keyboard shortcut to add the next item row."**
   **Enter** on the last cell opens the next row with the cursor in it. **Alt+N / Insert** adds a row, **Alt+D / Ctrl+Delete**
   removes one, **↑/↓** move between rows, **Ctrl+S** saves, **Ctrl+Enter** saves and opens print/share. Enter on an empty item
   cell leaves the grid instead of creating blank rows. → [lines.js](public/js/ui/lines.js).
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

There is no live Zoho login (that needs OAuth and a server-side app registration). What works today: import your Zoho
Books item and contact exports (headers like *Item Name, SKU, Rate, Purchase Rate, Opening Stock, Usage unit, Display
Name, MobilePhone, EmailID* are mapped automatically, and existing items are **updated by item code** instead of
duplicated); export items, contacts and invoices in Zoho-style column layouts; push any record to **Zoho Flow** through
a webhook action. Header names follow Zoho's templates as closely as we could without their live docs, and Zoho's own
import wizard lets you re-map any column that differs.

---

## Sync, backup and security

* **Where data lives.** In the browser's IndexedDB on each device. Ask the browser to protect it from cleanup under
  *Settings → This device*, and install the app to the home screen.
* **Sync** (optional): run `npm start` on any always-on machine (an old laptop, a cheap VPS), then *Settings → Sync* on
  each device with a workspace name and passphrase (see *Sync accounts* below). Each device keeps one streaming connection open (`/api/live`); the
  server announces every change and the other devices pull it within about a second (a once-a-minute poll is the
  fallback if a proxy blocks streaming). **Payments and stock merge, they are never overwritten** (see below). For other
  fields, an edit that saw the other device's edit wins; two edits made without seeing each other keep the newer value
  *and* leave a conflict note with both values on the record (keep device clocks on automatic time). Deletions sync. The server keeps 14 daily
  copies in `data/backups/`. The server is plain HTTP: put it behind HTTPS
  (Caddy, nginx, Cloudflare Tunnel) before exposing it to the internet. Smart Collect needs that anyway.
* **"Saved" means on disk.** The server answers a sync, a payment webhook or any other change only after it is
  written durably: to a temporary file that is flushed to disk (fsync), then renamed over the old file (atomic), then
  the folder flushed where the OS allows it (not on Windows, where NTFS journals the rename). If the write fails, the
  device or payment provider gets an error, keeps the change and sends it again; the server drops what it could not save
  and never serves it. Requests that change data run one at a time. Tested by killing the server process (no warning)
  straight after ten acknowledged saves and one acknowledged bank payment, and by making the disk refuse writes.
  Also tested: the process killed after the temporary file is written and after the rename (nothing acknowledged is
  lost, the resend lands once, leftovers are removed at start), a failure at each write step, and a damaged file (refused
  with "restore from a daily backup", never replaced). Cost: every change rewrites that shop's whole file, so a very
  large workspace makes each sync slower.
* **Only compatible app versions sync.** Each app speaks a numbered *sync protocol* that names the rules it follows
  when writing records ([protocol.js](public/js/protocol.js)): 2 = payments as a ledger, 3 = stock as movements, 4 =
  "bank-confirmed" only from the server's snapshot. The server accepts a range (now 4 to 4) and refuses anything
  outside it before reading, creating or changing anything. A device that is too old shows **Update to keep syncing**
  (a banner with *Update now*, and the status pill), keeps every record it has, and sends them after the update; a
  device newer than its server is told the server needs updating. The number changes only when the write rules change,
  never with ordinary releases.
* **Sync accounts.** A workspace is created only by the shop's first device, which must ask to create it and give the
  **setup code** the server prints when it starts (also in `data/setup-code.txt`; `SETUP_CODE` sets your own,
  `ALLOW_NEW_WORKSPACES=false` turns creation off). Other devices join with the workspace name and passphrase only,
  and a mistyped name is refused instead of creating an empty shop. Names ignore case and spaces (*Verma Kirana* =
  *verma-kirana*). A new passphrase must have 10+ characters, 5+ different characters, and no common password or the
  workspace name in it. *Suggest one* makes a 3 × 4 character passphrase (about 60 bits). The server stores a scrypt
  hash. Wrong guesses are limited to 8 a minute per address and 30 per 15 minutes per workspace from all addresses.
  A device whose passphrase was already accepted skips the limit (and the slow hash), so guessing cannot lock the
  shop's own devices out. **Change passphrase** (Settings → Sync) cuts off a lost phone or a former employee: their
  live feed closes at once, and on their next try the device stops syncing and says why, until the new passphrase is
  typed. Workspaces made before these rules keep their old passphrase and show a warning to change it.
* **Payments across devices.** Every payment row has a permanent id given when it is
  recorded, offline included, and rows are append-only: correcting or removing a payment writes a *reversal* that stays
  visible on the bill (*Reversed: Payments received*), crossed out and not counted. Syncing merges the rows from every
  device, so ₹300 cash taken on one offline device and ₹500 UPI on another are both there afterwards (₹800 paid), in
  either sync order. A repeated, replayed or interrupted sync adds nothing, and the same bank payment (UTR) counts once
  even if two devices recorded it. Paid, balance and status are always recomputed from the rows. Anything two devices
  changed at the same time is shown on the bill as *Changed on two devices at the same time*, with what was kept, until
  the owner taps *Checked*. A bill deleted on one device while another took a payment on it is kept. An edit form left
  open during a sync cannot remove payments it never showed. → [ledger.js](public/js/ledger.js), [details and tests](docs/tech/smart-collect-design.md#financial-records-across-devices-ledgerjs)
* **Stock across devices.** Stock works the same way. Each item keeps a list of movements (opening stock, every sale,
  purchase and return, every number typed by hand) and *Stock in hand* is their sum. Two devices selling the same item
  offline both count after sync (9 in stock, one sold on each: 7), in either order. Deleting or restoring the same bill
  on two devices moves the stock once. Typing a new number records the difference from what you saw, so it adds to
  sales made elsewhere meanwhile instead of wiping them. The item page shows *Stock history*, each sale linked to its bill.
* **Invoice numbers across devices.** Give each device a *device tag* (A, B) so offline devices never issue the same number.
* **The PIN** keeps casual users out on a shared device and separates owner from staff. It is **not** disk encryption:
  stored data is readable by anyone with the unlocked device, so also use the phone/laptop screen lock. Use
  *encrypted backup* for copies that leave the device.
* **Backups** are a single JSON file (`Settings → Backup & restore`), plain or passphrase-encrypted (AES-GCM, PBKDF2
  250k iterations). Restoring replaces everything on that device.
* **Payment events** are created only by the signed webhook. The signing secret stays on the server and is shown to
  the owner on request; devices cannot create or alter them.

---

## Architecture

```
 ┌─────────────────────────── device (browser, works offline) ───────────────────────────┐
 │ views/ (home, counter, lists, forms, inbox, payments, passport, builder, settings)    │
 │   │                                                                                    │
 │ store.js ── schema.js / formula.js (fields, safe formulas) ── rules.js (workflows)    │
 │   │          collect.js (Smart Collect matching)   credit.js (passport)   gst/js/      │
 │ db.js (IndexedDB)            sw.js (precache: app opens with no network)              │
 │   │                                                                                    │
 │ sync.js ── push dirty records / pull since seq ── live feed (SSE-style stream)        │
 └──────┬─────────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS (optional)
 ┌──────▼──────────── server/server.js (one file, zero dependencies) ────────────────────┐
 │ static files · /api/sync · /api/live · /api/export · daily backups                    │
 │ /api/collect/setup · /api/collect/hook/<id> (HMAC) · /api/collect/simulate (sandbox)  │
 │ data/<hash>.json per workspace · data/collect-index.json · data/backups/              │
 └──────▲─────────────────────────────────────────────────────────────────────────────────┘
        │ signed webhook
   UPI collections provider (e.g. Decentro)
```

* **Records** are `{ id, table, data, created, updated, deleted }`. Every table, including the system table `_collect`
  (bank-confirmed payments), syncs through the same path.
* **App definition** (tables, fields, rules, dashboards, settings) is one JSON document that syncs like a record.
* **Pure engines** (`formula`, `schema`, `rules`, `ledger`, `collect`, `credit`, `gst`) have no DOM and are tested directly in Node. The server imports `ledger`, `schema` and the GST hooks, so it merges and recomputes exactly as the devices do.

---

## Configuration

Server environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface (all, so phones on the same Wi-Fi can connect) |
| `DATA_DIR` | `./data` | Workspace files, the Smart Collect hook index and daily backups |
| `ALLOW_NEW_WORKSPACES` | `true` | `false` stops anyone creating a new workspace on this server |
| `SETUP_CODE` | generated | Code a shop's first device must give to create a workspace. Without it, one is made on first start, printed, and kept in `DATA_DIR/setup-code.txt` |
| `CORS_ORIGIN` | *(unset)* | Web pages from other origins allowed to use the API: a comma-separated list of exact origins (`https://vina.example.com`), or `*` on purpose. Unset: only pages served by this server; other sites are refused by the server (403), not just by the browser. **Set this if the app is hosted somewhere else than the sync server** (for example a static host) |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy that does not pass the original `Host`: the `X-Forwarded-Host` it sends then also counts as this server |
| `COLLECT_SANDBOX` | `true` | Allows *Simulate a payment*. **Set `false` in production** |

App settings that matter for payments: *Settings → Your business → UPI ID* (the merchant VPA for the QR), *Settings
→ Smart Collect* (on/off, sandbox), *Settings → Sync* (required for Smart Collect).

---

## HTTP API

All `POST` bodies are JSON. Every device call (`/api/sync`, `/api/live`, `/api/passphrase`, `/api/collect/setup`,
`/api/collect/simulate`) also sends `protocol` (the app's sync protocol, [protocol.js](public/js/protocol.js)); outside the
server's accepted range it is refused before anything is read: `426 { code: "update_required" }` (update the app) or
`409 { code: "server_outdated" }` (update the server). Workspace endpoints authenticate with `{ ws, token }` (workspace name + passphrase). An
unknown workspace is created only with `{ create: true, setupCode }` and a strong passphrase (`400 { error, code:
"weak_short" | "weak_simple" | "weak_guessable" }` otherwise). A wrong name or passphrase is `403`; too many wrong
tries are `429`.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | `{ ok: true }` |
| `POST /api/sync` | workspace | Push `records` and `app`; pull everything after `since`. Returns `{ seq, records, app, ws, weak? }` (`weak`: the passphrase would not be accepted today) |
| `POST /api/passphrase` | workspace | `{ newToken }`: change the passphrase for every device; closes live feeds using the old one |
| `POST /api/live` | workspace | Streaming response; writes `data: {"seq":n}` on every change |
| `POST /api/export` | workspace | Full server-side copy in backup format (`vina-backup`) |
| `POST /api/collect/setup` | workspace | `{ rotate? }` → `{ hookPath, secret, sandbox }` |
| `POST /api/collect/hook/<24 hex>` | `X-Signature: [sha256=]<hex HMAC-SHA256 of raw body>` | Provider webhook → `200 { ok, id }` / `{ duplicate }` / `{ ignored }`, `401`, `404`, `429` |
| `POST /api/collect/simulate` | workspace, sandbox on | `{ amount, ref?, vpa?, name?, phone?, utr? }`: same path as a real webhook |

Accepted webhook fields (flat or under `data`): `utr | rrn | bank_reference_number | bank_ref | npci_transaction_id`,
`amount | transaction_amount | txn_amount`, `reference | reference_id | tr | merchant_reference |
merchant_transaction_id`, `payer_vpa | payer_upi | payer_address | vpa`, `payer_name`, `payer_mobile | payer_phone`,
`status | transaction_status | txn_status | payment_status`, `timestamp | transaction_time`.

---

## Project layout

```
public/                     the whole app (static files; works from any web server)
  index.html  manifest.webmanifest  sw.js (offline service worker; file list from `npm run build:sw`)
  css/app.css               one stylesheet, light and dark
  js/main.js                boot, routing, navigation, lock screen, shortcuts, Smart Collect reconciler
  js/formula.js             safe expression language          js/logic.js     conditions + message templates
  js/schema.js              field types, formulas, validation, search
  js/rules.js               workflow engine                   js/analytics.js dashboard queries
  js/store.js  db.js        records, outbox, approvals; IndexedDB / memory adapters
  js/sync.js   security.js  sync client (+ Smart Collect setup/simulate); PIN + encrypted backups
  js/ledger.js              payments and stock across devices: permanent row ids, reversals, version vectors, merge (pure; server uses it too)
  js/collect.js             Smart Collect: per-bill UPI reference, payment matching (pure), idempotent apply
  js/credit.js              Credit Passport: readiness score, indicative limit, consented export (pure)
  js/print.js               invoices, receipts, UPI QR      js/csv.js  CSV parse/write, Zoho/Vyapar header aliases
  js/ui/                    combobox, line-item grid, form, charts, conditions editor, scanner, icons
  js/views/                 home, lists, record, print, counter (pos), inbox, payments, passport, reports,
                            builder, workflows, dashboards, importer, onboarding, settings
  js/templates/             sector starters (retail, gst, service, blank)
  js/lang/                  hi.js ta.js te.js
  gst/js/                   GST engine (gst.js), returns (returns.js), hooks and screens
server/server.js            static hosting + sync + live feed + daily backups + signed payment webhook
docs/                       strategy memo, PRDs, technical design
scripts/                    icon generator, service-worker list builder, translation extractor
tests/unit  tests/e2e       node:test unit tests; Chrome-driven end-to-end scenarios
```

---

## Extending Vina

* **Add a sector template:** copy [service.js](public/js/templates/service.js), define tables / rules / dashboards as
  plain objects (wrap every visible string in `t()`), and register it in [templates/index.js](public/js/templates/index.js).
  A unit test checks every formula, link and rule condition in every template. Smart Collect and the Credit Passport
  work on any table with a `balance` field and a payments line list (a money column and a mode picker).
* **Add a language:** create `public/js/lang/xx.js` (`export default { 'English text': 'translation' }`), add it to
  `LANGS` in [i18n.js](public/js/i18n.js), run `npm run build:sw`. `npm run i18n:missing -- xx` lists what is
  untranslated; a test fails if a translation drops a `{{placeholder}}` or Hindi misses an everyday-screen string.
  Missing keys fall back to English.
* **Connect a payment provider:** see [Going live](#smart-collect-upi-that-marks-bills-paid) and the
  [technical design](docs/tech/smart-collect-design.md).
* **After adding or renaming any file in `public/`:** run `npm run build:sw` (a test checks the offline file list).

---

## Tests

| Suite | Count | Covers |
|---|---|---|
| [core.test.mjs](tests/unit/core.test.mjs) | 17 | formulas, store, rules, outbox, walk-in sales, backups (including pre-rename files) |
| [gst.test.mjs](tests/unit/gst.test.mjs) | 26 | GSTIN checksum, tax split, numbering, GSTR-1/3B, ITC set-off, e-way bill |
| [assist.test.mjs](tests/unit/assist.test.mjs) | 15 | phone matching, quick create, item codes, usual items, typo search |
| [ledger.test.mjs](tests/unit/ledger.test.mjs) | 21 | the ₹300 + ₹500 acceptance test (both orders), replayed / interrupted sync, reversals, conflicts, delete vs payment, UPI on two devices, upgrade, stale edit form, randomised three-device convergence; stock: the 9 → 7 acceptance test (both orders), hand count vs sale, stale item form, bill edit / delete / restore on two devices, one bill changed twice, upgrade, randomised |
| [platform.test.mjs](tests/unit/platform.test.mjs) | 15 | CSV, translations (hi/ta/te), service-worker list, encryption, sync server, live feed, path traversal |
| [accounts.test.mjs](tests/unit/accounts.test.mjs) | 6 | passphrase rules, creation only with the setup code, a typo creates nothing, names ignore case, setup code persistence and settings, guessing limits per address and per workspace, changing the passphrase, workspaces made before the rules |
| [collect.test.mjs](tests/unit/collect.test.mjs) | 10 | references, matching ladder, idempotency, counter verify, wait-for-bill, owner queue, GST template, signed webhook, forgery refusal, sandbox, secret rotation |
| [credit.test.mjs](tests/unit/credit.test.mjs) | 8 | new shop, strong shop (exact points and limit), risky shop, GST credit notes and B2B financing, export privacy; provenance: typed or copied UTRs, amount cap, sandbox, device-made confirmations |
| [durability.test.mjs](tests/unit/durability.test.mjs) | 2 | server process SIGKILLed right after acknowledged saves and a webhook, then restarted; injected write failures |
| [compat.test.mjs](tests/unit/compat.test.mjs) | 3 | sync protocol policy, refusal before any data is touched, outdated device keeps and later syncs its records |
| [cors.test.mjs](tests/unit/cors.test.mjs) | 3 | same-origin default, listed origins, explicit wildcard |
| [perf.test.mjs](tests/unit/perf.test.mjs) | 1 | 3,000 bills / 2,000 items timings |
| [e2e/run.mjs](tests/e2e/run.mjs) | 30 | real keystrokes in headless Chrome: an outdated app told to update, counter, offline, two devices, live sync, payments and stock on two offline browsers, sync accounts (setup code, typo, change passphrase), PINs, builder, import, Hindi, phone layout, GST, Smart Collect at the counter and later, credit passport |

`npm run test:e2e -- "Smart Collect"` runs only matching scenarios. `SHOTS_DIR=./shots npm run test:e2e` saves screenshots.

---

## Renamed from MSME Builder

The product was called *MSME Builder*; it is now **Vina**. Existing shops keep working:

* **Data on devices is untouched.** The on-device database keeps its original internal name (`msme-builder`), because
  a new name would open an empty database and hide every existing shop's records. It is never shown to anyone.
* **Old backups still restore.** New files say `vina-backup` / `vina-encrypted`; files made before the rename
  (`msme-builder-backup` / `msme-builder-encrypted`) are accepted (unit-tested).
* **Offline cache** now uses the `vina-` prefix, and the old `msme-builder-` caches are cleared on the next update.
* The installed app's name changes after the next visit (`manifest.webmanifest`); the package is now `vina`.

---

## Honest limits

* **One bill changed differently on two devices at once can leave stock off by the difference.** Example: bill quantity
  2 changed to 3 on one device and to 4 on the other. The bill keeps one quantity and the item keeps one of the two stock
  changes, which may not match. Both show a *Changed on two devices* note, and the item note asks for a count.
* **An item's stock history keeps growing.** Every sale adds a row to the item, and the whole item is sent on each sync.
  Measured on a laptop: under 3 ms per sale at 1,000 movements, about 27 ms at 5,000, when the item's record is about
  800 KB. A best-seller at 50 sales a day reaches 5,000 in about 100 days, and a low-end phone is slower. Needs
  compacting old movements (a server-side checkpoint) before long-running use.
* **Merged-in changes do not trigger workflows.** A bill that becomes Paid only because two devices' payments were
  merged does not queue the "receipt when paid" message. Stock that falls to the reorder level only because of another
  device's sales does not raise a low-stock alert until the next sale or edit of that item on this device.
* **Outdated app versions are refused, not merged.** The server only syncs with apps that speak a sync protocol it
  accepts (see *Sync, backup and security*). Apps released before this rule send no protocol number and see a generic
  "Server error 426" instead of the update banner; reloading the app (or reopening it) loads the new version. The
  protocol only protects syncing: an outdated device keeps working offline on its own data until it updates.
* **One passphrase per shop, not per person.** Every device shares the workspace passphrase; there are no per-device
  keys, so cutting off one phone means changing it on all the others. Owner and staff are told apart by the app's
  PINs on each device, not by the server.
* **Synced data is not end-to-end encrypted.** Whoever runs the server can read the shop's records. Use HTTPS, and run
  the server yourself or with someone you trust.
* **Guessing limits reset when the server restarts,** and a device whose passphrase was accepted before a restart must
  pass the limits again until it is recognised. Workspaces made before the passphrase rules keep their old (possibly
  short) passphrase until the owner changes it. The app warns but does not force it.
* **Smart Collect needs a provider and a public server.** It is built and tested against a sandbox that uses the real
  webhook path. Going live needs a UPI collections account (merchant VPA), the provider's payload and signature mapped
  in `normalizeEvent` / `handleCollectHook`, and the sync server reachable over HTTPS with `COLLECT_SANDBOX=false`.
  Whether the provider returns the QR's `tr` reference must be confirmed in its sandbox (PRD-01, open question 1).
  Refunds and chargebacks are recorded (the owner books them on the bill; bank-confirmed money falls at once). A
  reconciliation sweep for lost webhooks is not built yet.
* **The Credit Passport is advisory.** It reads only this app's data. It is not a bureau score, no lender is connected,
  and the export is not yet signed. Its screen is in English for now.
* **WhatsApp/SMS/email are one tap, not fully automatic.** They open the user's own WhatsApp/SMS/email app with the
  message filled in (`wa.me` links: free, no account). Sending with nobody at the screen needs the paid WhatsApp
  Business Cloud API and a server holding the credentials; the **webhook** action is the bridge for that.
* **Scheduled workflows** (payment reminders, late-job alerts) run when the app is opened and about hourly while it
  stays open. There is no background job on a closed phone; they create reminders in the Outbox, they do not send.
* **Translations are first drafts.** Hindi is complete for everyday screens; Tamil and Telugu cover navigation,
  billing, dashboards and customer messages. The owner-side screens (App builder, Settings, Import, Credit passport)
  are English for now. **Have native speakers review before release.**
* **GST is indicative.** Use the *Shop with GST invoices* template for CGST/SGST/IGST, HSN and GSTR-1/3B; validate the
  JSON in the portal's offline tool before filing. The plain *Shop* template keeps a simple tax % per line.
  E-invoicing (IRN) is not built.
* **Barcodes** work with USB/Bluetooth scanners everywhere. Camera scanning needs a browser with BarcodeDetector
  (Chrome / Edge on Android, ChromeOS, macOS) over https or localhost; it is not available on desktop Windows Chrome or
  iPhone Safari, where the button is hidden. It has not been tried on real low-end phones yet.
* **Not built yet:** live Zoho/Google Sheets API connections, import of line-item tables (bills), per-field
  permissions, audit log, multi-branch stock transfer, and end-to-end encryption of synced data on the server.
* Tested in Chrome (desktop, phone-sized viewport). Please try it on the actual low-end Android phones and browsers your users have.

---

## Roadmap

| Next | Why | Doc |
|---|---|---|
| Provider sandbox integration (real webhooks, `tr` round-trip, signature scheme) | Turns Smart Collect from simulated to live | [PRD-01](docs/prd/01-smart-collect.md) |
| Reconciliation sweep for lost webhooks | Closes the remaining gap in collection accuracy | [PRD-01](docs/prd/01-smart-collect.md) |
| Hindi / Tamil / Telugu credit passport; Section 43B(h) reminders for Udyam-registered manufacturers and service providers | Reach and a stronger collection lever | [PRD-02](docs/prd/02-credit-passport.md) |
| Account Aggregator-verified inputs, signed export, lender handoff (ULI / OCEN-style) | From advice to an actual loan | [PRD-02](docs/prd/02-credit-passport.md) |
| Verified Payouts: penny-drop + GSTIN status, pay suppliers from the purchase bill | Money out, with fraud and ITC protection | [PRD-03](docs/prd/03-verified-payouts.md) |

The thinking behind the order: [From khata to credit](docs/strategy/khata-to-credit.md).
