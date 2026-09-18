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
  media: [{ url: "https://blob/v.mp4", kind: "video", name: "v.mp4" }],
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
  let flushes = 0;
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
      throwIf("releaseKey");
    },
    backfillKey: async (key, patch) => {
      calls.push(["backfillKey", key, patch]);
      throwIf("backfillKey");
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
        ads: resolved.mediaIds.flatMap((mediaId, index) =>
          mediaId
            ? [
                {
                  index,
                  creative: {
                    ad_account_id: resolved.adAccountId,
                    name: `${resolved.name} #${index + 1}`,
                    type: "WEB_VIEW" as const,
                    ad_product: "SNAP_AD" as const,
                    headline: shot.headline,
                    brand_name: shot.brandName,
                    call_to_action: shot.cta,
                    top_snap_media_id: mediaId,
                    shareable: true as const,
                    web_view_properties: { url: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`, block_preload: false as const, allow_snap_javascript_sdk: false as const, use_immersive_mode: false as const },
                    profile_properties: { profile_id: resolved.profileId },
                  },
                  ad: { name: `${resolved.name} #${index + 1}`, type: "REMOTE_WEBPAGE" as const, status: "ACTIVE" as const },
                },
              ]
            : [],
        ),
        landingUrl: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`,
      },
      label: "auto",
    }),
    buildName: ({ key, niche, geoLabel }) => `[16.09] (SNP) ${niche} - ${geoLabel} - ${key} - nazar - GC-Launcher`,
    write: (taskId, fields) => {
      (writes[taskId] ??= []).push(fields);
    },
    flush: async () => {
      flushes += 1;
    },
    sleep: async () => {},
    now: () => 1_000_000,
    maxMediaBytes: 32 * 1024 * 1024,
    mediaPollMs: 1,
    mediaWaitMs: 10,
  };
  const last = (taskId: string) => Object.assign({}, ...(writes[taskId] ?? []));
  const stages = (taskId: string) => (writes[taskId] ?? []).map((w) => w.stage).filter(Boolean);
  return { deps, calls, writes, last, stages, flushed: () => flushes };
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
  assert.deepEqual(backfills[0][2], { status: "active", campaign_id: "cmp-2", adsquad_id: "sq-3", ad_id: "ad-5", ad_count: 1, name: t1.name });
  // the creative carried the claimed key and the real media id
  const creative = w.calls.find((c) => c[0] === "createCreative");
  assert.match(JSON.stringify(creative), /glo-snp_001/);
  assert.match(JSON.stringify(creative), /media-1/);
  // the campaign starts one minute after the claim — a slow upload can never push start_time into the past
  const campaign = w.calls.find((c) => c[0] === "createCampaign");
  assert.equal((campaign![2] as { start_time: string }).start_time, new Date(1_000_000 + 60_000).toISOString());
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
  // 1) deadline = margin + mediaWaitMs + 5 ms: the fresh upload's reserve (10 + 120 000) fits with
  //    5 ms to spare; the second copy reuses the media, so its reserve is the margin alone.
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 120_000 + 10 + 5, w.deps);
  assert.equal(w.last("t1").status, "done");
  assert.equal(w.last("t1").stage, "live");
  assert.equal(w.last("t2").status, "done");
  assert.equal(w.last("t2").stage, "live");
  assert.equal(w.calls.filter((c) => c[0] === "createMedia").length, 1);
  // 2) deadline = margin + 5 ms: below mediaWaitMs + margin → refused before a single call.
  const w2 = world();
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 120_000 + 5, w2.deps);
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
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2"), pumpShot("t3", { media: [{ url: "https://blob/other.mp4", kind: "video" }] })], 1_000_000 + 120_000 + 10 + 3, w3.deps);
  assert.equal(w3.last("t1").status, "done");
  assert.equal(w3.last("t2").status, "done");
  assert.equal(w3.last("t3").status, "error");
  assert.match(String(w3.last("t3").error), /time budget/);
  assert.equal(w3.calls.filter((c) => c[0] === "createMedia").length, 1, "t3 never reached media");
  // 4) even with the media cached, a copy whose remaining budget is below the margin is REFUSED with
  //    the "fire it again" row: t1's upload moves the clock past the point where t2's chain tail fits.
  const w4 = world();
  let clock4 = 1_000_000;
  w4.deps.now = () => clock4;
  w4.deps.uploadMedia = async (id) => {
    w4.calls.push(["uploadMedia", id]);
    clock4 += 20;
  };
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 120_000 + 10 + 3, w4.deps);
  assert.equal(w4.last("t1").status, "done");
  assert.equal(w4.last("t2").status, "error");
  assert.equal(w4.last("t2").stage, "failed");
  assert.match(String(w4.last("t2").error), /time budget ran out before this copy; fire it again/);
  assert.equal(w4.calls.filter((c) => c[0] === "claimKey").length, 1, "t2 never claimed a key");
});

test("a registry backfill failure after activation still writes the done row and flushes, naming the failure", async () => {
  const w = world({ backfillKey: new Error("strapi 503") });
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.match(String(t1.error), /registry backfill failed.*strapi 503/);
  assert.equal(w.last("t2").status, "done", "the wave went on to the second copy");
  assert.equal(w.flushed(), 1);
});

test("a release failure at the media step still writes the error row and continues", async () => {
  const w = world({ uploadMedia: refusal("media too large"), releaseKey: new Error("strapi 503") });
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "media");
  assert.match(String(t1.error), /media too large.*registry: strapi 503/);
  assert.equal(t1.gcm, "glo-snp_001", "the claim the registry refused to release stays visible on the row");
  assert.equal(w.last("t2").status, "error", "shot 2 was processed (same injected media failure)");
  assert.ok(w.stages("t2").length > 0);
  assert.equal(w.flushed(), 1);
});

test("a buildWire throw is handled like a refusal: key released, row error, the wave goes on", async () => {
  const w = world();
  const real = w.deps.buildWire;
  let n = 0;
  w.deps.buildWire = (shot, resolved) => {
    if (++n === 1) throw new Error("boom");
    return real(shot, resolved);
  };
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.match(String(t1.error), /boom/);
  assert.equal(t1.gcm, "", "the key went back to the pool");
  assert.equal(w.calls.some((c) => c[0] === "createCampaign" && c[1] === "acct-a" && JSON.stringify(c[2]).includes("glo-snp_001")), false, "nothing built for shot 1");
  assert.equal(w.last("t2").status, "done", "shot 2 built normally");
  assert.equal(w.last("t2").gcm, "glo-snp_002");
});

test("flush runs even when a shot throws something the stages did not anticipate", async () => {
  const w = world();
  w.deps.sleep = async () => {
    throw new Error("unexpected");
  };
  await assert.rejects(runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps), /unexpected/);
  assert.equal(w.last("t1").status, "done", "the first copy was fully built before the throw");
  assert.equal(w.flushed(), 1);
});

// ---------- several creatives on one card: ONE campaign / ad squad / key, one creative + ad per file ----------

const vids = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://blob/c${i + 1}.mp4`, kind: "video" as const, name: `c${i + 1}.mp4` }));
const count = (w: ReturnType<typeof world>, step: string) => w.calls.filter((c) => c[0] === step).length;

test("three creatives: three uploads, ONE campaign and ad squad, three creatives + ads, the row keeps the first ad", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(3) })], 1_000_000 + 700_000, w.deps);
  assert.equal(count(w, "claimKey"), 1, "one key for the whole campaign");
  assert.equal(count(w, "createMedia"), 3);
  assert.equal(count(w, "uploadMedia"), 3);
  assert.equal(count(w, "createCampaign"), 1);
  assert.equal(count(w, "createAdSquad"), 1);
  assert.equal(count(w, "createCreative"), 3);
  assert.equal(count(w, "createAd"), 3);
  assert.deepEqual(w.stages("t1"), ["key", "media", "campaign", "adsquad", "creative", "ad", "creative", "ad", "creative", "ad", "activate", "live"]);
  const ads = w.calls.filter((c) => c[0] === "createAd");
  const squad = ads[0][1];
  assert.ok(ads.every((c) => c[1] === squad), "every ad lands in the campaign's ONE ad squad");
  assert.deepEqual(ads.map((c) => (c[2] as { name: string }).name.slice(-2)), ["#1", "#2", "#3"]);
  const creatives = w.calls.filter((c) => c[0] === "createCreative");
  assert.equal(new Set(creatives.map((c) => (c[2] as { top_snap_media_id: string }).top_snap_media_id)).size, 3, "each creative rides its own media");
  assert.ok(creatives.every((c) => JSON.stringify(c[2]).includes("utm_campaign=glo-snp_001")), "all on the one key");
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.equal(t1.error, "");
  const bound = w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>;
  assert.equal(bound.ad_count, 3);
  assert.equal(bound.ad_id, t1.ad_id, "the registry and the row both keep the FIRST ad");  assert.equal(count(w, "setCampaignStatus"), 1, "activated once, after the last ad");
});

test("copies of a multi-creative card reuse EVERY upload; the same file twice on a card uploads once", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(2) }), pumpShot("t2", { media: vids(2) })], 1_000_000 + 700_000, w.deps);
  assert.equal(count(w, "createMedia"), 2, "two files, uploaded once for both copies");
  assert.equal(count(w, "createAd"), 4);
  assert.equal(w.last("t2").status, "done");
  const w2 = world();
  const twice = [...vids(1), ...vids(1)];
  await runSnapPump("nazar", [pumpShot("t1", { media: twice })], 1_000_000 + 700_000, w2.deps);
  assert.equal(count(w2, "createMedia"), 1, "in-flight upload is shared, not raced");
  assert.equal(count(w2, "createAd"), 2);
});

test("one bad file does not sink the campaign: its upload is refused, the others go live, the row names it", async () => {
  const w = world();
  const upload = w.deps.createMedia;
  w.deps.createMedia = async (acct, name, type) => {
    if (name === "c2.mp4") {
      w.calls.push(["createMedia", acct, name, type]);
      throw refusal("unsupported codec");
    }
    return upload(acct, name, type);
  };
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(3) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.match(String(t1.error), /creative #2 \(c2\.mp4\) skipped.*unsupported codec/);
  assert.equal(count(w, "createAd"), 2);
  assert.deepEqual(w.calls.filter((c) => c[0] === "createAd").map((c) => (c[2] as { name: string }).name.slice(-2)), ["#1", "#3"], "the survivors keep their numbers");
  assert.equal(count(w, "releaseKey"), 0);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).ad_count, 2);
});

test("every file failing its upload: key released, row error at stage media, nothing built", async () => {
  const w = world({ uploadMedia: refusal("media too large") });
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(2) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "media");
  assert.match(String(t1.error), /all 2 creatives failed.*media too large/);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  assert.equal(count(w, "createCampaign"), 0);
});

test("a creative Snapchat refuses is skipped with its reason; the rest are built and the campaign goes live", async () => {
  const w = world();
  const create = w.deps.createCreative;
  let n = 0;
  w.deps.createCreative = async (acct, body) => {
    if (++n === 2) {
      w.calls.push(["createCreative", acct, body]);
      throw refusal("top snap media must be 9:16");
    }
    return create(acct, body);
  };
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(3) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.match(String(t1.error), /creative #2 \(c2\.mp4\) refused at the creative: top snap media must be 9:16/);
  assert.equal(count(w, "createCreative"), 3);
  assert.equal(count(w, "createAd"), 2);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).status, "active");
});

test("every creative refused: nothing can deliver → row error with the first reason, key retired, never activated", async () => {
  const w = world({ createCreative: refusal("headline violates policy") });
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(2) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "creative");
  assert.match(String(t1.error), /all 2 creatives were refused.*headline violates policy/);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).status, "retired");
  assert.equal(count(w, "setCampaignStatus"), 0);
});

test("an ambiguous outcome after the first ad exists: never re-sent, the rest are not attempted, the campaign still goes live with a note", async () => {
  const w = world();
  const create = w.deps.createAd;
  let n = 0;
  w.deps.createAd = async (sq, body) => {
    if (++n === 2) {
      w.calls.push(["createAd", sq, body]);
      throw new Error("fetch failed");
    }
    return create(sq, body);
  };
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(4) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.match(String(t1.error), /creative #2 \(c2\.mp4\): ambiguous outcome \(fetch failed\) at the ad.*2 more not sent/);
  assert.equal(count(w, "createAd"), 2, "the cut ad is never re-sent and #3/#4 are not attempted");
  assert.equal(count(w, "createCreative"), 2);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).ad_count, 1);
});

test("time budget inside the ads loop: the campaign goes live with the ads built so far and says how many are missing", async () => {
  const w = world();
  let clock = 1_000_000;
  w.deps.now = () => clock;
  const create = w.deps.createAd;
  w.deps.createAd = async (sq, body) => {
    clock += 400_000; // each ad eats most of the budget
    return create(sq, body);
  };
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(3) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.equal(count(w, "createAd"), 2, "#3 no longer fits before the deadline margin");
  assert.match(String(t1.error), /1 creative not built.*time budget/);
});

test("time budget inside the media stage: a later upload batch that cannot fit is left out, the uploaded ones launch", async () => {
  const w = world();
  let clock = 1_000_000;
  w.deps.now = () => clock;
  w.deps.uploadMedia = async (id) => {
    w.calls.push(["uploadMedia", id]);
    clock += 200_000;
  };
  // deadline − (mediaWaitMs 10 + margin 120 000) = 1 579 990: the first batch of 3 moves the clock to 1 600 000.
  await runSnapPump("nazar", [pumpShot("t1", { media: vids(5) })], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(count(w, "createMedia"), 3, "the second batch was never started");
  assert.equal(t1.status, "done");
  assert.match(String(t1.error), /creatives #4–#5 not uploaded.*time budget/);
});
