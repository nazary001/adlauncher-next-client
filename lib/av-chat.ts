// AV rail — the CHAT destination (server-only). ActiveView's Chat Builder hosts a publisher's chats
// on a subdomain of the publisher's own site (chat.thecadrion.com) whose CNAME points at AV's chat
// gateway; a chat's address is https://<chat host>/?asst=<id> (lib/av-link avChatUrl). The ad points
// at it instead of an article and carries the same utm params — the chat host's ad script reads them
// into GAM exactly like the site's.
//
// AV's external API (the AV_API_KEY one, lib/av-api) knows NO chats: they are built in the dashboard
// (Chat Builder → Subdomains & chats), so nothing here can be picked from a catalog and the chat's
// URL is pasted. What a request CAN prove is the HOST (all read live 29.09 on AV's chat hosts):
//   - its CNAME points at AV's chat gateway;
//   - the gateway routes it — before the Chat Builder activation is finished it answers
//     404 {"message":"no Route matched with those values"} behind its default certificate;
//   - it SHOWS ADS. The host's public /worker.js is its settings + a loader: the page starts only
//     with a chat key and the parts the loader requires, and takes its ads from ONE file, the ad
//     script the settings name, off AV's script CDN. AV assigns and publishes that script by hand
//     after its review ("Pending monetization" until then) — hosts were seen with no script, with
//     the template's placeholder, and with a name whose file the CDN does not have. Each of those
//     shows no ads: every visitor bought for it earns nothing, so the launch is refused.
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
/** Where every chat host's loader takes its ad script from (`${base}/${script}.js`, nothing encoded). */
const DEFAULT_SCRIPT_CDN = "https://scr.actview.net";
/** What the loader's validateSettings wants before the page starts — the ad script included. */
const REQUIRED_SETTINGS = ["key", "terms", "theme", "config", "botNames"] as const;
/** The template's default ad script: a name no host's own script carries (on the CDN it is another
 *  publisher's file). */
const PLACEHOLDER_SCRIPTS = new Set(["localhost"]);
/** A script name is remote content that becomes part of a URL: a plain file name or nothing. */
const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const HOST_TTL_MS = 5 * 60_000;
const READY_TTL_MS = 5 * 60_000;
const HINT_TTL_MS = 60_000;
const PAGE_OK_TTL_MS = 10 * 60_000;
const PAGE_OK_MAX = 500;
const DNS_TIMEOUT_MS = 3_000;
const DOH_TIMEOUT_MS = 5_000;
const SETTINGS_TIMEOUT_MS = 8_000;
const SCRIPT_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 8_000;
const SETTINGS_MAX_BYTES = 256 * 1024;
const SETTINGS_MAX_DEPTH = 12;
const DOH_MAX_BYTES = 64 * 1024;

export type AvChatShape = { base: string; host: string; path: string };
export type AvChatHostVerdict = { chat: true; gateway: string } | { chat: false; failed: boolean; reason?: string };
export type AvChatHostOption = { host: string; site: string; live: boolean; liveReason?: string };
export type AvChatResolved = { ok: true; kind: "chat"; base: string; site: string } | { ok: false; error: string; status: number };

/** `failed` = the check could not be made (the route answers 502), else it is the buyer's fix (400). */
type Ready = { ready: true } | { ready: false; failed: boolean; error: string };

type Cached<T> = { at: number; value: T };
const hostCache = new Map<string, Cached<{ chat: true; gateway: string }>>();
const readyCache = new Map<string, number>();
const hintCache = new Map<string, Cached<Ready>>();
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

/** A response body as text, read only as far as `max` bytes — the rest is never downloaded. */
async function textUpTo(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** One GET of the check: never follows a redirect (what it may name is not ours to request),
 *  bounded in time and — for the bodies that are read — in size. */
function get(url: string, accept: string, timeoutMs: number): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
}

/** The gateway hosts a chat subdomain's CNAME may point at. AV_CHAT_GATEWAYS (comma-separated)
 *  REPLACES the built-in one when set — AV moving its gateway must not need a deploy. */
function gateways(): string[] {
  const own = String(process.env.AV_CHAT_GATEWAYS ?? "").split(",").map(normHost).filter(Boolean);
  return own.length ? own : DEFAULT_GATEWAYS;
}

/** The origin the ad scripts are served from. AV_CHAT_SCRIPT_CDN (an https origin) REPLACES the
 *  built-in one when set — the twin of AV_CHAT_GATEWAYS. */
function scriptCdn(): string {
  const own = String(process.env.AV_CHAT_SCRIPT_CDN ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(own) ? own : DEFAULT_SCRIPT_CDN;
}

/** The host's CNAMEs from the runtime's resolver, given up after 3 s: left to itself the resolver
 *  waits about half a minute for a name server that does not answer (measured), longer than a
 *  route may run. */
async function cnamesFromResolver(host: string): Promise<string[]> {
  const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver.resolveCname(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          resolver.cancel();
          reject(Object.assign(new Error(`the name server did not answer in ${DNS_TIMEOUT_MS / 1000} s`), { code: "ETIMEOUT" }));
        }, DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The host's CNAMEs over DNS-over-HTTPS (Google's JSON API) — the fallback for a runtime whose own
 * resolver cannot be asked (seen 29.09: ECONNREFUSED on a machine whose system lookups worked).
 * NOERROR / NXDOMAIN are answers; anything else throws.
 */
async function cnamesOverHttps(host: string): Promise<string[]> {
  const res = await get(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=CNAME`, "application/dns-json", DOH_TIMEOUT_MS);
  const text = await textUpTo(res, DOH_MAX_BYTES);
  let body: { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not an answer */
  }
  if (!res.ok || !body || (body.Status !== 0 && body.Status !== 3)) {
    throw new Error(`DNS over HTTPS answered ${res.status}${body && body.Status !== undefined ? ` / status ${String(body.Status)}` : ""}`);
  }
  return (Array.isArray(body.Answer) ? body.Answer : []).filter((a) => a.type === 5).map((a) => normHost(a.data));
}

/** The host's CNAMEs ([] = it has none): the runtime's resolver first, DNS-over-HTTPS when that
 *  resolver could not be asked. Throws only when neither could answer. */
async function cnamesOf(host: string): Promise<string[]> {
  try {
    return (await cnamesFromResolver(host)).map(normHost);
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
 * Is `host` an ActiveView chat host — does its CNAME point at AV's chat gateway? Only a YES is
 * cached (5 min): a CNAME that was added a moment ago must be seen at once, and a DNS outage says
 * nothing about the host — it is a FAILED check, never "not a chat". A string that is not a host
 * name is answered without asking anyone.
 */
export async function avChatHost(host: string, force = false): Promise<AvChatHostVerdict> {
  const h = normHost(host);
  if (!HOST_RE.test(h)) return { chat: false, failed: false };
  const c = hostCache.get(h);
  if (!force && c && Date.now() - c.at < HOST_TTL_MS) return c.value;
  hostCache.delete(h);
  let cnames: string[];
  try {
    cnames = await cnamesOf(h);
  } catch (e) {
    return { chat: false, failed: true, reason: `the DNS lookup of ${h} failed (${errText(e)})` };
  }
  const gateway = gateways().find((g) => cnames.includes(g));
  if (!gateway) return { chat: false, failed: false };
  const verdict = { chat: true as const, gateway };
  hostCache.set(h, { at: Date.now(), value: verdict });
  return verdict;
}

/** Past the white space and the comments that start at `i`. */
function skipBlank(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else return i;
  }
}

/** Where a quoted text that opens at `i` closes (the index past its closing quote), and what it says. */
function readText(src: string, i: number): { value: string; end: number } {
  const quote = src[i];
  let value = "";
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      const n = src[++j];
      value += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : (n ?? "");
    } else if (c === quote) return { value, end: j + 1 };
    else if (c === "\n") break;
    else value += c;
  }
  throw new Error("an unclosed text");
}

/**
 * One value of a DATA-only literal that starts at `i`: JSON, or the template's JavaScript flavour of
 * it (bare keys, single quotes, trailing commas, comments). Anything that is not plain data — a
 * call, a name, a template, an expression — throws: what a page computes cannot be vouched for by
 * reading its source.
 */
function readData(src: string, at: number, depth = 0): { value: unknown; end: number } {
  if (depth > SETTINGS_MAX_DEPTH) throw new Error("nested too deep");
  let i = skipBlank(src, at);
  const c = src[i];
  if (c === '"' || c === "'") return readText(src, i);
  if (c === "{" || c === "[") {
    const list = c === "[";
    const close = list ? "]" : "}";
    const items: unknown[] = [];
    const entries: Record<string, unknown> = Object.create(null);
    i = skipBlank(src, i + 1);
    while (src[i] !== close) {
      if (i >= src.length) throw new Error("an unclosed literal");
      let key = "";
      if (!list) {
        if (src[i] === '"' || src[i] === "'") {
          const k = readText(src, i);
          key = k.value;
          i = k.end;
        } else {
          const k = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
          if (!k) throw new Error("not a key");
          key = k[0];
          i += key.length;
        }
        i = skipBlank(src, i);
        if (src[i] !== ":") throw new Error("a key without a value");
        i += 1;
      }
      const v = readData(src, i, depth + 1);
      if (list) items.push(v.value);
      else entries[key] = v.value; // a repeated key: the last one stands, as in the page
      i = skipBlank(src, v.end);
      if (src[i] === ",") i = skipBlank(src, i + 1);
      else if (src[i] !== close) throw new Error("not plain data");
    }
    return { value: list ? items : entries, end: i + 1 };
  }
  const word = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$.(])/.exec(src.slice(i, i + 40));
  if (!word) throw new Error("not plain data");
  const w = word[0];
  return { value: w === "true" ? true : w === "false" ? false : w === "null" ? null : Number(w), end: i + w.length };
}

/** Where the settings literal opens (the index of its "{"): the first `assistantQuizSettings = {`
 *  that is code — not inside a comment or a text. -1 = the file has none. */
function settingsStart(js: string): number {
  const opens = /assistantQuizSettings\s*=\s*\{/y;
  for (let i = 0; i < js.length; i++) {
    const c = js[i];
    if (c === '"' || c === "'" || c === "`") {
      // a text: skip to its closing quote (a template's ${} is never met before the settings)
      for (i++; i < js.length && js[i] !== c; i++) if (js[i] === "\\") i++;
    } else if (c === "/" && (js[i + 1] === "/" || js[i + 1] === "*")) {
      i = skipBlank(js, i) - 1;
    } else if (c === "a" && !/[\w$]/.test(js[i - 1] ?? "")) {
      opens.lastIndex = i;
      const m = opens.exec(js);
      if (m) return i + m[0].length - 1;
    }
  }
  return -1;
}

/**
 * A chat host's settings out of its /worker.js: `const assistantQuizSettings = {…};` followed by
 * the loader. The literal is read as DATA, at its own level (a key, a script or a part nested
 * deeper never stands in for the host's; the loader below names `script` / `disable` too), and then
 * read the way the host's own loader reads it: a missing or blank `script` is no script,
 * Boolean(config.disable) switches the ads off, and `missing` lists the parts the loader requires
 * and finds falsy — an EMPTY list or object is there. null = not that file, or not plain data.
 */
function chatSettings(js: string): { key: string; script: string; disable: boolean; missing: string[] } | null {
  const at = settingsStart(js);
  if (at < 0) return null;
  let settings: Record<string, unknown>;
  try {
    settings = readData(js, at).value as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const config = settings.config && typeof settings.config === "object" ? (settings.config as Record<string, unknown>) : null;
  return {
    key: text(settings.key),
    script: text(settings.script),
    disable: Boolean(config?.disable),
    missing: REQUIRED_SETTINGS.filter((part) => (part === "key" ? !text(settings.key) : !settings[part])),
  };
}

/** Is the ad script the host names actually SERVED by AV's CDN? The address is built exactly as the
 *  host's loader builds it. A file the CDN does not have answers 403 (read live) or 404 — the
 *  buyer's fix; anything else that is not a served script is a check that could not be made (a CDN
 *  outage must not send the buyer to ActiveView about a script that may be fine). */
async function adScriptServed(host: string, script: string): Promise<Ready> {
  if (!SCRIPT_NAME_RE.test(script)) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad script of ${host} is named ${JSON.stringify(script)}, which is no file name` };
  }
  const url = `${scriptCdn()}/${script}.js`;
  let status: number;
  let type: string;
  try {
    const res = await get(url, "application/javascript,*/*;q=0.8", SCRIPT_TIMEOUT_MS);
    status = res.status;
    type = res.headers.get("content-type") ?? "";
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad script of ${host} could not be checked (${url}: ${errText(e)})` };
  }
  if (status === 403 || status === 404) {
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — ${host} names the ad script "${script}" but ActiveView has not published it (${url} answered ${status}), so the chat shows no ads — ask ActiveView to publish it before buying traffic`,
    };
  }
  if (status !== 200 || !/javascript|ecmascript/i.test(type)) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad script of ${host} could not be checked (${url} answered ${status} ${type || "without a content type"})` };
  }
  return { ready: true };
}

/** May traffic be bought for this chat host — is it activated, published, and does it show ads? */
async function probeChatHost(host: string): Promise<Ready> {
  const url = `https://${host}/worker.js`;
  let status: number;
  let body: string;
  try {
    const res = await get(url, "application/javascript,*/*;q=0.8", SETTINGS_TIMEOUT_MS);
    status = res.status;
    body = await textUpTo(res, SETTINGS_MAX_BYTES);
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
  const settings = status === 200 ? chatSettings(body) : null;
  if (!settings) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad settings of ${host} could not be read (${url} answered ${status})` };
  }
  if (!settings.key) {
    return { ready: false, failed: false, error: `chat_not_live — ${host} has no chat key yet (its settings are still the template's): publish the chat in ActiveView → Chat Builder` };
  }
  if (!settings.script) {
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — ${host} shows no ads yet: ActiveView has not assigned its ad script (the chat is "Pending monetization") — ask ActiveView to finish the review before buying traffic`,
    };
  }
  if (PLACEHOLDER_SCRIPTS.has(settings.script.toLowerCase())) {
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — ${host} still names the template's placeholder ad script ("${settings.script}"), not its own — ask ActiveView to assign it before buying traffic`,
    };
  }
  if (settings.disable) {
    return { ready: false, failed: false, error: `chat_not_monetized — ads are switched off on ${host} (Chat Builder → the subdomain's ad settings)` };
  }
  if (settings.missing.length) {
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — the settings of ${host} are incomplete (no ${settings.missing.join(", ")}): its page stops before it loads the ad script, so the chat shows no ads — ask ActiveView to regenerate them`,
    };
  }
  return adScriptServed(host, settings.script);
}

/**
 * The launch's gate. Only a READY verdict is remembered (5 min): a host that was just activated,
 * approved or fixed is launchable at once, and a refusal is re-checked every time.
 */
async function chatHostReady(host: string, force = false): Promise<Ready> {
  const seen = readyCache.get(host);
  if (!force && seen !== undefined && Date.now() - seen < READY_TTL_MS) return { ready: true };
  readyCache.delete(host);
  const verdict = await probeChatHost(host);
  if (verdict.ready) {
    readyCache.set(host, Date.now());
    hintCache.delete(host);
  } else {
    // The refusal is the newest word on the host: a READY an older, overlapping check wrote
    // meanwhile must not outlive it.
    readyCache.delete(host);
    hintCache.set(host, { at: Date.now(), value: verdict });
  }
  return verdict;
}

/** The card's hint of the same verdict. A NOT-ready one is remembered for a minute — the catalog is
 *  read on every card load by every AV buyer, and a host that does not answer costs its whole
 *  timeout — but only here: a launch never reads this memory. */
async function chatHostHint(host: string, force = false): Promise<Ready> {
  const c = hintCache.get(host);
  if (!force && c && Date.now() - c.at < HINT_TTL_MS) return c.value;
  return chatHostReady(host, force);
}

/** Does the chat's address answer 200 — itself, not something it redirects to? (Remembered 10 min
 *  once proven, like an article; bounded, since any id answers and ids are the buyer's to type.) */
async function chatLive(base: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const seen = pageOkCache.get(base);
  if (seen !== undefined && Date.now() - seen < PAGE_OK_TTL_MS) return { ok: true };
  pageOkCache.delete(base);
  let status: number;
  try {
    const res = await get(base, "text/html,*/*;q=0.8", PAGE_TIMEOUT_MS);
    status = res.status;
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    return { ok: false, error: `destination_check_failed — ${base} did not answer (${errText(e)})` };
  }
  if (status !== 200) return { ok: false, error: `chat_not_live — ${base} answered ${status}` };
  if (pageOkCache.size >= PAGE_OK_MAX) pageOkCache.delete(pageOkCache.keys().next().value as string);
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
  if (!s || !HOST_RE.test(host) || !host.endsWith(`.${s}`) || host === `www.${s}`) {
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
  // Everything below is requested from the address's OWN host — which must be the one just proven.
  if (url.host !== host) return { ok: false, status: 400, error: `destination_invalid — ${shape.base} is not an address of ${host}` };
  const ready = await chatHostReady(host);
  if (!ready.ready) return { ok: false, status: ready.failed ? 502 : 400, error: ready.error };
  const live = await chatLive(url.base);
  if (!live.ok) return { ok: false, status: live.error.startsWith("destination_check_failed") ? 502 : 400, error: live.error };
  return { ok: true, kind: "chat", base: url.base, site: s };
}

/**
 * The card's hint: which of our sites have a chat host, and whether traffic may be bought for it.
 * Only the conventional `chat.<site>` is probed (the API lists none and a subdomain cannot be
 * enumerated) — a chat on any other subdomain still resolves when its URL is pasted. A site with no
 * chat host is left out; a host that could not be CHECKED is listed as such, never dropped (that
 * would read as "there is none"). `force` re-reads past every cache (the card's Retry).
 */
export async function avChatHosts(sites: string[], force = false): Promise<AvChatHostOption[]> {
  const probed = await Promise.all(
    [...new Set(sites.map(normHost).filter(Boolean))].map(async (site): Promise<AvChatHostOption | null> => {
      const host = `chat.${site}`;
      const verdict = await avChatHost(host, force);
      if (!verdict.chat) return verdict.failed ? { host, site, live: false, liveReason: `destination_check_failed — ${verdict.reason}` } : null;
      const ready = await chatHostHint(host, force);
      return { host, site, live: ready.ready, ...(ready.ready ? {} : { liveReason: ready.error }) };
    }),
  );
  return probed.filter((h): h is AvChatHostOption => h !== null);
}

/** Test seam: drop every per-instance cache. */
export function _resetAvChatCaches(): void {
  hostCache.clear();
  readyCache.clear();
  hintCache.clear();
  pageOkCache.clear();
}
