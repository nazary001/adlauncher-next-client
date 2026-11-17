// "Autofill all rows" on the shared clone board (components/clone-board) — the HS board's one-form batch
// edit (lib/hs-autofill, owner ask 16.10: «сменить гео, бюджет и бид во всех кампаниях сразу») on the
// MO / AIF / AV / VC row model. Offered on VC first (owner ask 17.11: «сделай его нормальным так как у нас и
// на других партнерах со всем функционалом»): a VC batch is ticked out of a long list of live campaigns,
// and retyping one bid on thirty rows is exactly what the form is for.
//
// The patch is the HS form's own (the same modal collects it): the TICKED fields land on every row. The
// field semantics are this board's — a targeting pick with no countries / languages hands the row back
// its source's own, the bid is the row's Bid column ("" on lowest cost), the budget is the cash-register
// string, copies "" = the batch default. Pure, so `node --test tests/clone-autofill.test.ts` runs it
// straight off disk.

import type { CloneRow } from "./clone";
import type { HsAutofillPatch } from "./hs-autofill";
import { bidKind, budgetOnStrategyChange, moneyCentsLabel } from "./types.ts";

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** One row after the patch — the SAME object when nothing changes (callers count changed rows by identity). */
export function cloneAutofillRow(row: CloneRow, patch: HsAutofillPatch, maxCopies: number): CloneRow {
  const next: CloneRow = { ...row };
  if (patch.targeting) {
    // An empty pick = "inherit": the row goes back to what its source targets.
    const countries = patch.targeting.countries.length ? patch.targeting.countries : row.source.countries;
    const locales = patch.targeting.locales.length ? patch.targeting.locales : row.source.locales;
    if (!sameList(row.countries, countries)) next.countries = [...countries];
    if (!sameList(row.locales, locales)) next.locales = [...locales];
  }
  if (patch.bidding) {
    next.bidStrategy = patch.bidding.bidStrategy;
    next.roasGoal = bidKind(patch.bidding.bidStrategy) === "none" ? "" : patch.bidding.bid;
    // The row's own strategy-select rule (owner rule 09-11): an untouched default budget follows the
    // strategy ($50 on min ROAS, else the source's own); a typed budget stays.
    if (patch.budget === undefined) {
      next.budget = moneyCentsLabel(budgetOnStrategyChange(row.bidStrategy, patch.bidding.bidStrategy, row.budget, row.source.originalBudget)) || row.budget;
    }
  }
  if (patch.budget !== undefined) next.budget = patch.budget;
  if (patch.copies !== undefined) {
    const n = Number(patch.copies);
    next.copies = patch.copies.trim() === "" || !Number.isFinite(n) ? null : Math.max(1, Math.min(maxCopies, Math.floor(n)));
  }
  const changed =
    next.countries !== row.countries ||
    next.locales !== row.locales ||
    next.bidStrategy !== row.bidStrategy ||
    next.roasGoal !== row.roasGoal ||
    next.budget !== row.budget ||
    next.copies !== row.copies;
  return changed ? next : row;
}

/** Every row after the patch, with how many changed. */
export function cloneAutofillRows(rows: readonly CloneRow[], patch: HsAutofillPatch, maxCopies: number): { rows: CloneRow[]; changed: number } {
  let changed = 0;
  const out = rows.map((r) => {
    const n = cloneAutofillRow(r, patch, maxCopies);
    if (n !== r) changed++;
    return n;
  });
  return { rows: out, changed };
}

/** Undo: the autofilled fields of every row that still exists go back to `before`; rows added since keep theirs. */
export function undoCloneAutofill(rows: readonly CloneRow[], before: readonly CloneRow[]): CloneRow[] {
  const byId = new Map(before.map((r) => [r.id, r]));
  return rows.map((r) => {
    const b = byId.get(r.id);
    if (!b) return r;
    return { ...r, countries: b.countries, locales: b.locales, bidStrategy: b.bidStrategy, roasGoal: b.roasGoal, budget: b.budget, copies: b.copies };
  });
}
