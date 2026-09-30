// The AV (ActiveView) link + key contract — PURE (no React, no aliases, type-only import), so the
// launch route, the clone route, the card's preview and `node --test tests/av-link.test.ts` share
// ONE builder.
//
// What AV reads (live 28.09, scr.actview.net/thecadrion.js): utm_source / utm_medium / utm_campaign /
// utm_content / utm_term straight from the landing URL, per session, into GAM key-values + their CDP.
// Revenue per campaign = GAM's KVP report by `utm_campaign`, which reports ONLY values registered in
// AV's "UTM Campaign Values" (UI upload, ≤200 per file) — hence a POOL of our own keys registered once
// (av001…), one key per campaign (the AIF brand twin). The script lower-cases utm_campaign when it
// compares sessions, so the keys are lower-case by construction.
//
//   <destination>?utm_source=facebook&utm_medium={{campaign.id}}&utm_campaign=<key>&utm_term={{adset.id}}&utm_content={{ad.id}}
//
// utm_medium carries the FB campaign id macro: CDP sessions (no registration needed) and the
// `utm_campaign_medium` combo (<key>_<campaign id>) tie back to the FB campaign even before the key
// earns revenue. The destination is an article of an AV site OR a Redirect path
// (redirect.<site>/<path>) — AV merges the link's params into whichever target the path picks.
import type { LinkSegment } from "./partners";

/** Highest key the codec knows: av001 … av999 (3 digits). The LAUNCHABLE range is smaller — only the
 *  keys the owner registered in AV (AV_KEYS_REGISTERED, lib/av-launch). */
export const AV_KEY_POOL_MAX = 999;
export const AV_KEY_RE = /^av(\d{3})$/;
export const avKeyCode = (n: number): string => `av${String(n).padStart(3, "0")}`;
/** 1-based index of a well-formed key within the codec range, else null. */
export function avKeyIndex(key: string): number | null {
  const m = AV_KEY_RE.exec(String(key ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= AV_KEY_POOL_MAX ? n : null;
}
/** Registered-range clamp: a sane integer 0…AV_KEY_POOL_MAX from any env-ish input (garbage → 0 = the
 *  stub: nothing launchable). */
export function avRegisteredCount(raw: unknown): number {
  const n = Math.floor(Number(String(raw ?? "").trim() || "0"));
  return Number.isFinite(n) && n > 0 ? Math.min(n, AV_KEY_POOL_MAX) : 0;
}
/** Is `key` inside the launchable (registered) range? */
export const avKeyLaunchable = (key: string, registered: number): boolean => {
  const i = avKeyIndex(key);
  return i != null && i <= registered;
};

/** The fixed tracking tail around the key (FB macros stay literal — never URL-encoded). */
export const AV_UTM_HEAD = "?utm_source=facebook&utm_medium={{campaign.id}}";
export const AV_UTM_TAIL = "&utm_term={{adset.id}}&utm_content={{ad.id}}";

export type AvBase = { ok: true; base: string; host: string; path: string } | { ok: false; error: string };

/** A chat's id in AV's Chat Builder: 24 hex characters (every id on AV's live chats, read 29.09). */
const AV_CHAT_ID_RE = /^[a-f0-9]{24}$/;
const chatIdOf = (raw: unknown): string => {
  const id = String(raw ?? "").trim().toLowerCase();
  return AV_CHAT_ID_RE.test(id) ? id : "";
};
/** What is wrong with an address that was meant to be a chat's. */
const AV_CHAT_URL_INVALID =
  "chat_url_invalid — a chat's address is https://<chat host>/?asst=<its 24-character id> (copy it from ActiveView → Chat Builder → View your chat)";

/**
 * Normalize a pasted / picked destination to its bare base: https, lower-case host, no userinfo/port,
 * no query/hash (tracking is ours), no trailing slash, and a real path (the home page is not a
 * destination). The one exception is a CHAT: its address is the root plus its id in the query
 * (https://<chat host>/?asst=<id>), so a root that names a well-formed chat id keeps exactly that
 * param; a root whose id is damaged (a character lost in the copy) is refused for the ID — "the home
 * page" would send the buyer looking for the wrong mistake. SHAPE only — whether the host is an AV
 * site / redirect domain / chat host and the page is live is the server's call (lib/av-destination).
 */
export function avDestinationBase(raw: string): AvBase {
  let s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "destination_required — pick an article or a redirect path" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "destination_invalid — not a URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "destination_invalid — http(s) only" };
  if (u.username || u.password || u.port) return { ok: false, error: "destination_invalid — no credentials or port in the URL" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return { ok: false, error: "destination_invalid — bad host" };
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path || path === "/") {
    const asst = u.searchParams.get("asst");
    const id = chatIdOf(asst);
    if (id) return { ok: true, base: `https://${host}/?asst=${id}`, host, path: "/" };
    if (asst !== null) return { ok: false, error: AV_CHAT_URL_INVALID };
    return { ok: false, error: "destination_invalid — pick an article (or a redirect path), not the home page" };
  }
  if (!/^\/[A-Za-z0-9._~\-/%]+$/.test(path) || path.length > 300) return { ok: false, error: "destination_invalid — unexpected characters in the path" };
  return { ok: true, base: `https://${host}${path}`, host, path };
}

export type AvChatUrl = { ok: true; base: string; host: string; id: string } | { ok: false; error: string };

/**
 * A chat URL → its ONE canonical address, https://<host>/?asst=<id>. AV serves a chat under two
 * addresses — /?asst=<id> and /<id>/ — and its dashboard hands out the second; read live 29.09 on the
 * chats of other AV publishers, the query form answers on every chat host while the path form only
 * answers where the gateway was set up for it, so both are normalized to the query form. SHAPE only:
 * AV answers 200 for ANY well-formed id (one static shell), so that the chat exists is never proven
 * by a request — the id is the buyer's to copy from Chat Builder.
 */
export function avChatUrl(raw: string): AvChatUrl {
  const b = avDestinationBase(raw);
  const id = b.ok ? chatIdOf(b.path === "/" ? new URL(b.base).searchParams.get("asst") : b.path.slice(1)) : "";
  if (b.ok && id) return { ok: true, base: `https://${b.host}/?asst=${id}`, host: b.host, id };
  if (!b.ok && !/home page/.test(b.error)) return { ok: false, error: b.error };
  return { ok: false, error: AV_CHAT_URL_INVALID };
}

/** A chat of ours built in ActiveView → Chat Builder: its host (a subdomain of an AV site), its
 *  24-character id and the name the card shows. */
export type AvKnownChat = { host: string; id: string; name: string };

/**
 * The chats the card offers with one click. AV's API lists no chats and a subdomain cannot be
 * enumerated, so a chat on a subdomain OTHER than the conventional chat.<site> is known from here
 * (owner 30.09: the Chat Builder host of thecadrion.com is lp1, its first chat "Emily"). A pick is
 * checked exactly like a pasted chat — on the pick and again on every launch the host must show ads
 * — so this list only saves the paste; it never vouches for a chat.
 */
export const AV_KNOWN_CHATS: readonly AvKnownChat[] = [
  { host: "lp1.thecadrion.com", id: "6abc53bbe2e270105e4c5586", name: "Emily — AI Companion (lp1)" },
];

const normChatHost = (h: unknown): string => String(h ?? "").trim().toLowerCase().replace(/\.+$/, "");

/** Our ROOT sites: a site that is a subdomain of another listed site has no chat host of its own. */
const rootSites = (siteDomains: string[]): string[] => {
  const sites = [...new Set(siteDomains.map(normChatHost).filter(Boolean))];
  return sites.filter((d) => !sites.some((o) => d.endsWith(`.${o}`)));
};

/** The root site a host is a subdomain of (never the site itself or its www), or "". */
const siteOfChatHost = (host: string, roots: string[]): string => roots.find((s) => host.endsWith(`.${s}`) && host !== `www.${s}`) ?? "";

/**
 * The chat hosts the card's catalog probes for our sites: chat.<site> of every ROOT site, then the
 * host of every known chat that is a subdomain of one of them — each host once, in that order. A
 * known chat of a site that is not ours is never probed (lib/av-chat would refuse it anyway).
 */
export function avChatProbeHosts(siteDomains: string[], known: readonly AvKnownChat[] = AV_KNOWN_CHATS): { host: string; site: string }[] {
  const roots = rootSites(siteDomains);
  const out = roots.map((site) => ({ host: `chat.${site}`, site }));
  for (const c of known) {
    const host = normChatHost(c.host);
    const site = siteOfChatHost(host, roots);
    if (site && !out.some((o) => o.host === host)) out.push({ host, site });
  }
  return out;
}

/** The known chats of our sites, each with its ONE canonical address (lib/av-link avChatUrl); a
 *  chat of another site or with a damaged id is left out. */
export function avKnownChats(siteDomains: string[], known: readonly AvKnownChat[] = AV_KNOWN_CHATS): Array<AvKnownChat & { base: string }> {
  const roots = rootSites(siteDomains);
  const out: Array<AvKnownChat & { base: string }> = [];
  for (const c of known) {
    const host = normChatHost(c.host);
    if (!siteOfChatHost(host, roots)) continue;
    const url = avChatUrl(`https://${host}/?asst=${String(c.id ?? "").trim()}`);
    if (url.ok) out.push({ host, id: url.id, name: c.name, base: url.base });
  }
  return out;
}

export type AvDestinationKind = "article" | "redirect" | "chat";

/**
 * DISPLAY-time kind of a stored destination — the card's link caption and the picker's tab. The
 * server re-resolves every launch (lib/av-destination) and is the authority; this reads the
 * address. A chat is known by its SHAPE alone (root + ?asst= is never a page), so it reads right
 * before the catalog has loaded; a redirect domain is a redirect; a site (or its www) has
 * articles; any other subdomain of a site holds redirect paths — or, named by a bare chat id, a
 * chat — and that stays true while the redirect list is unavailable.
 */
export function avDestinationKind(base: string, known: { sites: string[]; redirectDomains: string[] }): AvDestinationKind {
  const b = avDestinationBase(base);
  if (!b.ok) return "article";
  if (b.path === "/") return "chat";
  if (known.redirectDomains.some((d) => d.toLowerCase() === b.host)) return "redirect";
  const sites = known.sites.map((s) => s.toLowerCase());
  if (sites.some((s) => b.host === s || b.host === `www.${s}`)) return "article";
  if (!sites.some((s) => b.host.endsWith(`.${s}`))) return "article";
  return chatIdOf(b.path.slice(1)) ? "chat" : "redirect";
}

/** What the Destination field looked like when a slow answer was asked for / looks like now.
 *  `picks` counts the destinations the buyer set by hand — a pick made and undone leaves the value
 *  the same and still means the buyer moved on. */
export type AvCheckAsked = { value: string; mode: AvDestinationKind; picks: number };

/**
 * A slow answer — a check's verdict, a created redirect path — arrives seconds after the click:
 * may it still set the destination? "drop" once the field is gone (nothing is written, nothing
 * shown); "superseded" once the buyer moved on — they set or cleared a destination, something else
 * set one (copy settings), or they OPENED another tab: theirs stands and the answer is only
 * REPORTED in the box that asked; "apply" when the field is as it was. A tab that changed by itself
 * (`pinned` false: the catalog landed and the stored destination's kind was re-read) is no move of
 * the buyer.
 */
export function avCheckOutcome(asked: AvCheckAsked, now: AvCheckAsked & { mounted: boolean; pinned: boolean }): "apply" | "superseded" | "drop" {
  if (!now.mounted) return "drop";
  if (now.value !== asked.value || now.picks !== asked.picks) return "superseded";
  return now.mode !== asked.mode && now.pinned ? "superseded" : "apply";
}

/** A tab the buyer opened by hand, and the destination it was opened for. */
export type AvTabPin = { forValue: string; mode: AvDestinationKind } | null;

/**
 * The tab the Destination field shows: what the destination IS (`kind`, read off its address) —
 * until the buyer opens another tab for that same destination. A NEW destination takes the tab
 * back, whoever set it: a pick, copy settings, a duplicated card.
 */
export function avFieldTab(pin: AvTabPin, value: string, kind: AvDestinationKind): AvDestinationKind {
  return pin && pin.forValue === value ? pin.mode : kind;
}

/**
 * The pin after the buyer set a destination by hand from the tab `mode`. A destination shows on its
 * own tab (no pin); a CLEAR keeps the tab it was made from — an empty field reads as "article", and
 * falling back there would take a half-filled form (New path, a pasted URL) away from the buyer.
 */
export function avPinAfterPick(value: string, mode: AvDestinationKind): AvTabPin {
  return value ? null : { forValue: "", mode };
}

/** A line under a paste box: what it said, of which host, and up to which reading of the catalog it
 *  stands whatever the rows say (the catalog's successful reads are counted: the reading on screen
 *  when the answer landed — and the one the box asked for itself because of the answer, which only
 *  shows what the rows said, not a change). `hostLevel`: a refusal of the host. */
export type AvVerdict = { ok: boolean; text: string; forValue?: string; host?: string; hostLevel?: boolean; readAt: number };
/** What the catalog's row says of a chat host now (null: no row speaks for it). */
export type AvRowState = "ready" | "blocked" | "unchecked" | null;

/**
 * Is a line under a paste box still so? A success names the destination it set — it goes with it —
 * and says the host shows ads — it goes once a LATER reading of the catalog lists the host as not
 * ready (the reading it landed in may be stale, and a later one is what the buyer sees). A refusal
 * of the host goes once a later reading lists the host as ready; any other line stays until the box
 * changes.
 */
export function avVerdictStands(v: AvVerdict, now: { value: string; reading: number; row: AvRowState }): boolean {
  const newer = now.reading > v.readAt;
  if (v.ok) return (v.forValue === undefined || v.forValue === now.value) && !(newer && now.row === "blocked");
  return !(v.hostLevel && newer && now.row === "ready");
}

/** Is a refusal of a checked chat about its HOST (not activated, no ads, not checkable) — what the
 *  catalog's row speaks for — rather than about the address itself? */
export function avRefusalOfHost(error: string, base: string): boolean {
  return /^(?:chat_not_live|chat_not_monetized|destination_check_failed) — /.test(error) && !error.includes(base);
}

/** A redirect path's target as the card names it: its weight and the target's last path segment. A
 *  CHAT is named as one — its address is the root of its host, which alone would hide what it is. */
export function avMappingLabel(m: { url: string; percentage: number | null }): string {
  // a weight ActiveView's answer did not make readable is unknown (it reaches the card as null)
  const weight = typeof m.percentage === "number" && Number.isFinite(m.percentage) ? m.percentage : "?";
  const chat = avChatUrl(m.url);
  if (chat.ok) return `${weight}% chat ${chat.id.slice(0, 6)}…${chat.id.slice(-4)}`;
  let seg = "";
  try {
    const u = new URL(m.url);
    seg = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
  } catch {
    seg = m.url;
  }
  return `${weight}% ${seg}`;
}

/**
 * The AV link as ORDERED, role-tagged segments (the card colors each role; avLink joins them). The key
 * rides the shared `gcm` role (every partner's revenue marker is colored the same). Empty base → [].
 */
export function avLinkSegments(base: string, key: string): LinkSegment[] {
  const b = String(base ?? "").trim();
  if (!b) return [];
  // A chat's base already has a query (…/?asst=<id>): the tracking params JOIN it, and the slug is
  // cut before it (the id has no slash, but the split must not depend on that).
  const query = b.indexOf("?");
  const cut = (query < 0 ? b : b.slice(0, query)).lastIndexOf("/");
  return [
    { text: b.slice(0, cut + 1), role: "base" },
    { text: b.slice(cut + 1), role: "slug" },
    { text: query < 0 ? AV_UTM_HEAD : `&${AV_UTM_HEAD.slice(1)}`, role: "params" },
    { text: "&utm_campaign=", role: "gcmKey" },
    { text: key, role: "gcm" },
    { text: AV_UTM_TAIL, role: "params" },
  ];
}

/** The joined link (what the ad actually points at). Empty when there is no base. */
export function avLink(base: string, key: string): string {
  return avLinkSegments(base, key)
    .map((s) => s.text)
    .join("");
}

/** Clone rewrite: swap the utm_campaign value (the AV key) in a source link — or append it — keeping
 *  the destination, every other param and the literal FB macros. Replaces ANY existing value so a
 *  malformed/empty one never leaves a duplicate param behind. */
export function swapUtmCampaign(link: string, key: string): string {
  if (!link) return link;
  if (/[?&]utm_campaign=[^&#]*/.test(link)) return link.replace(/([?&]utm_campaign=)[^&#]*/g, `$1${key}`);
  const hash = link.indexOf("#");
  const head = hash >= 0 ? link.slice(0, hash) : link;
  const tail = hash >= 0 ? link.slice(hash) : "";
  return `${head}${head.includes("?") ? "&" : "?"}utm_campaign=${key}${tail}`;
}

/** The AV key a link carries (clone sources / task rows), "" when none. */
export function avKeyOfLink(link: string): string {
  const m = /[?&]utm_campaign=([^&#]*)/.exec(String(link ?? ""));
  return m ? decodeURIComponent(m[1]).trim().toLowerCase() : "";
}

/**
 * A readable title from an AV article path when the page's own <title> is not known yet:
 * "/cow-long-rec-govdeals-surplus-auctions-1-twjmh" → "Govdeals surplus auctions" + variant "twjmh".
 * AV's CMS prefixes a template code (cow-long-rec-…) and suffixes a random variant id.
 */
export function avArticleTitle(path: string): { title: string; variant: string } {
  let slug = String(path ?? "").replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  let variant = "";
  const v = /-\d+-([a-z0-9]{5})$/i.exec(slug);
  if (v) {
    variant = v[1].toLowerCase();
    slug = slug.slice(0, v.index);
  }
  slug = slug.replace(/^[a-z]{2,5}-(?:long|short|mid|med)-[a-z]{2,5}-/i, "");
  const words = slug.split("-").filter(Boolean).join(" ");
  const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : String(path ?? "");
  return { title, variant };
}

/** An ISO region / language code by Intl's own tables (a code Intl can't name comes back unchanged). */
function isCode(code: string, type: "region" | "language"): boolean {
  try {
    const name = new Intl.DisplayNames(["en"], { type }).of(type === "region" ? code.toUpperCase() : code.toLowerCase());
    return Boolean(name) && name!.toLowerCase() !== code.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The default campaign-name body of an AV card (owner ask 30.09: "нейминг был forklift certification |
 * US | es | … чтобы туда попадало по дефолту гео язык и название статьи … а дописывать тоже чтобы
 * можно было"): "<topic> | <GEO> | <lang> | ", the buyer types after the last bar. Our articles end in
 * "-<geo>-<lang>" (forklift-certification-mobile-app-us-es → "forklift certification mobile app | US |
 * es | "); the topic is the rest of the slug in lower-case words (AV's template prefix and variant id
 * stripped, avArticleTitle). A slug without the pair takes the geo from the card's countries ("US+CA")
 * and names no language; an AI-chat destination (no path) reads "ai chat". "" = not a URL.
 */
export function avAutoName(destination: string, countries: readonly string[] = []): string {
  let u: URL;
  try {
    u = new URL(String(destination ?? "").trim());
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const slug = u.pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  let topicSlug = slug;
  let geo = "";
  let lang = "";
  const pair = /-([a-z]{2})-([a-z]{2})$/i.exec(slug);
  if (pair && isCode(pair[1], "region") && isCode(pair[2], "language")) {
    geo = pair[1].toUpperCase();
    lang = pair[2].toLowerCase();
    topicSlug = slug.slice(0, pair.index);
  }
  if (!geo) geo = countries.map((c) => String(c).trim().toUpperCase()).filter(Boolean).join("+");
  const chat = slug === "" || Boolean(u.searchParams.get("asst")) || Boolean(chatIdOf(slug));
  const topic = chat ? "ai chat" : avArticleTitle(topicSlug).title.toLowerCase();
  const parts = [topic, geo, lang].filter(Boolean);
  return parts.length ? `${parts.join(" | ")} | ` : "";
}

/**
 * The name an AV card should carry after an edit: when the destination or the countries change, a name
 * the buyer has not taken over — empty, the default (their username), or one still starting with the
 * previous auto-name — becomes the new auto-name plus whatever was typed after the old one. null =
 * leave the name alone (the buyer typed their own, or the auto-name did not change).
 */
export function avFollowName(
  prev: { landing: string; countries: readonly string[] },
  next: { landing: string; countries: readonly string[]; name: string },
  owner: string,
): string | null {
  const before = avAutoName(prev.landing, prev.countries);
  const after = avAutoName(next.landing, next.countries);
  if (before === after) return null;
  const name = String(next.name ?? "");
  let tail: string | null = null;
  if (!name.trim() || name.trim() === owner.trim()) tail = "";
  else if (before && name.startsWith(before)) tail = name.slice(before.length);
  else if (before && name.trimEnd() === before.trimEnd()) tail = "";
  if (tail === null) return null;
  if (after) return after + tail;
  return tail.trim() ? tail.trim() : owner; // destination cleared: back to what the buyer typed, else the default
}

/** Files for AV's "UTM Campaign Values → Upload file" form: one key per line, ≤200 per file (AV's
 *  per-upload cap), plain text (accepted: CSV / XLSX / TXT, ≤50 KB). `from`…`to` inclusive. */
export function avKeysUploadFiles(from: number, to: number, perFile = 200): { name: string; content: string }[] {
  const a = Math.max(1, Math.floor(from));
  const b = Math.min(AV_KEY_POOL_MAX, Math.floor(to));
  const out: { name: string; content: string }[] = [];
  for (let start = a; start <= b; start += perFile) {
    const end = Math.min(b, start + perFile - 1);
    const lines: string[] = [];
    for (let n = start; n <= end; n++) lines.push(avKeyCode(n));
    out.push({ name: `av-keys-${avKeyCode(start)}-${avKeyCode(end)}.txt`, content: lines.join("\n") + "\n" });
  }
  return out;
}
