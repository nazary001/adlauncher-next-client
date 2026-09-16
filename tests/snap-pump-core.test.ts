// Node's built-in runner (v24 strips types natively): `node --test tests/snap-pump-core.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the after() pump algorithm with EVERY side effect injected: the stage order,
// media reuse across copies, the four dispositions (refusal before/after the campaign exists,
// ambiguous outcome, activation failure) and the time budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSnapPump, type SnapPumpDeps, type SnapPumpShot } from "../lib/snap-pump-core.ts";
import type { SnapLaunchShotIn } from "../lib/snap-launch.ts";

const shotIn = (over: Partial<SnapLaunchShotIn> = {}): SnapLaunchShotIn => ({
  adAccount: "acct-a",
  pixel: "px-1",
  optimizationGoal: "PIXEL_PURCHASE",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  headline: "Hello",
  brandName: "GC",
  cta: "MORE",
  mediaUrl: "https://blob/v.mp4",
  mediaKind: "video",
  mediaName: "v.mp4",
  geo: ["US"],
  minAge: "18",
  landingId: "cars",
  landingUrl: "",
  suffix: "",
  ...over,
});

const pumpShot = (taskId: string, over: Partial<SnapLaunchShotIn> = {}, startPaused = false): SnapPumpShot => ({
  taskId,
  shot: shotIn(over),
  ctx: { adAccountId: "acct-a", pixelId: "px-1", profileId: "prof-1", currency: "USD", niche: "Cars", geoLabel: "US", tail: "", startPaused },
});

type Call = [string, ...unknown[]];

/** A fake world: every dep records its call; failures are injected per step name. */
function world(fail: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const writes: Record<string, Record<string, unknown>[]> = {};
  let seq = 0;
  let keyN = 0;
  const throwIf = (step: string) => {
    const f = fail[step];
    if (f) throw f;
  };
  const deps: SnapPumpDeps = {
    claimKey: async (desired) => {
      calls.push(["claimKey", desired]);
      throwIf("claimKey");
      keyN += 1;
      return { key: `glo-snp_00${keyN}`, documentId: `doc-${keyN}` };
    },
    releaseKey: async (documentId) => {
      calls.push(["releaseKey", documentId]);
    },
    backfillKey: async (key, patch) => {
      calls.push(["backfillKey", key, patch]);
    },
    fetchBytes: async (url) => {
      calls.push(["fetchBytes", url]);
      throwIf("fetchBytes");
      return { bytes: new Uint8Array([1, 2, 3]), mime: "video/mp4", size: 3 };
    },
    createMedia: async (acct, name, type) => {
      calls.push(["createMedia", acct, name, type]);
      throwIf("createMedia");
      return { id: `media-${++seq}` };
    },
    uploadMedia: async (id) => {
      calls.push(["uploadMedia", id]);
      throwIf("uploadMedia");
    },
    mediaReady: async (id) => {
      calls.push(["mediaReady", id]);
      return true;
    },
    createCampaign: async (acct, body) => {
      calls.push(["createCampaign", acct, body]);
      throwIf("createCampaign");
      return { id: `cmp-${++seq}` };
    },
    createAdSquad: async (cmp, body) => {
      calls.push(["createAdSquad", cmp, body]);
      throwIf("createAdSquad");
      return { id: `sq-${++seq}` };
    },
    createCreative: async (acct, body) => {
      calls.push(["createCreative", acct, body]);
      throwIf("createCreative");
      return { id: `cr-${++seq}` };
    },
    createAd: async (sq, body) => {
      calls.push(["createAd", sq, body]);
      throwIf("createAd");
      return { id: `ad-${++seq}` };
    },
    setCampaignStatus: async (cmp, status) => {
      calls.push(["setCampaignStatus", cmp, status]);
      throwIf("setCampaignStatus");
    },
    buildWire: (shot, resolved) => ({
      wire: {
        campaign: { name: resolved.name, ad_account_id: resolved.adAccountId, status: "PAUSED", start_time: resolved.startTimeIso },
        adsquad: {
          name: resolved.name,
          type: "SNAP_ADS",
          billing_event: "IMPRESSION",
          delivery_constraint: "DAILY_BUDGET",
          daily_budget_micro: 10_000_000,
          bid_strategy: shot.bidStrategy,
          optimization_goal: shot.optimizationGoal,
          placement_v2: { config: "AUTOMATIC" },
          targeting: { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }] },
          status: "ACTIVE",
          start_time: resolved.startTimeIso,
        },
        creative: {
          ad_account_id: resolved.adAccountId,
          name: resolved.name,
          type: "WEB_VIEW",
          ad_product: "SNAP_AD",
          headline: shot.headline,
          brand_name: shot.brandName,
          call_to_action: shot.cta,
          top_snap_media_id: resolved.mediaId,
          shareable: true,
          web_view_properties: { url: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`, block_preload: false, allow_snap_javascript_sdk: false, use_immersive_mode: false },
          profile_properties: { profile_id: resolved.profileId },
        },
        ad: { name: resolved.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" },
        landingUrl: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`,
      },
      label: "auto",
    }),
    buildName: ({ key, niche, geoLabel }) => `[16.09] (SNP) ${niche} - ${geoLabel} - ${key} - nazar - GC-Launcher`,
    write: (taskId, fields) => {
      (writes[taskId] ??= []).push(fields);
    },
    flush: async () => {},
    sleep: async () => {},
    now: () => 1_000_000,
    maxMediaBytes: 32 * 1024 * 1024,
    mediaPollMs: 1,
    mediaWaitMs: 10,
  };
  const last = (taskId: string) => Object.assign({}, ...(writes[taskId] ?? []));
  const stages = (taskId: string) => (writes[taskId] ?? []).map((w) => w.stage).filter(Boolean);
  return { deps, calls, writes, last, stages };
}

const refusal = (msg: string) => Object.assign(new Error(msg), { status: 400 });

test("happy path: two copies share ONE media upload, each gets its own key, chain in order, activated at the end", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.stages("t1"), ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live"]);
  assert.deepEqual(w.stages("t2"), ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live"]);
  assert.equal(w.calls.filter((c) => c[0] === "createMedia").length, 1, "media created once per (account, url)");
  assert.equal(w.calls.filter((c) => c[0] === "uploadMedia").length, 1);
  const t1 = w.last("t1");
  const t2 = w.last("t2");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.equal(t1.gcm, "glo-snp_001");
  assert.equal(t2.gcm, "glo-snp_002");
  assert.equal(t1.campaign_id, "cmp-2");
  assert.equal(t1.adset_id, "sq-3");
  assert.equal(t1.ad_id, "ad-5");
  assert.equal(t1.link, "https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=glo-snp_001");
  assert.match(String(t1.name), /glo-snp_001 - nazar - GC-Launcher/);
  assert.equal(typeof t1.finished_at, "number");
  const activations = w.calls.filter((c) => c[0] === "setCampaignStatus");
  assert.deepEqual(activations, [["setCampaignStatus", "cmp-2", "ACTIVE"], ["setCampaignStatus", "cmp-6", "ACTIVE"]]);
  const backfills = w.calls.filter((c) => c[0] === "backfillKey");
  assert.equal(backfills.length, 2);
  assert.deepEqual(backfills[0][2], { status: "active", campaign_id: "cmp-2", adsquad_id: "sq-3", ad_id: "ad-5", name: t1.name });
  // the creative carried the claimed key and the real media id
  const creative = w.calls.find((c) => c[0] === "createCreative");
  assert.match(JSON.stringify(creative), /glo-snp_001/);
  assert.match(JSON.stringify(creative), /media-1/);
});

test("start paused: the chain is built, nothing is activated, row done at stage paused", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1", {}, true)], 1_000_000 + 700_000, w.deps);
  assert.equal(w.calls.some((c) => c[0] === "setCampaignStatus"), false);
  assert.equal(w.last("t1").status, "done");
  assert.equal(w.last("t1").stage, "paused");
});

test("key pool exhausted: row error at stage key, nothing else touched", async () => {
  const w = world({ claimKey: new Error("snap key pool exhausted — no free key glo-snp_001…100") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "key");
  assert.match(String(t1.error), /pool exhausted/);
  assert.equal(w.calls.some((c) => c[0] === "createMedia"), false);
});

test("media failure: the key goes back to the pool, row error at stage media", async () => {
  const w = world({ uploadMedia: refusal("media too large") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  assert.equal(w.last("t1").status, "error");
  assert.equal(w.last("t1").stage, "media");
  assert.equal(w.calls.some((c) => c[0] === "createCampaign"), false);
});

test("creative over the size cap is refused before any Snap call on that shot", async () => {
  const w = world();
  w.deps.fetchBytes = async () => ({ bytes: new Uint8Array(0), mime: "video/mp4", size: 40 * 1024 * 1024 });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.match(String(w.last("t1").error), /32 MB/);
  assert.equal(w.calls.some((c) => c[0] === "createMedia"), false);
});

test("4xx at the campaign: key released, row error with Snap's sentence", async () => {
  const w = world({ createCampaign: refusal("start_time must be in the future") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "campaign");
  assert.match(String(t1.error), /start_time must be in the future/);
});

test("4xx at the ad squad: campaign exists (PAUSED shell) → key RETIRED with the campaign id, row error", async () => {
  const w = world({ createAdSquad: refusal("daily_budget_micro below the minimum") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.equal(w.calls.some((c) => c[0] === "releaseKey"), false);
  const bf = w.calls.find((c) => c[0] === "backfillKey");
  assert.ok(bf);
  assert.equal(bf![1], "glo-snp_001");
  assert.equal((bf![2] as Record<string, unknown>).status, "retired");
  assert.equal((bf![2] as Record<string, unknown>).campaign_id, "cmp-2");
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "adsquad");
  assert.equal(t1.campaign_id, "cmp-2");
  assert.match(String(t1.error), /daily_budget_micro/);
  assert.equal(w.calls.some((c) => c[0] === "setCampaignStatus"), false, "never activated");
});

test("network cut at the creative: interrupted, key retired, never re-sent", async () => {
  const w = world({ createCreative: new Error("fetch failed") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "interrupted");
  assert.equal(t1.stage, "creative");
  assert.match(String(t1.error), /Ambiguous outcome/);
  assert.equal(w.calls.filter((c) => c[0] === "createCreative").length, 1);
  const bf = w.calls.find((c) => c[0] === "backfillKey");
  assert.equal((bf![2] as Record<string, unknown>).status, "retired");
});

test("activation failure is not a failed launch: done at stage paused with the reason", async () => {
  const w = world({ setCampaignStatus: refusal("policy review pending") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "paused");
  assert.match(String(t1.error), /activation failed.*policy review pending.*Ads Manager/);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).status, "active");
});

test("time budget: a shot past the deadline is failed without a single Snap call", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 10_000, w.deps);
  assert.equal(w.last("t1").status, "error");
  assert.match(String(w.last("t1").error), /time budget/);
  assert.equal(w.calls.length, 0);
});

test("media never READY within the wait: key released, row error", async () => {
  const w = world();
  w.deps.mediaReady = async () => false;
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.equal(w.last("t1").status, "error");
  assert.match(String(w.last("t1").error), /not ready/);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
});

test("a shot whose media wait cannot fit the remaining budget is refused, but a copy with the media already uploaded is admitted", async () => {
  // 1) deadline = margin + mediaWaitMs + 5 ms: the fresh upload's reserve (10 + 20 000) fits with
  //    5 ms to spare; the second copy reuses the media, so its reserve is the margin alone.
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 20_000 + 10 + 5, w.deps);
  assert.equal(w.last("t1").status, "done");
  assert.equal(w.last("t1").stage, "live");
  assert.equal(w.last("t2").status, "done");
  assert.equal(w.last("t2").stage, "live");
  assert.equal(w.calls.filter((c) => c[0] === "createMedia").length, 1);
  // 2) deadline = margin + 5 ms: below mediaWaitMs + margin → refused before a single call.
  const w2 = world();
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 20_000 + 5, w2.deps);
  assert.equal(w2.last("t1").status, "error");
  assert.match(String(w2.last("t1").error), /time budget/);
  assert.equal(w2.calls.length, 0);
  // 3) the clock moves during the first upload so the remaining budget lands between the margin and
  //    margin + mediaWaitMs: the cached copy (t2) is admitted, a fresh creative (t3) is refused.
  const w3 = world();
  let clock = 1_000_000;
  w3.deps.now = () => clock;
  w3.deps.uploadMedia = async (id) => {
    w3.calls.push(["uploadMedia", id]);
    clock += 5;
  };
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2"), pumpShot("t3", { mediaUrl: "https://blob/other.mp4" })], 1_000_000 + 20_000 + 10 + 3, w3.deps);
  assert.equal(w3.last("t1").status, "done");
  assert.equal(w3.last("t2").status, "done");
  assert.equal(w3.last("t3").status, "error");
  assert.match(String(w3.last("t3").error), /time budget/);
  assert.equal(w3.calls.filter((c) => c[0] === "createMedia").length, 1, "t3 never reached media");
});
