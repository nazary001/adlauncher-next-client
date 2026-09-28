// AV rail — the CHAT destination (server-only). ActiveView's Chat Builder hosts a publisher's chats
// on a subdomain of the publisher's own site (chat.thecadrion.com) whose CNAME points at AV's chat
// gateway; a chat's address is https://<chat host>/?asst=<id> (lib/av-link avChatUrl). The ad points
// at it instead of an article and carries the same utm params — the chat host's ad script reads them
// into GAM exactly like the site's.
//
// AV's external API (the AV_API_KEY one, lib/av-api) knows NO chats: they are built in the dashboard
// (Chat Builder → Subdomains & chats), so nothing here can be picked from a catalog and the chat's
// URL is pasted. What a request CAN prove is the HOST (read live 29.09 on AV's other chat hosts):
//   - its CNAME points at AV's chat gateway;
//   - the gateway routes it — before the Chat Builder activation is finished it answers
//     404 {"message":"no Route matched with those values"};
//   - it SHOWS ADS: the host's public /worker.js names the ad script AV assigns after its review.
//     Until then the chat is "Pending monetization" and every visitor earns nothing — a launch is
//     refused rather than buying that traffic.
// What a request can NOT prove is the chat itself: the gateway serves one static shell, so ANY
// well-formed id answers 200. The id is the buyer's to copy from Chat Builder.
//
// Only lib/av-link (pure) is imported, so `node --test tests/av-chat.test.ts` loads this straight
// off Node with DNS and fetch stubbed.
import dns from "node:dns/promises";
import { avChatUrl } from "./av-link";

const UA = "Mozilla/5.0 (compatible; adlauncher-av/1.0)";
/** The CNAME target the Chat Builder wizard hands out (step 2 "Copy your DNS keys", read 29.09). */
const DEFAULT_GATEWAYS = ["assistant-quiz-infrastructure-gateway.activeview.app"];
const HOST_TTL_MS = 5 * 60_000;
const READY_TTL_MS = 5 * 60_000;
const PAGE_OK_TTL_MS = 10 * 60_000;
const PAGE_TIMEOUT_MS = 10_000;
const SETTINGS_TIMEOUT_MS = 8_000;
const DOH_TIMEOUT_MS = 5_000;

export type AvChatShape = { base: string; host: string; path: string };
export type AvChatHostVerdict = { chat: true; gateway: string } | { chat: false; failed: boolean; reason?: string };
export type AvChatHostOption = { host: string; site: string; live: boolean; liveReason?: string };
export type AvChatResolved = { ok: true; kind: "chat"; base: string; site: string } | { ok: false; error: string; status: number };

/** `failed` = the check could not be made (the route answers 502), else it is the buyer's fix (400). */
type Ready = { ready: true } | { ready: false; failed: boolean; error: string };

type Cached<T> = { at: number; value: T };
const hostCache = new Map<string, Cached<AvChatHostVerdict>>();
const readyCache = new Map<string, number>();
const pageOkCache = new Map<string, number>();

const normHost = (h: unknown): string => String(h ?? "").trim().toLowerCase().replace(/\.+$/, "");

/** fetch wraps the real failure in `cause` and says only "fetch failed" — name the cause. */
const causeCode = (e: unknown): string => String((e as { cause?: { code?: unknown } })?.cause?.code ?? "");
function errText(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const detail = String(cause?.code ?? cause?.message ?? "");
  return detail ? `${message}: ${detail}` : message;
}
/** The certificate errors of a host AV has not issued a certificate for yet: until the Chat Builder
 *  activation is finished the gateway serves its own default (self-signed) one. */
const CERT_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The gateway hosts a chat subdomain's CNAME may point at. AV_CHAT_GATEWAYS (comma-separated)
 *  REPLACES the built-in one when set — AV moving its gateway must not need a deploy. */
function gateways(): string[] {
  const own = String(process.env.AV_CHAT_GATEWAYS ?? "").split(",").map(normHost).filter(Boolean);
  return own.length ? own : DEFAULT_GATEWAYS;
}

/**
 * The host's CNAMEs over DNS-over-HTTPS (Google's JSON API) — the fallback for a runtime whose own
 * resolver cannot be asked (seen 29.09: dns.resolveCname answered ECONNREFUSED on a machine whose
 * system lookups worked). NOERROR / NXDOMAIN are answers; anything else throws.
 */
async function cnamesOverHttps(host: string): Promise<string[]> {
  const res = await fetch(`https://dns.google/resolve?name=${host}&type=CNAME`, {
    headers: { Accept: "application/dns-json" },
    cache: "no-store",
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] } | null;
  if (!res.ok || !body || (body.Status !== 0 && body.Status !== 3)) {
    throw new Error(`DNS over HTTPS answered ${res.status}${body && body.Status !== undefined ? ` / status ${String(body.Status)}` : ""}`);
  }
  return (Array.isArray(body.Answer) ? body.Answer : []).filter((a) => a.type === 5).map((a) => normHost(a.data));
}

/** The host's CNAMEs ([] = it has none): the runtime's resolver first, DNS-over-HTTPS when that
 *  resolver could not be asked. Throws only when neither could answer. */
async function cnamesOf(host: string): Promise<string[]> {
  try {
    return (await dns.resolveCname(host)).map(normHost);
  } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? "");
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    try {
      return await cnamesOverHttps(host);
    } catch (e2) {
      throw new Error(`${code || errText(e)}; ${errText(e2)}`);
    }
  }
}

/**
 * Is `host` an ActiveView chat host — does its CNAME point at AV's chat gateway? A clean DNS answer
 * (including "no such record") is a verdict and is cached 5 min; a DNS outage is a FAILED check:
 * it says nothing about the host, so it is never cached and never reads as "not a chat".
 */
export async function avChatHost(host: string, force = false): Promise<AvChatHostVerdict> {
  const h = normHost(host);
  const c = hostCache.get(h);
  if (!force && c && Date.now() - c.at < HOST_TTL_MS) return c.value;
  let cnames: string[];
  try {
    cnames = await cnamesOf(h);
  } catch (e) {
    return { chat: false, failed: true, reason: `the DNS lookup of ${h} failed (${errText(e)})` };
  }
  const gateway = gateways().find((g) => cnames.includes(g));
  const v: AvChatHostVerdict = gateway ? { chat: true, gateway } : { chat: false, failed: false };
  hostCache.set(h, { at: Date.now(), value: v });
  return v;
}

/**
 * The two ad settings of a chat host out of its /worker.js: `script` (the ad script's name — "" until
 * AV assigns one) and `config.disable`. The file is `const assistantQuizSettings = {…};` followed by
 * the loader code; read live 29.09 the literal is JSON-style with QUOTED keys. Only the literal is
 * read (the loader names `script` / `disable` too), with either key style; null = not that file.
 */
function adSettings(js: string): { script: string; disable: boolean } | null {
  const at = js.indexOf("assistantQuizSettings");
  if (at < 0) return null;
  const end = js.indexOf("};", at);
  const literal = end < 0 ? js.slice(at) : js.slice(at, end + 1);
  const script = /(?:^|[\s{,])["']?script["']?\s*:\s*(["'])(.*?)\1/.exec(literal);
  const disable = /(?:^|[\s{,])["']?disable["']?\s*:\s*(true|false)\b/.exec(literal);
  if (!script || !disable) return null;
  return { script: script[2].trim(), disable: disable[1] === "true" };
}

/**
 * May traffic be bought for this chat host — is it activated and does it show ads? Reads the host's
 * public /worker.js (AV generates it per host: `script` = the ad script's name, `config.disable` =
 * ads switched off). Only a READY verdict is cached (5 min): a host that was just activated or
 * approved must be launchable at once.
 */
async function chatHostReady(host: string, force = false): Promise<Ready> {
  const seen = readyCache.get(host);
  if (!force && seen && Date.now() - seen < READY_TTL_MS) return { ready: true };
  readyCache.delete(host);
  const url = `https://${host}/worker.js`;
  let status: number;
  let body: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/javascript,*/*;q=0.8" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.text().catch(() => "");
  } catch (e) {
    if (CERT_ERRORS.has(causeCode(e))) {
      return {
        ready: false,
        failed: false,
        error: `chat_not_live — ${host} has no certificate of its own yet (AV's chat gateway still serves its default one): finish the activation in ActiveView → Chat Builder`,
      };
    }
    return { ready: false, failed: true, error: `destination_check_failed — ${host} did not answer (${errText(e)})` };
  }
  if (status === 404 && /no Route matched/i.test(body)) {
    return { ready: false, failed: false, error: `chat_not_live — AV's chat gateway has no route for ${host} yet: finish the activation in ActiveView → Chat Builder` };
  }
  const settings = status === 200 ? adSettings(body) : null;
  if (!settings) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad settings of ${host} could not be read (${url} answered ${status})` };
  }
  if (!settings.script) {
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — ${host} shows no ads yet: ActiveView has not assigned its ad script (the chat is "Pending monetization") — ask ActiveView to finish the review before buying traffic`,
    };
  }
  if (settings.disable) {
    return { ready: false, failed: false, error: `chat_not_monetized — ads are switched off on ${host} (Chat Builder → the subdomain's ad settings)` };
  }
  readyCache.set(host, Date.now());
  return { ready: true };
}

/** Does the chat's address answer 200 on its own host? (Cached 10 min once proven, like an article.) */
async function chatLive(base: string, host: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const seen = pageOkCache.get(base);
  if (seen && Date.now() - seen < PAGE_OK_TTL_MS) return { ok: true };
  let res: Response;
  try {
    res = await fetch(base, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `destination_check_failed — ${base} did not answer (${errText(e)})` };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status !== 200) return { ok: false, error: `chat_not_live — ${base} answered ${res.status}` };
  let finalHost = host;
  try {
    finalHost = new URL(res.url || base).hostname.toLowerCase();
  } catch {
    /* an unparseable final URL keeps the requested host */
  }
  if (finalHost !== host) return { ok: false, error: `destination_invalid — ${base} redirects off the chat host (${finalHost})` };
  pageOkCache.set(base, Date.now());
  return { ok: true };
}

/**
 * The server's verdict on a destination whose host is a SUBDOMAIN of the AV site `site` and is not
 * one of its redirect domains (lib/av-destination routes it here): the host must be a chat host that
 * shows ads, the URL must name a chat, and its canonical address must answer there. `base` comes
 * back canonical (…/?asst=<id>) whichever form was stored. `status` = the HTTP status the route
 * should answer (400 = the buyer's fix, 502 = a check that could not be made).
 */
export async function resolveAvChat(shape: AvChatShape, site: string): Promise<AvChatResolved> {
  const host = normHost(shape.host);
  const s = normHost(site);
  if (!s || !host.endsWith(`.${s}`) || host === `www.${s}`) {
    return { ok: false, status: 400, error: `destination_not_av — ${host} is not a chat subdomain of ${s || "an ActiveView site of ours"}` };
  }
  const verdict = await avChatHost(host);
  if (!verdict.chat) {
    if (verdict.failed) return { ok: false, status: 502, error: `destination_check_failed — ${verdict.reason}` };
    return {
      ok: false,
      status: 400,
      error: `destination_not_av — ${host} is neither ${s}, one of its redirect domains, nor an ActiveView chat subdomain (its CNAME does not point at AV's chat gateway)`,
    };
  }
  const url = avChatUrl(shape.base);
  if (!url.ok) return { ok: false, status: 400, error: url.error };
  const ready = await chatHostReady(host);
  if (!ready.ready) return { ok: false, status: ready.failed ? 502 : 400, error: ready.error };
  const live = await chatLive(url.base, host);
  if (!live.ok) return { ok: false, status: live.error.startsWith("destination_check_failed") ? 502 : 400, error: live.error };
  return { ok: true, kind: "chat", base: url.base, site: s };
}

/**
 * The card's hint: which of our sites have a chat host, and whether traffic may be bought for it.
 * Only the conventional `chat.<site>` is probed (the API lists none and a subdomain cannot be
 * enumerated) — a chat on any other subdomain still resolves when its URL is pasted. A site without
 * one, or a failed DNS check, is left out. `force` re-reads past the caches (the card's Retry).
 */
export async function avChatHosts(sites: string[], force = false): Promise<AvChatHostOption[]> {
  const out: AvChatHostOption[] = [];
  for (const raw of sites) {
    const site = normHost(raw);
    if (!site) continue;
    const host = `chat.${site}`;
    const verdict = await avChatHost(host, force);
    if (!verdict.chat) continue;
    const ready = await chatHostReady(host, force);
    out.push({ host, site, live: ready.ready, ...(ready.ready ? {} : { liveReason: ready.error }) });
  }
  return out;
}

/** Test seam: drop every per-instance cache. */
export function _resetAvChatCaches(): void {
  hostCache.clear();
  readyCache.clear();
  pageOkCache.clear();
}
