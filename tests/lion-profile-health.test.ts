// A LION profile Facebook will not let LION read — the profile's user is CHECKPOINTED ("You cannot
// access the app till you log in to www.facebook.com and follow the instructions given", OAuth
// error 190 / subcode 459) or its session died — comes back as HTTP 200 with
// `data: { status: false, error: {…} }` (live on GLO-01 15.10: glo-01-39 and glo-01-66, the first
// profile of the picker among them). Until 15.10 the client read that as "no data", the route
// answered a bare 502 and every account picker showed "Loading…" for ever ("accounts do not load
// in the cloner"). These tests load the real lib/lion.ts in a child process with `fetch` stubbed
// and prove: the reason is named (checkpoint vs another Facebook error vs an empty answer), the
// team's profile health lists exactly the unreadable profiles (and is remembered), and ONE dead
// profile no longer blinds the strict team's "whose campaign is it" judge.
// Run: node --test tests/lion-profile-health.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (rel: string): string => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

// LION's live answer of 15.10 for a checkpointed profile (data.error as its FacebookRequestError).
const CHECKPOINT = {
  status: false,
  error: {
    name: "FacebookRequestError",
    message: "You cannot access the app till you log in to www.facebook.com and follow the instructions given.",
    response: {
      message: "You cannot access the app till you log in to www.facebook.com and follow the instructions given.",
      type: "OAuthException",
      code: 190,
      error_data: '{"checkpoint_url":"https:\\/\\/www.facebook.com"}',
      error_subcode: 459,
      fbtrace_id: "AFgsEXkUdtg4DYQ4cPl00_d",
    },
  },
};
// Another Facebook refusal in the same envelope (a dead session) — named, but not a checkpoint.
const INVALIDATED = {
  status: false,
  error: {
    name: "FacebookRequestError",
    message: "Error validating access token: The session has been invalidated because the user changed their password.",
    response: { type: "OAuthException", code: 190, error_subcode: 460 },
  },
};
const GOOD = {
  accounts: [{ id: "act_1", name: "GC-HS-VD-C1-BR-254", status: 1, currency: "USD" }],
  pages: [{ id: "11", name: "P" }],
  locales: [{ id: 6, name: "English (US)" }],
};

const SCRIPT = `
  await import(${at("tests/_resolve-hook.ts")});
  const calls = [];
  const BODIES = JSON.parse(process.env.T_BODIES);
  const PROFILES = Object.keys(BODIES);
  globalThis.fetch = async (u, init) => {
    const p = new URL(String(u));
    calls.push((init?.method ?? "GET") + " " + p.pathname + p.search);
    let body = {};
    if (p.pathname === "/api/facebook/profiles/list/") body = { profiles: PROFILES.map((slug) => ({ slug, label: "L-" + slug, name: "Persona " + slug, readonly: false })) };
    else if (p.pathname === "/api/facebook/profile/data/") { const slug = p.searchParams.get("profile_slug"); body = { slug, name: "Persona " + slug, data: BODIES[slug] }; }
    else if (p.pathname.endsWith("/details/")) body = { campaignsData: [{ campaign_id: "777", campaign_name: "made by hand in Ads Manager", account_id: "act_1" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lion = await import(${at("lib/lion.ts")});
  const out = {};
  const attempt = async (name, fn) => {
    const n = calls.length;
    try { out[name] = { ok: true, value: await fn(), calls: calls.length - n }; }
    catch (e) { out[name] = { ok: false, error: String(e.message), unreadable: lion.lionProfileUnreadable(e), calls: calls.length - n }; }
  };
  for (const slug of PROFILES) await attempt("data:" + slug, async () => (await lion.lionProfileData(slug)).accounts.length);
  await attempt("health", () => lion.lionProfilesHealth());
  await attempt("healthAgain", () => lion.lionProfilesHealth());
  await attempt("team777", () => lion.lionCampaignTeam("777"));
  out.calls = calls;
  console.log(JSON.stringify(out));
`;

type Attempt = {
  ok: boolean;
  value?: unknown;
  error?: string;
  unreadable?: { slug: string; message: string; fbCode: number | null; fbSubcode: number | null; checkpoint: boolean } | null;
  calls: number;
};
type Out = Record<string, Attempt> & { calls: string[] };

function under(team: "glo-01" | "glo-02", bodies: Record<string, unknown>): Out {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEXT_PUBLIC_ADL_TEAM: team,
    LION_BASE: "http://lion.invalid",
    LION_TOKEN: "unit-test-key",
    LION_ACR: team.toUpperCase(),
    HS_PAGES_API_KEY: "",
    T_BODIES: JSON.stringify(bodies),
  };
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", SCRIPT], { env, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Out;
}

test("a checkpointed profile is refused BY NAME, with Facebook's reason — not as 'no data'", () => {
  const out = under("glo-01", { "glo-01-39": CHECKPOINT, "glo-01-41": GOOD });
  const dead = out["data:glo-01-39"];
  assert.equal(dead.ok, false);
  assert.match(dead.error ?? "", /cannot read profile "glo-01-39"/);
  assert.match(dead.error ?? "", /log in again/);
  assert.match(dead.error ?? "", /checkpoint/);
  assert.match(dead.error ?? "", /190\/459/);
  assert.match(dead.error ?? "", /pick another profile/);
  assert.deepEqual(dead.unreadable, {
    slug: "glo-01-39",
    message: CHECKPOINT.error.message,
    fbCode: 190,
    fbSubcode: 459,
    checkpoint: true,
  });
  // the readable profile next to it is untouched
  assert.deepEqual(out["data:glo-01-41"], { ok: true, value: 1, calls: 1 });
});

test("another Facebook refusal in the same envelope is named too, but is no checkpoint; an EMPTY answer keeps the old wording", () => {
  const out = under("glo-01", { "glo-01-66": INVALIDATED, "glo-01-70": {} });
  const dead = out["data:glo-01-66"];
  assert.equal(dead.ok, false);
  assert.match(dead.error ?? "", /cannot read profile "glo-01-66"/);
  assert.match(dead.error ?? "", /session has been invalidated/);
  assert.doesNotMatch(dead.error ?? "", /checkpoint/);
  assert.equal(dead.unreadable?.checkpoint, false);
  assert.equal(dead.unreadable?.fbSubcode, 460);
  const empty = out["data:glo-01-70"];
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /LION returned no data for profile "glo-01-70"/);
  assert.equal(empty.unreadable, null, "an empty answer is not LION's own 'cannot read' verdict");
});

test("profile health lists exactly the unreadable profiles with their reasons, re-reads only those, and is remembered", () => {
  const out = under("glo-01", { "glo-01-39": CHECKPOINT, "glo-01-41": GOOD, "glo-01-66": INVALIDATED, "glo-01-70": {} });
  const health = out.health;
  assert.equal(health.ok, true, health.error);
  const unreadable = health.value as Record<string, string>;
  assert.deepEqual(Object.keys(unreadable).sort(), ["glo-01-39", "glo-01-66", "glo-01-70"]);
  assert.match(unreadable["glo-01-39"], /log in again \(checkpoint/);
  assert.match(unreadable["glo-01-66"], /session has been invalidated/);
  assert.match(unreadable["glo-01-70"], /returned no data/);
  // the four per-profile reads above already cached glo-01-41 — the probe re-asks LION only for the
  // three that failed (a failure is never cached as data) plus the team's profile list (its first
  // read in this process: a GLO-01 data read needs no list), and a second probe asks nothing
  const probeCalls = out.calls.slice(4, 4 + health.calls).sort();
  assert.deepEqual(
    probeCalls,
    [
      "GET /api/facebook/profile/data/?profile_slug=glo-01-39",
      "GET /api/facebook/profile/data/?profile_slug=glo-01-66",
      "GET /api/facebook/profile/data/?profile_slug=glo-01-70",
      "GET /api/facebook/profiles/list/",
    ],
    JSON.stringify(out.calls),
  );
  assert.deepEqual(out.healthAgain, { ok: true, value: unreadable, calls: 0 });
});

test("strict team: ONE checkpointed profile no longer blinds the 'whose campaign is it' judge", () => {
  // glo-02-1 lists act_1; glo-02-2 is checkpointed. Campaign 777 (no acronym) sits in act_1.
  const out = under("glo-02", { "glo-02-1": GOOD, "glo-02-2": CHECKPOINT });
  assert.equal(out.team777.ok, true, out.team777.error);
  assert.equal(out.team777.value, "own", "the readable profile's accounts decide; the dead one is skipped");
});

test("strict team: with NO readable profile the judge still fails closed (unknown)", () => {
  const out = under("glo-02", { "glo-02-1": CHECKPOINT, "glo-02-2": INVALIDATED });
  assert.equal(out.team777.ok, true, out.team777.error);
  assert.equal(out.team777.value, "unknown");
});
