// Node's built-in runner (v24 strips types natively): `node --test tests/vc-link.test.ts`.
// VC (ValueClick) link / pixel / delivery contract — lib/vc-link imports ./types without an
// extension (the bundler's resolution); the hook lets the dynamic import load it straight off disk.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  VC_PIXEL,
  VC_LEAD_PIXEL,
  VC_PIXELS,
  VC_SALES_OBJECTIVE,
  VC_LEADS_OBJECTIVE,
  VC_TRAFFIC_OBJECTIVE,
  VC_READY_LINKS,
  pinVcNamePrefix,
  vcArticleTitle,
  vcAutoName,
  vcDelivery,
  vcDestination,
  vcLink,
  vcLinkSegments,
  vcLockPatch,
  vcModeOf,
  vcPixelName,
  vcReadyEventMismatch,
  vcReadyLinkOf,
  vcReadyMode,
  vcServerName,
} = await import("../lib/vc-link.ts");
const { isReady, makeCampaign, withPartnerMark } = await import("../lib/types.ts");
const { adsetPayload, campaignPayload, creativePayload } = await import("../lib/fb-launch.ts");
const { VC_OPTIMIZATIONS } = await import("../lib/catalog.ts");
const { buildToolCampaign } = await import("../lib/tool-launch.ts");
const { toolInputFromCampaign } = await import("../lib/tool-run.ts");

const LP = "https://www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/";
/** A Content Arb link of a landingpage NOT in the ready list — its title comes from the slug. */
const LP_OTHER = "https://www.qualitydays.com/coa/explore-your-dating-style-zz9yx8wv7u/";

test("the VC pixel is the dataset the owner gave for launcher campaigns", () => {
  assert.equal(VC_PIXEL.id, "1505591128290736");
});

test("vcDelivery: conversions / min-ROAS = Sales + Purchase on the VC pixel; clicks = Traffic, no pixel", () => {
  assert.deepEqual(vcDelivery("conversions"), { objective: VC_SALES_OBJECTIVE, optimization: "conversions", pixel: VC_PIXEL.id, conversionEvent: "PURCHASE" });
  assert.deepEqual(vcDelivery("clicks"), { objective: VC_TRAFFIC_OBJECTIVE, optimization: "clicks", pixel: "" });
  // min-ROAS always optimizes purchase value — a stale "clicks" draft still lands on the pixel
  assert.equal(vcDelivery("clicks", "LOWEST_COST_WITH_MIN_ROAS").pixel, VC_PIXEL.id);
  assert.equal(vcDelivery("").optimization, "conversions");
  assert.equal(vcDelivery("garbage").pixel, VC_PIXEL.id);
});

// ---- the Lead mode (owner ask 05.11: «возможность заливать на событие Lead») ----------------------------

test("the Lead dataset is the S-1 nik pixel the owner named; the known VC datasets carry their names", () => {
  assert.equal(VC_LEAD_PIXEL.id, "2126539511577664");
  assert.equal(VC_LEAD_PIXEL.name, "S-1 nik pixel");
  assert.deepEqual(VC_PIXELS.map((p) => p.id), [VC_PIXEL.id, VC_LEAD_PIXEL.id]);
  assert.equal(vcPixelName(VC_LEAD_PIXEL.id), "S-1 nik pixel");
  assert.equal(vcPixelName(VC_PIXEL.id), "VC pixel");
  assert.equal(vcPixelName("123"), "123");
  // the card's select offers the three modes by their mode value, Lead in the middle
  assert.deepEqual(VC_OPTIMIZATIONS.map((o) => o.value), ["conversions", "lead", "clicks"]);
  assert.match(VC_OPTIMIZATIONS[1].label, /Lead/);
  assert.match(VC_OPTIMIZATIONS[1].label, /S-1 nik pixel/);
});

test("vcDelivery('lead') = a Leads campaign optimizing LEAD on the S-1 nik pixel; min-ROAS still means Purchase value", () => {
  assert.deepEqual(vcDelivery("lead"), { objective: VC_LEADS_OBJECTIVE, optimization: "conversions", pixel: VC_LEAD_PIXEL.id, conversionEvent: "LEAD" });
  assert.equal(VC_LEADS_OBJECTIVE, "OUTCOME_LEADS");
  // a Lead card that switches to min-ROAS optimizes purchase VALUE on the VC pixel (Lead carries no value)
  assert.deepEqual(vcDelivery("lead", "LOWEST_COST_WITH_MIN_ROAS"), vcDelivery("conversions"));
  // a bid cap / cost cap keeps the Lead mode
  assert.equal(vcDelivery("lead", "LOWEST_COST_WITH_BID_CAP").conversionEvent, "LEAD");
  assert.equal(vcDelivery("lead", "COST_CAP").objective, VC_LEADS_OBJECTIVE);
});

test("vcModeOf: the mode is read off optimization + event — LEAD under conversions is the Lead mode, anything else Purchase", () => {
  const c = makeCampaign("m1");
  assert.equal(vcModeOf(c), "conversions");
  assert.equal(vcModeOf({ ...c, conversionEvent: "LEAD" }), "lead");
  assert.equal(vcModeOf({ ...c, optimization: "clicks", conversionEvent: "LEAD" }), "clicks");
  // another partner's draft event reads as Purchase (vcDelivery then pins PURCHASE)
  assert.equal(vcModeOf({ ...c, conversionEvent: "CONTENT_VIEW" }), "conversions");
  // the round trip: the mode the select shows is the mode its patch wrote
  for (const mode of ["conversions", "lead", "clicks"] as const) {
    assert.equal(vcModeOf({ ...c, ...vcDelivery(mode) }), mode, mode);
  }
});

test("vcReadyMode / vcReadyEventMismatch: a ready landingpage's VC Tracking event vs the card's optimization", () => {
  const BF = "https://www.qualitydays.com/coa/what-is-your-black-friday-shopping-superpower-d3k4c7b7ek/";
  assert.equal(vcReadyMode("LEAD"), "lead");
  assert.equal(vcReadyMode("PURCHASE"), "conversions");
  const purchase = { ...makeCampaign("r1"), ...vcDelivery("conversions") };
  const lead = { ...makeCampaign("r2"), ...vcDelivery("lead") };
  const clicks = { ...makeCampaign("r3"), ...vcDelivery("clicks") };
  // a Black Friday quiz fires Lead: a Purchase card is told so, a Lead card agrees, clicks optimize no event
  assert.equal(vcReadyEventMismatch({ ...purchase, landing: BF }), "LEAD");
  assert.equal(vcReadyEventMismatch({ ...lead, landing: BF }), "");
  assert.equal(vcReadyEventMismatch({ ...clicks, landing: BF }), "");
  // min-ROAS optimizes Purchase value whatever the mode — still a mismatch on a Lead quiz
  assert.equal(vcReadyEventMismatch({ ...lead, landing: BF, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" }), "LEAD");
  // the 23.10 nine fire Purchase: a Lead card is told so, a Purchase card agrees
  assert.equal(vcReadyEventMismatch({ ...lead, landing: LP }), "PURCHASE");
  assert.equal(vcReadyEventMismatch({ ...purchase, landing: LP }), "");
  // a landingpage outside the ready list (or no link) fires who-knows-what — nothing to compare
  assert.equal(vcReadyEventMismatch({ ...lead, landing: LP_OTHER }), "");
  assert.equal(vcReadyEventMismatch({ ...purchase, landing: "" }), "");
  // readiness holds a mismatched card through the partner's `fit` check (lib/partners launchReadyOpts for VC)
  const opts = { landing: true, landingValid: (v: string) => vcDestination(v).ok, page: true, account: true, fit: (c: { optimization: "conversions" | "clicks"; conversionEvent: string; bidStrategy: string; landing: string }) => !vcReadyEventMismatch(c) };
  const base = { ...purchase, name: "Tima", countries: ["US"], page: "6100", account: "123456" };
  assert.equal(isReady({ ...base, landing: LP }, opts), true);
  assert.equal(isReady({ ...base, landing: BF }, opts), false);
  assert.equal(isReady({ ...base, landing: BF, ...vcDelivery("lead") }, opts), true);
  assert.equal(isReady({ ...base, landing: BF, ...vcDelivery("clicks") }, opts), true);
});

test("vcLockPatch: a fresh card converges to Purchase on the VC pixel and is idempotent", () => {
  const c = makeCampaign("c1");
  const patch = vcLockPatch(c);
  assert.deepEqual(patch, { pixel: VC_PIXEL.id });
  assert.deepEqual(vcLockPatch({ ...c, ...patch }), {});
});

test("vcLockPatch: a Lead card keeps Lead — Leads objective + LEAD on the S-1 nik pixel — and is idempotent; a stale pixel / objective converge", () => {
  const lead = { ...makeCampaign("c3"), ...vcDelivery("lead") };
  assert.deepEqual(vcLockPatch(lead), {});
  // a restored Lead draft that still carries the VC pixel / Sales objective converges (the event wins)
  const stale = { ...lead, pixel: VC_PIXEL.id, objective: VC_SALES_OBJECTIVE };
  assert.deepEqual(vcLockPatch(stale), { objective: VC_LEADS_OBJECTIVE, pixel: VC_LEAD_PIXEL.id });
  // a Lead card on min-ROAS snaps to Purchase on the VC pixel (value), the strategy untouched
  const roas = { ...lead, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" };
  assert.deepEqual(vcLockPatch(roas), { objective: VC_SALES_OBJECTIVE, pixel: VC_PIXEL.id, conversionEvent: "PURCHASE" });
  // Lead → clicks drops to Traffic without a pixel; the stale LEAD event is harmless (no promoted_object)
  const clicks = { ...lead, optimization: "clicks" as const };
  assert.deepEqual(vcLockPatch(clicks), { objective: VC_TRAFFIC_OBJECTIVE, pixel: "" });
});

test("the shared FB payloads for a Lead card: OUTCOME_LEADS + OFFSITE_CONVERSIONS with LEAD on the S-1 nik pixel", () => {
  const lead = { ...makeCampaign("c11"), countries: ["US"], ...vcDelivery("lead") };
  assert.equal(campaignPayload(lead, "n").objective, "OUTCOME_LEADS");
  const binds = { accountId: "123456", pageId: "6100", pageName: "Page", pixelId: lead.pixel };
  const as = adsetPayload(lead, "n", "1", binds, []) as { promoted_object?: { pixel_id: string; custom_event_type: string }; optimization_goal: string };
  assert.equal(as.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.deepEqual(as.promoted_object, { pixel_id: VC_LEAD_PIXEL.id, custom_event_type: "LEAD" });
});

test("through TOOL a Lead card builds OUTCOME_LEADS / OFFSITE_CONVERSIONS / WEBSITE LEAD on the S-1 nik pixel (inferred combo, allow_inferred)", () => {
  const lead = { ...makeCampaign("c12"), countries: ["US"], budget: "7", bidStrategy: "LOWEST_COST_WITH_BID_CAP", bidCap: "0,50", cta: "LEARN_MORE", ...vcDelivery("lead") };
  const input = toolInputFromCampaign(lead, {
    name: "n",
    pageId: "6100",
    pixelId: lead.pixel,
    localeIds: [],
    creatives: [{ name: "n", media: { kind: "video", id: "v1" } as never, primaryText: "t", headline: "h", url: "https://trackwow3.xyz/r/x", cta: "LEARN_MORE" }],
    status: "ACTIVE",
    accountCurrency: "USD",
  });
  const r = buildToolCampaign(input);
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.body.campaign.objective, "OUTCOME_LEADS");
  assert.equal(r.body.adsets[0].optimization_goal, "OFFSITE_CONVERSIONS");
  assert.deepEqual(r.body.adsets[0].conversion, { destination_type: "WEBSITE", pixel_id: VC_LEAD_PIXEL.id, event: "LEAD" });
  assert.deepEqual(r.body.adsets[0].bid, { amount: 0.5 });
  // TOOL's /capabilities (05.11) confirms only LEAD_GENERATION/ON_AD under Leads — the website Lead combo rides inferred
  assert.equal(r.body.options?.allow_inferred, true);
});

// ---- the name carries the landingpage's title (owner ask 05.11) ------------------------------------------

test("vcArticleTitle: a ready landingpage's own VC title; any other Content Arb link reads its slug as words; junk = ''", () => {
  assert.equal(vcArticleTitle(LP), "Words or Actions? Explore Your Connection Style");
  assert.equal(vcArticleTitle("qualitydays.com/coa/explore-your-food-personality-35hkgthi0x?x=1"), "Explore Your Food Personality");
  assert.equal(vcArticleTitle(LP_OTHER), "Explore your dating style");
  assert.equal(vcArticleTitle("https://www.qualitydays.com/coa/money-zz9yx8wv7u/"), "Money");
  assert.equal(vcArticleTitle("https://example.com/coa/words-or-actions-fn3zbpziuj/"), "");
  assert.equal(vcArticleTitle("https://www.qualitydays.com/rsp/x/?cmpid=abc123defg"), "");
  assert.equal(vcArticleTitle(""), "");
  assert.equal(vcAutoName(LP_OTHER), "Explore your dating style - ");
  assert.equal(vcAutoName(""), "");
});

test("pinVcNamePrefix: the partner prefix + the title as its own segment, identity-preserving", () => {
  const base = "[05/11] (VC) - ";
  const a = { ...makeCampaign("p1", base, "Tima"), landing: LP };
  const b = { ...makeCampaign("p2", base, "Katya"), landing: "" };
  const rows = [a, b];
  const pinned = pinVcNamePrefix(rows, base);
  assert.equal(pinned[0].namePrefix, "[05/11] (VC) - Words or Actions? Explore Your Connection Style - ");
  assert.equal(pinned[0].name, "Tima");
  assert.equal(pinned[1].namePrefix, base);
  assert.equal(pinVcNamePrefix(pinned, base), pinned);
  // the link changes → the prefix follows
  const moved = pinVcNamePrefix([{ ...pinned[0], landing: LP_OTHER }], base);
  assert.equal(moved[0].namePrefix, "[05/11] (VC) - Explore your dating style - ");
  // a card born on another partner keeps only the date prefix it is given
  assert.equal(pinVcNamePrefix([{ ...a, namePrefix: "[05/11] (MO) - " }], base)[0].namePrefix, pinned[0].namePrefix);
});

test("vcServerName: date prefix + the RESOLVED link's title + the tail; a tail that already carries the title is not doubled", () => {
  const full = "[05/11] (VC) - Words or Actions? Explore Your Connection Style - Tima";
  assert.equal(vcServerName("[05/11] (VC) - ", "Tima", LP), full);
  // the client's locked prefix (title and all) is NOT the server's word — only its date part is kept
  assert.equal(vcServerName("[05/11] (VC) - Some Stale Title - ", "Tima", LP), full);
  // a tab that kept the title in the editable field / a buyer who typed it as a segment
  assert.equal(vcServerName("[05/11] (VC) - ", "Words or Actions? Explore Your Connection Style - Tima", LP), full);
  assert.equal(vcServerName("[05/11] (VC) - ", "Tima - words or actions? explore your connection style", LP), "[05/11] (VC) - Tima - words or actions? explore your connection style");
  // a title inside a longer segment is not the title
  assert.equal(vcServerName("[05/11] (VC) - ", "Tima Words or Actions? Explore Your Connection Style", LP), "[05/11] (VC) - Words or Actions? Explore Your Connection Style - Tima Words or Actions? Explore Your Connection Style");
  // an empty tail = the title alone; a dotted date prefix is kept as is; no prefix grammar = no date
  assert.equal(vcServerName("[05/11] (VC) - ", "", LP), "[05/11] (VC) - Words or Actions? Explore Your Connection Style");
  assert.equal(vcServerName("[05.11] (VC) - ", "Tima", LP_OTHER), "[05.11] (VC) - Explore your dating style - Tima");
  assert.equal(vcServerName("", "Tima", LP_OTHER), "Explore your dating style - Tima");
  // the route then stamps its own partner mark into the prefix
  assert.equal(withPartnerMark(vcServerName("[05/11] (MO) - ", "Tima", LP_OTHER), "VC"), "[05/11] (VC) - Explore your dating style - Tima");
  // a link that is not a VC landingpage (the route refuses it earlier anyway) adds nothing
  assert.equal(vcServerName("[05/11] (VC) - ", "Tima", "https://example.com/x"), "[05/11] (VC) - Tima");
});

test("vcLockPatch: clicks drop to Traffic without a pixel; min-ROAS keeps (and forces) conversions", () => {
  const clicks = { ...makeCampaign("c2"), optimization: "clicks" as const, pixel: VC_PIXEL.id };
  assert.deepEqual(vcLockPatch(clicks), { objective: VC_TRAFFIC_OBJECTIVE, pixel: "" });
  const roas = { ...clicks, objective: VC_TRAFFIC_OBJECTIVE, pixel: "", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,3" };
  assert.deepEqual(vcLockPatch(roas), { objective: VC_SALES_OBJECTIVE, optimization: "conversions", pixel: VC_PIXEL.id });
  // the bid strategy itself is untouched — VC's Purchase carries a value, min-ROAS is allowed
  assert.equal({ ...roas, ...vcLockPatch(roas) }.bidStrategy, "LOWEST_COST_WITH_MIN_ROAS");
});

test("vcDestination: accepts the Content Arb link (with/without scheme, slash, extras, fragment) and normalizes it", () => {
  const d = vcDestination(`  ${LP}  `);
  assert.ok(d.ok);
  assert.equal(d.ok && d.url, LP);
  assert.equal(d.ok && d.lpId, "fn3zbpziuj");
  const noScheme = vcDestination("www.qualitydays.com/coa/words-or-actions-fn3zbpziuj");
  assert.equal(noScheme.ok && noScheme.url, LP);
  const extras = vcDestination("http://qualitydays.com/coa/explore-your-food-personality-35hkgthi0x/?utm_source=fb#top");
  assert.equal(extras.ok && extras.url, "https://qualitydays.com/coa/explore-your-food-personality-35hkgthi0x/?utm_source=fb");
  assert.equal(extras.ok && extras.lpId, "35hkgthi0x");
});

test("vcDestination: refuses empty, junk, foreign hosts, look-alikes, Search Arb links, other paths, credentials and ports", () => {
  const bad = (s: string, re: RegExp) => {
    const d = vcDestination(s);
    assert.equal(d.ok, false, s);
    assert.match((d as { error: string }).error, re, s);
  };
  bad("", /destination_required/);
  bad("not a url at all", /destination/);
  bad("https://example.com/coa/words-or-actions-fn3zbpziuj/", /destination_not_vc/);
  bad("https://qualitydays.com.evil.io/coa/words-or-actions-fn3zbpziuj/", /destination_not_vc/);
  bad("https://notqualitydays.com/coa/words-or-actions-fn3zbpziuj/", /destination_not_vc/);
  // VC's Search Arb (RSOC) — not launched from here (owner 23.10: content arb only)
  bad("https://www.qualitydays.com/rsp/como-funciona-um-software-de-gestao-para-construcao-3/?cmpid=aoz37upzf0", /destination_search_arb/);
  bad("https://www.qualitydays.com/", /destination_not_coa/);
  bad("https://www.qualitydays.com/coa/", /destination_not_coa/);
  bad("https://www.qualitydays.com/coa/words-or-actions/", /destination_not_coa/);
  bad("https://www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/extra/", /destination_not_coa/);
  bad("https://u:p@www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/", /credentials/);
  bad("https://www.qualitydays.com:8443/coa/words-or-actions-fn3zbpziuj/", /port/);
  bad("ftp://www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/", /https/);
});

test("vcLink: the normalized landingpage link, nothing of ours added; joined segments = link", () => {
  assert.equal(vcLink(LP), LP);
  assert.equal(vcLink(`${LP}?utm_source=fb`), `${LP}?utm_source=fb`);
  assert.equal(new URL(vcLink(LP)).search, "");
  assert.equal(vcLink(LP), vcLinkSegments(LP).map((s) => s.text).join(""));
  assert.equal(vcLink("https://example.com/coa/x-fn3zbpziuj/"), "");
});

test("vcLinkSegments: base / quiz slug / the landingpage id tagged / tail", () => {
  const segs = vcLinkSegments(LP);
  assert.deepEqual(segs.map((s) => s.role), ["base", "slug", "gcm", "params"]);
  assert.equal(segs[0].text, "https://www.qualitydays.com/coa/");
  assert.equal(segs[1].text, "words-or-actions-");
  assert.equal(segs[2].text, "fn3zbpziuj");
  assert.equal(segs[3].text, "/");
  assert.equal(vcLinkSegments(`${LP}?a=1`)[3].text, "/?a=1");
});

test("VC_READY_LINKS: every ready landingpage is a valid Content Arb link whose id is its own", () => {
  assert.equal(VC_READY_LINKS.length, 27);
  const ids = new Set<string>();
  for (const l of VC_READY_LINKS) {
    const d = vcDestination(l.url);
    assert.ok(d.ok, l.url);
    assert.equal(d.ok && d.url, l.url);
    assert.equal(d.ok && d.lpId, l.id);
    assert.ok(l.niche && l.title && ["EN", "ES", "PT"].includes(l.lang), l.url);
    assert.ok(l.event === "PURCHASE" || l.event === "LEAD", l.url);
    assert.ok(!ids.has(l.id), `duplicate ${l.id}`);
    ids.add(l.id);
  }
  assert.equal(vcReadyLinkOf(LP)?.id, "fn3zbpziuj");
  // The three Black Friday landingpages (05.11) fire LEAD into the S-1 nik pixel per their VC Tracking;
  // the nine of 23.10 fire PURCHASE into the VC pixel.
  for (const id of ["d3k4c7b7ek", "kcvhp9yt0f", "yqj0on8cgc"]) assert.equal(VC_READY_LINKS.find((l) => l.id === id)?.event, "LEAD", id);
  assert.equal(VC_READY_LINKS.filter((l) => l.event === "PURCHASE").length, 9);
  const bf = vcReadyLinkOf("https://www.qualitydays.com/coa/what-is-your-black-friday-shopping-superpower-d3k4c7b7ek/");
  assert.equal(bf?.title, "What Is Your Black Friday Shopping Superpower?");
  assert.equal(bf?.niche, "Black Friday / Shopping");
  assert.equal(vcReadyLinkOf("https://www.qualitydays.com/coa/are-you-a-smart-planner-or-a-spontaneous-shopper-kcvhp9yt0f/")?.id, "kcvhp9yt0f");
  assert.equal(vcReadyLinkOf("https://www.qualitydays.com/coa/what-does-your-black-friday-shopping-style-reveal-about-you-yqj0on8cgc/")?.id, "yqj0on8cgc");
  assert.equal(vcReadyLinkOf("qualitydays.com/coa/words-or-actions-fn3zbpziuj?x=1")?.id, "fn3zbpziuj");
  assert.equal(vcReadyLinkOf("https://www.qualitydays.com/coa/some-other-quiz-abcdefghij/"), null);
  assert.equal(vcReadyLinkOf(""), null);
});

test("VC_READY_LINKS: the 10.11 quizzes — five niches, each in EN / ES / PT, each firing Lead", () => {
  // [language, niche, the link as VC prints it, the quiz's public title]
  const rows: [string, string, string, string][] = [
    ["EN", "Astrology / Zodiac", "https://www.qualitydays.com/coa/are-you-more-fire-earth-air-or-water-l9yz5jh8al/", "Are You More Fire, Earth, Air, or Water?"],
    ["ES", "Astrology / Zodiac", "https://www.qualitydays.com/coa/eres-mas-fuego-tierra-aire-o-agua-5m5zpgj36a/", "¿Eres más fuego, tierra, aire o agua?"],
    ["PT", "Astrology / Zodiac", "https://www.qualitydays.com/coa/voce-e-mais-fogo-terra-ar-ou-agua-lni5wgxefh/", "Você é mais fogo, terra, ar ou água?"],
    ["EN", "Love / Relationships", "https://www.qualitydays.com/coa/are-you-a-romantic-dreamer-or-a-practical-partner-afisuync73/", "Are You a Romantic Dreamer or a Practical Partner?"],
    ["ES", "Love / Relationships", "https://www.qualitydays.com/coa/eres-un-alma-romantica-o-un-corazon-practico-l470bp8ioz/", "¿Eres un alma romántica o un corazón práctico?"],
    ["PT", "Love / Relationships", "https://www.qualitydays.com/coa/no-amor-voce-sonha-alto-ou-tem-os-pes-no-chao-9xih0kcl3c/", "No amor, você sonha alto ou tem os pés no chão?"],
    ["EN", "Numerology / Life Path", "https://www.qualitydays.com/coa/what-does-your-birthday-number-represent-63lpxyt9f6/", "What Does Your Birthday Number Represent?"],
    ["ES", "Numerology / Life Path", "https://www.qualitydays.com/coa/que-representa-tu-numero-de-cumpleanos-azumevchez/", "¿Qué representa tu número de cumpleaños?"],
    ["PT", "Numerology / Life Path", "https://www.qualitydays.com/coa/o-que-o-seu-numero-de-aniversario-representa-1582t0n3uf/", "O que o seu número de aniversário representa?"],
    ["EN", "Tarot / Intuition", "https://www.qualitydays.com/coa/are-you-more-the-star-the-sun-or-the-empress-iizi7oluss/", "Are You More The Star, The Sun, or The Empress?"],
    ["ES", "Tarot / Intuition", "https://www.qualitydays.com/coa/eres-mas-la-estrella-el-sol-o-la-emperatriz-v114lsuae4/", "¿Eres más La Estrella, El Sol o La Emperatriz?"],
    ["PT", "Tarot / Intuition", "https://www.qualitydays.com/coa/voce-e-mais-a-estrela-o-sol-ou-a-imperatriz-0t3j63tlvo/", "Você é mais a Estrela, o Sol ou a Imperatriz?"],
    ["EN", "Self-Care / Inner Balance", "https://www.qualitydays.com/coa/are-you-a-cozy-evening-or-outdoor-escape-person-9219428wfo/", "Are You a Cozy Evening or Outdoor Escape Person?"],
    ["ES", "Self-Care / Inner Balance", "https://www.qualitydays.com/coa/eres-de-noches-acogedoras-o-de-escapadas-al-aire-libre-0tda2xyfd5/", "¿Eres de noches acogedoras o de escapadas al aire libre?"],
    ["PT", "Self-Care / Inner Balance", "https://www.qualitydays.com/coa/voce-e-do-tipo-noite-aconchegante-ou-aventura-ao-ar-livre-y83zpkdt2f/", "Você é do tipo noite aconchegante ou aventura ao ar livre?"],
  ];
  const purchase = { ...makeCampaign("q1"), ...vcDelivery("conversions") };
  const lead = { ...makeCampaign("q2"), ...vcDelivery("lead") };
  for (const [lang, niche, url, title] of rows) {
    const l = vcReadyLinkOf(url);
    assert.ok(l, url);
    assert.equal(l.url, url);
    assert.equal(l.lang, lang, url);
    assert.equal(l.niche, niche, url);
    assert.equal(l.title, title, url);
    // their VC Tracking (read in VC 10.11): S-1 nik pixel + Lead — a Lead card agrees, a Purchase card is told
    assert.equal(l.event, "LEAD", url);
    assert.equal(vcReadyEventMismatch({ ...lead, landing: url }), "", url);
    assert.equal(vcReadyEventMismatch({ ...purchase, landing: url }), "LEAD", url);
    // the campaign name carries the quiz's own title, in the quiz's language — accents, ¿ and commas as they are,
    // and a tail that already holds the title is not doubled
    assert.equal(vcArticleTitle(url), title);
    assert.equal(vcServerName("[10/11] (VC) - ", "Tima", url), `[10/11] (VC) - ${title} - Tima`);
    assert.equal(vcServerName("[10/11] (VC) - ", `${title} - Tima`, url), `[10/11] (VC) - ${title} - Tima`);
  }
  // a niche is one picker section holding its three languages, EN first
  for (const niche of new Set(rows.map((r) => r[1])))
    assert.deepEqual(VC_READY_LINKS.filter((l) => l.niche === niche).map((l) => l.lang), ["EN", "ES", "PT"], niche);
  // every earlier ready landingpage is English
  assert.equal(VC_READY_LINKS.filter((l) => l.lang === "EN").length, 17);
});

test("the shared FB payloads carry the VC pixel + Purchase on conversions and nothing on clicks", () => {
  const conv = { ...makeCampaign("c9"), countries: ["BR"], ...vcDelivery("conversions") };
  const binds = { accountId: "123456", pageId: "6100", pageName: "Page", pixelId: VC_PIXEL.id };
  assert.equal(campaignPayload(conv, "n").objective, "OUTCOME_SALES");
  const as = adsetPayload(conv, "n", "1", binds, []) as { promoted_object?: { pixel_id: string; custom_event_type: string }; optimization_goal: string };
  assert.deepEqual(as.promoted_object, { pixel_id: VC_PIXEL.id, custom_event_type: "PURCHASE" });
  assert.equal(as.optimization_goal, "OFFSITE_CONVERSIONS");
  const clicks = { ...makeCampaign("c10"), countries: ["BR"], ...vcDelivery("clicks") };
  const asc = adsetPayload(clicks, "n", "1", { ...binds, pixelId: "" }, []) as { promoted_object?: unknown; optimization_goal: string };
  assert.equal(asc.promoted_object, undefined);
  assert.equal(asc.optimization_goal, "LINK_CLICKS");
  assert.equal(campaignPayload(clicks, "n").objective, "OUTCOME_TRAFFIC");
  const link = vcLink(LP);
  const cr = creativePayload({ ...conv, cta: "LEARN_MORE", headline: "Hi" }, "n", binds, { videoId: "v1", thumbUrl: "https://x/t.jpg", link }) as {
    object_story_spec: { video_data: { call_to_action: { value: { link: string } } } };
  };
  assert.equal(cr.object_story_spec.video_data.call_to_action.value.link, link);
});

test("vcToolAccounts: VC's cabinets in TOOL = named GC-for-VC-* or seen by a session of the VC project", async () => {
  const { vcToolAccounts, isPageId } = await import("../lib/vc-link.ts");
  const rows = [
    { account_id: "1", name: "GC-for-VC-BR-742", sessions: [{ id: 1 }] },
    { account_id: "2", name: "gc-for-vc-br-762", sessions: [] },
    { account_id: "6", name: "GC-VD-C1-DE-38-RSOC", sessions: [{ id: 2 }] },
    { account_id: "3", name: "GC-HS-VD-C1-BR-7", sessions: [{ id: 2 }] },
    { account_id: "4", name: "Willie Dumond", sessions: [{ id: 3 }] },
    { account_id: "5", name: "GC-AV-LA-565", sessions: [{ id: 4 }] },
  ];
  const projects: Record<number, string | null> = { 1: "HS", 2: "HS", 3: "vc", 4: "AV" };
  assert.deepEqual(vcToolAccounts(rows, (id) => projects[id]).map((a) => a.account_id), ["1", "2", "4"]);
  assert.deepEqual(vcToolAccounts(rows, () => null).map((a) => a.account_id), ["1", "2"]);
  assert.ok(isPageId("610000000000001") && !isPageId("61x") && !isPageId("1234"));
  const { isVcAccountName } = await import("../lib/vc-link.ts");
  assert.ok(isVcAccountName("GC-for-VC-BR-749") && isVcAccountName(" gc-for-vc-br-762 "));
  assert.ok(!isVcAccountName("rr") && !isVcAccountName("GC-VD-C1-DE-4") && !isVcAccountName("GC-HS-VD-C1-BR-7") && !isVcAccountName(""));
});
