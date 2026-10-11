# Smart Collect: technical design

For engineers. The product view is in [PRD-01](../prd/01-smart-collect.md).

## Flow

```
 counter device                    customer's UPI app          provider (collections)          sync server                    every device
 ─────────────                     ──────────────────          ──────────────────────          ───────────                    ────────────
 bill starts: id fixed
 QR = upi://pay?pa=<merchant VPA>
      &am=<balance>&tr=refFor(id)  ──scan──►  pays  ─────────►  credit confirmed
                                                                POST /api/collect/hook/<id> ─►  verify HMAC(secret, raw body)
                                                                  {utr, amount, reference,      normalizeEvent()
                                                                   payer…, status}              record _collect/<hash(utr)>
                                                                                                (exists? → 200 duplicate)
                                                                                                notify live feed ─────────────►  /api/sync pull
                                                                                                                                 reconcileAll():
                                                                                                                                  matchPayment() → applyMatch()
                                                                                                                                  bill.payments += {UPI, amount, ref: UTR}
                                                                                                                                  rules run (Paid, receipt queued)
                                                                                                ◄──────────── /api/sync push ────  _collect status: matched
```

The server never reads or writes bills. It authenticates the provider, stores the bank's facts, and announces them.
Matching happens on the devices, against whatever table the shop built.

## Data

**Event record** (`table: '_collect'`, id `col_<sha256(utr)[0:20]>`):

| Field | Set by | Notes |
|---|---|---|
| `utr, amount, ref, vpa, name, phone, at, source` | Server only | Read-only to devices: the server overwrites them on any device push |
| `status` | Server (`new`), then devices | `new` → `matched` / `review` / `ignored` |
| `how, by, allocations, unapplied, suggestion, reason, matchedAt` | Devices | `how`: done, verify, ref, party, manual, … `by`: auto or owner |

**Bill payment row** gains `ref` (*UTR / ref*). New templates include it, and `upgradeCollect` adds it once to older
shops.

**Reference**: `refFor(recordId)` is `MB` + 10 base-36 characters from two 32-bit FNV-style hashes of the record id.
It is deterministic (the same on every device) and fits UPI's `tr` (alphanumeric, ≤ 35). No lookup table is needed:
devices recompute references for their open bills.

## Matching ladder (`matchPayment`, pure)

1. **done**: some bill already has a payment row with this UTR → mark the event matched, change nothing.
2. **verify**: the referenced bill has a UPI row with this amount and no UTR (the cashier pressed F2 / "UPI
   received") → attach the UTR to that row.
3. **ref**: the referenced bill is open → pay it; any surplus goes to the same customer's other open bills, oldest
   first. Money left over after that → review.
4. **wait**: the reference is ours (`MB…`) but the bill is not on this device → stay `new` for 12 h (the bill may be
   on a counter or an offline device), then review with suggestions. *This stops a counter payment for a new ₹500
   bill landing on the same customer's older ₹500 bill.*
5. **party**: no reference; the payer's mobile (from the VPA or phone) matches a customer with exactly one open bill
   of that exact balance → pay it.
6. **party-fifo** (suggestion): known payer, several bills → oldest first, owner confirms.
7. **amount** (suggestion): exactly one open bill from the last 45 days with this balance.
8. **none** → owner chooses a bill or marks *not a sale*.

Only 1, 2, 3 (fully allocated) and 5 apply automatically.

## Guarantees and how they are enforced

| Guarantee | Mechanism | Test |
|---|---|---|
| A retried webhook changes nothing | Event id derived from UTR; existing id → `duplicate: true` | `collect server: signed webhook …` |
| The same bank payment is never counted twice | `applyMatch` skips bills that already have the UTR; across devices, the ledger merge keeps one row per UTR (see below) | `… never counts twice`; `UPI across devices …` in ledger.test.mjs |
| Unsigned or mis-signed calls are rejected | HMAC-SHA256 over the raw body, constant-time compare; failures rate-limited per IP | `… bad signatures` |
| Devices cannot forge or alter bank facts | `/api/sync` drops device-created `_collect` records, restores bank fields from the server copy and sends that copy back; every copy the server sends carries `origin: 'server'` and a `bank` snapshot that devices never write, and only that snapshot can make a payment "bank-confirmed" (credit.js) | `… forgeries change nothing`; `provenance: …` in credit.test.mjs |
| Failed or pending payments are not money | Only success statuses are stored | same test (`FAILED` → ignored) |
| Payments never go to the wrong bill by guesswork | Ladder above; `wait` step | `… never pays an older bill by guesswork` |
| Rotating the secret retires the old URL | New hook id + secret; index updated | `… rotating the secret` |

## Financial records across devices ([ledger.js](../../public/js/ledger.js))

Found and reproduced on 2026-10-10: bills synced as whole snapshots, newest copy wins. A ₹300 cash payment on one
offline device and a ₹500 UPI payment on another left only ₹500 after sync, with no warning. That is fixed. The
mechanism and the separate guarantees it provides:

**Model**
- A payments list is declared a **ledger** (`ledger: true` on the field; older shops are migrated once, `collectV` 2).
- Every payment row gets a **permanent id** (`_id`) when it is recorded, offline included, plus when (`_at`) and by
  whom (`_by`). Rows saved before ids existed get a **deterministic** id from record, field, content and position, so
  every device names the same old row the same way.
- Rows are **append-only.** The only in-place change allowed is filling a blank bank reference once (`ref` → UTR).
  Correcting an amount, mode or date writes a **reversal** of the old row (kept in `payments__void` with reason, time
  and person) plus a new row. Removing a row writes a reversal. Nothing is ever deleted.
- Every record carries a **version vector** (`vv`: device → edit count). This tells "B saw A's edit" apart from "A and B
  edited without seeing each other" without trusting device clocks.
- **Totals are derived, never merged.** `paid`, `balance` and `status` are recomputed from the merged rows on the device
  that merges, and on the server whenever it combines two copies (same engine: schema.js and the GST hooks).

**Merge** (`mergeRecords`, the same code on devices and server, in both directions)
- Payment rows: union by id; reversals win; for the same id, a filled bank reference beats a blank one.
- Plain fields: the dominating version wins. If the edits were concurrent, the newer one wins **and** a conflict note
  with both values is stored on the record (`__conflicts`). The owner sees it on the bill and on the home screen,
  and marks it *Checked*.
- Deleted on one device while a payment was recorded on the other: the bill is kept and a note says why.
- One payment corrected differently on two devices: both corrections are kept (no money hidden) and a note asks the
  owner to remove the wrong one.
- **An edit form that was open during a sync** passes the version it started from (`base`). A save can only reverse
  payments the editor actually saw. Payments that arrived meanwhile stay. A payment reversed elsewhere meanwhile stays
  reversed, unless the editor changed its amount, in which case it becomes new money with a note.
- The server returns the merged copy to the sender whenever it differs from what was sent. A repeated or interrupted
  request merges to the same result.

**Stock** (fixed 2026-10-11; reproduced before: true stock 7, shown 8)
- An item's stock is a ledger of **movements** (`stock_moves`, `ledger: true`, hidden). The `stock` field names it
  (`moves: 'stock_moves'`) and is **derived**: the sum of the rows, recomputed after every merge like `paid`, and never
  reported as a conflict.
- A stock workflow (`adjust_stock`) appends a row with the change (`kind: 'rule'`, the rule, the bill). Its id is not
  random. It is a hash of rule, bill, item, what happened (created / updated / deleted) and the bill's version vector
  *before* the change. The same change made on two devices (both delete the same bill, both restore it) is therefore
  one row. Two *different* changes to the same bill version have the same id and different amounts: the merge keeps
  one and writes a note on the item (`kind: 'row'`).
- A number typed or imported for stock becomes an adjustment row: the typed value minus the value the editor saw (`base`
  for an open form). It adds to sales made elsewhere meanwhile instead of replacing them.
- Items saved before this change have a number and no rows. Their first save writes an **opening row** whose id depends
  only on the item, so two devices upgrading the same item write one row. `upgradeStock` (on every start, idempotent)
  converts every number field an `adjust_stock` workflow writes to, including ones made in the App builder. A target
  field without `moves` keeps the old behaviour.
- The item page shows the last 30 movements (*Stock history*), each sale linked to its bill.

**Separate guarantees, each with its test** (tests/unit/ledger.test.mjs unless noted)

| Guarantee | What it means | Test |
|---|---|---|
| **Preservation of distinct payments** | Two different payments on one bill, recorded on two offline devices, both survive sync in either order | `acceptance: ₹300 cash on A and ₹500 UPI on B …` (both orders); e2e `two browsers offline …` |
| **Duplicate prevention** | The same payment delivered twice, a replayed sync request, or an interrupted sync never adds a row | `the same payment delivered twice, a replayed sync request, and an interrupted sync add nothing` |
| **Same bank money counted once** | One UTR matched on two devices, or a counter "UPI received" plus the bank's confirmation, is one payment | `UPI across devices …` |
| **History, not overwrite** | Corrections and removals are reversals with reason, time and person; a stale device cannot bring them back | `payments are append-only …` |
| **Totals agree with rows** | On every device, on the server copy, and after restoring a backup | `the server keeps a consistent copy …` |
| **No silent resolution** | Concurrent edits, double corrections and delete-vs-payment leave a visible note | `simultaneous edits …`, `corrected differently …`, `deleted on one device …` (both timings) |
| **Stale screens are safe** | An open edit form cannot remove unseen payments or revive reversed ones | `an edit form opened before a sync …` |
| **Upgrade is safe** | Rows saved before ids existed are not duplicated when two devices upgrade | `payments saved before rows had ids …` |
| **Convergence** | Random payments, corrections, removals and sync orders on three devices end identical, nothing lost or doubled | `randomised: three devices …` (3 seeds in CI; 25 seeds × 60 steps run once by hand) |
| **Preservation of distinct stock movements** | The same item sold offline on two devices: both sales count, in either sync order, on devices, server and a fresh device | `stock acceptance: the same item sold offline on A and on B …` (both orders); e2e `two browsers offline …` |
| **Stock: the same change counts once** | One bill deleted (or restored) on two devices moves stock once; retries add nothing | `stock: editing, deleting and restoring a bill …` |
| **Stock: corrections add up** | A number typed on one device and a sale on another both count; an open item form cannot undo an unseen sale | `stock: a correction typed on one device …`, `stock: an item form opened before a sync …` |
| **Stock: no silent resolution** | One bill changed differently on two devices leaves a note on the item | `stock: one bill changed differently …` |
| **Stock: upgrade is safe** | Two devices upgrading the same item write one opening row | `stock saved before movements …` |
| **Stock: convergence** | Random sales, deleted bills, hand corrections and sync orders on three devices: stock = opening + corrections − sales on live bills, on every device | `stock randomised …` (3 seeds) |

**Not covered yet (same class, still open)**
- **One bill changed differently on two devices at once** (quantity 2 → 3 on one, 2 → 4 on the other): the bill keeps
  one quantity and the item keeps one stock change, which may not be the same one. Both carry a note; the item's asks
  for a count.
- **Stock history size.** Movements are never compacted, and the whole item record is synced. Measured (laptop, one
  item): under 3 ms per sale at 1,000 movements, about 27 ms at 5,000 (record about 800 KB). Proposed fix: the server
  folds movements older than a cut-off into one checkpoint row that lists the folded ids. Only the server folds, so
  checkpoints never overlap.
- **Workflows do not run on merged-in changes.** If a bill becomes Paid only because two devices' payments were
  merged, the "receipt when paid" message is not queued on either device. Likewise a low-stock alert caused only by
  another device's sales waits for the next local change to that item.
- **Devices on an older version are refused, not merged** (fixed 2026-10-11, [protocol.js](../../public/js/protocol.js)).
  Every device call carries the app's sync protocol; the server accepts a range (4–4 today) and answers 426 (update the
  app) or 409 (update the server) before authenticating or reading the body's records. The device keeps everything
  local and sends it after updating. Tests: compat.test.mjs (policy; refusal creates and changes nothing on any device
  endpoint; an old device keeps its record and syncs it once after updating; a newer app than the server) and the
  e2e scenario *an app version the sync server no longer accepts…*. Apps from before protocols exist send none and are
  treated as protocol 1.
- "Newer" for concurrent plain-field edits uses the record's `updated` time, so device clocks still decide *which*
  value is kept. The other value is never lost: it is in the conflict note.

## Durability: an acknowledgement means the data is on disk

Fixed 2026-10-11: the server answered syncs and webhooks first and wrote the file 300 ms later. A crash in that window
lost changes the device had already marked as synced (it never sends them again) and payments the provider had been
told were received (it never resends them). Reproduced: a workspace created and acknowledged was gone after a hard kill.

Now (server.js, `exclusive` / `commit`):
- Handlers change memory and *declare* what to write (`persist`) and what to do afterwards (`afterCommit`: live
  notifications, closing old feeds). Nothing is answered before `commit()` finishes.
- `writeDurably`: temporary file, `fsync`, `rename` over the old file, `fsync` of the directory (skipped where the OS
  refuses it: Windows). The hook index is written the same way.
- A failed write → the request returns 503, the changed workspaces are dropped from memory (the server falls back to
  the file on disk) and no device is notified. The device keeps the change and resends it; merges are idempotent.
- Workspace-changing API requests run strictly one after another, so a failed write cannot be overwritten by a
  later request that was built on top of it, and no request reads unsaved state.
- Daily backup copies are taken after the durable write and are best-effort (a failed copy is logged, the live file
  is already safe).

Tests (durability.test.mjs): the real server as a separate process, killed with SIGKILL straight after each of ten
acknowledged syncs and after an acknowledged webhook, restarted from the same folder: everything acknowledged is
there and no temporary files are left. And with writes made to fail: the device is told, keeps its change, the server
does not keep or serve it, and the retry lands exactly once.

## Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/collect/setup` `{ws, token, rotate?}` | Workspace passphrase | Returns `hookPath`, `secret`, `sandbox` |
| `POST /api/collect/hook/<24 hex>` | `X-Signature: [sha256=]<hex HMAC>` | Provider webhook. 200 ok / duplicate / ignored, 401, 404, 429 |
| `POST /api/collect/simulate` `{ws, token, amount, ref?, vpa?, name?, phone?, utr?}` | Workspace passphrase; `COLLECT_SANDBOX` not `false` | Sandbox: the same path as a real webhook |

The hook id → workspace index is in `DATA_DIR/collect-index.json` (written atomically). The secret is stored in the
workspace document on the server and is never synced to devices.

## Integrating a real provider

1. Map the provider's payload in `normalizeEvent` (server/server.js). It already accepts common names: `utr / rrn /
   bank_reference_number`, `reference_id / tr / merchant_reference`, `payer_vpa`, `transaction_status`, flat or
   under `data`.
2. Match its signature scheme in `handleCollectHook` (header name, encoding, any timestamp prefix).
3. Set the shop's UPI ID to the provider-issued merchant VPA, and confirm the provider returns our `tr`
   (PRD-01, open question 1).
4. Put the server behind HTTPS and set `COLLECT_SANDBOX=false` in production.

## Known limits

- Financial records across devices: see the section above for what is guaranteed and what is still open (one bill
  changed twice, stock history size, workflows on merged-in changes, devices on older versions).
- One provider per workspace.
- Bank refunds are not handled yet (PRD-01, R15): a refund event should add a negative ledger row. Manual corrections are reversals (above).
- A bill started at the counter and finished on *Full form* gets a new id, so its payment is matched by phone or
  amount suggestion rather than by reference.
- The unverified-UPI check uses record `updated` time as the grace anchor, so editing a bill restarts its 15 minutes.
