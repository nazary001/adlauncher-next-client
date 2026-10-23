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
  vcAdTitle,
  vcDelivery,
  vcDestination,
  vcLink,
  vcLinkSegments,
  vcLockPatch,
} = await import("../lib/vc-link.ts");
const { makeCampaign } = await import("../lib/types.ts");
const { adsetPayload, campaignPayload, creativePayload } = await import("../lib/fb-launch.ts");

const LP = "https://www.qualitydays.com/rsp/como-funciona-um-software-de-gestao-para-construcao-3/?cmpid=aoz37upzf0";

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

test("vcDestination: accepts the dashboard link (with/without scheme, extras, fragment) and normalizes it", () => {
  const d = vcDestination(`  ${LP}  `);
  assert.ok(d.ok);
  assert.equal(d.ok && d.url, LP);
  assert.equal(d.ok && d.cmpid, "aoz37upzf0");
  const noScheme = vcDestination("www.qualitydays.com/rsp/x-y/?cmpid=abc123defg&sty=dark");
  assert.equal(noScheme.ok && noScheme.url, "https://www.qualitydays.com/rsp/x-y/?cmpid=abc123defg&sty=dark");
  const http = vcDestination("http://qualitydays.com/rsp/x/?cmpid=abc123defg#top");
  assert.equal(http.ok && http.url, "https://qualitydays.com/rsp/x/?cmpid=abc123defg");
});

test("vcDestination: refuses empty, junk, foreign hosts, look-alikes, no cmpid, home page, credentials and ports", () => {
  const bad = (s: string, re: RegExp) => {
    const d = vcDestination(s);
    assert.equal(d.ok, false, s);
    assert.match((d as { error: string }).error, re, s);
  };
  bad("", /destination_required/);
  bad("not a url at all", /destination/);
  bad("https://example.com/rsp/x/?cmpid=abc123defg", /destination_not_vc/);
  bad("https://qualitydays.com.evil.io/rsp/x/?cmpid=abc123defg", /destination_not_vc/);
  bad("https://notqualitydays.com/rsp/x/?cmpid=abc123defg", /destination_not_vc/);
  bad("https://www.qualitydays.com/rsp/x/", /destination_no_cmpid/);
  bad("https://www.qualitydays.com/rsp/x/?cmpid=a b", /destination_no_cmpid/);
  bad("https://www.qualitydays.com/?cmpid=abc123defg", /home page/);
  bad("https://u:p@www.qualitydays.com/rsp/x/?cmpid=abc123defg", /credentials/);
  bad("https://www.qualitydays.com:8443/rsp/x/?cmpid=abc123defg", /port/);
  bad("ftp://www.qualitydays.com/rsp/x/?cmpid=abc123defg", /https/);
});

test("vcAdTitle: the ad's bold title — headline, else title", () => {
  assert.equal(vcAdTitle({ title: "T", headline: "H" }), "H");
  assert.equal(vcAdTitle({ title: " T ", headline: "" }), "T");
  assert.equal(vcAdTitle({ title: "", headline: "" }), "");
});

test("vcLink: writes the ad title into adtitle (encoded), replacing the pasted one; joined segments = link", () => {
  const link = vcLink(LP, "Software de gestão & obras");
  const u = new URL(link);
  assert.equal(u.searchParams.get("cmpid"), "aoz37upzf0");
  assert.equal(u.searchParams.get("adtitle"), "Software de gestão & obras");
  assert.equal(link, vcLinkSegments(LP, "Software de gestão & obras").map((s) => s.text).join(""));
  const replaced = new URL(vcLink(`${LP}&adtitle=Old+Title&sty=dark`, "New"));
  assert.equal(replaced.searchParams.getAll("adtitle").length, 1);
  assert.equal(replaced.searchParams.get("adtitle"), "New");
  assert.equal(replaced.searchParams.get("sty"), "dark");
  // an empty title keeps whatever the buyer pasted (or none)
  assert.equal(vcLink(LP, ""), LP);
  assert.equal(new URL(vcLink(`${LP}&adtitle=Kept`, "  ")).searchParams.get("adtitle"), "Kept");
  assert.equal(vcLink("https://example.com/x/?cmpid=abc123defg", "T"), "");
});

test("vcLinkSegments: base / slug / params with the adtitle value tagged", () => {
  const segs = vcLinkSegments(LP, "Hi");
  assert.deepEqual(segs.map((s) => s.role), ["base", "slug", "params", "gcmKey", "gcm"]);
  assert.equal(segs[0].text, "https://www.qualitydays.com/rsp/");
  assert.equal(segs[1].text, "como-funciona-um-software-de-gestao-para-construcao-3/");
  assert.equal(segs[3].text, "&adtitle=");
  assert.equal(segs[4].text, "Hi");
  assert.deepEqual(vcLinkSegments(LP, "").map((s) => s.role), ["base", "slug", "params"]);
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
  const link = vcLink(LP, "Hi");
  const cr = creativePayload({ ...conv, cta: "LEARN_MORE", headline: "Hi" }, "n", binds, { videoId: "v1", thumbUrl: "https://x/t.jpg", link }) as {
    object_story_spec: { video_data: { call_to_action: { value: { link: string } } } };
  };
  assert.equal(cr.object_story_spec.video_data.call_to_action.value.link, link);
});
