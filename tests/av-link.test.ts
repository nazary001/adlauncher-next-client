// Node's built-in runner (v24 strips types natively): `node --test tests/av-link.test.ts`.
// lib/av-link.ts imports only a TYPE from ./partners (erased), so it loads straight off Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AV_KEY_POOL_MAX,
  avArticleTitle,
  avChatUrl,
  avDestinationBase,
  avDestinationKind,
  avKeyCode,
  avKeyIndex,
  avKeyLaunchable,
  avKeyOfLink,
  avKeysUploadFiles,
  avLink,
  avLinkSegments,
  avRegisteredCount,
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

test("a root without a well-formed chat id stays refused as the home page", () => {
  for (const raw of [
    "https://chat.thecadrion.com/",
    "https://chat.thecadrion.com/?asst=",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc52",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc5233",
    "https://chat.thecadrion.com/?asst=6a2312cef9f4e11b130fc52g",
    "https://chat.thecadrion.com/?asst=../../etc/passwd",
    "https://chat.thecadrion.com/?utm_campaign=av001",
  ]) {
    assert.equal(avDestinationBase(raw).ok, false, raw);
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

test("a URL that names no chat id is not a chat URL", () => {
  for (const raw of [
    "",
    "https://chat.thecadrion.com/",
    "https://chat.thecadrion.com/6a2312cef9f4e11b130fc52",
    "https://chat.thecadrion.com/6a2312cef9f4e11b130fc5233",
    "https://chat.thecadrion.com/6a2312cef9f4e11b130fc52g",
    "https://chat.thecadrion.com/a/6a2312cef9f4e11b130fc523",
    "https://chat.thecadrion.com/some-article?asst=6a2312cef9f4e11b130fc523",
    "ftp://chat.thecadrion.com/6a2312cef9f4e11b130fc523",
    "https://user:pw@chat.thecadrion.com/6a2312cef9f4e11b130fc523",
  ]) {
    const r = avChatUrl(raw);
    assert.equal(r.ok, false, raw);
    assert.match(!r.ok ? r.error : "", /^(chat_url_invalid|destination_required|destination_invalid) — /, raw);
  }
});

test("destination kind for the card caption: article on the site, redirect on a redirect domain, chat on any other subdomain", () => {
  const known = { sites: ["thecadrion.com"], redirectDomains: ["redirect.thecadrion.com"] };
  assert.equal(avDestinationKind("https://thecadrion.com/some-article", known), "article");
  assert.equal(avDestinationKind("https://www.thecadrion.com/some-article", known), "article");
  assert.equal(avDestinationKind("https://redirect.thecadrion.com/jobs", known), "redirect");
  assert.equal(avDestinationKind(CHAT, known), "chat");
  assert.equal(avDestinationKind("https://CHAT.thecadrion.com/?asst=6a2312cef9f4e11b130fc523", known), "chat", "host case does not matter");
});

test("destination kind falls back to article for anything it cannot place", () => {
  const known = { sites: ["thecadrion.com"], redirectDomains: ["redirect.thecadrion.com"] };
  assert.equal(avDestinationKind("", known), "article");
  assert.equal(avDestinationKind("not a url", known), "article");
  assert.equal(avDestinationKind(`https://chat.other-site.com/?asst=${CHAT_ID}`, known), "article", "a subdomain of a foreign domain is not our chat");
  assert.equal(avDestinationKind("https://notthecadrion.com/x", known), "article", "a suffix match is not a subdomain");
  assert.equal(avDestinationKind(CHAT, { sites: [], redirectDomains: [] }), "article", "no catalog yet");
});
