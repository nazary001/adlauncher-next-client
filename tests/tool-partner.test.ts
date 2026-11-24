// Node's built-in runner (v24 strips types natively): `node --test tests/tool-partner.test.ts`.
// lib/tool-partner.ts imports nothing, so it loads straight off Node.
// Which partner a cabinet TOOL sees belongs to (owner 24.11: «не привязываться к неймингу … с tool по
// сесии определяло какой это партнер»): the project of the live sessions that see it, the name only
// for a cabinet no partner's session sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PARTNER_NAME, TOOL_PARTNER_PROJECT, toolAccountPartners, toolPartnerAccounts, toolPartnerCabinetHint, toolPartnersByName } from "../lib/tool-partner.ts";

type Row = { account_id: string; name: string; sessions: { id: number; name: string }[] };
const row = (account_id: string, name: string, ...sessions: number[]): Row => ({ account_id, name, sessions: sessions.map((id) => ({ id, name: `s${id}` })) });
const ids = (rows: Row[]) => rows.map((r) => r.name);

// TOOL team GLO-01 as it answered on 24.11 (GET /accounts status-1 rows + GET /sessions).
const SESSIONS = new Map([
  [10, { name: "av-04", profile: "Елена Тимофеева", status: "active", project: "AV" }],
  [166, { name: "AV-7", profile: "Carl Schultz", status: "active", project: "AV" }],
  [167, { name: "AV-8", profile: "Benz Pilapil", status: "expired", project: "AV" }],
  [168, { name: "AV-9", profile: "Kolawat Thayommai", status: "active", project: "AV" }],
]);
const LA = ["565", "566", "567", "568", "569", "570", "571", "572", "573", "574"].map((n) => row(`1${n}`, `GC-AV-LA-${n}`, 10, 166));
const T4Y = ["19", "20", "21", "22", "23", "24", "25", "26", "27"].map((n) => row(`2${n}`, `GC-for-VC-T4Y-UTC-${n}`, 166, 168));
const PERSONAL = [row("301", "Елена Тимофеева", 10), row("302", "Carl Schultz", 166), row("303", "Kolawat Thayommai", 168)];
const LIVE = [...LA, ...T4Y, ...PERSONAL];

test("the cabinets moved to AV are AV's by their sessions, whatever their old name says — and VC no longer gets them (24.11)", () => {
  const av = toolPartnerAccounts("av", LIVE, SESSIONS);
  assert.deepEqual(ids(av), [...ids(LA), ...ids(T4Y)], "the ten GC-AV-LA-… and the nine still named GC-for-VC-T4Y-UTC-…, in TOOL's order");
  assert.equal(av.length, 19);
  assert.deepEqual(toolPartnerAccounts("vc", LIVE, SESSIONS), [], "a cabinet an AV session holds is not VC's because of its name");
  assert.deepEqual(toolAccountPartners(T4Y[8], SESSIONS), ["av"]);
});

test("a profile's own personal cabinet is nobody's: TOOL lists it with the business ones, its name is the profile's", () => {
  for (const p of PERSONAL) assert.deepEqual(toolAccountPartners(p, SESSIONS), [], p.name);
  // the profile's name however it is spaced / cased — and a cabinet of ANOTHER person's name is not it
  assert.deepEqual(toolAccountPartners(row("1", "  carl   SCHULTZ ", 166), SESSIONS), []);
  assert.deepEqual(toolAccountPartners(row("2", "Carl Schultz", 168), SESSIONS), ["av"], "seen by AV-9 only, whose profile is somebody else: an ordinary cabinet of that session");
  // a personal cabinet that carries a partner's name keeps the name's verdict
  const dir = new Map([[1, { profile: "GC-AV-LA-900", status: "active", project: "AV" }]]);
  assert.deepEqual(toolAccountPartners(row("3", "GC-AV-LA-900", 1), dir), ["av"]);
});

test("no session list from TOOL → the name alone, as before", () => {
  for (const dir of [null, undefined]) {
    assert.deepEqual(ids(toolPartnerAccounts("av", LIVE, dir)), ids(LA));
    assert.deepEqual(ids(toolPartnerAccounts("vc", LIVE, dir)), ids(T4Y));
  }
  assert.deepEqual(toolPartnersByName(" gc-av-la-565 "), ["av"]);
  assert.deepEqual(toolPartnersByName("GC-for-VC-BR-742"), ["vc"]);
  for (const other of ["GC-HS-VD-C1-BR-7", "rr", "", null, undefined, "AV-GC-1", "xGC-AV-1"]) assert.deepEqual(toolPartnersByName(other), [], String(other));
});

test("a cabinet no partner's session sees is read by its name: unfiled sessions, another project, a session TOOL does not list, an expired one", () => {
  const dir = new Map([
    [1, { profile: "a", status: "active", project: null }],
    [2, { profile: "b", status: "active", project: "HS" }],
    [3, { profile: "c", status: "expired", project: "AV" }],
    [4, { profile: "d", status: "disabled", project: "VC" }],
    [5, { profile: "e", status: "active", project: "" }],
  ]);
  assert.deepEqual(toolAccountPartners(row("1", "GC-AV-LA-565", 1), dir), ["av"]);
  assert.deepEqual(toolAccountPartners(row("2", "GC-for-VC-BR-742", 2), dir), ["vc"]);
  assert.deepEqual(toolAccountPartners(row("3", "GC-for-VC-T4Y-UTC-27", 3), dir), ["vc"], "an expired AV session holds nothing live — it has no word");
  assert.deepEqual(toolAccountPartners(row("4", "GC-AV-LA-565", 4), dir), ["av"], "nor has a disabled VC one");
  assert.deepEqual(toolAccountPartners(row("5", "GC-AV-LA-565", 5, 99), dir), ["av"], "99 is in no list");
  assert.deepEqual(toolAccountPartners(row("6", "Some Business 12", 1, 2, 5), dir), [], "no partner's session, no partner's name");
  assert.deepEqual(toolAccountPartners(row("7", "GC-AV-LA-565"), dir), ["av"], "no sessions on the row");
  assert.deepEqual(toolAccountPartners({ name: "GC-AV-LA-565", sessions: null }, dir), ["av"]);
  assert.deepEqual(toolAccountPartners({ name: null }, dir), []);
});

test("the session's word wins over the name both ways; sessions of two partners make a cabinet both partners'", () => {
  const dir = new Map([
    [1, { profile: "a", status: "active", project: " av " }],
    [2, { profile: "b", status: "active", project: "vc" }],
    [3, { profile: "c", status: "active", project: "HS" }],
  ]);
  assert.deepEqual(toolAccountPartners(row("1", "GC-for-VC-BR-742", 1), dir), ["av"], "named VC, held by an AV session → AV (project read without case / spaces)");
  assert.deepEqual(toolAccountPartners(row("2", "GC-AV-LA-565", 2), dir), ["vc"], "named AV, held by a VC session → VC");
  assert.deepEqual(toolAccountPartners(row("3", "Any Name", 1, 2), dir), ["av", "vc"]);
  assert.deepEqual(toolAccountPartners(row("4", "GC-AV-LA-565", 1, 3), dir), ["av"], "an HS session beside an AV one changes nothing");
  assert.deepEqual(toolAccountPartners(row("5", "Any Name", 2, 3), dir), ["vc"]);
});

test("a cabinet that carries another rail's name is never a partner's by its sessions alone", () => {
  const dir = new Map([[1, { profile: "a", status: "active", project: "AV" }]]);
  const hs = (name: string) => /^GC-HS-/i.test(name);
  const rows = [row("1", "GC-HS-VD-C1-BR-7", 1), row("2", "GC-HS-VD-C1-BR-8", 1), row("3", "GC-AV-LA-565", 1), row("4", "GC-for-VC-T4Y-UTC-27", 1)];
  assert.deepEqual(ids(toolPartnerAccounts("av", rows, dir, { otherRail: hs })), ["GC-AV-LA-565", "GC-for-VC-T4Y-UTC-27"]);
  assert.deepEqual(ids(toolPartnerAccounts("av", rows, dir)), ids(rows), "without the guard the session's word covers them all");
  assert.deepEqual(toolAccountPartners(rows[0], dir, { otherRail: hs }), []);
});

test("the projects and the names the rule reads, and how a refusal words them", () => {
  assert.deepEqual(TOOL_PARTNER_PROJECT, { av: "AV", vc: "VC" });
  assert.ok(TOOL_PARTNER_NAME.av.test("GC-AV-LA-565") && !TOOL_PARTNER_NAME.av.test("GC-for-VC-BR-742"));
  assert.ok(TOOL_PARTNER_NAME.vc.test("gc-for-vc-t4y-utc-27") && !TOOL_PARTNER_NAME.vc.test("GC-AV-LA-565"));
  assert.equal(toolPartnerCabinetHint("av"), `seen by a session of TOOL's "AV" project, or named GC-AV-…`);
  assert.equal(toolPartnerCabinetHint("vc"), `seen by a session of TOOL's "VC" project, or named GC-for-VC-…`);
});
