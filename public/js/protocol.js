// Sync protocol: what a device and the sync server must agree on before they exchange records.
//
// Each number names a set of rules for what a device writes, or must understand, so that merging never loses or
// misstates money. It changes only when those rules change, never with ordinary releases. The server accepts a range
// and refuses anything outside it before reading any data: a device that is too old is told to update (its own records
// stay on it, untouched, and sync after the update); a device newer than the server is told the server needs updating,
// so it never sends records the server would merge by older rules.
//
//   1  whole records, newest copy wins (before 2026-10-10). A device that sends no protocol number is a 1.
//   2  payments are an append-only ledger: permanent row ids, reversals, version vectors, conflict notes (ledger.js)
//   3  stock is a ledger of movements (stock_moves); `stock` is their sum
//   4  "bank-confirmed" comes only from the server's `bank` snapshot on payment records (collect.js bankConfirmations).
//      A 3 would still call typed UTRs bank-confirmed in its credit passport, so it is not accepted either.
//
// Raise SYNC_PROTOCOL when devices must follow a new rule. Raise the server's minimum (SERVER_ACCEPTS.min) only when
// older devices would lose data or report something false; otherwise let the range widen.

export const SYNC_PROTOCOL = 4;
export const SERVER_ACCEPTS = { min: 4, max: 4 };
export const LEGACY_PROTOCOL = 1;

/** null when compatible; otherwise { status, code, error } for the device. */
export function protocolProblem(sent, accepts = SERVER_ACCEPTS) {
  const n = Number.isInteger(sent) ? sent : LEGACY_PROTOCOL;
  if (n < accepts.min) {
    return { status: 426, code: 'update_required', error: `Update to keep syncing. This app (sync protocol ${n}) is older than the server accepts (${accepts.min}). Everything on this device is kept and syncs after the update.` };
  }
  if (n > accepts.max) {
    return { status: 409, code: 'server_outdated', error: `The sync server needs an update. This app uses sync protocol ${n}; the server understands up to ${accepts.max}. Nothing was sent.` };
  }
  return null;
}
