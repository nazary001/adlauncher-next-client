// lib/team.ts — the one place that says what a team may use. Run: node --test tests/team.test.ts
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_TEAM,
  routeNeed,
  teamAcrProblem,
  teamAllowsDb,
  teamAllowsJob,
  teamAllowsPath,
  teamConfig,
  teamHas,
  teamNamespace,
  teamOwnsProfile,
} from "../lib/team.ts";

const GLO1 = teamConfig("glo-01");
const GLO2 = teamConfig("glo-02");

test("teamConfig: unset is the first team, a typo is refused instead of silently becoming it", () => {
  assert.equal(teamConfig(undefined).id, DEFAULT_TEAM);
  assert.equal(teamConfig("").id, DEFAULT_TEAM);
  assert.equal(teamConfig("  ").id, DEFAULT_TEAM);
  assert.equal(teamConfig("glo-02").id, "glo-02");
  assert.equal(teamConfig(" GLO-02 ").id, "glo-02");
  assert.throws(() => teamConfig("glo-2"), /names no team/);
  assert.throws(() => teamConfig("glo-03"), /names no team/);
});

test("glo-01 keeps everything it had; glo-02 is HS through LION on Facebook only", () => {
  assert.deepEqual([...GLO1.partners], ["br", "in", "us", "av"]);
  assert.equal(GLO1.defaultPartner, "in");
  assert.deepEqual([...GLO1.hsChannels], ["lion", "token", "tool"]);
  assert.deepEqual([...GLO2.partners], ["br"]);
  assert.equal(GLO2.defaultPartner, "br");
  assert.deepEqual([...GLO2.hsChannels], ["lion"]);
  assert.deepEqual([...GLO2.platforms], []);
  assert.deepEqual([...GLO2.ownerTools], ["accounts"]);
  assert.equal(GLO2.pagesRegistry, false);
  assert.equal(GLO2.toolsDirectory, false);
  assert.equal(teamHas("graph", GLO2), false);
  assert.equal(teamHas("fbTokens", GLO2), false);
  assert.equal(teamHas("platform:any", GLO2), false);
  assert.equal(teamHas("legacyBlob", GLO2), false);
  assert.equal(teamHas("partner:br", GLO2), true);
  for (const need of ["graph", "fbTokens", "platform:any", "legacyBlob", "channel:token", "channel:tool", "tool:sessions"] as const) {
    assert.equal(teamHas(need, GLO1), true, need);
  }
});

// ---- every route and page of the app is classified -------------------------------------------------

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts" || e.name === "page.tsx") out.push(p);
  }
  return out;
}

/** app/(app)/google/clone/page.tsx → /google/clone · app/api/tool-sessions/[id]/route.ts → /api/tool-sessions/x */
function urlOf(file: string): string {
  const segs = path
    .relative(APP_DIR, path.dirname(file))
    .split(path.sep)
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => (/^\[.*\]$/.test(s) ? "x" : s));
  return `/${segs.join("/")}`;
}

const ROUTES = walk(APP_DIR).map(urlOf).sort();

test("every route and page under app/ has a row in lib/team.ts", () => {
  assert.ok(ROUTES.length > 100, `walked ${ROUTES.length} routes`);
  const unknown = ROUTES.filter((r) => routeNeed(r) === null);
  assert.deepEqual(unknown, [], "classify these in lib/team.ts (API_NEEDS / PAGE_NEEDS)");
});

test("glo-01 reaches every route of the app — nothing changes for the first team", () => {
  assert.deepEqual(ROUTES.filter((r) => !teamAllowsPath(r, GLO1)), []);
  assert.equal(teamAllowsPath("/api/some-route-added-later", GLO1), true);
});

test("glo-02 reaches exactly the HS-through-LION surface", () => {
  const allowed = ROUTES.filter((r) => teamAllowsPath(r, GLO2));
  assert.deepEqual(allowed, [
    "/",
    "/accounts",
    "/api/acct-assignments",
    "/api/acct-limit",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/api/creatives",
    "/api/hs-tasks",
    "/api/hs/activate",
    "/api/hs/duplicate",
    "/api/hs/jurar",
    "/api/hs/launch",
    "/api/hs/page-volume",
    "/api/hs/pixels",
    "/api/hs/profile-data",
    "/api/hs/profiles",
    "/api/hs/sources",
    "/api/hs/status",
    "/api/launch-queue",
    "/api/launch-queue/cron",
    "/api/launch-queue/pump",
    "/api/team",
    "/clone",
    "/login",
  ]);
});

test("glo-02: the other partners, channels, platforms and owner tools are refused; unknown APIs fail closed", () => {
  for (const p of [
    "/api/launch",
    "/api/clone/run",
    "/api/adaccounts",
    "/api/fanpages/volume",
    "/api/gcm",
    "/api/aif/launch",
    "/api/av/launch",
    "/api/hs/token-launch",
    "/api/hs/token-duplicate",
    "/api/hs/token-jurar",
    "/api/hs/token-status",
    "/api/hs/token-cron",
    "/api/hs/tool-launch",
    "/api/hs/tool-duplicate",
    "/api/tool/ready",
    "/api/tool-sessions/abc/check",
    "/api/fb-tokens/signers",
    "/api/google/launch",
    "/api/google-tasks",
    "/api/tiktok/launch",
    "/api/snap/launch",
    "/api/wave-status",
    "/api/launch-tasks",
    "/api/auto-landings/1/prepare-launch",
    "/api/blob-upload",
    "/api/some-route-added-later",
    "/google",
    "/google/clone",
    "/tiktok",
    "/snap/keys",
    "/tokens",
    "/sessions",
    "/auto-landings",
    "/av/keys",
  ]) {
    assert.equal(teamAllowsPath(p, GLO2), false, p);
  }
});

test("a path is matched by whole segments, with or without a trailing slash", () => {
  assert.equal(routeNeed("/api/hs/launch"), "partner:br");
  assert.equal(routeNeed("/api/hs-tasks"), "partner:br");
  assert.equal(routeNeed("/api/hs/token-launch"), "channel:token");
  assert.equal(routeNeed("/api/launch"), "partner:in");
  assert.equal(routeNeed("/api/launch/"), "partner:in");
  assert.equal(routeNeed("/api/launch-queue/pump"), "always");
  assert.equal(routeNeed("/api/launch-tasks"), "graph");
  assert.equal(routeNeed("/api/tool/ready"), "channel:tool");
  assert.equal(routeNeed("/api/tool-sessions/jobs/7"), "channel:tool");
  assert.equal(routeNeed("/"), "always");
  // assets and framework internals are not pages of ours — never refused
  assert.equal(routeNeed("/icon.svg"), null);
  assert.equal(teamAllowsPath("/icon.svg", GLO2), true);
  assert.equal(teamAllowsPath("/_next/webpack-hmr", GLO2), true);
  // a look-alike prefix is not the page
  assert.equal(routeNeed("/google-thing"), null);
});

test("launch queue: glo-02 may only hand over and run hs.lion", () => {
  assert.equal(teamAllowsJob("hs", "hs.lion", GLO2), true);
  for (const [scope, kind] of [
    ["hs", "hs.token"],
    ["hs", "hs.tool"],
    ["hs", "mo.launch"],
    ["hs", "nonsense"],
    ["mo", "mo.launch"],
    ["mo", "fb.clone"],
    ["aif", "aif.launch"],
    ["aif", "fb.clone"],
    ["av", "av.launch"],
    ["mo", "hs.lion"],
    ["xx", "hs.lion"],
  ] as const) {
    assert.equal(teamAllowsJob(scope, kind, GLO2), false, `${scope}/${kind}`);
  }
  for (const [scope, kind] of [
    ["hs", "hs.lion"],
    ["hs", "hs.token"],
    ["hs", "hs.tool"],
    ["mo", "mo.launch"],
    ["mo", "fb.clone"],
    ["aif", "aif.launch"],
    ["aif", "fb.clone"],
    ["av", "av.launch"],
    ["av", "fb.clone"],
  ] as const) {
    assert.equal(teamAllowsJob(scope, kind, GLO1), true, `${scope}/${kind}`);
  }
  assert.equal(teamAllowsJob("mo", "hs.lion", GLO1), false);
  assert.equal(teamAllowsJob("hs", "mo.launch", GLO1), false);
});

test("LION profiles: each team owns its own prefix, the un-prefixed pools stay with glo-01", () => {
  // the company-wide list both keys returned on 08.10
  const live = [
    "glo-01-39", "glo-01-41", "glo-01-42", "glo-01-43", "glo-01-46", "glo-01-48", "glo-01-49", "glo-01-50",
    "glo-01-51", "glo-01-52", "glo-01-57", "glo-01-58", "glo-01-59", "glo-01-60", "glo-01-66", "glo-01-67",
    "glo-01-68", "globecoders-RENT-5", "globecoders-RENT-6", "globecoders-RENT-T4Y-7", "globecoders-RENT-T4Y-8",
    "glo-02-1", "glo-02-2", "glo-02-3", "glo-02-4", "glo-02-5",
  ];
  assert.deepEqual(live.filter((s) => teamOwnsProfile(s, GLO2)), ["glo-02-1", "glo-02-2", "glo-02-3", "glo-02-4", "glo-02-5"]);
  const glo1 = live.filter((s) => teamOwnsProfile(s, GLO1));
  assert.equal(glo1.length, 21);
  assert.ok(!glo1.some((s) => s.startsWith("glo-02-")));
  // no profile belongs to both, none is orphaned
  for (const s of live) assert.equal(Number(teamOwnsProfile(s, GLO1)) + Number(teamOwnsProfile(s, GLO2)), 1, s);
  // a third team's profiles belong to neither; junk belongs to nobody
  assert.equal(teamOwnsProfile("glo-03-1", GLO1), false);
  assert.equal(teamOwnsProfile("glo-03-1", GLO2), false);
  assert.equal(teamOwnsProfile("GLO-02-9", GLO2), true);
  assert.equal(teamOwnsProfile(" glo-02-9 ", GLO2), true);
  assert.equal(teamOwnsProfile("glo-020-1", GLO2), false);
  assert.equal(teamOwnsProfile("", GLO1), false);
  assert.equal(teamOwnsProfile("", GLO2), false);
});

test("a LION key of the other team is refused; an ACR that names no team is not judged", () => {
  assert.equal(teamAcrProblem("GLO-01", GLO1), null);
  assert.equal(teamAcrProblem("glo-02", GLO2), null);
  assert.match(String(teamAcrProblem("GLO-01", GLO2)), /lion_team_mismatch/);
  assert.match(String(teamAcrProblem("GLO-02", GLO1)), /lion_team_mismatch/);
  assert.equal(teamAcrProblem("", GLO2), null);
  assert.equal(teamAcrProblem("ACME", GLO2), null);
});

test("each team runs on its own database", () => {
  for (const db of ["gc", "gc_test"]) {
    assert.equal(teamAllowsDb(db, GLO1), true, db);
    assert.equal(teamAllowsDb(db, GLO2), false, db);
  }
  for (const db of ["gc_glo02", "gc_glo02_test", "gc_glo-02", "GC_GLO02"]) {
    assert.equal(teamAllowsDb(db, GLO2), true, db);
    assert.equal(teamAllowsDb(db, GLO1), false, db);
  }
  assert.equal(teamAllowsDb("gc_glo03", GLO2), false);
  assert.equal(teamAllowsDb("", GLO2), false);
});

test("the first team's store namespace is empty — its S3 keys stay what they were", () => {
  assert.equal(teamNamespace(GLO1), "");
  assert.equal(teamNamespace(GLO2), "glo-02");
});
