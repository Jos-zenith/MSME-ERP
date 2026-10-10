# From khata to credit

*Strategy memo · MSME Builder × payment and verification APIs (for example Decentro) · October 2026 · Status: proposal*

## The one-line version

Every bill a small shop raises is money it is owed. Today that bill stops being useful once it is printed. **We make
every bill collectable (Smart Collect), every payment provable (bank UTR on the record), and the resulting history
financeable (Credit Passport).** We do it inside a billing app the shop already uses every day, on a cheap phone and
with poor internet.

## The problem, in the shop's words

| What the owner says | What is actually going on |
|---|---|
| "Customer showed me a payment screenshot. Was it real?" | UPI confirmation reaches the customer's phone, not the shop's books. Fake-screenshot fraud is common enough that soundbox devices became a mass product just to announce payments out loud. |
| "I spend the evening matching UPI credits to bills." | Static QR codes carry no bill reference. Every credit in the bank app must be matched by hand to a name and an amount. |
| "Ravi paid ₹2,000. Which of his bills was that for?" | Khata customers pay in round numbers against several bills. Matching is guesswork. |
| "The bank wants 12 months of statements, ITRs and a CA certificate." | The shop's real cash flow is in its bills and UPI credits, but nothing turns that into the evidence a lender accepts. |
| "I need ₹50,000 for Diwali stock. The moneylender charges 3% a month." | Formal working-capital credit does not reach most micro shops. |

## Why now (the Indian context)

These are directional figures from public sources. Check the latest numbers before quoting them externally.

- **UPI is the default rail for small payments.** It handled over 20 billion transactions a month by late 2025
  (NPCI). For a kirana shop, the money already moves digitally. What is missing is the *record*.
- **Merchant UPI earns no MDR.** P2M UPI has carried zero merchant discount rate since 2020. A business here cannot be
  built on payment fees. It has to be built on what payments enable: reconciliation, working capital, and verified
  data. That shapes our business model below.
- **The credit gap is structural.** IFC (2018) put the addressable MSME credit gap at about ₹25.8 lakh crore. Lenders
  cite the same reason every time: no reliable, verifiable cash-flow data on small borrowers.
- **The public rails for consented data now exist.** Account Aggregator (RBI NBFC-AA framework), GST data available
  through AA, OCEN, and RBI's Unified Lending Interface (ULI) all assume the borrower can share their own data with
  consent. A shop's billing app is the natural place where that consent starts.
- **The rules reward clean, consented data.** The DPDP Act, 2023 (consent and purpose limitation) and RBI's digital
  lending rules (2022 guidelines, consolidated as Directions in 2025: money moves between borrower and regulated
  lender, and service providers do not hold funds) both favour a design that never touches money and shares only
  what the owner chooses.
- **Late payment now has a tax cost for some buyers.** Under Section 43B(h) of the Income-tax Act (from FY 2023-24),
  a buyer can claim a deduction for payment to a Udyam-registered *micro or small manufacturer or service provider*
  only once it is paid within the MSMED Act limit (15 days, or up to 45 with a written agreement). This does not cover
  traders, so it matters for our service and manufacturing users, not for kirana shops. Phase 2 uses it as a
  collection lever (see PRD-02).

## What we built, and why in this order

```
          Today                        Smart Collect (PRD-01)                Credit Passport (PRD-02)        Verified Payouts (PRD-03)
  bill ─► printed / WhatsApp    bill ─► QR with its own reference    books ─► readiness score + limit    supplier ─► penny-drop + GSTIN
          paid? owner checks           bank confirms ─► bill paid           consented data pack ─►           check ─► pay from the app
          bank app by hand             with UTR, on every device            lender of the owner's choice
```

1. **Smart Collect comes first because it is the wedge.** It solves a pain the owner feels at the counter every day
   (fake screenshots, evening reconciliation). It needs no behaviour change from the customer, who scans a QR as
   before. And it creates **bank-verified receipts**, the raw material for everything after it.
2. **Credit Passport comes second because it monetises the data.** A score built on *verified* inflows is worth more
   to a lender than self-reported sales. It also gives the owner a reason to push customers towards UPI, which feeds
   step 1.
3. **Verified Payouts closes the loop.** Money comes in through Smart Collect and goes out to suppliers. With both
   directions in the app, it becomes the shop's operating account in practice, without holding funds.

### The flywheel

More UPI collected through Smart Collect → more bank-verified history → a higher Passport score and a better limit
→ the owner pushes UPI harder (the passport tells them to: "+N points possible") → more Smart Collect volume. Every
turn also improves the platform's matching data and lender-side default models.

## How this fits a Decentro-style API stack

Product capability → API family it needs. Exact endpoints and field names are decided at integration time. The code
keeps the provider behind one normaliser, `normalizeEvent` in server/server.js.

| Capability | API family | Where it shows up |
|---|---|---|
| A collections VPA per shop; payment confirmation webhooks with UTR and reference | UPI collections / dynamic QR / virtual accounts | Smart Collect (built against a sandbox) |
| Retrieve a payment by reference when a webhook is missed | Transaction status | Smart Collect reconciliation sweep (P1) |
| Verify supplier bank accounts (penny drop, name match) and GSTINs | KYC / verification | Verified Payouts (roadmap) |
| Pay suppliers | Payouts | Verified Payouts (roadmap) |
| Consented bank and GST data for lenders | Account Aggregator | Credit Passport phase 2 |
| Route a loan application to a lender | Lending marketplace / ULI-OCEN connectors | Credit Passport phase 3 |

**Why this matters for an API company.** The billing app is a distribution channel for the APIs. Each shop that turns
on Smart Collect is a merchant VPA and a stream of collection events. Each passport shared is a lead for the lending
stack. Each supplier verified is a KYC call, and each one paid is a payout.

## Business model (hypothesis to test)

| Stream | Who pays | Shape | Notes |
|---|---|---|---|
| Collections | Shop (bundled plan) | Small monthly fee for Smart Collect, or per-transaction on non-UPI rails | UPI P2M has zero MDR, so the value sold is reconciliation, not processing |
| Lending distribution | Lender | Fee on disbursed loans (as an RBI-compliant lending service provider) | The largest pool. Needs a regulated lender partner and full LSP disclosures |
| Verification and payouts | Shop | Per-payout fee; verification bundled | Low unit price, high frequency |
| Invoice discounting referrals | Platform / financier | Fee on discounted value | For B2B sellers with GST-registered buyers |

The free core (billing, stock, GST, offline) stays free. It is the distribution, not the product we charge for.

## What we measure

**North-star metric: ₹ of receivables settled with a bank-verified UTR per active shop per month.** It grows only when
collection, verification and adoption all work together.

| Layer | Metric | First target (pilot, 90 days) |
|---|---|---|
| Adoption | % of active shops with Smart Collect on | 25% of shops with sync on |
| Reliability | Auto-match rate (matched without the owner) | ≥ 90% of events |
| Correctness | Wrongly applied payments (guardrail) | 0 confirmed. Every reversal investigated |
| Speed | Bill shows paid, p95, after the bank confirms | ≤ 5 s on a live connection |
| Owner value | Minutes per day spent reconciling (survey and diary) | −50% |
| Receivables | Days sales outstanding (DSO) for credit shops | −20% |
| Credit | Passports exported → lender applications → sanctions | Funnel instrumented. Targets set after 4 weeks of baseline |

## Risks we are choosing to carry

| Risk | Mitigation in the design |
|---|---|
| A wrong auto-match pays the wrong bill | Auto-apply only when sure (the bill's own reference, or the payer's phone plus the exact amount). Everything else is a suggestion. Payments that carry our reference *wait* for their bill rather than guess (a tested case). |
| Double-counting (retries, two devices) | Idempotent by UTR at the server (record id = hash of UTR) and at the bill (no second row with the same UTR). |
| A staff device forges a "bank confirmed" event | Only the webhook creates payment events. The server refuses device-created ones and keeps the bank's fields read-only (tested). |
| We become a payment aggregator by accident | We never hold or route funds. Money goes from the payer to the shop's account at the provider. We receive notifications only. |
| A lender treats the score as a credit decision | It is labelled indicative everywhere. The export says so, lists its basis, and carries a consent block with purpose and expiry. |
| Privacy | The passport export holds aggregates only: no customer names, phones or bill numbers (tested). |

## Asks

1. A sandbox account with a UPI collections provider to replace the simulator with real webhooks (1 week).
2. Ten pilot shops in one city: 5 kirana and 5 service businesses, all with sync on (4 weeks).
3. A conversation with one NBFC partner about what they would accept as a pre-qualification signal (feeds PRD-02 phase 3).
