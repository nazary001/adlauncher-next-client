// Node's built-in runner (v24 strips types natively): `node --test tests/google-account-status.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — lib/google-account-status.ts: which launch accounts Google has suspended (owner
// ask 21.09: the pickers list only the ones that are not). The status comes from LION's metrics
// rows; a suspended account stops having rows within days, so the verdict is the LATEST seen
// status, remembered across scans.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanGoogleAccountBook,
  googleAccountDeadReason,
  googleAccountDeadVerdict,
  mergeGoogleAccountBooks,
  mergeGoogleAccountDay,
  type GoogleAccountStatusBook,
} from "../lib/google-account-status.ts";

const row = (accountId: string, accountStatus: string) => ({ accountId, accountStatus });

test("the latest day wins: an account seen ENABLED then SUSPENDED is dead, and the reverse is alive again", () => {
  let book: GoogleAccountStatusBook = {};
  book = mergeGoogleAccountDay(book, "2026-09-17", [row("6586636091", "ENABLED")]).book;
  book = mergeGoogleAccountDay(book, "2026-09-18", [row("6586636091", "SUSPENDED")]).book;
  assert.deepEqual(book["6586636091"], { status: "SUSPENDED", day: "2026-09-18" });
  assert.deepEqual(googleAccountDeadVerdict(book, "6586636091"), { status: "SUSPENDED", day: "2026-09-18" });
  // reinstated: a NEWER day shows it delivering again
  book = mergeGoogleAccountDay(book, "2026-09-25", [row("6586636091", "ENABLED")]).book;
  assert.equal(googleAccountDeadVerdict(book, "6586636091"), null);
});

test("scan order does not matter: an older day never overrides a newer verdict", () => {
  // the scan reads today first, then back — the ban of 19.09 must survive the ENABLED rows of 15–18.09
  let book: GoogleAccountStatusBook = {};
  for (const [day, status] of [["2026-09-19", "SUSPENDED"], ["2026-09-18", "ENABLED"], ["2026-09-17", "ENABLED"], ["2026-09-15", "ENABLED"]] as const) {
    book = mergeGoogleAccountDay(book, day, [row("1843099770", status)]).book;
  }
  assert.deepEqual(book["1843099770"], { status: "SUSPENDED", day: "2026-09-19" });
  const again = mergeGoogleAccountDay(book, "2026-09-16", [row("1843099770", "ENABLED")]);
  assert.equal(again.changed, false);
  assert.equal(again.book, book); // untouched book is returned as-is (no needless store write)
});

test("one day that disagrees with itself: the dead word is the later truth; many rows of one account fold into one verdict", () => {
  const mixed = mergeGoogleAccountDay({}, "2026-09-18", [row("9651870827", "ENABLED"), row("9651870827", "SUSPENDED"), row("9651870827", "ENABLED")]);
  assert.deepEqual(mixed.book["9651870827"], { status: "SUSPENDED", day: "2026-09-18" });
  assert.equal(mixed.changed, true);
  const same = mergeGoogleAccountDay(mixed.book, "2026-09-18", [row("9651870827", "suspended ")]); // spelling is normalized
  assert.equal(same.changed, false);
});

test("an account the metrics never showed has no verdict — it is offered; ENABLED is alive; CANCELED / CLOSED are dead too", () => {
  const book = mergeGoogleAccountDay({}, "2026-09-21", [row("1633475800", "ENABLED"), row("111", "CANCELED"), row("222", "CLOSED")]).book;
  assert.equal(googleAccountDeadVerdict(book, "3266365788"), null); // never seen (a fresh account)
  assert.equal(googleAccountDeadVerdict(book, "1633475800"), null);
  assert.equal(googleAccountDeadVerdict(book, "111")?.status, "CANCELED");
  assert.equal(googleAccountDeadVerdict(book, "222")?.status, "CLOSED");
  assert.equal(googleAccountDeadVerdict({}, "1633475800"), null); // nothing known at all → nothing hidden
});

test("junk is skipped: rows without an id or a status, a malformed day", () => {
  const r = mergeGoogleAccountDay({}, "2026-09-21", [row("", "SUSPENDED"), row("123456", ""), row("  ", "ENABLED")]);
  assert.deepEqual(r.book, {});
  assert.equal(r.changed, false);
  assert.equal(mergeGoogleAccountDay({}, "21.09.2026", [row("123456", "SUSPENDED")]).changed, false);
});

test("the remembered book is cleaned on the way in, and two books merge per account by the newer day", () => {
  const stored = cleanGoogleAccountBook({
    "5378080027": { status: "suspended", day: "2026-09-17" },
    "6713307003": { status: "SUSPENDED" }, // no day
    "oops": { status: "SUSPENDED", day: "2026-09-17" }, // not a customer id
    "9074716433": "SUSPENDED", // not an object
    "1633475800": { status: "ENABLED", day: "2026-09-21" },
  });
  assert.deepEqual(stored, { "5378080027": { status: "SUSPENDED", day: "2026-09-17" }, "1633475800": { status: "ENABLED", day: "2026-09-21" } });
  assert.deepEqual(cleanGoogleAccountBook(null), {});
  assert.deepEqual(cleanGoogleAccountBook([1, 2]), {});
  // the remembered ban outlives the scan window; a fresher scan still overrides it
  const fresh: GoogleAccountStatusBook = { "5378080027": { status: "ENABLED", day: "2026-09-30" }, "9822058144": { status: "SUSPENDED", day: "2026-09-19" } };
  assert.deepEqual(mergeGoogleAccountBooks(stored, fresh), {
    "5378080027": { status: "ENABLED", day: "2026-09-30" },
    "1633475800": { status: "ENABLED", day: "2026-09-21" },
    "9822058144": { status: "SUSPENDED", day: "2026-09-19" },
  });
  assert.deepEqual(mergeGoogleAccountBooks(stored, {}), stored);
});

test("the reason a refusal and the board's note print", () => {
  assert.equal(googleAccountDeadReason({ status: "SUSPENDED", day: "2026-09-19" }), "suspended on Google (LION saw it 19.09)");
  assert.equal(googleAccountDeadReason({ status: "CANCELED", day: "2026-10-02" }), "canceled on Google (LION saw it 02.10)");
});
