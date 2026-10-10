# PRD-03: Verified Payouts (roadmap)

*Pay suppliers from the purchase bill, after their bank account and GSTIN are verified*

| | |
|---|---|
| Status | Proposal. Not built |
| Owner | APM, Payments |
| Builds on | Purchases table (exists), GSTIN checksum (exists), Smart Collect's signed webhook and idempotency patterns |
| Depends on | Verification APIs (bank account penny drop or penny-less, name match; GSTIN status) and a payouts API |

## 1. Problem

Shops pay suppliers by UPI or bank transfer from a personal banking app, then record the purchase separately, if at
all. Three things go wrong:

- **Wrong-account and impersonation fraud.** "Our bank details have changed" messages work because nobody checks
  whose account it is.
- **Input tax credit lost.** A supplier with a cancelled or wrong GSTIN means the shop's GST credit on that purchase
  is at risk. The app checks the GSTIN *checksum* today, not whether it is *active*.
- **Purchases and payments drift apart.** The books do not show what is still owed to whom.

## 2. Goals

- Verify a supplier once: bank account exists, the name on it matches the supplier, and the GSTIN is active.
- Pay a purchase bill from the bill. The payout carries the bill reference, and its UTR lands on the bill
  automatically (the same matching and idempotency as Smart Collect, in the other direction).
- The owner approves every payout. Staff can only prepare them. This reuses the existing approvals workflow.

**Non-goals:** holding a wallet balance, credit lines to pay suppliers (later, with a lender), or international
payments.

## 3. Experience (proposal)

1. **Supplier → Verify.** The app sends account number + IFSC (and GSTIN) to the verification API and shows: *"Bank
   account belongs to SHREE GANESH TRADERS ✓ matches"*, *"GSTIN active since 2019 ✓"*. The result and its timestamp
   are stored on the supplier. If any detail changes later, verification is required again.
2. **Purchase bill → Pay.** Amount defaults to the balance. Staff tap *Request payment*, the owner gets an approval
   (existing workflow), and on approval the payout goes out from the shop's funding account at the provider.
3. **Confirmation.** The payout webhook (signed, idempotent by UTR) marks the purchase paid with the UTR. A failure
   returns the bill to *Unpaid* with the reason.

## 4. Requirements

| # | Requirement | Priority |
|---|---|---|
| V1 | Bank account verification with name match score, stored with timestamp; re-verify on any change | P0 |
| V2 | GSTIN status check (active / cancelled / suspended) on supplier save and before payout | P0 |
| V3 | Payout only to a verified account, only after owner approval | P0 |
| V4 | Payout webhook → purchase marked paid with UTR; idempotent; failures reversed visibly | P0 |
| V5 | Daily payout limit set by the owner; two-step confirmation above it | P1 |
| V6 | "Verified supplier" badge; warning on purchase entry for an unverified or cancelled-GSTIN supplier | P1 |
| V7 | Bulk pay due purchases (weekly supplier run) | P2 |

## 5. Metrics

- % of payout volume to verified accounts: 100% by design (a guardrail, not a target)
- Purchase bills paid in-app ÷ purchase bills
- Input tax credit at risk flagged (₹ of purchases from cancelled-GSTIN suppliers)
- Time from approval to supplier credit, p95

## 6. Risks

| Risk | Mitigation |
|---|---|
| Money-movement compliance | Payouts run from the shop's own account at a regulated provider. We never hold funds. |
| A compromised owner device approves payouts | Owner PIN required for approval, daily limit, alert to the owner's phone on every payout |
| Name-match false negatives (trade names vs legal names) | Show the bank's name and let the owner confirm, with a reason recorded |

## 7. Why it is third

It needs live money movement, a funding account per shop and stronger device security. Smart Collect and the
Passport create value with notifications and data alone. They prove the matching and idempotency patterns this
PRD reuses, and they earn the owner's trust before we ask to move their money.
