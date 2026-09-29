// Node's built-in runner (v24 strips types natively): `node --test tests/av-link.test.ts`.
// lib/av-link.ts imports only a TYPE from ./partners (erased), so it loads straight off Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AV_KEY_POOL_MAX,
  avArticleTitle,
  avChatUrl,
  avCheckOutcome,
  avDestinationBase,
  avDestinationKind,
  avFieldTab,
  avKeyCode,
  avKeyIndex,
  avKeyLaunchable,
  avKeyOfLink,
  avKeysUploadFiles,
  avLink,
  avLinkSegments,
  avMappingLabel,
  avPinAfterPick,
  avRefusalOfHost,
  avRegisteredCount,
  avVerdictStands,
  swapUtmCampaign,
} from "../lib/av-link.ts";

const ART = "https://thecadrion.com/cow-long-rec-govdeals-surplus-auctions-1-twjmh";

test("link = destination + utm_source/medium macro/campaign key/term/content, macros literal", () => {
  assert.equal(
    avLink(ART, "av007"),
    `${ART}?utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=av007&utm_term={{adset.id}}&utm_content={{ad.id}}`,
  );
  // A redirect path is a destination like any other — AV merges the params into the target.
  assert.equal(
    avLink("https://redirect.thecadrion.com/jobs", "av120"),
    "https://redirect.thecadrion.com/jobs?utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=av120&utm_term={{adset.id}}&utm_content={{ad.id}}",
  );
  assert.equal(avLink("", "av001"), "");
});

test("segments color the key as the marker and join to the link", () => {
  const segs = avLinkSegments(ART, "av042");
  assert.deepEqual(
    segs.map((s) => s.role),
    ["base", "slug", "params", "gcmKey", "gcm", "params"],
  );
  assert.equal(segs.find((s) => s.role === "gcm")?.text, "av042");
  assert.equal(segs.map((s) => s.text).join(""), avLink(ART, "av042"));
  assert.equal(segs[0].text, "https://thecadrion.com/");
});

test("key codec: av001…av999, lower-case, registered range gates launchability", () => {
  assert.equal(avKeyCode(1), "av001");
  assert.equal(avKeyCode(999), "av999");
  assert.equal(avKeyIndex("av042"), 42);
  assert.equal(avKeyIndex("AV042"), null);
  assert.equal(avKeyIndex("av000"), null);
  assert.equal(avKeyIndex("av1000"), null);
  assert.equal(avKeyIndex("test01"), null);
  assert.equal(AV_KEY_POOL_MAX, 999);
  assert.equal(avRegisteredCount(undefined), 0);
  assert.equal(avRegisteredCount(""), 0);
  assert.equal(avRegisteredCount("abc"), 0);
  assert.equal(avRegisteredCount("-5"), 0);
  assert.equal(avRegisteredCount("200"), 200);
  assert.equal(avRegisteredCount("5000"), 999);
  assert.equal(avKeyLaunchable("av200", 200), true);
  assert.equal(avKeyLaunchable("av201", 200), false);
  assert.equal(avKeyLaunchable("av001", 0), false);
});

test("destination base: https, lower-case host, query/hash/trailing slash stripped, home refused", () => {
  const ok = avDestinationBase("thecadrion.com/cow-long-rec-govdeals-surplus-auctions-1-twjmh/?utm_campaign=x#top");
  assert.deepEqual(ok, { ok: true, base: ART, host: "thecadrion.com", path: "/cow-long-rec-govdeals-surplus-auctions-1-twjmh" });
  const up = avDestinationBase("http://TheCadrion.com/Some-Article");
  assert.equal(up.ok && up.base, "https://thecadrion.com/Some-Article");
  assert.equal(avDestinationBase("").ok, false);
  assert.equal(avDestinationBase("https://thecadrion.com/").ok, false);
  assert.equal(avDestinationBase("https://thecadrion.com").ok, false);
  assert.equal(avDestinationBase("ftp://thecadrion.com/a").ok, false);
  assert.equal(avDestinationBase("https://user:pw@thecadrion.com/a").ok, false);
  assert.equal(avDestinationBase("https://thecadrion.com:8443/a").ok, false);
  assert.equal(avDestinationBase("https://localhost/a").ok, false);
  // Raw markup never survives: the URL parser percent-encodes it (and the server's live check 404s it).
  const junk = avDestinationBase("https://thecadrion.com/a b<script>");
  assert.ok(!junk.ok || !/[\s<>"]/.test(junk.base));
});

test("clone swap replaces the key, keeps destination + macros; appends when missing", () => {
  const src = avLink(ART, "av003");
  assert.equal(swapUtmCampaign(src, "av077"), avLink(ART, "av077"));
  assert.equal(swapUtmCampaign(`${ART}?utm_campaign=&x=1`, "av010"), `${ART}?utm_campaign=av010&x=1`);
  assert.equal(swapUtmCampaign(ART, "av011"), `${ART}?utm_campaign=av011`);
  assert.equal(swapUtmCampaign(`${ART}?a=1#h`, "av012"), `${ART}?a=1&utm_campaign=av012#h`);
  assert.equal(avKeyOfLink(src), "av003");
  assert.equal(avKeyOfLink(ART), "");
});

test("article title from the CMS path: template prefix and variant id peeled off", () => {
  assert.deepEqual(avArticleTitle("/cow-long-rec-govdeals-surplus-auctions-1-twjmh"), { title: "Govdeals surplus auctions", variant: "twjmh" });
  assert.deepEqual(avArticleTitle("/cow-long-rec-bstock-seasonal-liquidation-guide"), { title: "Bstock seasonal liquidation guide", variant: "" });
  assert.deepEqual(avArticleTitle("/plain-article"), { title: "Plain article", variant: "" });
});

test("upload files: ≤200 keys each, one per line, inclusive range", () => {
  const files = avKeysUploadFiles(1, 450);
  assert.deepEqual(
    files.map((f) => f.name),
    ["av-keys-av001-av200.txt", "av-keys-av201-av400.txt", "av-keys-av401-av450.txt"],
  );
  assert.equal(files[0].content.trim().split("\n").length, 200);
  assert.equal(files[2].content.trim().split("\n").at(-1), "av450");
  assert.ok(files.every((f) => f.content.length < 50 * 1024));
  assert.deepEqual(avKeysUploadFiles(5, 3), []);
});

// ---------- chat destinations (ActiveView → Chat Builder) ----------
// A chat's address carries its id in the QUERY: https://<chat host>/?asst=<24 hex>. Read live 29.09 on
// the chats of other AV publishers: that form answers on every chat host, the path form /<id>/ only
// on the hosts whose gateway route was set up for it.

const CHAT_ID = "6a2312cef9f4e11b130fc523";
const CHAT = `https://chat.thecadrion.com/?asst=${CHAT_ID}`;

test("a chat link joins the tracking params with & — the chat's address already has a query", () => {
  assert.equal(
    avLink(CHAT, "av015"),
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc523&utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=av015&utm_term={{adset.id}}&utm_content={{ad.id}}",
  );
});

test("chat link segments: the chat id is the slug, the key is still the marker", () => {
  assert.deepEqual(avLinkSegments(CHAT, "av015"), [
    { text: "https://chat.thecadrion.com/", role: "base" },
    { text: "?asst=6a2312cef9f4e11b130fc523", role: "slug" },
    { text: "&utm_source=facebook&utm_medium={{campaign.id}}", role: "params" },
    { text: "&utm_campaign=", role: "gcmKey" },
    { text: "av015", role: "gcm" },
    { text: "&utm_term={{adset.id}}&utm_content={{ad.id}}", role: "params" },
  ]);
});

test("a clone of a chat ad swaps the key and keeps the chat id", () => {
  assert.equal(
    swapUtmCampaign(avLink(CHAT, "av015"), "av016"),
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc523&utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=av016&utm_term={{adset.id}}&utm_content={{ad.id}}",
  );
  assert.equal(avKeyOfLink(avLink(CHAT, "av015")), "av015");
});

test("destination base keeps a chat's address (root + its id) and nothing else of the query", () => {
  assert.deepEqual(avDestinationBase("https://Chat.TheCadrion.com/?utm_source=x&asst=6A2312CEF9F4E11B130FC523&fbclid=1#h"), {
    ok: true,
    base: CHAT,
    host: "chat.thecadrion.com",
    path: "/",
  });
  assert.deepEqual(avDestinationBase(avLink(CHAT, "av015")), { ok: true, base: CHAT, host: "chat.thecadrion.com", path: "/" }, "a launched chat link reads back as its base");
});

test("a root that names no chat id is refused as the home page", () => {
  for (const raw of ["https://chat.thecadrion.com/", "https://chat.thecadrion.com/?utm_campaign=av001", "https://chat.thecadrion.com/?ASST=6a2312cef9f4e11b130fc523"]) {
    const r = avDestinationBase(raw);
    assert.equal(r.ok, false, raw);
    assert.match(!r.ok ? r.error : "", /^destination_invalid — .*home page/, raw);
  }
});

test("a root whose chat id is damaged is refused for the ID, not as the home page — on every tab, launch and clone", () => {
  for (const raw of [
    "https://chat.thecadrion.com/?asst=",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc52",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc5233",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc52g",
    "https://chat.thecadrion.com/?asst=../../etc/passwd",
    "https://chat.thecadrion.com/?utm_source=facebook&asst=nothex&utm_campaign=av001",
  ]) {
    const r = avDestinationBase(raw);
    assert.equal(r.ok, false, raw);
    assert.match(!r.ok ? r.error : "", /^chat_url_invalid — .*24-character id/, raw);
    const c = avChatUrl(raw);
    assert.equal(!c.ok && c.error, !r.ok && r.error, "the chat tab says the same");
  }
});

test("an article keeps dropping its whole query, a chat id included", () => {
  assert.deepEqual(avDestinationBase(`https://thecadrion.com/some-article?asst=${CHAT_ID}&utm_campaign=x`), {
    ok: true,
    base: "https://thecadrion.com/some-article",
    host: "thecadrion.com",
    path: "/some-article",
  });
});

test("a pasted chat URL is normalized to its one canonical address from either form AV serves", () => {
  const want = { ok: true, base: CHAT, host: "chat.thecadrion.com", id: CHAT_ID };
  for (const raw of [
    CHAT,
    "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523",
    "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/",
    "chat.thecadrion.com/6A2312CEF9F4E11B130FC523/?utm_source=x&utm_campaign=old#h",
    "https://CHAT.thecadrion.com/?utm_source=chat&asst=6a2312cef9f4e11b130fc523",
  ]) {
    assert.deepEqual(avChatUrl(raw), want, raw);
  }
});

test("a URL that names no chat id is not a chat URL, and says which way it is wrong", () => {
  const cases: [string, RegExp][] = [
    ["", /^destination_required — /],
    ["https://chat.thecadrion.com/", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/6a2312cef9f4e11b130fc52", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/6a2312cef9f4e11b130fc5233", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/6a2312cef9f4e11b130fc52g", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/a/6a2312cef9f4e11b130fc523", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/some-article?asst=6a2312cef9f4e11b130fc523", /^chat_url_invalid — /],
    ["https://chat.thecadrion.com/?ASST=6a2312cef9f4e11b130fc523", /^chat_url_invalid — /],
    ["ftp://chat.thecadrion.com/6a2312cef9f4e11b130fc523", /^destination_invalid — http\(s\) only/],
    ["https://user:pw@chat.thecadrion.com/6a2312cef9f4e11b130fc523", /^destination_invalid — no credentials/],
    ["https://chat.thecadrion.com:8443/?asst=6a2312cef9f4e11b130fc523", /^destination_invalid — no credentials or port/],
  ];
  for (const [raw, want] of cases) {
    const r = avChatUrl(raw);
    assert.equal(r.ok, false, raw);
    assert.match(!r.ok ? r.error : "", want, raw);
  }
});

test("when an address names two chat ids, the one the chat page itself reads is kept (the path, then the FIRST asst)", () => {
  const other = "0123456789abcdef01234567";
  const want = { ok: true, base: CHAT, host: "chat.thecadrion.com", id: CHAT_ID };
  assert.deepEqual(avChatUrl(`https://chat.thecadrion.com/${CHAT_ID}/?asst=${other}`), want);
  assert.deepEqual(avChatUrl(`https://chat.thecadrion.com/?asst=${CHAT_ID}&asst=${other}`), want);
});

// ---------- what a stored destination IS, for the card (display only — the server decides) ----------

const KNOWN = { sites: ["thecadrion.com"], redirectDomains: ["redirect.thecadrion.com"] };

test("destination kind: an article on the site, a path on a redirect domain, a chat by its address", () => {
  assert.equal(avDestinationKind("https://thecadrion.com/some-article", KNOWN), "article");
  assert.equal(avDestinationKind("https://www.thecadrion.com/some-article", KNOWN), "article");
  assert.equal(avDestinationKind("https://redirect.thecadrion.com/jobs", KNOWN), "redirect");
  assert.equal(avDestinationKind(CHAT, KNOWN), "chat");
  assert.equal(avDestinationKind("https://CHAT.thecadrion.com/?asst=6a2312cef9f4e11b130fc523", KNOWN), "chat", "host case does not matter");
  assert.equal(avDestinationKind(`https://chat.thecadrion.com/${CHAT_ID}/`, KNOWN), "chat", "the dashboard's path form");
});

test("a chat is known by its address alone — before the catalog has loaded, and whatever the catalog lists", () => {
  assert.equal(avDestinationKind(CHAT, { sites: [], redirectDomains: [] }), "chat");
  assert.equal(avDestinationKind(CHAT, { sites: ["thecadrion.com", "chat.thecadrion.com"], redirectDomains: [] }), "chat", "a chat host that is also listed as a site");
});

test("a path on a subdomain is a redirect path even while the redirect list is unavailable — never a chat", () => {
  assert.equal(avDestinationKind("https://redirect.thecadrion.com/jobs", { sites: ["thecadrion.com"], redirectDomains: [] }), "redirect");
});

test("a subdomain that is a site of its own keeps its articles", () => {
  const known = { sites: ["thecadrion.com", "blog.thecadrion.com"], redirectDomains: [] };
  assert.equal(avDestinationKind("https://blog.thecadrion.com/some-post", known), "article");
  assert.equal(avDestinationKind("https://www.blog.thecadrion.com/some-post", known), "article");
});

test("destination kind falls back to article for anything it cannot place", () => {
  assert.equal(avDestinationKind("", KNOWN), "article");
  assert.equal(avDestinationKind("not a url", KNOWN), "article");
  assert.equal(avDestinationKind("https://notthecadrion.com/x", KNOWN), "article", "a suffix match is not a subdomain");
  assert.equal(avDestinationKind("https://sub.other-site.com/x", KNOWN), "article", "a subdomain of a foreign domain");
  assert.equal(avDestinationKind("https://redirect.thecadrion.com/jobs", { sites: [], redirectDomains: [] }), "article", "no catalog yet");
});

// ---------- a slow answer (a check, a created path) arrives seconds after the click ----------

const ASKED = { value: "https://thecadrion.com/a", mode: "chat" as const, picks: 3 };

/** The field now: there, and on a tab the destination itself chose (none opened by hand). */
const THERE = { mounted: true, pinned: false };

test("a slow answer is applied when the field is as it was when it was asked for", () => {
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, ...THERE }), "apply");
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, mounted: true, pinned: true }), "apply", "on a tab the buyer opened and stayed on");
});

test("a slow answer writes nothing once the field is gone", () => {
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, mounted: false, pinned: false }), "drop");
  assert.equal(avCheckOutcome(ASKED, { value: "https://thecadrion.com/other", mode: "article", picks: 9, mounted: false, pinned: true }), "drop");
});

test("a destination picked while the answer was on its way stands: the answer is not applied", () => {
  assert.equal(avCheckOutcome({ value: "", mode: "chat", picks: 0 }, { value: "https://thecadrion.com/picked", mode: "chat", picks: 1, ...THERE }), "superseded");
});

test("a pick that was made and undone meanwhile still counts: the value is the same, the answer is not applied", () => {
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, picks: 5, ...THERE }), "superseded");
});

test("a destination changed from OUTSIDE the field (copy settings) supersedes the answer too", () => {
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, value: "https://thecadrion.com/copied", ...THERE }), "superseded");
});

test("a buyer who opened another tab moved on: the answer is not applied behind their back", () => {
  assert.equal(avCheckOutcome(ASKED, { ...ASKED, mode: "redirect", mounted: true, pinned: true }), "superseded");
});

test("a tab that changed BY ITSELF is no move of the buyer: the answer is applied", () => {
  // The catalog landed while the check ran and the stored destination's kind was re-read
  // (a path on a subdomain: "article" until the sites are known, "redirect" after).
  assert.equal(avCheckOutcome({ ...ASKED, mode: "article" }, { ...ASKED, mode: "redirect", ...THERE }), "apply");
});

// ---------- which tab the Destination field shows ----------

const A_CHAT = "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc523";

test("the tab shows what the destination is", () => {
  assert.equal(avFieldTab(null, "", "article"), "article");
  assert.equal(avFieldTab(null, A_CHAT, "chat"), "chat");
  assert.equal(avFieldTab(null, "https://redirect.thecadrion.com/jobs", "redirect"), "redirect");
});

test("a tab the buyer opened stays open for as long as the destination is the one it was opened for", () => {
  const opened = { forValue: ART, mode: "chat" as const };
  assert.equal(avFieldTab(opened, ART, "article"), "chat");
  assert.equal(avFieldTab(opened, ART, "redirect"), "chat", "a catalog that lands late re-reads the kind — the tab is still the buyer's");
});

test("a new destination takes the tab back — one pushed from outside the field too", () => {
  const opened = { forValue: ART, mode: "redirect" as const };
  assert.equal(avFieldTab(opened, A_CHAT, "chat"), "chat");
  assert.equal(avFieldTab(opened, "", "article"), "article");
});

test("a destination set by hand shows on its own tab; one CLEARED by hand keeps the tab it was cleared from", () => {
  assert.equal(avPinAfterPick(A_CHAT, "article"), null);
  assert.deepEqual(avPinAfterPick("", "redirect"), { forValue: "", mode: "redirect" });
  assert.deepEqual(avPinAfterPick("", "chat"), { forValue: "", mode: "chat" });
  // …which is what keeps a half-filled form on the tab: the cleared field reads "redirect", not "article"
  assert.equal(avFieldTab(avPinAfterPick("", "redirect"), "", "article"), "redirect");
});

// ---------- a redirect path's targets, as the card names them ----------

test("a redirect path's target reads as its weight and its last path segment", () => {
  assert.equal(avMappingLabel({ url: "https://thecadrion.com/forklift-certification-us-en", percentage: 100 }), "100% forklift-certification-us-en");
  assert.equal(avMappingLabel({ url: "https://thecadrion.com/jobs/forklift/", percentage: 60 }), "60% forklift");
  assert.equal(avMappingLabel({ url: "https://thecadrion.com/", percentage: 10 }), "10% thecadrion.com");
  assert.equal(avMappingLabel({ url: "not a url", percentage: 5 }), "5% not a url");
  assert.equal(avMappingLabel({ url: "https://thecadrion.com/a", percentage: NaN }), "?% a", "a weight that could not be read");
  assert.equal(avMappingLabel({ url: "https://thecadrion.com/a", percentage: null }), "?% a", "…as it reaches the card");
});

test("a target that is a CHAT reads as a chat — its address is the root, so the host alone would hide it", () => {
  assert.equal(avMappingLabel({ url: A_CHAT, percentage: 40 }), "40% chat 6a2312…c523");
  assert.equal(avMappingLabel({ url: "https://chat.thecadrion.com/6a2312cef9f4e11b130fc523/?utm_source=x", percentage: 40 }), "40% chat 6a2312…c523");
});

// ---------- is a line under a paste box still so? ----------

/** Readings of the catalog, counted: the one the answer landed in, and a later one. */
const R1 = 1;
const R2 = 2;
const HOST = "chat.thecadrion.com";

test("a success stands while it is the destination and no newer reading lists its host as not ready", () => {
  const ok = { ok: true, text: "Chat host ready", forValue: A_CHAT, host: HOST, readAt: R1 };
  assert.equal(avVerdictStands(ok, { value: A_CHAT, reading: R1, row: "blocked" }), true, "the reading it landed in may be stale — it stands");
  assert.equal(avVerdictStands(ok, { value: A_CHAT, reading: R2, row: "ready" }), true);
  assert.equal(avVerdictStands(ok, { value: A_CHAT, reading: R2, row: null }), true, "no row speaks for the host");
  assert.equal(avVerdictStands(ok, { value: A_CHAT, reading: R2, row: "unchecked" }), true, "a row that could not be checked says nothing");
  assert.equal(avVerdictStands(ok, { value: A_CHAT, reading: R2, row: "blocked" }), false, "a newer reading says the host is not ready");
  assert.equal(avVerdictStands(ok, { value: ART, reading: R1, row: null }), false, "the destination is another one");
});

test("a refusal of the HOST goes once a newer reading lists the host as ready; any other line stays", () => {
  const host = { ok: false, text: "chat_not_monetized — chat.thecadrion.com shows no ads yet", host: HOST, hostLevel: true, readAt: R1 };
  assert.equal(avVerdictStands(host, { value: "", reading: R1, row: "ready" }), true);
  assert.equal(avVerdictStands(host, { value: "", reading: R2, row: "blocked" }), true);
  assert.equal(avVerdictStands(host, { value: "", reading: R2, row: null }), true);
  assert.equal(avVerdictStands(host, { value: "", reading: R2, row: "ready" }), false);
  const address = { ...host, text: `chat_not_live — ${A_CHAT} answered 404`, hostLevel: false };
  assert.equal(avVerdictStands(address, { value: "", reading: R2, row: "ready" }), true, "a refusal of the ADDRESS is not the row's to take back");
  const other = { ok: false, text: "destination_not_av — talk.thecadrion.com …", host: "talk.thecadrion.com", hostLevel: false, readAt: R1 };
  assert.equal(avVerdictStands(other, { value: "", reading: R2, row: null }), true);
});

test("a line stands through the reading the box asked for itself — only a LATER one weighs it", () => {
  const refusal = { ok: false, text: "chat_not_monetized — chat.thecadrion.com shows no ads yet", host: HOST, hostLevel: true, readAt: R2 };
  assert.equal(avVerdictStands(refusal, { value: "", reading: R2, row: "ready" }), true, "the box's own re-read disagrees: both are shown");
  assert.equal(avVerdictStands(refusal, { value: "", reading: 3, row: "ready" }), false, "a later reading still says ready");
});

test("a refusal is of the host when it says what the host is — not what the address answered", () => {
  assert.equal(avRefusalOfHost("chat_not_live — chat.thecadrion.com has no certificate of its own yet", A_CHAT), true);
  assert.equal(avRefusalOfHost("chat_not_monetized — chat.thecadrion.com shows no ads yet", A_CHAT), true);
  assert.equal(avRefusalOfHost("destination_check_failed — the DNS lookup of chat.thecadrion.com failed (ETIMEOUT)", A_CHAT), true);
  assert.equal(avRefusalOfHost(`chat_not_live — ${A_CHAT} answered 404`, A_CHAT), false);
  assert.equal(avRefusalOfHost(`destination_check_failed — ${A_CHAT} answered 503: try again in a moment`, A_CHAT), false);
  assert.equal(avRefusalOfHost("chat_url_invalid — a chat's address is …", A_CHAT), false);
  assert.equal(avRefusalOfHost("destination_not_av — chat.thecadrion.com is not …", A_CHAT), false);
});
