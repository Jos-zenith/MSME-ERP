# PRD-02: Credit Passport

*How ready the shop looks to a lender, read from its own books, with a consented data pack it can share*

| | |
|---|---|
| Status | **Built** (phase 1: score, limit, guidance, export). Phases 2–3 are proposals |
| Owner | APM, Credit |
| Code | [public/js/credit.js](../../public/js/credit.js) (pure engine), [public/js/views/passport.js](../../public/js/views/passport.js) |
| Tests | [tests/unit/credit.test.mjs](../../tests/unit/credit.test.mjs) (5), e2e scenario "credit passport: …" |
| Depends on | Phase 1: nothing external. Phase 2: Account Aggregator / GST data. Phase 3: a regulated lender partner |

## 1. Problem

A kirana or small service business that needs ₹50,000–₹5,00,000 of working capital usually hears "bring 12 months
of bank statements, ITRs and a CA certificate". Many cannot, and fall back on informal credit at far higher rates.
Yet the shop's real cash flow is already recorded in its billing app: what it sells each month, how customers pay,
how fast credit customers settle.

Two gaps:
- **The owner cannot see their standing.** They do not know what a lender looks at, or what to change.
- **The lender cannot trust self-reported numbers.** Sales typed into an app are a claim. Bank-confirmed receipts are
  evidence.

## 2. Users and jobs

| User | Job to be done |
|---|---|
| Owner | "Tell me if I can get a loan, roughly how much, and what to fix first, without filling in a form." |
| Owner | "Let me share my numbers with a lender I choose, without handing over my customers' details." |
| Lender (phase 3) | "Pre-qualify small borrowers cheaply on cash-flow data I can verify." |

## 3. Goals and non-goals

**Goals**
- G1. An explainable readiness score (0–100) from data already in the app. Every point is traceable to a factor the
  owner can see.
- G2. The top 3 actions that would raise it, with the points each could add.
- G3. An indicative working-capital limit grounded in a norm Indian banks actually use.
- G4. A shareable export with aggregates only and an explicit consent block.
- G5. Turn Smart Collect's bank-verified receipts into a measurable trust signal (`verifiedShare`).

**Non-goals**
- Being a credit score or a credit decision. It is labelled indicative everywhere.
- Pulling bureau data, or pulling anything without explicit, purpose-bound consent.
- Lending, or holding funds (phase 3 routes to a regulated lender).

## 4. How the score works (built)

Computed on the device from the bills table and its payments. Pure function, unit-tested.

| Factor | Measures | Points | Full marks at |
|---|---|---|---|
| Trading history | Full months of billing (max 12 read) | 10 | ≥ 12 months |
| Steady sales | Coefficient of variation of monthly sales (last ≤ 6 full months) | 15 | ≤ 20% swing |
| Sales growth | Last 3 full months vs the 3 before | 10 | ≥ +10% |
| Money received digitally | Non-cash share of collections, last 90 days | 20 | ≥ 60% |
| Collection speed | DSO = receivables ÷ billed in 90 days × 90 | 20 | ≤ 15 days |
| Overdue dues | Overdue share of receivables (due date passed, or 30 days with none) | 10 | ≤ 10% |
| Customer spread | Largest customer's share of 90-day sales | 10 | ≤ 20% |
| GST registration | Valid GSTIN (checksum verified) | 5 | Present |

**Bands:** Strong ≥ 75 · Good ≥ 60 · Fair ≥ 40 · Building < 40. Fewer than 3 full months shows an "early picture"
banner.

**Indicative limit** = 20% of annualised turnover × readiness factor (1.0 / 0.75 / 0.5 / 0.25 by band), rounded down
to ₹1,000. The 20% comes from the Nayak Committee norm that Indian banks apply to working-capital limits for micro
and small enterprises. Annualised turnover = average of the last 3 full months × 12 (projected from the current month
when there is no full month).

**Invoice-financing candidates:** unpaid bills to GST-registered buyers, under 90 days late. Shown as an amount the
owner could get paid early (for example through TReDS, where the buyer is on it).

**Design choices**
- **Weights favour what lenders can verify and what the owner can change.** Digital collections and collection speed
  carry 40 of 100 points. History is not shown as an improvement action because the owner cannot speed it up.
- **Cash-only, cash-on-the-spot shops are not punished on speed.** No receivables means full speed points. They lose
  on *digital*, which is fair: their cash flow is unprovable.
- **Credit notes reduce sales; proformas and challans are ignored** (GST document signs from the GST engine).

## 5. The export (built)

`vina-credit-passport-YYYY-MM-DD.json`, format `vina-credit-passport` v1:

- business name, GSTIN (only if valid), state
- **consent:** purpose ("Working-capital loan assessment"), `validUntil` (30 days), and a plain statement of what it
  contains
- score, band, factor points and values, metrics, limit, invoice-finance summary, monthly series
- **basis:** how it was computed, that bank-confirmed receipts are counted in `verifiedShare`, and that it is
  indicative

**Never included:** customer names, phone numbers, bill numbers or individual bills (asserted in unit and e2e tests).
This is data minimisation in the spirit of the DPDP Act, 2023.

## 6. Success metrics

| Type | Metric | Target |
|---|---|---|
| Engagement | % of owners who open the passport monthly | 30% of active owners |
| Behaviour | Change in digital share after first view (cohort vs control) | +10 pts in 60 days |
| Behaviour | Change in DSO for shops that act on "collection speed" advice | −20% in 60 days |
| Funnel (phase 3) | Export → application → sanction → disbursal | Instrumented. Targets after baseline |
| Quality (phase 3) | Lender-reported 90-day default rate by band | Bands rank-order risk (Strong < Good < Fair) |
| Guardrail | Owners reporting the score as "a loan promise" (support tags) | ~0. Copy is revised if this ever appears |

## 7. Requirements and phases

| # | Requirement | Phase | Status |
|---|---|---|---|
| C1 | Score, bands, factor table, top-3 improvements | 1 | Built |
| C2 | Indicative limit on the 20% norm, scaled by band | 1 | Built |
| C3 | Monthly sales chart; received / digital / bank-confirmed table | 1 | Built |
| C4 | Export with consent block; no personal data | 1 | Built |
| C5 | Owner-only (staff cannot open); printable | 1 | Built |
| C6 | Hindi, Tamil and Telugu copy for the passport | 1.1 | Next (owner screens are English today, like Settings) |
| C7 | Section 43B(h) nudge for Udyam-registered micro/small *manufacturers and service providers*: B2B bills unpaid past 45 days get a reminder template that mentions the buyer's deduction timing | 2 | Proposal |
| C8 | Verified inputs via Account Aggregator: bank statement and GST returns pulled with consent, reconciled against in-app sales (a mismatch lowers confidence, not the score) | 2 | Proposal |
| C9 | Signed export: the server signs the passport hash so a lender can check it was not edited | 2 | Proposal |
| C10 | Lender handoff through ULI / OCEN-style connectors to a regulated lender; KFS and disclosures shown in-app; no funds through us | 3 | Proposal |
| C11 | Score calibration on real repayment outcomes (monotonic by band) before any lender relies on it | 3 | Proposal |

## 8. Risks

| Risk | Mitigation |
|---|---|
| Owners read the score as a promise | "Indicative" on the screen, in the export and in the basis text. No lender names or offers in phase 1. |
| Gaming (typing fake sales) | Phase 1 is advisory only. Phase 2 gives weight to bank-confirmed receipts and AA-verified statements. Self-reported data alone never unlocks credit. |
| Model bias against cash-heavy micro shops | The factor table shows exactly why. Guidance points to fixable actions. Monitor approval rates by segment in phase 3. |
| Regulatory (digital lending) | Phase 3 only with a regulated lender. We act as a lending service provider under RBI rules: disclosures, KFS, no pass-through of funds, grievance officer. |

## 9. Open questions

1. Which lenders accept a cash-flow pre-qualification signal, and what format do they want (AA FI types, a ULI
   schema)?
2. Should the export include `verifiedShare` evidence (UTR list) on request, as a stronger proof with explicit extra
   consent?
3. Is 20% × band too conservative for shops with ≥ 70% bank-confirmed inflows? (Calibrate in phase 3.)
