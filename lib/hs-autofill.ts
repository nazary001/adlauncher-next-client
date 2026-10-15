// "Autofill all rows" for the HS clone board (owner ask 16.10: "в клонере сделай как бы автофил
// функцию чтобы можно было сменить гео, бюджет и бид во всех кампаниях сразу"): the ticked fields of
// ONE form land on every row of the wave. Pure — the board's rows stay the board's, this only says what
// each row becomes (and what Undo puts back), so `node --test tests/hs-autofill.test.ts` runs it
// straight off Node. The field semantics are the row's own: a targeting override with no countries
// inherits the source's geo, a bid is in the field's human spelling ("" = inherit), the budget is the
// cash-register string, copies "" = the wave default.

import { CLONE_DEFAULT_BUDGET, bidKind, budgetOnStrategyChange, moneyCentsLabel, parseMoney } from "./types.ts";

export type HsAutofillPatch = {
  /** Targeting override for every row: countries (["WW"] = worldwide; [] = inherit the source's geo)
   *  and FB locale ids ([] = inherit). */
  targeting?: { countries: string[]; locales: string[] };
  /** The clone's bid strategy and the bid for it ("" on lowest cost — nothing to bid). */
  bidding?: { bidStrategy: string; bid: string };
  /** Daily budget in the field's cash-register spelling ("15,00"). */
  budget?: string;
  /** Copies per row ("" = the wave default). */
  copies?: string;
};

/** The slice of a board row the autofill reads and writes. */
export type HsAutofillRow = {
  id: string;
  /** LION facts — null while loading; status "UNREADABLE" = the row is out of the wave anyway. */
  info: { status: string; bidStrategy: string } | null;
  bidStrategy: string;
  bid: string;
  budget: string;
  countries: string[];
  locales: string[];
  copies: string;
  state: "idle" | "sending" | "ok" | "error" | "unsure";
  msg?: string;
};

export const autofillEmpty = (p: HsAutofillPatch): boolean =>
  !p.targeting && !p.bidding && p.budget === undefined && p.copies === undefined;

/** Rows the autofill reaches: a source LION can read (or is still reading), not mid-submit. */
export function autofillTakes(row: Pick<HsAutofillRow, "info" | "state">): boolean {
  return row.info?.status !== "UNREADABLE" && row.state !== "sending";
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One row after the patch — the SAME object when nothing changes (callers count changed rows by
 * identity). A changed queued/failed row becomes an idle draft again (the board's editRow rule: a
 * queued row is not fireable until the buyer edits it); a held row keeps its hold.
 */
export function autofillRow<T extends HsAutofillRow>(row: T, patch: HsAutofillPatch, defaultBudget: string = CLONE_DEFAULT_BUDGET): T {
  if (!autofillTakes(row)) return row;
  const next: T = { ...row };
  if (patch.targeting) {
    if (!sameList(row.countries, patch.targeting.countries)) next.countries = [...patch.targeting.countries];
    if (!sameList(row.locales, patch.targeting.locales)) next.locales = [...patch.targeting.locales];
  }
  if (patch.bidding) {
    const prev = row.bidStrategy || row.info?.bidStrategy || "";
    next.bidStrategy = patch.bidding.bidStrategy;
    next.bid = patch.bidding.bid;
    // Same rule as the row's own strategy select (owner rule 09-11): an untouched default budget
    // follows the strategy ($50 on min ROAS, $10 otherwise); a typed budget stays.
    if (patch.budget === undefined) {
      next.budget = moneyCentsLabel(budgetOnStrategyChange(prev, patch.bidding.bidStrategy, row.budget, defaultBudget)) || row.budget;
    }
  }
  if (patch.budget !== undefined) next.budget = patch.budget;
  if (patch.copies !== undefined) next.copies = patch.copies;
  const changed =
    next.countries !== row.countries ||
    next.locales !== row.locales ||
    next.bidStrategy !== row.bidStrategy ||
    next.bid !== row.bid ||
    next.budget !== row.budget ||
    next.copies !== row.copies;
  if (!changed) return row;
  if (row.state !== "unsure") {
    next.state = "idle";
    next.msg = undefined;
  }
  return next;
}

/** Every row after the patch, with how many changed and how many the autofill does not reach. */
export function autofillRows<T extends HsAutofillRow>(
  rows: readonly T[],
  patch: HsAutofillPatch,
  defaultBudget: string = CLONE_DEFAULT_BUDGET,
): { rows: T[]; changed: number; skipped: number } {
  let changed = 0;
  let skipped = 0;
  const out = rows.map((r) => {
    if (!autofillTakes(r)) {
      skipped++;
      return r;
    }
    const n = autofillRow(r, patch, defaultBudget);
    if (n !== r) changed++;
    return n;
  });
  return { rows: out, changed, skipped };
}

/**
 * Undo: the editable fields — and the state — of every row that still exists go back to `before`
 * (a row whose content is exactly the queued content again is queued again). Rows added since keep
 * theirs; a hold is neither lifted nor re-imposed by an undo.
 */
export function undoAutofill<T extends HsAutofillRow>(rows: readonly T[], before: readonly T[]): T[] {
  const byId = new Map(before.map((r) => [r.id, r]));
  return rows.map((r) => {
    const b = byId.get(r.id);
    if (!b) return r;
    const state = r.state === "unsure" || b.state === "unsure" ? r.state : b.state;
    return {
      ...r,
      countries: b.countries,
      locales: b.locales,
      bidStrategy: b.bidStrategy,
      bid: b.bid,
      budget: b.budget,
      copies: b.copies,
      state,
      msg: state === b.state ? b.msg : r.msg,
    };
  });
}

/** "targeting · strategy + bid · budget · copies" — what the banner says landed. */
export function autofillNote(p: HsAutofillPatch): string {
  const parts: string[] = [];
  if (p.targeting) parts.push(p.targeting.countries.length || p.targeting.locales.length ? "targeting" : "targeting → inherit");
  if (p.bidding) parts.push(bidKind(p.bidding.bidStrategy) === "none" ? "strategy" : "strategy + bid");
  if (p.budget !== undefined) parts.push("budget");
  if (p.copies !== undefined) parts.push("copies");
  return parts.join(" · ");
}

/** Why the form cannot be applied yet — null when it can. */
export function autofillProblem(p: HsAutofillPatch, maxCopies: number): string | null {
  if (autofillEmpty(p)) return "Tick at least one field";
  if (p.bidding) {
    if (!p.bidding.bidStrategy) return "Pick a strategy";
    const kind = bidKind(p.bidding.bidStrategy);
    if (kind !== "none") {
      if (!p.bidding.bid.trim()) return kind === "roas" ? "Type the ROAS goal (0,34 = 34%)" : "Type the bid cap in $";
      if (parseMoney(p.bidding.bid) <= 0) return "The bid must be above 0";
    }
  }
  if (p.budget !== undefined && parseMoney(p.budget) < 1) return "Budget — min $1/day";
  if (p.copies !== undefined && p.copies !== "") {
    const n = Number(p.copies);
    if (!Number.isInteger(n) || n < 1 || n > maxCopies) return `Copies — 1 to ${maxCopies}, or empty for the wave default`;
  }
  return null;
}
