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

/**
 * Normalize a pasted / picked destination to its bare base: https, lower-case host, no userinfo/port,
 * no query/hash (tracking is ours), no trailing slash, and a real path (the home page is not a
 * destination). SHAPE only — whether the host is an AV site / redirect domain and the page is live
 * is the server's call (lib/av-destination).
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
  if (!path || path === "/") return { ok: false, error: "destination_invalid — pick an article (or a redirect path), not the home page" };
  if (!/^\/[A-Za-z0-9._~\-/%]+$/.test(path) || path.length > 300) return { ok: false, error: "destination_invalid — unexpected characters in the path" };
  return { ok: true, base: `https://${host}${path}`, host, path };
}

/**
 * The AV link as ORDERED, role-tagged segments (the card colors each role; avLink joins them). The key
 * rides the shared `gcm` role (every partner's revenue marker is colored the same). Empty base → [].
 */
export function avLinkSegments(base: string, key: string): LinkSegment[] {
  const b = String(base ?? "").trim();
  if (!b) return [];
  const cut = b.lastIndexOf("/");
  return [
    { text: b.slice(0, cut + 1), role: "base" },
    { text: b.slice(cut + 1), role: "slug" },
    { text: AV_UTM_HEAD, role: "params" },
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
