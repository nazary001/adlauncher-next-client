// The hs-tools pages registry keeps one fanpage list per launcher team (its update of 13.10:
// `/fb/api/v1/pages?team=glo-01 | glo-02 | *`, an unknown team answers 400). A launcher asks for its
// own team's list — never the un-filtered one, which is every team's. These tests load the real
// lib/hs-pages.ts in a child process per team with `fetch` stubbed.
// Run: node --test tests/hs-pages-team.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { teamConfig, teamPagesQuery } from "../lib/team.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (rel: string): string => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

const SCRIPT = `
  await import(${at("tests/_resolve-hook.ts")});
  const calls = [];
  globalThis.fetch = async (u, init) => {
    const p = new URL(String(u));
    calls.push((init?.method ?? "GET") + " " + p.pathname + p.search);
    const body = p.pathname.endsWith("/pages/used")
      ? { ok: true, errors: [] }
      : { ok: true, pages: [
          { page_id: "100001", name: "P", state: "ok", has_data: true, used: 3, limit: 250, free: 247 },
          { page_id: "100003", name: "Lisa4 | (Not Eligible)", state: "ok", has_data: true, used: 0, limit: 250, free: 250 },
        ] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const pages = await import(${at("lib/hs-pages.ts")});
  const out = { configured: pages.hsPagesConfigured() };
  out.refusal = await pages.hsPageRefusal("br", [{ id: "100001" }]);
  // 100001 is OK in the registry, 100002 has no row, 100003 is OK there but the HS team marked its NAME
  const offer = await pages.hsOfferablePages("br", [{ id: "100001", name: "P" }, { id: "100002", name: "Q" }, { id: "100003", name: "Lisa4 | (Not Eligible)" }]);
  out.offer = offer.pages.length;
  out.offered = offer.pages.map((p) => p.id);
  out.hidden = offer.hidden;
  out.marked = offer.marked;
  if (process.env.T_MO) out.mo = Object.keys(await pages.hsToolsPageStates("in")).length;
  await pages.reportPagesUsed("br", [{ pageId: "100001", delta: 2 }]);
  out.calls = calls;
  console.log(JSON.stringify(out));
`;

type Out = { configured: boolean; refusal: unknown; offer: number; offered: string[]; hidden: number; marked: number; mo?: number; calls: string[] };

function under(team: string | null, env: Record<string, string> = {}): Out {
  const childEnv: Record<string, string | undefined> = { ...process.env, HS_PAGES_API_URL: "http://registry.invalid", HS_PAGES_API_KEY: "unit-test-key", ...env };
  if (team === null) delete childEnv.NEXT_PUBLIC_ADL_TEAM;
  else childEnv.NEXT_PUBLIC_ADL_TEAM = team;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", SCRIPT], { env: childEnv, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Out;
}

test("every team's registry filter names that team", () => {
  assert.equal(teamPagesQuery(teamConfig("glo-01")), "?team=glo-01");
  assert.equal(teamPagesQuery(teamConfig("glo-02")), "?team=glo-02");
  assert.equal(teamPagesQuery(teamConfig(undefined)), "?team=glo-01"); // unset = the first team
});

test("glo-01 reads its own team's fanpages from the registry — the HS list only", () => {
  const o = under(null, { T_MO: "1" });
  assert.equal(o.configured, true);
  assert.equal(o.refusal, null); // the page the registry marks OK may launch
  assert.equal(o.offer, 1); // the one it has no row for is hidden, as always
  assert.deepEqual(o.offered, ["100001"]);
  assert.equal(o.hidden, 1); // the registry's verdict…
  assert.equal(o.marked, 1); // …and the HS team's own mark in the page name (owner ask 16.10), counted apart
  assert.equal(o.mo, 2); // the MO states read is the stub's two rows as they are — the mark hides in the pickers, not here
  // one read of the HS list (the gate and the picker share the snapshot), filtered to the team…
  assert.deepEqual(o.calls.filter((c) => c.startsWith("GET /fb/")), ["GET /fb/api/v1/pages?team=glo-01"]);
  // …the MO list has no teams — it is asked as it always was
  assert.deepEqual(o.calls.filter((c) => c.startsWith("GET /mo/")), ["GET /mo/fb/api/v1/pages"]);
  // the usage ledger goes by page id
  assert.deepEqual(o.calls.filter((c) => c.startsWith("POST")), ["POST /fb/api/v1/pages/used"]);
});

test("glo-02: the registry lists none of its fanpages yet — it is not asked and gates nothing", () => {
  const o = under("glo-02");
  assert.equal(o.configured, false);
  assert.equal(o.refusal, null);
  // no registry verdict — but a page the HS team marked "(Not Eligible)" in its name is still hidden
  assert.equal(o.offer, 2);
  assert.deepEqual(o.offered, ["100001", "100002"]);
  assert.equal(o.hidden, 0);
  assert.equal(o.marked, 1);
  assert.deepEqual(o.calls, []);
});
