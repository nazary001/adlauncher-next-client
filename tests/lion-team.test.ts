// LION answers the WHOLE company's profile list to every team's key and lets any key read and launch
// on any profile (probed 08.10) — so the team separation on the HS rail is ours to keep, inside the
// LION client (lib/lion.ts) and the fanka gate (lib/hs-pages.ts). These tests load the real modules in
// a child process per team with `fetch` stubbed: they prove what each team is shown, that a foreign
// profile is refused BEFORE a single request leaves, and that a key of the wrong team sends nothing.
// Run: node --test tests/lion-team.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (rel: string): string => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

// The company-wide list both keys returned on 08.10.
const LIVE = [
  "glo-01-67", "globecoders-RENT-5", "globecoders-RENT-6", "globecoders-RENT-T4Y-8", "globecoders-RENT-T4Y-7",
  "glo-01-39", "glo-01-41", "glo-01-42", "glo-01-43", "glo-01-46", "glo-01-48", "glo-01-49", "glo-01-50", "glo-01-51",
  "glo-01-52", "glo-01-57", "glo-01-58", "glo-01-59", "glo-01-60", "glo-01-66",
  "glo-02-1", "glo-02-2", "glo-02-3", "glo-02-4", "glo-02-5", "glo-01-68",
];

const SCRIPT = `
  await import(${at("tests/_resolve-hook.ts")});
  const calls = [];
  const LIVE = ${JSON.stringify(LIVE)};
  globalThis.fetch = async (u, init) => {
    const p = new URL(String(u));
    calls.push((init?.method ?? "GET") + " " + p.pathname + p.search);
    let body = {};
    if (p.pathname === "/api/facebook/profiles/list/") body = { profiles: LIVE.map((slug) => ({ slug, label: "L-" + slug, name: "", readonly: false })) };
    else if (p.pathname === "/api/facebook/profile/data/") body = { data: { accounts: [{ id: "act_1", name: "A", status: 1, currency: "USD" }], pages: [{ id: "11", name: "P" }], locales: [] } };
    else if (p.pathname.endsWith("/pixels/")) body = { pixels: [{ id: "9", name: "px" }] };
    else if (p.pathname.endsWith("/create/")) body = { creation_results: [{ result: "success", task_id: "t1" }] };
    else if (p.pathname.endsWith("/duplicate/")) body = { duplication_results: [{ result: "success", task_ids: ["t2"] }] };
    else if (p.pathname.endsWith("/jurar/")) body = { juro_results: [{ result: "success", task_ids: ["t3"] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lion = await import(${at("lib/lion.ts")});
  const pages = await import(${at("lib/hs-pages.ts")});
  const out = {};
  const attempt = async (name, fn) => {
    const n = calls.length;
    try { out[name] = { ok: true, value: await fn(), calls: calls.length - n }; }
    catch (e) { out[name] = { ok: false, error: String(e.message), status: e.status ?? null, calls: calls.length - n }; }
  };
  const OWN = process.env.T_OWN, FOREIGN = process.env.T_FOREIGN;
  await attempt("profiles", async () => (await lion.lionProfiles()).map((p) => p.slug));
  await attempt("ownData", async () => (await lion.lionProfileData(OWN)).accounts.length);
  await attempt("foreignData", () => lion.lionProfileData(FOREIGN));
  await attempt("ownPixels", async () => (await lion.lionAccountPixels(OWN, "act_1")).length);
  await attempt("foreignPixels", () => lion.lionAccountPixels(FOREIGN, "act_1"));
  const binds = (slug) => ({ profile_slug: slug, account_id: "act_1", page_id: "11", pixel_id: "9" });
  await attempt("foreignCreate", () => lion.lionCreateCampaign({ ...binds(FOREIGN), campaign: { campaign_name: "x" } }));
  await attempt("foreignDuplicate", () => lion.lionDuplicate({ ...binds(FOREIGN), campaign_id: "1", starting_budget: 1000, number_of_copies: 1, name_suffix: "" }));
  await attempt("foreignJurar", () => lion.lionJurar({ ...binds(FOREIGN), object_story_ids: ["11_1"], starting_budget: 1000, country_codes: ["US"], locales: [], name_suffix: "", conversion_event: "PURCHASE" }));
  await attempt("ownCreate", async () => (await lion.lionCreateCampaign({ ...binds(OWN), campaign: { campaign_name: "x" } })).task_id);
  // the fanka gate on a page the registry has never heard of (no HS_PAGES_API_KEY in this child)
  await attempt("fankaRefusal", () => pages.hsPageRefusal("br", [{ id: "11", name: "P" }]));
  await attempt("fankaOffer", async () => { const r = await pages.hsOfferablePages("br", [{ id: "11" }, { id: "12" }]); return { offered: r.pages.length, hidden: r.hidden, unavailable: r.unavailable }; });
  await attempt("registryConfigured", async () => pages.hsPagesConfigured());
  console.log(JSON.stringify(out));
`;

type Attempt = { ok: boolean; value?: unknown; error?: string; status?: number | null; calls: number };

function under(team: string | null, env: Record<string, string>): Record<string, Attempt> {
  const childEnv: Record<string, string | undefined> = { ...process.env, LION_BASE: "http://lion.invalid", LION_TOKEN: "unit-test-key", HS_PAGES_API_KEY: "", ...env };
  if (team === null) delete childEnv.NEXT_PUBLIC_ADL_TEAM;
  else childEnv.NEXT_PUBLIC_ADL_TEAM = team;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", SCRIPT], { env: childEnv, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Record<string, Attempt>;
}

test("glo-02: only its five profiles, a glo-01 profile is refused before any request leaves", () => {
  const o = under("glo-02", { LION_ACR: "GLO-02", T_OWN: "glo-02-3", T_FOREIGN: "glo-01-39" });
  assert.deepEqual(o.profiles.value, ["glo-02-1", "glo-02-2", "glo-02-3", "glo-02-4", "glo-02-5"]);
  assert.equal(o.ownData.ok, true);
  assert.equal(o.ownPixels.ok, true);
  assert.equal(o.ownCreate.value, "t1");
  for (const k of ["foreignData", "foreignPixels", "foreignCreate", "foreignDuplicate", "foreignJurar"]) {
    assert.equal(o[k].ok, false, k);
    assert.match(String(o[k].error), /profile "glo-01-39" is not a GLO-02 profile/, k);
    assert.equal(o[k].status, 403, k);
    assert.equal(o[k].calls, 0, `${k}: nothing may be sent for a foreign profile`);
  }
});

test("glo-02: the un-prefixed RENT pools are the first team's — refused too", () => {
  const o = under("glo-02", { LION_ACR: "GLO-02", T_OWN: "glo-02-1", T_FOREIGN: "globecoders-RENT-5" });
  assert.equal(o.foreignData.ok, false);
  assert.equal(o.foreignCreate.calls, 0);
});

test("glo-01: everything it had, minus the other team's profiles", () => {
  const o = under(null, { LION_ACR: "GLO-01", T_OWN: "globecoders-RENT-5", T_FOREIGN: "glo-02-1" });
  const slugs = o.profiles.value as string[];
  assert.equal(slugs.length, 21);
  assert.ok(slugs.includes("glo-01-39") && slugs.includes("globecoders-RENT-T4Y-8"));
  assert.ok(!slugs.some((s) => s.startsWith("glo-02-")));
  assert.equal(o.ownData.ok, true);
  assert.equal(o.ownCreate.value, "t1");
  for (const k of ["foreignData", "foreignPixels", "foreignCreate", "foreignDuplicate", "foreignJurar"]) {
    assert.equal(o[k].ok, false, k);
    assert.match(String(o[k].error), /is not a GLO-01 profile/, k);
    assert.equal(o[k].calls, 0, k);
  }
});

test("a LION key of the other team sends nothing at all", () => {
  const o = under("glo-02", { LION_ACR: "GLO-01", T_OWN: "glo-02-1", T_FOREIGN: "glo-01-39" });
  for (const k of ["profiles", "ownData", "ownPixels", "ownCreate"]) {
    assert.equal(o[k].ok, false, k);
    assert.match(String(o[k].error), /lion_team_mismatch/, k);
    assert.equal(o[k].calls, 0, k);
  }
  const first = under(null, { LION_ACR: "GLO-02", T_OWN: "glo-01-39", T_FOREIGN: "glo-02-1" });
  assert.match(String(first.profiles.error), /lion_team_mismatch/);
  assert.equal(first.ownCreate.calls, 0);
});

test("the fanka gate: glo-01 still fails closed without the registry, glo-02 has none to ask", () => {
  const first = under(null, { LION_ACR: "GLO-01", T_OWN: "glo-01-39", T_FOREIGN: "glo-02-1" });
  const refusal = first.fankaRefusal.value as { error: string; status: number } | null;
  assert.equal(refusal?.status, 503);
  assert.match(String(refusal?.error), /fanka_status_unavailable/);
  assert.deepEqual(first.fankaOffer.value, { offered: 0, hidden: 2, unavailable: "HS_PAGES_API_KEY is not configured" });

  const second = under("glo-02", { LION_ACR: "GLO-02", T_OWN: "glo-02-1", T_FOREIGN: "glo-01-39" });
  assert.equal(second.fankaRefusal.value, null);
  assert.deepEqual(second.fankaOffer.value, { offered: 2, hidden: 0, unavailable: null });
  // …and a key in the env changes nothing there: no read, no usage report into the first team's ledger
  const withKey = under("glo-02", { LION_ACR: "GLO-02", T_OWN: "glo-02-1", T_FOREIGN: "glo-01-39", HS_PAGES_API_KEY: "some-key" });
  assert.equal(withKey.registryConfigured.value, false);
  assert.equal(withKey.fankaRefusal.value, null);
  assert.equal(withKey.fankaRefusal.calls, 0);
  const firstWithKey = under(null, { LION_ACR: "GLO-01", T_OWN: "glo-01-39", T_FOREIGN: "glo-02-1", HS_PAGES_API_KEY: "some-key" });
  assert.equal(firstWithKey.registryConfigured.value, true);
});
