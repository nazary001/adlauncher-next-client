// Google Ads rail — which launch accounts are ACTIVE on Google (owner ask 21.09: the pickers list
// only those). Pure and dependency-free (node --test).
//
// The status is the `status` word google-weapon puts on every account of its customers list
// (Google's CustomerStatus passed through by LION since 25.09: ENABLED | SUSPENDED | …), read live
// with the list. Only ENABLED may launch; every other word — and a missing one — hides the account
// with a reason, so nothing is ever guessed alive. The campaign-derived book of 21.09 (LION's
// metrics `account_status` folded over days and remembered in app-cache) is gone: the list is the
// one source (owner call 25.09).

/** The status LION showed for one account, and the São Paulo day (YYYY-MM-DD) it was read. */
export type GoogleAccountVerdict = { status: string; day: string };

/** The one CustomerStatus word an account may launch on. */
export const GOOGLE_LIVE_STATUS = "ENABLED";
/** Stamped on an account whose row carried no status at all — not known to be active. (Not a
 *  Google word: Google's own UNKNOWN / UNSPECIFIED stay distinguishable in the reason.) */
export const GOOGLE_NO_STATUS = "NO_STATUS";

const norm = (s: unknown): string => String(s ?? "").trim().toUpperCase();

/**
 * The verdict from the customers list's `status` field, as of `day` (the São Paulo day of the
 * read): null when the account may launch (ENABLED); otherwise the dead verdict — SUSPENDED,
 * CANCELED, CLOSED, a word we have never seen, or NO_STATUS for a row that carried none.
 */
export function googleCustomerStatusVerdict(status: unknown, day: string): GoogleAccountVerdict | null {
  const word = norm(status) || GOOGLE_NO_STATUS;
  return word === GOOGLE_LIVE_STATUS ? null : { status: word, day };
}

/** "suspended on Google (LION saw it 25.09)" — the reason a refusal and the board's note print. */
export function googleAccountDeadReason(v: GoogleAccountVerdict): string {
  const [, m, d] = v.day.split("-");
  if (v.status === GOOGLE_NO_STATUS) return `without a status on LION's list (${d}.${m}) — not known to be active`;
  return `${v.status.toLowerCase()} on Google (LION saw it ${d}.${m})`;
}

/** An account of the partner's list as the catalog needs it (the picker row type extends this). */
export type GoogleCatalogCustomer = { customerId: string; name: string; mccId?: string; status?: string };
/** A partner account the catalog keeps off the pickers, with the reason a route or a board prints. */
export type GoogleHiddenAccount = { customerId: string; name: string; status: string; day: string; reason: string };

/**
 * The launch catalog from the partner's list: `customers` = the accounts the console offers AND
 * accepts as targets (the owner's allowlist, ENABLED on Google), `suspended` = allowlisted accounts
 * hidden because they are not (the boards name them), `dead` = EVERY partner account that is not
 * ENABLED, listed or not (a JURO lands on its source's own account, which no picker ever offered —
 * the routes refuse from this list). Input order is kept.
 */
export function foldGoogleLaunchCatalog<C extends GoogleCatalogCustomer>(
  all: readonly C[],
  day: string,
  isLaunchAccount: (c: C) => boolean,
): { customers: C[]; suspended: GoogleHiddenAccount[]; dead: GoogleHiddenAccount[] } {
  const customers: C[] = [];
  const suspended: GoogleHiddenAccount[] = [];
  const dead: GoogleHiddenAccount[] = [];
  for (const c of all) {
    const verdict = googleCustomerStatusVerdict(c.status, day);
    const hidden = verdict ? { customerId: c.customerId, name: c.name, status: verdict.status, day: verdict.day, reason: googleAccountDeadReason(verdict) } : null;
    if (hidden) dead.push(hidden);
    if (!isLaunchAccount(c)) continue;
    if (hidden) suspended.push(hidden);
    else customers.push(c);
  }
  return { customers, suspended, dead };
}
