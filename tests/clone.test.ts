// Node's built-in runner (v24 strips types natively): `node --test tests/clone.test.ts`.
// lib/clone.ts imports only a TYPE from ./partners (erased), so it loads straight off Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CloneRow,
  type CloneSource,
  flattenPreview,
  makeCloneRow,
  rowCopiesOf,
  normalizeRowDest,
  rowDestination,
  splitCloneName,
} from "../lib/clone.ts";

const src: CloneSource = {
  campaignId: "120001",
  name: "[05/08] (t1) - [ES] - MKDIGITAL - Tima",
  countries: ["ES"],
  locales: [],
  category: "",
  placement: "FULL",
  ageMin: "18",
  userOs: "all",
  originalBudget: "10",
  originalRoas: "0,40",
  bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
  objective: "OUTCOME_SALES",
  optimization: "conversions",
  conversionEvent: "PURCHASE",
  redirectType: "META ADX",
  creatives: [],
};
const settings = { pageId: "p-default", accountId: "source", pixelId: "", copies: 2 };

test("a fresh row rides the batch settings (no own destination, no own copies)", () => {
  const row = makeCloneRow(src, "08.09", "r1", "nazar");
  assert.equal(row.dest, null);
  assert.equal(row.copies, null);
  assert.deepEqual(rowDestination(row, settings), { pageId: "p-default", accountId: "source", pixelId: "" });
  assert.equal(rowCopiesOf(row, settings), 2);
});

test("a row's own destination and copies win over the batch settings", () => {
  const row: CloneRow = {
    ...makeCloneRow(src, "08.09", "r1", "nazar"),
    dest: { pageId: "p-own", accountId: "123", pixelId: "px" },
    copies: 5,
  };
  assert.deepEqual(rowDestination(row, settings), { pageId: "p-own", accountId: "123", pixelId: "px" });
  assert.equal(rowCopiesOf(row, settings), 5);
});

test("a partial row destination overrides ONE field and rides the batch for the rest", () => {
  const base = makeCloneRow(src, "08.09", "r1", "nazar");
  const batch = { pageId: "p-default", accountId: "111", pixelId: "px-111" };
  // fanpage only → the batch account AND its pixel
  assert.deepEqual(
    rowDestination({ ...base, dest: { pageId: "p-own", accountId: "", pixelId: "" } }, batch),
    { pageId: "p-own", accountId: "111", pixelId: "px-111" },
  );
  // an account of its own with no pixel pick: the batch pixel belongs to ANOTHER account → missing
  assert.deepEqual(
    rowDestination({ ...base, dest: { pageId: "", accountId: "222", pixelId: "" } }, batch),
    { pageId: "p-default", accountId: "222", pixelId: "" },
  );
  // the batch's own account picked explicitly → its pixel still inherits
  assert.deepEqual(
    rowDestination({ ...base, dest: { pageId: "", accountId: "111", pixelId: "" } }, batch),
    { pageId: "p-default", accountId: "111", pixelId: "px-111" },
  );
  // a pixel of its own wins over the inherited one
  assert.deepEqual(
    rowDestination({ ...base, dest: { pageId: "", accountId: "", pixelId: "px-other" } }, batch),
    { pageId: "p-default", accountId: "111", pixelId: "px-other" },
  );
});

test("normalizeRowDest: an all-empty override is no override", () => {
  assert.equal(normalizeRowDest({ pageId: "", accountId: "", pixelId: "" }), null);
  assert.equal(normalizeRowDest(null), null);
  assert.deepEqual(normalizeRowDest({ pageId: "p", accountId: "", pixelId: "" }), { pageId: "p", accountId: "", pixelId: "" });
});

test("copies are clamped to 1..100 on both sides", () => {
  const row = makeCloneRow(src, "08.09", "r1", null);
  assert.equal(rowCopiesOf({ ...row, copies: 0 }, settings), 2); // 0 = not set → batch
  assert.equal(rowCopiesOf({ ...row, copies: 999 }, settings), 100);
  assert.equal(rowCopiesOf(row, { copies: 0 }), 1);
  assert.equal(rowCopiesOf(row, { copies: 250 }), 100);
});

test("flattenPreview expands each row by ITS copies and names copies (k)", () => {
  const a = makeCloneRow(src, "08.09", "a", "nazar");
  const b: CloneRow = { ...makeCloneRow({ ...src, campaignId: "120002" }, "08.09", "b", "nazar"), copies: 3 };
  const items = flattenPreview([a, b], 1);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.rowId), ["a", "b", "b", "b"]);
  assert.equal(items[0].name, `${a.namePrefix}${a.name}`); // single copy → no "(k)"
  assert.equal(items[3].name, `${b.namePrefix}${b.name} (3)`);
});

test("splitCloneName re-dates and marks the prefix (unchanged contract)", () => {
  assert.deepEqual(splitCloneName("[05.08] - (t1) - [ES] - X", "06.08"), {
    prefix: "[06/08] (CLONE) - (t1) - ",
    name: "[ES] - X",
  });
});
