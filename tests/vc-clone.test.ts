// Node's built-in runner (v24 strips types natively): `node --test tests/vc-clone.test.ts`.
// VC (ValueClick) clones — the pure contract behind the VC clone board (owner ask 05.11: clones of every
// ACTIVE VC campaign onto the "S-1 nik pixel", bid cap $0,50, " - Lead" on the name, Lead optimization
// instead of Purchase): the source read off a Graph campaign tree, the board's settings applied to it,
// the Campaign the launch payload builders get, the refusals, and the TOOL body.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const vc = await import("../lib/vc-clone.ts");
const { VC_PIXEL } = await import("../lib/vc-link.ts");
const { adsetPayload, campaignPayload } = await import("../lib/fb-launch.ts");
const { cloneCreativePayload } = await import("../lib/clone-run.ts");
const tl = await import("../lib/tool-launch.ts");
const { bidKind, normalizeRoasGoal, parseMoney } = await import("../lib/types.ts");

const TRACK = "https://trackwow3.xyz/r/82ptkvx42wrsjuxag75hlol4?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}";
const PAGE = "105520599041074";

/** A live VC source as GET /<campaign>?fields=VC_SOURCE_FIELDS answers it (shape read 05.11 off GC-for-VC-BR-742). */
function tree(over: Record<string, unknown> = {}) {
  return {
    id: "52564425188380",
    name: "[26/10] (VC) - [EN] - AV - Tima - FOOD",
    account_id: "1203001234567890",
    objective: "OUTCOME_SALES",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    special_ad_categories: [],
    daily_budget: "700",
    bid_strategy: "LOWEST_COST_WITH_BID_CAP",
    created_time: "2026-10-26T12:35:12-0300",
    adsets: {
      data: [
        {
          id: "52564425196980",
          name: "[26/10] (VC) - [EN] - AV - Tima - FOOD",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          bid_amount: 200,
          promoted_object: { pixel_id: VC_PIXEL.id, custom_event_type: "PURCHASE", smart_pse_enabled: false },
          targeting: {
            age_max: 65,
            age_min: 18,
            age_range: [18, 65],
            geo_locations: { countries: ["US"], location_types: ["frequently_in", "home", "recent"] },
            targeting_automation: { advantage_audience: 1 },
          },
          dsa_beneficiary: "Ngọc Linh",
          dsa_payor: "Ngọc Linh",
        },
      ],
    },
    ads: {
      data: [
        {
          id: "52564425216180",
          name: "[26/10] (VC) - [EN] - AV - Tima - FOOD · 2",
          status: "ACTIVE",
          creative: {
            id: "2486615498527743",
            object_story_spec: {
              page_id: PAGE,
              link_data: { link: TRACK, message: "Food choices…", name: "LEARN MORE ", description: "🟢 LEARN MORE →", image_hash: "6b05", call_to_action: { type: "LEARN_MORE", value: { link: TRACK } } },
            },
          },
        },
        {
          id: "52564425212780",
          name: "[26/10] (VC) - [EN] - AV - Tima - FOOD · 1",
          status: "ACTIVE",
          creative: {
            id: "1638689087664658",
            object_story_spec: { page_id: PAGE, link_data: { link: TRACK, message: "Food choices…", name: "LEARN MORE ", image_hash: "c931", call_to_action: { type: "LEARN_MORE", value: { link: TRACK } } } },
          },
        },
      ],
    },
    ...over,
  };
}

test("the Lead pixel is the dataset the owner named (S-1 nik pixel) and the defaults are the owner's ask", () => {
  assert.equal(vc.VC_LEAD_PIXEL.id, "2126539511577664");
  assert.deepEqual(vc.VC_CLONE_DEFAULTS, { pixelId: vc.VC_LEAD_PIXEL.id, event: "LEAD", bidStrategy: "LOWEST_COST_WITH_BID_CAP", bidCap: "0,50", budget: "", suffix: "Lead" });
  assert.deepEqual(
    vc.VC_CLONE_PIXELS.map((p) => p.id),
    [vc.VC_LEAD_PIXEL.id, VC_PIXEL.id],
  );
  assert.equal(vc.vcPixelName(VC_PIXEL.id), VC_PIXEL.name);
  assert.equal(vc.vcPixelName("123"), "123");
});

test("vcCloneDelivery: Lead = OUTCOME_LEADS + LEAD (Meta refuses LEAD under Sales); Purchase = OUTCOME_SALES + PURCHASE", () => {
  assert.deepEqual(vc.vcCloneDelivery("LEAD"), { objective: "OUTCOME_LEADS", optimization: "conversions", conversionEvent: "LEAD" });
  assert.deepEqual(vc.vcCloneDelivery("PURCHASE"), { objective: "OUTCOME_SALES", optimization: "conversions", conversionEvent: "PURCHASE" });
  assert.equal(vc.isVcCloneEvent("LEAD"), true);
  assert.equal(vc.isVcCloneEvent("lead"), false);
  assert.equal(vc.isVcCloneEvent(""), false);
});

test("vcCloneName: the suffix joins the name as its own segment, once, whatever the case; no suffix = the name as is", () => {
  assert.equal(vc.vcCloneName("[26/10] (VC) - [EN] - AV - Tima - FOOD", "Lead"), "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead");
  assert.equal(vc.vcCloneName("[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead", "Lead"), "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead");
  assert.equal(vc.vcCloneName("[26/10] (VC) - X - LEAD", "Lead"), "[26/10] (VC) - X - LEAD");
  assert.equal(vc.vcCloneName("[26/10] (VC) - Leadership", "Lead"), "[26/10] (VC) - Leadership - Lead");
  assert.equal(vc.vcCloneName("  [26/10] (VC) - X  ", ""), "[26/10] (VC) - X");
  assert.equal(vc.vcCloneName("[26/10] (VC) - X", "  Lead  "), "[26/10] (VC) - X - Lead");
});

test("vcAdFacts: a static image ad (link_data), a video ad (its CTA link), an Advantage+ feed, and an ad with nothing reusable", () => {
  const img = vc.vcAdFacts(tree().ads.data[0]);
  assert.deepEqual(img, { adId: "52564425216180", name: "[26/10] (VC) - [EN] - AV - Tima - FOOD · 2", kind: "image", pageId: PAGE, link: TRACK });
  const video = vc.vcAdFacts({ id: "1", name: "v", creative: { object_story_spec: { page_id: PAGE, video_data: { video_id: "v1", call_to_action: { type: "LEARN_MORE", value: { link: TRACK } } } } } });
  assert.deepEqual(video, { adId: "1", name: "v", kind: "video", pageId: PAGE, link: TRACK });
  const feed = vc.vcAdFacts({ id: "2", creative: { object_story_spec: { page_id: PAGE }, asset_feed_spec: { videos: [{ video_id: "v2" }], link_urls: [{ website_url: TRACK }] } } });
  assert.equal(feed.kind, "video");
  assert.equal(feed.link, TRACK);
  const none = vc.vcAdFacts({ id: "3", creative: { object_story_spec: { page_id: PAGE, link_data: { link: TRACK } } } });
  assert.equal(none.kind, "none");
  assert.equal(none.pageId, PAGE);
});

test("vcCloneSourceOf: the live tree becomes the board's source row (account digits, $ budget / bid, strategy, event, pixel, geo, page, ads, DSA)", () => {
  const s = vc.vcCloneSourceOf(tree(), "GC-for-VC-BR-742");
  assert.equal(s.campaignId, "52564425188380");
  assert.equal(s.accountId, "1203001234567890");
  assert.equal(s.accountName, "GC-for-VC-BR-742");
  assert.equal(s.name, "[26/10] (VC) - [EN] - AV - Tima - FOOD");
  assert.equal(s.status, "ACTIVE");
  assert.equal(s.objective, "OUTCOME_SALES");
  assert.equal(s.budget, "7");
  assert.equal(s.bidStrategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(s.bidCap, "2");
  assert.equal(s.optimizationGoal, "OFFSITE_CONVERSIONS");
  assert.equal(s.conversionEvent, "PURCHASE");
  assert.equal(s.pixelId, VC_PIXEL.id);
  assert.deepEqual(s.countries, ["US"]);
  assert.equal(s.ageMin, "18");
  assert.equal(s.placement, "FULL");
  assert.equal(s.userOs, "all");
  assert.deepEqual(s.localeIds, []);
  assert.equal(s.category, "");
  assert.equal(s.pageId, PAGE);
  assert.equal(s.dsaBeneficiary, "Ngọc Linh");
  assert.equal(s.ads.length, 2);
  assert.equal(s.ads[0].kind, "image");
  assert.equal(s.ads[0].link, TRACK);
  assert.equal(s.createdTime, "2026-10-26T12:35:12-0300");

  // act_-prefixed account, worldwide + gendered compliance targeting, Android, locales, a special category, a min-ROAS source
  const s2 = vc.vcCloneSourceOf(
    tree({
      account_id: "act_77",
      special_ad_categories: ["CREDIT"],
      bid_strategy: "LOWEST_COST_WITH_MIN_ROAS",
      adsets: {
        data: [
          {
            optimization_goal: "VALUE",
            bid_constraints: { roas_average_floor: 3000 },
            promoted_object: { pixel_id: VC_PIXEL.id, custom_event_type: "PURCHASE" },
            targeting: { age_min: 25, genders: [2], facebook_positions: ["feed"], geo_locations: { country_groups: ["worldwide"] }, user_os: ["Android"], locales: [6, 16] },
          },
        ],
      },
    }),
  );
  assert.equal(s2.accountId, "77");
  assert.equal(s2.category, "CREDIT");
  assert.equal(s2.bidCap, "0,3");
  assert.deepEqual(s2.countries, ["WW"]);
  assert.equal(s2.ageMin, "25");
  assert.equal(s2.placement, "COMPLIANCE_MULHER");
  assert.equal(s2.userOs, "android");
  assert.deepEqual(s2.localeIds, [6, 16]);

  // a legacy ad-set-budget source, a click source with no pixel, no ads
  const s3 = vc.vcCloneSourceOf(tree({ daily_budget: undefined, bid_strategy: undefined, adsets: { data: [{ daily_budget: "1000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", optimization_goal: "LINK_CLICKS", targeting: { geo_locations: { countries: ["BR", "MX"] } } }] }, ads: { data: [] } }));
  assert.equal(s3.budget, "10");
  assert.equal(s3.bidStrategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(s3.bidCap, "");
  assert.equal(s3.pixelId, "");
  assert.equal(s3.conversionEvent, "");
  assert.deepEqual(s3.countries, ["BR", "MX"]);
  assert.equal(s3.pageId, "");
  assert.deepEqual(s3.ads, []);
});

test("vcCloneEditOf: the owner's defaults on a source = Lead on the S-1 pixel, bid cap 0,50, the source's budget, ' - Lead' on the name", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcCloneEditOf(s, vc.VC_CLONE_DEFAULTS);
  assert.deepEqual(e, {
    campaignId: "52564425188380",
    accountId: "1203001234567890",
    name: "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead",
    budget: "7",
    bidStrategy: "LOWEST_COST_WITH_BID_CAP",
    bidCap: "0,50",
    pixelId: vc.VC_LEAD_PIXEL.id,
    event: "LEAD",
  });
  // a budget override, a typed name, lowest cost drops the bid, an inherited strategy keeps the source's own bid
  const e2 = vc.vcCloneEditOf(s, { ...vc.VC_CLONE_DEFAULTS, budget: "12", bidStrategy: "LOWEST_COST_WITHOUT_CAP" }, "My clone");
  assert.equal(e2.budget, "12");
  assert.equal(e2.name, "My clone");
  assert.equal(e2.bidStrategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(e2.bidCap, "");
  const e3 = vc.vcCloneEditOf(s, { ...vc.VC_CLONE_DEFAULTS, bidStrategy: "", bidCap: "" });
  assert.equal(e3.bidStrategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(e3.bidCap, "2");
});

test("vcCloneCampaign + the launch builders: OUTCOME_LEADS CBO at the source's $7, bid_amount 50 on the ad set, LEAD on the S-1 pixel, the source's targeting, DSA from the binds", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcCloneEditOf(s, vc.VC_CLONE_DEFAULTS);
  const c = vc.vcCloneCampaign(e, s);
  assert.equal(c.objective, "OUTCOME_LEADS");
  assert.equal(c.optimization, "conversions");
  assert.equal(c.conversionEvent, "LEAD");
  assert.equal(c.pixel, vc.VC_LEAD_PIXEL.id);
  assert.equal(c.account, s.accountId);
  assert.equal(c.page, PAGE);
  assert.equal(c.bidStrategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(c.bidCap, "0,50");
  assert.equal(c.budget, "7");
  assert.deepEqual(c.countries, ["US"]);

  const camp = campaignPayload(c, e.name);
  assert.equal(camp.name, "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead");
  assert.equal(camp.objective, "OUTCOME_LEADS");
  assert.equal(camp.daily_budget, 700);
  assert.equal(camp.bid_strategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(camp.status, "ACTIVE");
  assert.deepEqual(camp.special_ad_categories, []);

  const binds = { accountId: s.accountId, pageId: s.pageId, pageName: s.dsaBeneficiary, pixelId: e.pixelId };
  const adset = adsetPayload(c, e.name, "CAMP1", binds, s.localeIds) as Record<string, any>;
  assert.equal(adset.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(adset.bid_amount, 50);
  assert.equal(adset.bid_constraints, undefined);
  assert.equal(adset.daily_budget, undefined);
  assert.deepEqual(adset.promoted_object, { pixel_id: vc.VC_LEAD_PIXEL.id, custom_event_type: "LEAD" });
  assert.deepEqual(adset.targeting.geo_locations, { location_types: ["home", "recent"], countries: ["US"] });
  assert.equal(adset.targeting.age_min, 18);
  assert.equal(adset.targeting.age_max, 65);
  assert.equal(adset.targeting.genders, undefined);
  assert.equal(adset.targeting.targeting_automation, undefined);
  assert.equal(adset.dsa_beneficiary, "Ngọc Linh");
  assert.equal(adset.status, "ACTIVE");

  // Purchase on the old pixel keeps Sales
  const p = vc.vcCloneCampaign({ ...e, event: "PURCHASE", pixelId: VC_PIXEL.id }, s);
  assert.equal(p.objective, "OUTCOME_SALES");
  assert.equal(p.conversionEvent, "PURCHASE");
  const ap = adsetPayload(p, "n", "C", { ...binds, pixelId: VC_PIXEL.id }, []) as Record<string, any>;
  assert.deepEqual(ap.promoted_object, { pixel_id: VC_PIXEL.id, custom_event_type: "PURCHASE" });
});

test("the creative is rebuilt from the source ad as is — same page, same image, same copy, the tracking link untouched", () => {
  const ad = tree().ads.data[0];
  const media = { kind: "image" as const, data: ad.creative.object_story_spec.link_data };
  const cr = cloneCreativePayload("clone · 1", PAGE, media, "", "", (l) => l) as Record<string, any>;
  assert.equal(cr.name, "clone · 1");
  assert.equal(cr.object_story_spec.page_id, PAGE);
  assert.equal(cr.object_story_spec.link_data.link, TRACK);
  assert.equal(cr.object_story_spec.link_data.image_hash, "6b05");
  assert.equal(cr.object_story_spec.link_data.message, "Food choices…");
  assert.deepEqual(cr.object_story_spec.link_data.call_to_action, { type: "LEARN_MORE", value: { link: TRACK } });
});

test("vcCloneRefusal: the owner's defaults pass; every bad edit is refused by name before any write", () => {
  const s = vc.vcCloneSourceOf(tree());
  const good = vc.vcCloneEditOf(s, vc.VC_CLONE_DEFAULTS);
  assert.equal(vc.vcCloneRefusal(good, s), null);
  assert.match(vc.vcCloneRefusal({ ...good, event: "VIEW" as never }, s) ?? "", /^event_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, pixelId: "" }, s) ?? "", /^pixel_required/);
  assert.match(vc.vcCloneRefusal({ ...good, pixelId: "abc" }, s) ?? "", /^pixel_required/);
  assert.match(vc.vcCloneRefusal({ ...good, name: "  " }, s) ?? "", /^name_required/);
  assert.match(vc.vcCloneRefusal({ ...good, bidStrategy: "TARGET_COST" }, s) ?? "", /^bid_strategy_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, bidCap: "" }, s) ?? "", /^bid_required/);
  assert.match(vc.vcCloneRefusal({ ...good, bidCap: "0" }, s) ?? "", /^bid_required/);
  assert.match(vc.vcCloneRefusal({ ...good, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }, s) ?? "", /^roas_needs_purchase/);
  assert.equal(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }, s), null);
  assert.match(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "15" }, s) ?? "", /^roas_goal_ambiguous/);
  assert.match(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "500" }, s) ?? "", /^roas_goal_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, budget: "0,5" }, s) ?? "", /^budget_too_low/);
  assert.equal(vc.vcCloneRefusal({ ...good, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidCap: "" }, s), null);
  const noGeo = vc.vcCloneSourceOf(tree({ adsets: { data: [{ targeting: {} }] } }));
  assert.match(vc.vcCloneRefusal(vc.vcCloneEditOf(noGeo, vc.VC_CLONE_DEFAULTS), noGeo) ?? "", /country/);
  const noAds = vc.vcCloneSourceOf(tree({ ads: { data: [] } }));
  assert.match(vc.vcCloneRefusal(vc.vcCloneEditOf(noAds, vc.VC_CLONE_DEFAULTS), noAds) ?? "", /page unknown|no reusable/);
  const noMedia = vc.vcCloneSourceOf(tree({ ads: { data: [{ id: "1", creative: { object_story_spec: { page_id: PAGE, link_data: { link: TRACK } } } }] } }));
  assert.match(vc.vcCloneRefusal(vc.vcCloneEditOf(noMedia, vc.VC_CLONE_DEFAULTS), noMedia) ?? "", /no reusable/);
});

test("isVcCloneEdit: the wire shape the clone route accepts (digits ids, strings, a known event)", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcCloneEditOf(s, vc.VC_CLONE_DEFAULTS);
  assert.equal(vc.isVcCloneEdit(e), true);
  assert.equal(vc.isVcCloneEdit({ ...e, campaignId: "x" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, event: "nope" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, name: 5 }), false);
  assert.equal(vc.isVcCloneEdit(null), false);
  assert.equal(vc.isVcCloneEdit({ campaignId: "52564425188380", name: "n", event: "LEAD" }), true);
});

test("VC clone through TOOL: the same Campaign maps to a CampaignRequest — OUTCOME_LEADS, conversion LEAD on the S-1 pixel, bid {amount: 0.5} USD, the tracking link on every creative", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcCloneEditOf(s, vc.VC_CLONE_DEFAULTS);
  const c = vc.vcCloneCampaign(e, s);
  const kind = bidKind(c.bidStrategy);
  const raw = parseMoney(c.bidCap);
  const r = tl.buildToolCampaign({
    name: tl.toolEnsureMark(e.name),
    objective: c.objective,
    budgetUsd: parseMoney(c.budget),
    bidStrategy: c.bidStrategy,
    bid: kind === "roas" ? { kind: "roas", coefficient: normalizeRoasGoal(raw) ?? 0 } : kind === "cap" ? { kind: "cap", usd: raw } : { kind: "none" },
    optimization: c.optimization,
    conversionEvent: c.conversionEvent,
    pixelId: e.pixelId,
    pageId: s.pageId,
    countries: c.countries,
    localeIds: s.localeIds,
    category: c.category,
    placement: c.placement,
    platforms: [],
    ageMin: c.ageMin,
    userOs: c.userOs,
    creatives: s.ads.map((a, i) => ({ name: `${e.name} · ${i + 1}`, media: { type: "image", image_hash: "6b05" }, primaryText: "Food choices…", headline: "LEARN MORE", url: a.link, cta: "LEARN_MORE" })),
    status: "ACTIVE",
    accountCurrency: "USD",
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.body.campaign.name, "[26/10] (VC) - GCL TOOL - [EN] - AV - Tima - FOOD - Lead");
  assert.equal(r.body.campaign.objective, "OUTCOME_LEADS");
  assert.equal(r.body.campaign.daily_budget, 7);
  assert.equal(r.body.campaign.bid_strategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(r.body.adsets[0].optimization_goal, "OFFSITE_CONVERSIONS");
  assert.deepEqual(r.body.adsets[0].conversion, { destination_type: "WEBSITE", pixel_id: vc.VC_LEAD_PIXEL.id, event: "LEAD" });
  assert.deepEqual(r.body.adsets[0].bid, { amount: 0.5 });
  assert.equal(r.body.adsets[0].ads.length, 2);
  assert.ok(r.body.adsets[0].ads.every((a) => a.creative.url === TRACK));
  assert.equal(r.body.options?.allow_inferred, true);
});
