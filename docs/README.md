# Product docs

Vina (formerly MSME Builder) started as an offline-first billing, stock and GST app for small Indian shops. These documents take it
from **recording money** to **moving and financing money**, on top of payment and verification APIs such as Decentro's.

| Read | What it is | Status |
|---|---|---|
| [Strategy: from khata to credit](strategy/khata-to-credit.md) | Why this, why now, how it makes money, what we measure | Proposal |
| [PRD-01: Smart Collect](prd/01-smart-collect.md) | UPI payments that mark bills paid by themselves, with the bank's UTR | **Built** (sandbox) |
| [PRD-02: Credit Passport](prd/02-credit-passport.md) | Loan-readiness score and consented data pack from the shop's own books | **Built** |
| [PRD-03: Verified Payouts](prd/03-verified-payouts.md) | Pay suppliers from the app, after bank-account and GSTIN verification | Roadmap |
| [Tech note: Smart Collect](tech/smart-collect-design.md) | Architecture, data model, security, failure modes | Built |

Reading order: strategy (10 min), then the PRD for the area you own. Engineers can go straight to the tech note.

**What "built" means here.** The feature works end to end against a **sandbox**: the sync server receives a signed
webhook exactly as a provider would send it, and *Settings → Smart Collect → Simulate a payment* drives that path for
demos. Going live means mapping one provider's webhook fields in `normalizeEvent` (server/server.js) and pointing the
provider at the webhook URL. No provider credentials are in this repository.

Tests that back the claims in these docs:

```
npm test                          # 127 unit tests; collect, credit, ledger (payments and stock across devices) and accounts (sync passphrases) .test.mjs cover this work; durability, compat and cors cover the integrity fixes of 2026-10-11
npm run test:e2e                  # 30 browser scenarios; the last five cover Smart Collect, the Credit Passport, payments and stock on two offline browsers, and sync accounts
```
