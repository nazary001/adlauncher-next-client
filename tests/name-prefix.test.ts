// Node's built-in runner (v24 strips types natively): `node --test tests/name-prefix.test.ts`.
// The fixed name prefix follows the ACTIVE partner (live bug 23.09: cards born on MO and launched
// after a switch to AIF went out as "[DD/MM] (MO) - …", so every list showed AIF waves as MO runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCampaign, moEnsureSocMark, pinNamePrefix, withPartnerMark } from "../lib/types.ts";

const MO = "[23/09] (MO) - ";
const AIF = "[23/09] (AIF) - ";

test("pinNamePrefix: cards born on MO follow the switch to AIF", () => {
  const rows = [makeCampaign("a", MO, "Tima"), makeCampaign("b", MO, "Dima")];
  const next = pinNamePrefix(rows, AIF);
  assert.deepEqual(
    next.map((c) => c.namePrefix + c.name),
    ["[23/09] (AIF) - Tima", "[23/09] (AIF) - Dima"],
  );
  assert.notEqual(next, rows);
  assert.equal(rows[0].namePrefix, MO, "input rows are never mutated");
});

test("pinNamePrefix: the SAME array comes back when every prefix already matches (no cascade)", () => {
  const rows = [makeCampaign("a", AIF, "Tima"), makeCampaign("b", AIF, "Dima")];
  assert.equal(pinNamePrefix(rows, AIF), rows);
});

test("pinNamePrefix: only the drifted card is re-minted, the rest keep their identity", () => {
  const ok = makeCampaign("a", AIF, "Tima");
  const drifted = makeCampaign("b", MO, "Dima");
  const next = pinNamePrefix([ok, drifted], AIF);
  assert.equal(next[0], ok);
  assert.notEqual(next[1], drifted);
  assert.equal(next[1].namePrefix, AIF);
});

test("pinNamePrefix: HS has no fixed prefix — switching there empties it", () => {
  const next = pinNamePrefix([makeCampaign("a", MO, "Tima")], "");
  assert.equal(next[0].namePrefix, "");
  assert.equal(next[0].name, "Tima");
});

test("withPartnerMark: the creating route stamps ITS partner into a prefix-shaped name", () => {
  assert.equal(withPartnerMark("[23/09] (MO) - Tima", "AIF"), "[23/09] (AIF) - Tima");
  assert.equal(withPartnerMark("[23/09] (AIF) - Tima", "MO"), "[23/09] (MO) - Tima");
  assert.equal(withPartnerMark("[23.09] (MO) - x", "AIF"), "[23.09] (AIF) - x"); // dotted date too
  assert.equal(withPartnerMark("[23/09] (AIF) - Tima", "AIF"), "[23/09] (AIF) - Tima"); // idempotent
});

test("withPartnerMark: names without the prefix grammar pass through untouched", () => {
  assert.equal(withPartnerMark("e2e audit aif", "AIF"), "e2e audit aif");
  assert.equal(withPartnerMark("(MO) - no date", "AIF"), "(MO) - no date");
  assert.equal(withPartnerMark("", "AIF"), "");
});

test("withPartnerMark keeps the SOC marker and composes with moEnsureSocMark either way round", () => {
  assert.equal(withPartnerMark(moEnsureSocMark("[23/09] (AIF) - Tima"), "MO"), "[23/09] (MO) - SOC - Tima");
  assert.equal(moEnsureSocMark(withPartnerMark("[23/09] (AIF) - Tima", "MO")), "[23/09] (MO) - SOC - Tima");
  assert.equal(withPartnerMark("[23/09] (MO) - SOC - Tima", "AIF"), "[23/09] (AIF) - SOC - Tima");
});
