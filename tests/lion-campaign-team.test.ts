// LION's campaign reads are company-wide like its profile list (probed 08.10: the GLO-02 key read
// details/ and targeting/ of live GLO-01 campaigns) and it duplicates any campaign of the company.
// So a campaign that arrives by ID — a clone / JURO source, an activation — is judged inside the LION
// client before it is used (lib/lion "whose campaign is it", lib/team judgeCampaign). These tests load
// the real lib/lion.ts in a child process per team with `fetch` stubbed.
// Run: node --test tests/lion-campaign-team.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (rel: string): string => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

// What LION's details/ knows in this test. The stubbed profile data gives every own profile ONE
// account, act_1 — so "act_1" is the team's own account and everything else is somebody else's.
const CAMPAIGNS = {
  "9001": { campaign_name: "[06/10] (GLO-01) API - (#ADX [HIGH]) - [US] - a", account_id: "act_111" },
  "9002": { campaign_name: "[06/10] (GLO-02) API - (#ADX [HIGH]) - [US] - b", account_id: "act_222" },
  "9003": { campaign_name: "made by hand, in our account", account_id: "act_1" },
  "9004": { campaign_name: "made by hand, somewhere else", account_id: "act_999" },
  "9006": { campaign_name: "[06/10] (ABC-03) API - somebody who is not a launcher team", account_id: "act_555" },
}; // "9005" is absent: LION answers its per-id error row ("Campaign data not found")

const SCRIPT = `
  await import(${at("tests/_resolve-hook.ts")});
  const CAMPAIGNS = ${JSON.stringify(CAMPAIGNS)};
  const calls = [];
  globalThis.fetch = async (u, init) => {
    const p = new URL(String(u));
    const method = init?.method ?? "GET";
    calls.push(method + " " + p.pathname);
    let body = {};
    if (p.pathname === "/api/facebook/profiles/list/") body = { profiles: [{ slug: process.env.T_PROFILE, label: "", name: "" }] };
    else if (p.pathname === "/api/facebook/profile/data/") body = { data: { accounts: [{ id: "act_1", name: "A", status: 1, currency: "USD" }], pages: [{ id: "11", name: "P" }], locales: [] } };
    else if (p.pathname === "/api/facebook/campaigns/details/") {
      const ids = JSON.parse(init.body).campaign_ids.map(String);
      body = { campaignsData: ids.map((id) => CAMPAIGNS[id]
        ? { campaign_id: id, campaign_status: "ACTIVE", bid_strategy: "LOWEST_COST_WITHOUT_CAP", campaign_budget: 10, account_currency: "USD", adsets: [{ ads: [{ creative: { object_story_id: "11_" + id } }] }], ...CAMPAIGNS[id] }
        : { campaign_id: id, error: "Campaign data not found" }) };
    }
    else if (p.pathname === "/api/facebook/campaigns/targeting/") body = { campaignsData: Object.keys(CAMPAIGNS).map((id) => ({ campaign_id: id, countries_code: ["US"], locales: ["English"], locales_ids: [6] })) };
    else if (p.pathname === "/api/facebook/campaigns/metrics/") body = [];
    else if (p.pathname.endsWith("/duplicate/")) body = { duplication_results: [{ result: "success", task_ids: ["t2"], campaign_id: "777" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lion = await import(${at("lib/lion.ts")});
  const IDS = ["9001", "9002", "9003", "9004", "9005", "9006"];
  const out = {};
  const dup = async (id) => {
    const n = calls.filter((c) => c.endsWith("/duplicate/")).length;
    const all = calls.length;
    let r;
    try { await lion.lionDuplicate({ profile_slug: process.env.T_PROFILE, account_id: "act_1", page_id: "11", pixel_id: "9", campaign_id: id, starting_budget: 1000, number_of_copies: 1, name_suffix: "" }); r = "sent"; }
    catch (e) { r = "refused: " + e.message; }
    return { r, submitted: calls.filter((c) => c.endsWith("/duplicate/")).length - n, calls: calls.length - all };
  };
  // 1) a duplicate with NOTHING read before it (a hand-made request straight at the write)
  out.coldDup = {};
  for (const id of IDS) out.coldDup[id] = await dup(id);
  // 2) what the readers hand on
  out.sourceInfo = Object.fromEntries((await lion.lionSourceInfo(IDS)).map((s) => [s.campaignId, s.status + (s.name ? "" : " (no name)") + (s.countries.length ? "" : " (no geo)")]));
  out.juro = Object.fromEntries(Object.values(await lion.lionJuroSources(IDS)).map((s) => [s.campaignId, s.status + " stories=" + s.stories.length]));
  out.ads = Object.fromEntries(Object.entries(await lion.lionCampaignAds(IDS)).map(([id, v]) => [id, v.status + "/" + v.adsCount]));
  out.facts = {};
  for (const id of IDS) out.facts[id] = (await lion.lionSourceBidFacts(id)).bidStrategy || "(none)";
  // 3) the same duplicates AFTER the reads (the real order: a route reads the source, then submits)
  out.warmDup = {};
  for (const id of IDS) out.warmDup[id] = await dup(id);
  // 4) the verdicts an activation goes by
  out.team = {};
  for (const id of IDS) out.team[id] = await lion.lionCampaignTeam(id);
  out.source = {};
  for (const id of IDS) out.source[id] = await lion.lionSourceTeam(id);
  console.log(JSON.stringify(out));
`;

type Dup = { r: string; submitted: number; calls: number };
type Out = {
  coldDup: Record<string, Dup>;
  warmDup: Record<string, Dup>;
  sourceInfo: Record<string, string>;
  juro: Record<string, string>;
  ads: Record<string, string>;
  facts: Record<string, string>;
  team: Record<string, string>;
  source: Record<string, string>;
};

function under(team: string | null, acr: string, profile: string): Out {
  const env: Record<string, string | undefined> = { ...process.env, LION_BASE: "http://lion.invalid", LION_TOKEN: "unit-test-key", LION_ACR: acr, T_PROFILE: profile, HS_PAGES_API_KEY: "" };
  if (team === null) delete env.NEXT_PUBLIC_ADL_TEAM;
  else env.NEXT_PUBLIC_ADL_TEAM = team;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", SCRIPT], { env, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Out;
}

test("glo-02: only its own campaigns are readable, clonable and activatable", () => {
  const o = under("glo-02", "GLO-02", "glo-02-1");
  // own: the name carries GLO-02 (9002), or it is hand-made in the team's own account (9003)
  for (const id of ["9002", "9003"]) {
    assert.equal(o.sourceInfo[id], "ACTIVE", id);
    assert.equal(o.juro[id], "ACTIVE stories=1", id);
    assert.equal(o.ads[id], "ACTIVE/1", id);
    assert.equal(o.team[id], "own", id);
    assert.equal(o.coldDup[id].r, "sent", id);
    assert.equal(o.coldDup[id].submitted, 1, id);
    assert.equal(o.warmDup[id].r, "sent", id);
  }
  // not its own: GLO-01's (9001), hand-made in another account (9004), a third party's (9006)
  for (const id of ["9001", "9004", "9006"]) {
    assert.equal(o.sourceInfo[id], "UNREADABLE (no name) (no geo)", id);
    assert.equal(o.juro[id], "UNREADABLE stories=0", id);
    assert.equal(o.ads[id], "UNREADABLE/0", id);
    assert.equal(o.facts[id], "(none)", id);
    assert.equal(o.team[id], "foreign", id);
    for (const d of [o.coldDup[id], o.warmDup[id]]) {
      assert.match(d.r, /^refused: campaign \d+ is not a GLO-02 campaign$/, id);
      assert.equal(d.submitted, 0, `${id}: nothing may be submitted`);
    }
  }
  // LION cannot show it (9005): a strict team does not work on what it cannot prove
  assert.equal(o.team["9005"], "unknown");
  assert.match(o.coldDup["9005"].r, /^refused: campaign 9005 could not be confirmed as a GLO-02 campaign/);
  assert.equal(o.coldDup["9005"].submitted, 0);
  assert.equal(o.warmDup["9005"].submitted, 0);
});

test("glo-01: everything as before — only a GLO-02 campaign is out of reach", () => {
  const o = under(null, "GLO-01", "glo-01-39");
  for (const id of ["9001", "9003", "9004", "9006"]) {
    assert.equal(o.sourceInfo[id], "ACTIVE", id);
    assert.equal(o.juro[id], "ACTIVE stories=1", id);
    assert.equal(o.ads[id], "ACTIVE/1", id);
    assert.equal(o.facts[id], "LOWEST_COST_WITHOUT_CAP", id);
    assert.equal(o.team[id], "own", id);
    assert.equal(o.warmDup[id].r, "sent", id);
    assert.equal(o.warmDup[id].submitted, 1, id);
  }
  // the other launcher team's campaign: unreadable, and refused once a read has shown whose it is
  assert.equal(o.sourceInfo["9002"], "UNREADABLE (no name) (no geo)");
  assert.equal(o.juro["9002"], "UNREADABLE stories=0");
  assert.equal(o.ads["9002"], "UNREADABLE/0");
  assert.equal(o.facts["9002"], "(none)");
  assert.equal(o.team["9002"], "foreign");
  assert.match(o.warmDup["9002"].r, /^refused: campaign 9002 is not a GLO-01 campaign$/);
  assert.equal(o.warmDup["9002"].submitted, 0);
  // one LION cannot show goes through as it always did (a fresh campaign lags in details/)
  assert.equal(o.sourceInfo["9005"], "UNREADABLE (no name) (no geo)");
  assert.equal(o.warmDup["9005"].r, "sent");
});

test("glo-01 pays nothing for it: a duplicate asks LION no extra question", () => {
  const o = under(null, "GLO-01", "glo-01-39");
  // nothing was read before these — the submit is the ONLY request (no details/, no profile data)
  for (const id of ["9001", "9003", "9005"]) {
    assert.equal(o.coldDup[id].r, "sent", id);
    assert.equal(o.coldDup[id].calls, 1, `${id}: exactly the duplicate call itself`);
  }
  // …and after a read the verdict is remembered: again just the one call
  for (const id of ["9001", "9003"]) assert.equal(o.warmDup[id].calls, 1, id);
  assert.equal(o.warmDup["9002"].calls, 0, "a refused source sends nothing at all");
  assert.equal(o.source["9005"], "unknown");
});
