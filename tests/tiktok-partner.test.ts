// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-partner.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — the tiktok-weapon client with a stubbed globalThis.fetch (the real partner is never
// touched by a unit test): catalog mapping + caches, the retry policy (reads retry once, launches
// NEVER), the partner's refusal sentence, and the LIVE-LAUNCH GUARD — an instance that is not
// production can read the live host but cannot fire at it (the 14.09 Google incident).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LION_TOKEN = "tok-1";
process.env.NEXT_PUBLIC_TIKTOK_ENABLED = "1";
delete process.env.TIKTOK_WEAPON_TOKEN;
delete process.env.TIKTOK_ALLOW_LIVE_LAUNCH;
delete process.env.VERCEL_ENV;

type Api = typeof import("../lib/tiktok-weapon.ts");
/** A fresh module instance (its own caches and its own BASE) per scenario. */
async function load(tag: string, base: string | null): Promise<Api> {
  if (base === null) delete process.env.TIKTOK_WEAPON_BASE;
  else process.env.TIKTOK_WEAPON_BASE = base;
  return (await import(`../lib/tiktok-weapon.ts?${tag}`)) as Api;
}

type Rec = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stubFetch(handler: (r: Rec, n: number) => Response | Promise<Response>) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const rec = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null };
    calls.push(rec);
    return handler(rec, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const ADVERTISERS = {
  advertisers: [
    { advertiser_id: "7501321230599962632", name: "gcxunion 308 (London)", status: "STATUS_ENABLE", currency: "usd", country: "EE", timezone: "Europe/London", role: "ROLE_CHILD_ADVERTISER", owner_bc_id: "7168775890770395138", launch_eligible: true },
    { advertiser_id: "7447865971177570305", name: "gcxunion 117", status: "STATUS_LIMIT", currency: "USD", country: "EE", timezone: "America/Los_Angeles", role: "ROLE_CHILD_ADVERTISER", owner_bc_id: "7168775890770395138", launch_eligible: false },
    { advertiser_id: "7399569529648480257", name: "gcxunion 19", status: "STATUS_ENABLE", currency: "USD", country: "EE", timezone: "America/Los_Angeles", role: "ROLE_CHILD_ADVERTISER", owner_bc_id: "7168775890770395138", launch_eligible: true },
    { name: "no id — dropped" },
  ],
};

test("advertisers: mapped, sorted by name (numeric), cached 10 min; every request carries the bearer and a trailing slash", async () => {
  const api = await load("adv", "https://tw.test");
  const s = stubFetch(() => json(ADVERTISERS));
  try {
    const list = await api.twAdvertisers();
    assert.deepEqual(list.map((a) => a.name), ["gcxunion 19", "gcxunion 117", "gcxunion 308 (London)"]);
    assert.deepEqual(list[2], {
      advertiserId: "7501321230599962632",
      name: "gcxunion 308 (London)",
      status: "STATUS_ENABLE",
      currency: "USD",
      country: "EE",
      timezone: "Europe/London",
      bcId: "7168775890770395138",
      launchEligible: true,
    });
    await api.twAdvertisers();
    assert.equal(s.calls.length, 1, "second read is served from the cache");
    assert.equal(s.calls[0].url, "https://tw.test/api/external/advertisers/");
    assert.equal(s.calls[0].headers.authorization, "Bearer tok-1");
  } finally {
    s.restore();
  }
});

test("an empty advertisers answer is an error and is never cached", async () => {
  const api = await load("adv-empty", "https://tw.test");
  let n = 0;
  const s = stubFetch(() => (++n === 1 ? json({ advertisers: [] }) : json(ADVERTISERS)));
  try {
    await assert.rejects(api.twAdvertisers(), /no advertisers/);
    assert.equal((await api.twAdvertisers()).length, 3);
  } finally {
    s.restore();
  }
});

test("advertiser config: pixels with their supported modes, country and language codes; cached per advertiser", async () => {
  const api = await load("cfg", "https://tw.test");
  const s = stubFetch(() =>
    json({
      advertiser_id: "7501321230599962632",
      name: "gcxunion 308 (London)",
      currency: "USD",
      owner_bc_id: "7168775890770395138",
      pixels: [{ pixel_id: "7222981506665299970", pixel_code: "CGUJ36RC77U0HA6062A0", supported_modes: ["NORMAL_WITH_BID", "NORMAL_NO_BID", "VO_HIGHEST_VALUE", "VO_MIN_ROAS"] }, { pixel_id: "x" }],
      locales: { countries: [{ country_code: "us", region_id: "6252001", region_name: "United States" }, { region_name: "no code" }], languages: [{ code: "en", name: "English" }, { code: "fi", name: " Finnish" }] },
    }),
  );
  try {
    const cfg = await api.twAdvertiserConfig("7501321230599962632");
    assert.deepEqual(cfg, {
      advertiserId: "7501321230599962632",
      name: "gcxunion 308 (London)",
      currency: "USD",
      pixels: [{ pixelId: "7222981506665299970", pixelCode: "CGUJ36RC77U0HA6062A0", supportedModes: ["NORMAL_WITH_BID", "NORMAL_NO_BID", "VO_HIGHEST_VALUE", "VO_MIN_ROAS"] }],
      countries: [{ code: "US", name: "United States" }],
      languages: [{ code: "en", name: "English" }, { code: "fi", name: "Finnish" }],
    });
    await api.twAdvertiserConfig("7501321230599962632");
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].url, "https://tw.test/api/external/advertisers/7501321230599962632/config/");
  } finally {
    s.restore();
  }
});

test("reads retry once on a 5xx; a 4xx is the partner's sentence with its status", async () => {
  const api = await load("retry", "https://tw.test");
  let n = 0;
  const s = stubFetch(() => (++n === 1 ? json({ error: "boom" }, 500) : json({ taskId: "65f2a", kind: "launch", status: "RUNNING" })));
  try {
    const t = await api.twTask("65f2a");
    assert.equal(t.status, "running");
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
  const s2 = stubFetch(() => json({ error: "advertiser not allowed for this user" }, 403));
  try {
    await assert.rejects(api.twAdvertiserConfig("7000000000000000009"), (e: unknown) => {
      assert.ok(e instanceof api.TiktokWeaponError);
      assert.equal(e.status, 403);
      assert.equal(e.message, "advertiser not allowed for this user");
      return true;
    });
    assert.equal(s2.calls.length, 1, "a 4xx is never retried");
  } finally {
    s2.restore();
  }
});

test("launches are ONE attempt — a 5xx is never re-sent", async () => {
  const api = await load("once", "https://tw.test");
  const s = stubFetch(() => json({ error: "upstream" }, 502));
  try {
    for (const fire of [
      () => api.twCampaignLaunch({ advertiser_id: "1" } as never),
      () => api.twCloneLaunch({ source_campaign_id: "1" } as never),
      () => api.twJuroLaunch({ source_campaign_id: "1" } as never),
    ]) {
      await assert.rejects(fire(), (e: unknown) => e instanceof api.TiktokWeaponError && e.status === 502);
    }
    assert.deepEqual(s.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
      "POST /api/external/campaign/launch/",
      "POST /api/external/clone/launch/",
      "POST /api/external/juro/launch/",
    ]);
  } finally {
    s.restore();
  }
});

test("a 201 hands back the partner task id; an answer without one is an error", async () => {
  const api = await load("task-id", "https://tw.test");
  const s = stubFetch((_r, n) => (n === 1 ? json({ ok: true, status: "pending", taskId: "65f2a1" }, 201) : json({ ok: true }, 201)));
  try {
    assert.deepEqual(await api.twCloneLaunch({ source_campaign_id: "1900000000000001", budget: "20.00", pixel_code: "PX", name_suffix: "s" }), { taskId: "65f2a1" });
    assert.equal(JSON.parse(s.calls[0].body as string).source_campaign_id, "1900000000000001");
    await assert.rejects(api.twCloneLaunch({ source_campaign_id: "1", budget: "20.00", pixel_code: "PX", name_suffix: "s" }), /returned no taskId/);
  } finally {
    s.restore();
  }
});

test("LIVE-LAUNCH GUARD: on the production host a non-production instance reads but never fires", async () => {
  const api = await load("live", null); // no override → the production host
  assert.equal(api.tiktokLiveLaunchAllowed(), false);
  const s = stubFetch(() => json(ADVERTISERS));
  try {
    assert.equal((await api.twAdvertisers()).length, 3, "reads still go out");
    assert.equal(new URL(s.calls[0].url).hostname, "tiktok-weapon.highstakes.tech");
    const before = s.calls.length;
    for (const fire of [
      () => api.twCampaignLaunch({ advertiser_id: "1" } as never),
      () => api.twCloneLaunch({ source_campaign_id: "1" } as never),
      () => api.twJuroLaunch({ source_campaign_id: "1" } as never),
    ]) {
      await assert.rejects(fire(), (e: unknown) => {
        assert.ok(e instanceof api.TiktokWeaponError);
        assert.match(e.message, /tiktok_live_launch_blocked/);
        assert.equal(e.status, 403);
        return true;
      });
    }
    assert.equal(s.calls.length, before, "ZERO requests left the process");

    process.env.TIKTOK_ALLOW_LIVE_LAUNCH = "1";
    assert.equal(api.tiktokLiveLaunchAllowed(), true);
    delete process.env.TIKTOK_ALLOW_LIVE_LAUNCH;
    process.env.VERCEL_ENV = "production";
    assert.equal(api.tiktokLiveLaunchAllowed(), true);
    process.env.VERCEL_ENV = "preview";
    assert.equal(api.tiktokLiveLaunchAllowed(), false);
    delete process.env.VERCEL_ENV;
  } finally {
    s.restore();
  }
  // Any other base (the mock, a staging host) is not the production host → free to fire.
  assert.equal((await load("mock", "http://127.0.0.1:3197")).tiktokLiveLaunchAllowed(), true);
});

test("dataset fetch is a POST with the campaign id; its 404 keeps the status for the pump", async () => {
  const api = await load("dataset", "https://tw.test");
  const s = stubFetch((r) => (JSON.parse(r.body as string).campaign_id === "404" ? json({ error: "campaign not found" }, 404) : json({ ok: true, runId: "run_abc123" }, 202)));
  try {
    assert.deepEqual(await api.twDatasetFetch("1900000000000001"), { runId: "run_abc123" });
    assert.equal(s.calls[0].method, "POST");
    assert.equal(s.calls[0].url, "https://tw.test/api/external/dataset/fetch/");
    await assert.rejects(api.twDatasetFetch("404"), (e: unknown) => e instanceof api.TiktokWeaponError && e.status === 404);
  } finally {
    s.restore();
  }
});

test("tasks: the full record is mapped; a per-id failure never sinks the batch", async () => {
  const api = await load("tasks", "https://tw.test");
  const s = stubFetch((r) => {
    if (r.url.includes("/tasks/gone/")) return json({ error: "task not found" }, 404);
    return json({
      taskId: "65f2a",
      kind: "clone",
      status: "failed",
      client_reference: "ttc-w-01",
      campaign_name: "{HS-Ab3k} …",
      campaign_id: null,
      adgroup_id: null,
      ad_ids: [],
      error_message: "Video too short",
      error_step: "video_upload",
      created_at: "2026-09-03T14:58:00.000Z",
      updated_at: "2026-09-03T15:00:00.000Z",
    });
  });
  try {
    const [a, b] = await api.twTasks(["65f2a", "gone"]);
    assert.deepEqual(a, {
      taskId: "65f2a",
      kind: "clone",
      status: "failed",
      campaignId: null,
      campaignName: "{HS-Ab3k} …",
      adgroupId: null,
      adIds: [],
      errorMessage: "Video too short",
      errorStep: "video_upload",
      createdAt: "2026-09-03T14:58:00.000Z",
      updatedAt: "2026-09-03T15:00:00.000Z",
    });
    assert.equal(b.status, "not_found");
    assert.equal(b.taskId, "gone");
  } finally {
    s.restore();
  }
});

test("refusal sentences keep the partner's words and its lists", async () => {
  const { tiktokWeaponErrorMessage } = await load("msg", "https://tw.test");
  assert.equal(tiktokWeaponErrorMessage(400, { error: "budget must be at least 20.00" }), "budget must be at least 20.00");
  assert.equal(
    tiktokWeaponErrorMessage(400, { error: "landing URL not allowed", allowed_domains: ["choice-flow.org", "guide-choice.com"] }),
    "landing URL not allowed · allowed domains: choice-flow.org, guide-choice.com",
  );
  assert.equal(tiktokWeaponErrorMessage(404, { error: "source not in dataset", hint: "call dataset/fetch first" }), "source not in dataset (call dataset/fetch first)");
  assert.equal(tiktokWeaponErrorMessage(400, { message: "bad pixel", available_pixels: ["A", "B"] }), "bad pixel · available pixels: A, B");
  assert.match(tiktokWeaponErrorMessage(403, { error: "Forbidden" }), /advertiser not allowed for the LION user or not launch eligible/);
  assert.equal(tiktokWeaponErrorMessage(502, "<html>bad gateway</html>"), "<html>bad gateway</html>");
  assert.equal(tiktokWeaponErrorMessage(500, null), "tiktok-weapon HTTP 500");
  assert.equal(tiktokWeaponErrorMessage(undefined, null), "tiktok-weapon unreachable");
});
