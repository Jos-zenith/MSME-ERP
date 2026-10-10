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
| Two devices cannot double-pay a bill | `applyMatch` skips bills that already have the UTR; per-record last-write-wins keeps one version | `… never counts twice` |
| Unsigned or mis-signed calls are rejected | HMAC-SHA256 over the raw body, constant-time compare; failures rate-limited per IP | `… bad signatures` |
| Devices cannot forge or alter bank facts | `/api/sync` drops device-created `_collect` records and restores bank fields from the server copy | `… forgeries change nothing` |
| Failed or pending payments are not money | Only success statuses are stored | same test (`FAILED` → ignored) |
| Payments never go to the wrong bill by guesswork | Ladder above; `wait` step | `… never pays an older bill by guesswork` |
| Rotating the secret retires the old URL | New hook id + secret; index updated | `… rotating the secret` |

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

- One provider per workspace.
- No refunds or reversals yet (PRD-01, R15).
- A bill started at the counter and finished on *Full form* gets a new id, so its payment is matched by phone or
  amount suggestion rather than by reference.
- The unverified-UPI check uses record `updated` time as the grace anchor, so editing a bill restarts its 15 minutes.
