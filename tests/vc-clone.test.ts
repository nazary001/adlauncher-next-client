// Node's built-in runner (v24 strips types natively): `node --test tests/vc-clone.test.ts`.
// VC (ValueClick) clones — the pure contract behind the VC cloner (owner ask 05.11: clones of every ACTIVE
// VC campaign onto the "S-1 nik pixel", bid cap $0,50, Lead optimization instead of Purchase; owner ask
// 17.11: a full cloner like the other partners' — the cabinet, the page, the pixel, the targeting per row):
// the source read off a Graph campaign tree, a board row turned into the edit, where the clone lands, the
// Campaign the launch payload builders get, the refusals, and the TOOL body.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const vc = await import("../lib/vc-clone.ts");
const { VC_PIXEL } = await import("../lib/vc-link.ts");
const { adsetPayload, campaignPayload } = await import("../lib/fb-launch.ts");
const { cloneCreativePayload } = await import("../lib/clone-run.ts");
const tl = await import("../lib/tool-launch.ts");
const cloneLib = await import("../lib/clone.ts");
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

type Src = ReturnType<typeof vc.vcCloneSourceOf>;
type Pick = Parameters<typeof vc.vcRowEdit>[1];

/** A board row seeded from a source and left untouched (what components/clone-board seeds for it). */
function rowOf(s: Src, over: Partial<Pick> = {}): Pick {
  return {
    name: "[17/11] (CLONE) - (VC) - [EN] - AV - Tima - FOOD",
    budget: s.budget,
    bidStrategy: s.bidStrategy,
    bid: s.bidCap,
    countries: [...s.countries],
    locales: vc.vcLocaleNames(s.localeIds),
    category: s.category,
    placement: s.placement,
    ageMin: s.ageMin,
    accountId: "",
    pageId: "",
    pixelId: "",
    event: "SOURCE",
    userOs: "",
    ...over,
  };
}

/** The 05.11 batch (Lead on the S-1 pixel, bid cap $0,50) as a row. */
const LEAD: Partial<Pick> = { event: "LEAD", bidStrategy: "LOWEST_COST_WITH_BID_CAP", bid: "0,50", name: "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead" };

/** A link-click source: Traffic, no promoted pixel. */
const clickTree = () => tree({ objective: "OUTCOME_TRAFFIC", bid_strategy: "LOWEST_COST_WITHOUT_CAP", adsets: { data: [{ optimization_goal: "LINK_CLICKS", targeting: { geo_locations: { countries: ["US"] } } }] } });

test("the Lead pixel is the dataset the owner named (S-1 nik pixel); the board offers as-the-source, Lead and Purchase", () => {
  assert.equal(vc.VC_LEAD_PIXEL.id, "2126539511577664");
  assert.deepEqual(
    vc.VC_CLONE_PIXELS.map((p) => p.id),
    [vc.VC_LEAD_PIXEL.id, VC_PIXEL.id],
  );
  assert.deepEqual(
    vc.VC_CLONE_EVENTS.map((e) => e.value),
    ["SOURCE", "LEAD", "PURCHASE"],
  );
  assert.equal(vc.vcPixelName(VC_PIXEL.id), VC_PIXEL.name);
  assert.equal(vc.vcPixelName("123"), "123");
});

test("vcCloneDelivery: Lead = OUTCOME_LEADS + LEAD on the S-1 pixel (Meta refuses LEAD under Sales); Purchase = OUTCOME_SALES + PURCHASE on the VC pixel; as the source = the source's own", () => {
  assert.deepEqual(vc.vcCloneDelivery("LEAD"), { objective: "OUTCOME_LEADS", optimization: "conversions", conversionEvent: "LEAD", pixel: vc.VC_LEAD_PIXEL.id });
  assert.deepEqual(vc.vcCloneDelivery("PURCHASE"), { objective: "OUTCOME_SALES", optimization: "conversions", conversionEvent: "PURCHASE", pixel: VC_PIXEL.id });
  const purchase = vc.vcCloneSourceOf(tree());
  assert.deepEqual(vc.vcCloneDelivery("SOURCE", purchase), { objective: "OUTCOME_SALES", optimization: "conversions", conversionEvent: "PURCHASE", pixel: VC_PIXEL.id });
  const lead = vc.vcCloneSourceOf(
    tree({ objective: "OUTCOME_LEADS", adsets: { data: [{ optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "2126539511577664", custom_event_type: "LEAD" }, targeting: { geo_locations: { countries: ["US"] } } }] } }),
  );
  assert.deepEqual(vc.vcCloneDelivery("SOURCE", lead), { objective: "OUTCOME_LEADS", optimization: "conversions", conversionEvent: "LEAD", pixel: "2126539511577664" });
  // a link-click source stays a click clone with no pixel; forcing Lead on it makes it a Lead clone
  const clicks = vc.vcCloneSourceOf(clickTree());
  assert.deepEqual(vc.vcCloneDelivery("SOURCE", clicks), { objective: "OUTCOME_TRAFFIC", optimization: "clicks", conversionEvent: "", pixel: "" });
  assert.equal(vc.vcCloneDelivery("LEAD", clicks).objective, "OUTCOME_LEADS");
  assert.equal(vc.isVcCloneEvent("LEAD"), true);
  assert.equal(vc.isVcCloneEvent("SOURCE"), true);
  assert.equal(vc.isVcCloneEvent("lead"), false);
  assert.equal(vc.isVcCloneEvent(""), false);
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
  const s3 = vc.vcCloneSourceOf(
    tree({ daily_budget: undefined, bid_strategy: undefined, adsets: { data: [{ daily_budget: "1000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", optimization_goal: "LINK_CLICKS", targeting: { geo_locations: { countries: ["BR", "MX"] } } }] }, ads: { data: [] } }),
  );
  assert.equal(s3.budget, "10");
  assert.equal(s3.bidStrategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(s3.bidCap, "");
  assert.equal(s3.pixelId, "");
  assert.equal(s3.conversionEvent, "");
  assert.deepEqual(s3.countries, ["BR", "MX"]);
  assert.equal(s3.pageId, "");
  assert.deepEqual(s3.ads, []);
});

test("vcLocaleNames + vcBoardSource: the source as the shared clone board's row source — its locale ids spelled as names, the VC facts along", () => {
  assert.deepEqual(vc.vcLocaleNames([6, 16]), ["English (US)", "Portuguese (Brazil)"]);
  assert.deepEqual(vc.vcLocaleNames([]), []);
  assert.deepEqual(vc.vcLocaleNames([21]), []); // "Chinese (traditional)" needs both of its keys
  assert.deepEqual(vc.vcLocaleNames([21, 22, 999999]), ["Chinese (traditional)"]);
  const s = vc.vcCloneSourceOf(tree(), "GC-for-VC-BR-742");
  const b = vc.vcBoardSource(s);
  assert.equal(b.campaignId, s.campaignId);
  assert.equal(b.name, s.name);
  assert.deepEqual(b.countries, ["US"]);
  assert.deepEqual(b.locales, []);
  assert.equal(b.originalBudget, "7");
  assert.equal(b.originalRoas, "2");
  assert.equal(b.bidStrategy, "LOWEST_COST_WITH_BID_CAP");
  assert.equal(b.optimization, "conversions");
  assert.equal(b.conversionEvent, "PURCHASE");
  assert.equal(b.redirectType, "");
  assert.equal(b.creatives.length, 2);
  assert.equal(b.vc, s);
  assert.equal(vc.vcBoardSource(vc.vcCloneSourceOf(clickTree())).optimization, "clicks");
});

test("vcRowEdit: an untouched row is a faithful copy in the source's own cabinet — no override rides the edit", () => {
  const s = vc.vcCloneSourceOf(tree());
  assert.deepEqual(vc.vcRowEdit(s, rowOf(s)), {
    campaignId: "52564425188380",
    accountId: "1203001234567890",
    name: "[17/11] (CLONE) - (VC) - [EN] - AV - Tima - FOOD",
    budget: "7",
    bidStrategy: "LOWEST_COST_WITH_BID_CAP",
    bidCap: "2",
    pixelId: "",
    event: "SOURCE",
  });
  // the board's "From each source" picks are the source's own too
  assert.deepEqual(vc.vcRowEdit(s, rowOf(s, { accountId: "source", pageId: "source" })), vc.vcRowEdit(s, rowOf(s)));
  // a source with locale ids the table has no name for keeps them: nothing to override
  const odd = vc.vcCloneSourceOf(tree({ adsets: { data: [{ targeting: { locales: [6, 999999], geo_locations: { countries: ["US"] } } }] } }));
  assert.equal(vc.vcRowEdit(odd, rowOf(odd)).locales, undefined);
  assert.deepEqual(vc.vcCloneLocaleIds(vc.vcRowEdit(odd, rowOf(odd)), odd), { ids: [6, 999999], unknown: [] });
});

test("vcRowEdit: what the buyer changed rides as an override — the cabinet, the page, the pixel, the event, the targeting, the bid", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcRowEdit(
    s,
    rowOf(s, {
      accountId: "act_1203009999999999",
      pageId: "610000000000002",
      pixelId: "2126539511577664",
      event: "LEAD",
      countries: ["BR", "MX"],
      locales: ["Portuguese (Brazil)"],
      placement: "COMPLIANCE",
      ageMin: "25",
      userOs: "android",
      budget: "12,00",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      bid: "0,50",
    }),
  );
  assert.equal(e.accountId, "1203009999999999");
  assert.equal(e.pageId, "610000000000002");
  assert.equal(e.pixelId, "2126539511577664");
  assert.equal(e.event, "LEAD");
  assert.deepEqual(e.countries, ["BR", "MX"]);
  assert.deepEqual(e.locales, ["Portuguese (Brazil)"]);
  assert.equal(e.placement, "COMPLIANCE");
  assert.equal(e.ageMin, "25");
  assert.equal(e.userOs, "android");
  assert.equal(e.budget, "12,00");
  assert.equal(e.bidStrategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(e.bidCap, ""); // lowest cost carries no bid
  // the source's own page / OS picked again is no override; a garbage pixel never rides
  const same = vc.vcRowEdit(s, rowOf(s, { pageId: PAGE, userOs: "all", pixelId: "abc" }));
  assert.equal(same.pageId, undefined);
  assert.equal(same.userOs, undefined);
  assert.equal(same.pixelId, "");
});

test("vcCloneBinds: where the clone lands — the picks over the source's own; another cabinet is a cross-account clone; a click clone promotes no pixel", () => {
  const s = vc.vcCloneSourceOf(tree());
  assert.deepEqual(vc.vcCloneBinds(vc.vcRowEdit(s, rowOf(s)), s), { accountId: s.accountId, pageId: PAGE, pixelId: VC_PIXEL.id, cross: false });
  assert.deepEqual(vc.vcCloneBinds(vc.vcRowEdit(s, rowOf(s, { event: "LEAD" })), s), { accountId: s.accountId, pageId: PAGE, pixelId: vc.VC_LEAD_PIXEL.id, cross: false });
  assert.deepEqual(vc.vcCloneBinds(vc.vcRowEdit(s, rowOf(s, { accountId: "1203009999999999", pageId: "610000000000002", pixelId: "2200000000000001" })), s), {
    accountId: "1203009999999999",
    pageId: "610000000000002",
    pixelId: "2200000000000001",
    cross: true,
  });
  // an edit queued before 17.11: the source's cabinet named, the pixel and the event explicit
  assert.deepEqual(vc.vcCloneBinds({ accountId: s.accountId, pixelId: vc.VC_LEAD_PIXEL.id, event: "LEAD" }, s), { accountId: s.accountId, pageId: PAGE, pixelId: vc.VC_LEAD_PIXEL.id, cross: false });
  assert.equal(vc.vcCloneBinds({ accountId: "", pixelId: "", event: "LEAD" }, s).accountId, s.accountId);
  const clicks = vc.vcCloneSourceOf(clickTree());
  assert.equal(vc.vcCloneBinds(vc.vcRowEdit(clicks, rowOf(clicks, { pixelId: "2200000000000001" })), clicks).pixelId, "");
});

test("vcCloneCampaign + the launch builders: OUTCOME_LEADS CBO at the source's $7, bid_amount 50 on the ad set, LEAD on the S-1 pixel, the source's targeting, DSA from the binds", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcRowEdit(s, rowOf(s, LEAD));
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

  const b = vc.vcCloneBinds(e, s);
  const binds = { accountId: b.accountId, pageId: b.pageId, pageName: s.dsaBeneficiary, pixelId: b.pixelId };
  const adset = adsetPayload(c, e.name, "CAMP1", binds, vc.vcCloneLocaleIds(e, s).ids) as Record<string, any>;
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

test("vcCloneCampaign: a row's own cabinet, page and targeting reach the ad set; a click source clones as link clicks with no promoted pixel", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcRowEdit(
    s,
    rowOf(s, { accountId: "1203009999999999", pageId: "610000000000002", countries: ["BR", "MX"], locales: ["Portuguese (Brazil)", "Spanish (all)"], placement: "COMPLIANCE_HOMEM", ageMin: "25", userOs: "android" }),
  );
  const c = vc.vcCloneCampaign(e, s);
  assert.equal(c.account, "1203009999999999");
  assert.equal(c.page, "610000000000002");
  assert.equal(c.objective, "OUTCOME_SALES"); // as the source
  assert.equal(c.pixel, VC_PIXEL.id);
  assert.deepEqual(c.countries, ["BR", "MX"]);
  assert.deepEqual(vc.vcCloneLocaleIds(e, s), { ids: [16], unknown: [] }); // "(all)" = no restriction
  const b = vc.vcCloneBinds(e, s);
  const adset = adsetPayload(c, e.name, "CAMP1", { accountId: b.accountId, pageId: b.pageId, pageName: "E2E Fanpage Two", pixelId: b.pixelId }, vc.vcCloneLocaleIds(e, s).ids) as Record<string, any>;
  assert.deepEqual(adset.targeting.geo_locations, { location_types: ["home", "recent"], countries: ["BR", "MX"] });
  assert.deepEqual(adset.targeting.locales, [16]);
  assert.equal(adset.targeting.age_min, 25);
  assert.deepEqual(adset.targeting.genders, [1]);
  assert.deepEqual(adset.targeting.user_os, ["Android"]);
  assert.deepEqual(adset.promoted_object, { pixel_id: VC_PIXEL.id, custom_event_type: "PURCHASE" });
  assert.equal(adset.dsa_beneficiary, "E2E Fanpage Two");

  const clicks = vc.vcCloneSourceOf(clickTree());
  const ce = vc.vcRowEdit(clicks, rowOf(clicks));
  const cc = vc.vcCloneCampaign(ce, clicks);
  assert.equal(cc.objective, "OUTCOME_TRAFFIC");
  assert.equal(cc.optimization, "clicks");
  assert.equal(cc.pixel, "");
  const cb = vc.vcCloneBinds(ce, clicks);
  const cad = adsetPayload(cc, ce.name, "C", { accountId: cb.accountId, pageId: cb.pageId, pageName: "", pixelId: cb.pixelId }, []) as Record<string, any>;
  assert.equal(cad.optimization_goal, "LINK_CLICKS");
  assert.equal(cad.promoted_object, undefined);
  assert.equal(vc.vcCloneRefusal(ce, clicks), null);
});

test("the creative is rebuilt from the source ad as is — same image, same copy, the tracking link untouched; the page is the clone's", () => {
  const ad = tree().ads.data[0];
  const media = { kind: "image" as const, data: ad.creative.object_story_spec.link_data };
  const cr = cloneCreativePayload("clone · 1", PAGE, media, "", "", (l) => l) as Record<string, any>;
  assert.equal(cr.name, "clone · 1");
  assert.equal(cr.object_story_spec.page_id, PAGE);
  assert.equal(cr.object_story_spec.link_data.link, TRACK);
  assert.equal(cr.object_story_spec.link_data.image_hash, "6b05");
  assert.equal(cr.object_story_spec.link_data.message, "Food choices…");
  assert.deepEqual(cr.object_story_spec.link_data.call_to_action, { type: "LEARN_MORE", value: { link: TRACK } });
  const other = cloneCreativePayload("clone · 1", "610000000000002", media, "", "", (l) => l) as Record<string, any>;
  assert.equal(other.object_story_spec.page_id, "610000000000002");
});

test("vcCloneRefusal: a faithful copy and the Lead batch pass; every bad edit is refused by name before any write", () => {
  const s = vc.vcCloneSourceOf(tree());
  assert.equal(vc.vcCloneRefusal(vc.vcRowEdit(s, rowOf(s)), s), null);
  const good = vc.vcRowEdit(s, rowOf(s, LEAD));
  assert.equal(vc.vcCloneRefusal(good, s), null);
  assert.match(vc.vcCloneRefusal({ ...good, event: "VIEW" as never }, s) ?? "", /^event_invalid/);
  assert.equal(vc.vcCloneRefusal({ ...good, pixelId: "" }, s), null); // "" = the event's own dataset
  assert.match(vc.vcCloneRefusal({ ...good, pixelId: "abc" }, s) ?? "", /^pixel_required/);
  assert.match(vc.vcCloneRefusal({ ...good, name: "  " }, s) ?? "", /^name_required/);
  assert.match(vc.vcCloneRefusal({ ...good, accountId: "nope" }, s) ?? "", /^account_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, pageId: "nope" }, s) ?? "", /^fanpage_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, bidStrategy: "TARGET_COST" }, s) ?? "", /^bid_strategy_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, bidCap: "" }, s) ?? "", /^bid_required/);
  assert.match(vc.vcCloneRefusal({ ...good, bidCap: "0" }, s) ?? "", /^bid_required/);
  assert.match(vc.vcCloneRefusal({ ...good, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }, s) ?? "", /^roas_needs_purchase/);
  assert.equal(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }, s), null);
  assert.equal(vc.vcCloneRefusal({ ...good, event: "SOURCE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }, s), null); // the source is Purchase
  assert.match(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "15" }, s) ?? "", /^roas_goal_ambiguous/);
  assert.match(vc.vcCloneRefusal({ ...good, event: "PURCHASE", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "500" }, s) ?? "", /^roas_goal_invalid/);
  assert.match(vc.vcCloneRefusal({ ...good, budget: "0,5" }, s) ?? "", /^budget_too_low/);
  assert.equal(vc.vcCloneRefusal({ ...good, bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidCap: "" }, s), null);
  assert.match(vc.vcCloneRefusal({ ...good, countries: [] }, s) ?? "", /^geo_required/);
  assert.match(vc.vcCloneRefusal({ ...good, countries: ["Brazil"] }, s) ?? "", /^geo_invalid/);
  assert.equal(vc.vcCloneRefusal({ ...good, countries: ["WW"] }, s), null);
  assert.match(vc.vcCloneRefusal({ ...good, locales: ["Zulu"] }, s) ?? "", /^locale_unknown/);
  const noGeo = vc.vcCloneSourceOf(tree({ adsets: { data: [{ targeting: {} }] } }));
  assert.match(vc.vcCloneRefusal(vc.vcRowEdit(noGeo, rowOf(noGeo, LEAD)), noGeo) ?? "", /country/);
  const noAds = vc.vcCloneSourceOf(tree({ ads: { data: [] } }));
  assert.match(vc.vcCloneRefusal(vc.vcRowEdit(noAds, rowOf(noAds, LEAD)), noAds) ?? "", /page unknown/);
  // a picked page rescues a source whose ads name none — then the missing reusable ad is what stops it
  assert.match(vc.vcCloneRefusal(vc.vcRowEdit(noAds, rowOf(noAds, { ...LEAD, pageId: "610000000000002" })), noAds) ?? "", /no reusable/);
  const noMedia = vc.vcCloneSourceOf(tree({ ads: { data: [{ id: "1", creative: { object_story_spec: { page_id: PAGE, link_data: { link: TRACK } } } }] } }));
  assert.match(vc.vcCloneRefusal(vc.vcRowEdit(noMedia, rowOf(noMedia, LEAD)), noMedia) ?? "", /no reusable/);
});

test("isVcCloneEdit: the wire shape the clone route accepts — today's edit, and the one queued before 17.11", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcRowEdit(s, rowOf(s, { accountId: "1203009999999999", countries: ["BR"], locales: ["Portuguese (Brazil)"], userOs: "android" }));
  assert.equal(vc.isVcCloneEdit(e), true);
  assert.equal(vc.isVcCloneEdit({ ...e, campaignId: "x" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, event: "nope" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, name: 5 }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, countries: "BR" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, locales: [16] }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, userOs: "ios" }), false);
  assert.equal(vc.isVcCloneEdit({ ...e, pageId: 610000000000002 }), false);
  assert.equal(vc.isVcCloneEdit(null), false);
  assert.equal(vc.isVcCloneEdit({ campaignId: "52564425188380", name: "n", event: "LEAD" }), true);
  // the body of a job queued by the 05.11 board: no page, no targeting, the source's cabinet named
  const old = {
    campaignId: "52564425188380",
    accountId: "1203001234567890",
    name: "[26/10] (VC) - [EN] - AV - Tima - FOOD - Lead",
    budget: "7",
    bidStrategy: "LOWEST_COST_WITH_BID_CAP",
    bidCap: "0,50",
    pixelId: "2126539511577664",
    event: "LEAD" as const,
  };
  assert.equal(vc.isVcCloneEdit(old), true);
  assert.equal(vc.vcCloneRefusal(old, s), null);
  const c = vc.vcCloneCampaign(old, s);
  assert.equal(c.objective, "OUTCOME_LEADS");
  assert.equal(c.account, s.accountId);
  assert.equal(c.page, PAGE);
  assert.equal(c.pixel, "2126539511577664");
  assert.equal(vc.vcCloneBinds(old, s).cross, false);
});

test("VC clone through TOOL: the same Campaign maps to a CampaignRequest — OUTCOME_LEADS, conversion LEAD on the S-1 pixel, bid {amount: 0.5} USD, the tracking link on every creative", () => {
  const s = vc.vcCloneSourceOf(tree());
  const e = vc.vcRowEdit(s, rowOf(s, LEAD));
  const c = vc.vcCloneCampaign(e, s);
  const b = vc.vcCloneBinds(e, s);
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
    pixelId: b.pixelId,
    pageId: b.pageId,
    countries: c.countries,
    localeIds: vc.vcCloneLocaleIds(e, s).ids,
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

test("a clone's name on the shared board carries (CLONE) and the (VC) tier; through TOOL the mark sits after that prefix", () => {
  const { splitCloneName } = cloneLib;
  assert.deepEqual(splitCloneName("[26/10] (VC) - [EN] - AV - Tima - FOOD", "17.11"), { prefix: "[17/11] (CLONE) - (VC) - ", name: "[EN] - AV - Tima - FOOD" });
  // a clone of a clone, and of a TOOL-born source (the board drops the source's mark off the tail)
  assert.deepEqual(splitCloneName("[10/11] (CLONE) - (VC) - GCL TOOL - Quiz - Tima", "17.11"), { prefix: "[17/11] (CLONE) - (VC) - ", name: "GCL TOOL - Quiz - Tima" });
  assert.equal(tl.stripToolMark("GCL TOOL - Quiz - Tima"), "Quiz - Tima");
  assert.equal(tl.toolEnsureMark("[17/11] (CLONE) - (VC) - Quiz - Tima"), "[17/11] (CLONE) - (VC) - GCL TOOL - Quiz - Tima");
});
