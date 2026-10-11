# PRD-01: Smart Collect

*UPI payments that mark bills paid by themselves, with the bank's UTR*

| | |
|---|---|
| Status | **Built**, against a sandbox. Ready for a provider integration and a pilot |
| Owner | APM, Collections |
| Code | [public/js/collect.js](../../public/js/collect.js), [server/server.js](../../server/server.js) (Smart Collect section), [views/pos.js](../../public/js/views/pos.js), [views/payments.js](../../public/js/views/payments.js) |
| Tests | [tests/unit/collect.test.mjs](../../tests/unit/collect.test.mjs) (10), e2e scenarios "Smart Collect: …" (2) |
| Depends on | A UPI collections provider (merchant VPA + payment webhook), and the sync server reachable over HTTPS |

## 1. Problem

A shop shows a static UPI QR. The customer pays, and the shop then has two problems:

1. **Is it real?** The confirmation is on the *customer's* phone. Owners and cashiers judge a screenshot, and fakes get
   through. Hardware soundboxes exist to solve exactly this.
2. **Which bill was it for?** A static QR carries no bill reference. At the end of the day, someone matches bank
   credits to bills by name and amount. For khata (credit) customers paying round sums against several bills, this is
   guesswork, and errors cause disputes.

The app already had a "UPI received" button. It records what the cashier *believes*, not what the bank *confirmed*.

## 2. Users and jobs

| User | Job to be done |
|---|---|
| Cashier at the counter | "Tell me the money has actually arrived before I hand over the goods, without looking at anyone's phone." |
| Owner, evening | "Show me which bills are paid, and only ask me about the payments you could not place." |
| Owner, credit customers | "When a customer pays from the WhatsApp bill days later, mark that bill paid and thank them, without me doing anything." |

## 3. Goals and non-goals

**Goals**
- G1. A UPI payment against a bill's QR marks that bill paid, with the bank's UTR, on every device, within seconds
  of the bank's confirmation.
- G2. Never apply money to the wrong bill. When unsure, ask the owner and offer a suggestion.
- G3. Never count money twice, whatever the provider retries or devices race.
- G4. Billing keeps working offline. Only the confirmation needs a connection, and it can catch up later.
- G5. Make unconfirmed "UPI received" claims visible: the fake-screenshot check.

**Non-goals (v1)**
- Holding or routing funds. Money goes from payer to the shop's account at the provider, and we only receive notices.
- Refunds, chargebacks, UPI Autopay mandates (later PRD).
- Card and net-banking reconciliation (the same design applies; the next rail after UPI).

## 4. Success metrics

| Type | Metric | Target (pilot) |
|---|---|---|
| North star | ₹ settled with a bank UTR per active shop per month | Baseline in week 1, then +25% month on month |
| Primary | Auto-match rate: events matched without the owner | ≥ 90% |
| Primary | Time from bank confirmation to "paid" on screen, p95 | ≤ 5 s (live connection) |
| Guardrail | Payments applied to the wrong bill | 0. Each reversal gets a root-cause review |
| Guardrail | Duplicate payment rows (same UTR twice) | 0. Prevented by design and tested |
| Secondary | Unverified UPI claims per 100 UPI bills | Falls week on week as staff learn to wait for "confirmed" |
| Secondary | Owner minutes per day reconciling (diary study) | −50% |

## 5. The experience

### 5.1 At the counter (built)

1. Cashier scans items and presses **F2 (UPI)**. The QR shows the exact amount and carries this bill's own reference
   (`tr=MBxxxxxxxxxx`). The bill's id is fixed when the bill starts, so the reference exists before the bill is saved.
2. Under the QR: *"Waiting for the payment… it is confirmed here by itself"* (pulsing dot).
3. The customer pays. The provider notifies the sync server, which tells every device. Within a second or two:
   **"₹149.10 received · confirmed by the bank · UTR 4123…"**. If the customer paid less: *"₹100 received, ₹49.10
   still to pay"*.
4. **Enter** saves. The UPI payment row carries the UTR. No second confirmation step.

### 5.2 Later payments (built)

A credit customer pays days later from the QR on their WhatsApp bill or printed invoice. The bill turns **Paid**. The
existing "receipt" workflow queues a thank-you message, written from the paid bill. A toast shows
*"₹546 received by UPI · INV-0011 marked paid"*.

### 5.3 The owner's queue (built): Messages & approvals → Payments

- **Payments to match:** confirmed money we could not place for sure. Each shows the payer, UTR and our suggestion
  (for example *"INV-0003 ₹500, INV-0007 ₹200"*), with **Apply**, **Choose bill…** (closest amounts first) and
  **Not a sale**.
- **Marked UPI, not confirmed by the bank:** bills someone marked "UPI received" with no bank confirmation after 15
  minutes, with who marked it. This is the fake-screenshot check.
- **Recently confirmed:** what happened automatically, with UTRs. This is the audit trail.

The bell badge and the home screen's *Needs attention* card count the first two lists.

### 5.4 Settings (built)

Turn on, see the webhook URL and signing secret (copy and rotate), toggle sandbox, **Simulate a payment**, and see
30-day stats (*"42 payments matched by themselves (₹38,400) · 95% automatic"*).

## 6. Requirements

| # | Requirement | Priority | Status |
|---|---|---|---|
| R1 | Per-bill reference in the UPI QR (`tr`), stable across devices, 12 characters, alphanumeric | P0 | Built |
| R2 | Signed webhook endpoint per workspace (HMAC-SHA256 of the raw body, constant-time compare); rotate secret | P0 | Built |
| R3 | Idempotency by UTR at the server (event id = hash of UTR) and at the bill (no second row with that UTR) | P0 | Built |
| R4 | Matching ladder: already-recorded → verify counter claim → bill reference → payer phone + exact amount → suggestions | P0 | Built |
| R5 | A payment that carries our reference but whose bill is not on this device *waits* (12 h) instead of guessing | P0 | Built |
| R6 | Overpayment and unmatched money go to the owner, never auto-applied | P0 | Built |
| R7 | Devices cannot create or alter bank events (server-side) | P0 | Built |
| R8 | Live confirmation at the counter; one-tap simulate in sandbox | P0 | Built |
| R9 | Owner queue: apply suggestion, choose bill, not a sale | P0 | Built |
| R10 | Unverified UPI claims list (grace 15 min, only from the day Smart Collect was enabled) | P1 | Built |
| R11 | Existing shops get the `UTR / ref` column once (migration) | P1 | Built |
| R12 | Reconciliation sweep: fetch payments by reference from the provider for bills marked UPI with no event after N minutes (covers lost webhooks) | P1 | Next |
| R13 | Per-shop provider VPA onboarding inside the app (KYC handoff to the provider) | P1 | Next |
| R14 | Timestamped signature header to bound replay windows (replay is already harmless because of R3) | P2 | Next |
| R15 | Refunds: a negative event reverses the row with that UTR and flags the bill | P2 | Later |

## 7. Key decisions

| Decision | Chosen | Alternatives considered | Why |
|---|---|---|---|
| Where matching runs | On the devices, against local data | On the server | The server never sees the app's schema and stays a dumb relay. Matching works for any table built in the App builder. Offline devices catch up. |
| How certain before auto-applying | Only the bill's own reference, or payer phone + exact balance with a single candidate | Amount-only matching | Amount-only collisions are common in a kirana (₹50, ₹100). A wrong match costs more than a question. |
| Counter flow when the cashier already pressed "UPI received" | *Verify* that row by attaching the UTR | Add a second payment | The cashier's claim and the bank's word describe the same money. Verifying keeps one row and makes unverified claims visible. |
| Static QR or provider-generated dynamic QR | QR made on the device with `tr` | A dynamic QR created through the provider API per bill | Works offline and costs no API call per bill. Needs the provider to echo `tr` (open question 1). Dynamic QR stays as the fallback. |
| Event storage | A `_collect` system table that syncs like any record | A separate queue and API | Reuses the sync, backup and live feed already built and tested. One data path. |

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Provider does not return `tr` for on-device QRs | Medium | High | Confirm in the sandbox (open question 1). Fallback: dynamic QR via the provider API when online, static QR + phone matching when offline. |
| A payment recorded on another device is overwritten (record-level last-write-wins sync) | Medium with 2+ devices offline | **High**: money silently disappears from the books | **Fixed 2026-10-10** (ledger.js): permanent row ids, append-only reversals, merge on sync, totals recomputed, conflict notes. 13 unit + 1 browser test. Same class, stock levels: **fixed 2026-10-11**, stock is a ledger of movements (8 more unit tests; the browser test also sells on both devices). Remaining: one bill changed differently on two devices at once (flagged); stock history grows without compaction |
| Lost webhook | Low | Medium | R12 reconciliation sweep, plus the unverified list makes it visible. |
| Wrong match | Low (by design) | High | Conservative auto-apply, hold for reference-carrying events, owner queue, full audit trail with UTR. |
| Server not reachable from the internet | High for self-hosters | High | Docs cover HTTPS tunnels. The hosted option is the commercial path. |
| Staff ignore "waiting" and hand over goods | Medium | Medium | The unverified list names who marked it. Training copy at the counter. |

## 9. Compliance notes

- **We do not hold funds.** Payer → provider → shop's settlement account. The app and server only receive
  notifications, which keeps us out of payment-aggregator scope. Confirm with counsel before launch.
- **Data:** payer VPA, name and phone sit in the shop's own workspace (their customer data) and are never shared
  outside it. Retention follows the workspace's backups (14 days on the server).
- **Signing secret** lives only on the server and is shown to the owner on request. Rotation retires the old URL.

## 10. Rollout

1. **Sandbox (done):** simulator through the real webhook path; unit and e2e tests.
2. **Provider sandbox (1 week):** map `normalizeEvent` to the provider's payload; confirm `tr` round-trip (Q1);
   signature scheme.
3. **Pilot (4 weeks, 10 shops, sync on):** feature flag per workspace. Weekly review of every review-queue item and
   every reversal. Diary study for reconciliation time.
4. **Exit criteria for wider release:** auto-match ≥ 90%, zero wrong applications, p95 ≤ 5 s, and 7 of 10 shops keep
   it on.

## 11. Open questions

1. Does the provider echo the payer-app `tr` (or our reference) for on-device QRs with its merchant VPA? If not, use
   dynamic QR per bill when online.
2. What is the provider's exact webhook signature scheme (header name, timestamp, encoding)? `normalizeEvent` and the
   signature check are the only code that changes.
3. Should a partially paid bill at the counter auto-save as part-paid, or always wait for the cashier? (v1: the
   cashier decides.)
4. What hold window suits reference-carrying events whose bill never arrives? (v1: 12 h.)
