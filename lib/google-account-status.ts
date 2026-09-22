// Google Ads rail — which launch accounts are SUSPENDED on Google (owner ask 21.09: the pickers
// list only accounts that are not). Pure and dependency-free (node --test).
//
// The only place the status is visible to us is LION's Google metrics: every campaign row of a day
// carries its account's `account_status` (ENABLED | SUSPENDED, Google's CustomerStatus passed
// through; google-weapon's customers list has no status, and our own Google Ads API cannot see
// LION's MCC). Two facts shape the rule (read live 15–21.09):
//   • a suspended account stops delivering, so a day or two later it has NO rows at all — the
//     verdict is its LATEST seen status, never "today's";
//   • …and a week later it is out of any scan window — so the book is REMEMBERED (app-cache) and a
//     verdict only changes when a NEWER day says otherwise (a reinstated account shows up ENABLED
//     as soon as one of its campaigns delivers again).
// An account the metrics never showed (brand new, nothing launched yet) has no verdict: it is
// offered — the filter hides what is known to be dead, it never guesses.

/** The latest status LION showed for one account, and the São Paulo day (YYYY-MM-DD) it was seen. */
export type GoogleAccountVerdict = { status: string; day: string };
/** customer id → its latest verdict. */
export type GoogleAccountStatusBook = Record<string, GoogleAccountVerdict>;

/** Google's CustomerStatus values an account cannot launch on. */
const DEAD_STATUSES: ReadonlySet<string> = new Set(["SUSPENDED", "CANCELED", "CLOSED"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s: unknown): string => String(s ?? "").trim().toUpperCase();

/**
 * Fold one day's metrics rows into the book (returns a NEW book; `changed` = something moved).
 * A newer day always wins; the same day again only ever turns an account dead (a suspension lands
 * mid-day, so rows of one day may disagree — the dead word is the later truth); an older day never
 * touches a newer verdict. Rows without an account id or a status are skipped.
 */
export function mergeGoogleAccountDay(
  book: GoogleAccountStatusBook,
  day: string,
  rows: readonly { accountId: string; accountStatus: string }[],
): { book: GoogleAccountStatusBook; changed: boolean } {
  if (!DAY_RE.test(day)) return { book, changed: false };
  const next: GoogleAccountStatusBook = { ...book };
  let changed = false;
  for (const r of rows) {
    const id = String(r.accountId ?? "").trim();
    const status = norm(r.accountStatus);
    if (!id || !status) continue;
    const had = next[id];
    const wins = !had || day > had.day || (day === had.day && had.status !== status && DEAD_STATUSES.has(status));
    if (!wins) continue;
    next[id] = { status, day };
    changed = true;
  }
  return { book: changed ? next : book, changed };
}

/** A stored book as it came back from the cache, cleaned: anything malformed is dropped. */
export function cleanGoogleAccountBook(raw: unknown): GoogleAccountStatusBook {
  const out: GoogleAccountStatusBook = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const x = (v ?? {}) as Record<string, unknown>;
    const status = norm(x.status);
    const day = String(x.day ?? "");
    if (/^\d{4,}$/.test(id) && status && DAY_RE.test(day)) out[id] = { status, day };
  }
  return out;
}

/** Two books into one — per account the newer day wins (a dead word wins a same-day tie). */
export function mergeGoogleAccountBooks(a: GoogleAccountStatusBook, b: GoogleAccountStatusBook): GoogleAccountStatusBook {
  let book = a;
  for (const [id, v] of Object.entries(b)) book = mergeGoogleAccountDay(book, v.day, [{ accountId: id, accountStatus: v.status }]).book;
  return book;
}

/** The verdict that takes an account off the pickers, or null when it may launch (ENABLED, or
 *  never seen by LION's metrics). */
export function googleAccountDeadVerdict(book: GoogleAccountStatusBook, customerId: string): GoogleAccountVerdict | null {
  const v = book[String(customerId ?? "").trim()];
  return v && DEAD_STATUSES.has(v.status) ? v : null;
}

/** "suspended on Google (LION saw it 19.09)" — the reason a refusal and the board's note print. */
export function googleAccountDeadReason(v: GoogleAccountVerdict): string {
  const [, m, d] = v.day.split("-");
  return `${v.status.toLowerCase()} on Google (LION saw it ${d}.${m})`;
}
