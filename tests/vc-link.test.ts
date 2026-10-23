// Node's built-in runner (v24 strips types natively): `node --test tests/vc-link.test.ts`.
// VC (ValueClick) link / pixel / delivery contract — lib/vc-link imports ./types without an
// extension (the bundler's resolution); the hook lets the dynamic import load it straight off disk.
import "./_resolve-hook.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  VC_PIXEL,
  VC_SALES_OBJECTIVE,
  VC_TRAFFIC_OBJECTIVE,
  VC_READY_LINKS,
  vcDelivery,
  vcDestination,
  vcLink,
  vcLinkSegments,
  vcLockPatch,
  vcReadyLinkOf,
} = await import("../lib/vc-link.ts");
const { makeCampaign } = await import("../lib/types.ts");
const { adsetPayload, campaignPayload, creativePayload } = await import("../lib/fb-launch.ts");

const LP = "https://www.qualitydays.com/coa/words-or-actions-fn3zbpziuj/";

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

test("vcLockPatch: a fresh card converges to Purchase on the VC pixel and is idempotent", () => {
  const c = makeCampaign("c1");
  const patch = vcLockPatch(c);
  assert.deepEqual(patch, { pixel: VC_PIXEL.id });
  assert.deepEqual(vcLockPatch({ ...c, ...patch }), {});
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
  assert.equal(VC_READY_LINKS.length, 9);
  const ids = new Set<string>();
  for (const l of VC_READY_LINKS) {
    const d = vcDestination(l.url);
    assert.ok(d.ok, l.url);
    assert.equal(d.ok && d.url, l.url);
    assert.equal(d.ok && d.lpId, l.id);
    assert.ok(l.niche && l.title && l.lang === "EN", l.url);
    assert.ok(!ids.has(l.id), `duplicate ${l.id}`);
    ids.add(l.id);
  }
  assert.equal(vcReadyLinkOf(LP)?.id, "fn3zbpziuj");
  assert.equal(vcReadyLinkOf("qualitydays.com/coa/words-or-actions-fn3zbpziuj?x=1")?.id, "fn3zbpziuj");
  assert.equal(vcReadyLinkOf("https://www.qualitydays.com/coa/some-other-quiz-abcdefghij/"), null);
  assert.equal(vcReadyLinkOf(""), null);
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
