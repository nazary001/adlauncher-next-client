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
//     shows no ads: every visitor bought for it earns nothing, so the launch is refused. The
//     settings are vouched for only while the REST of the file is the loader they are read for
//     (it loads the ad script the settings name and leaves them as they are): Chat Builder is a
//     beta and its loader has changed before — a form the launcher does not know is a failed check.
// What a request can NOT prove is the chat itself: the gateway serves one static shell, so ANY
// well-formed id answers 200. The id is the buyer's to copy from Chat Builder.
//
// Only lib/av-link (pure) is imported, so `node --test tests/av-chat.test.ts` loads this straight
// off Node with DNS and fetch stubbed.
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { AV_KNOWN_CHATS, type AvKnownChat, avChatProbeHosts, avChatUrl } from "./av-link";

const UA = "Mozilla/5.0 (compatible; adlauncher-av/1.0)";
/** The CNAME target the Chat Builder wizard hands out (step 2 "Copy your DNS keys", read 29.09). */
const DEFAULT_GATEWAYS = ["assistant-quiz-infrastructure-gateway.activeview.app"];
/** Where every chat host's loader takes its ad script from (`${base}/${script}.js`, nothing encoded). */
const DEFAULT_SCRIPT_CDN = "https://scr.actview.net";
/** What a loader's validateSettings wants before the page starts, where the loader does not list it
 *  itself (every loader read live 29.09 that lists its parts lists these). */
const REQUIRED_SETTINGS: readonly string[] = ["key", "terms", "theme", "config", "botNames"];
/** A list of required parts the launcher judges by: a few plain names. */
const REQUIRED_MAX = 24;
const PART_NAME_RE = /^[A-Za-z_$][\w$-]{0,39}$/;
/** How many missing parts a refusal names (they come from the remote loader's list). */
const PARTS_ECHO_MAX = 5;
/** How a loader reads the settings' script: optionally or by its quoted name, trimmed or not. */
const SCRIPT_READ = String.raw`assistantQuizSettings\s*(?:(?:\?\.\s*)?\[\s*(?:"script"|'script')\s*\]|\??\.\s*script\b)(?:\s*\??\.\s*trim\s*\(\s*\))?`;
/**
 * How every loader read live takes its ads: loadRemoteScript({ …, fileName: <the settings' script> }),
 * read in the CODE of the file (codeOnly: a quoted plain name stays, any other text is blank). The
 * name may be read optionally or by its quoted name, trimmed, made a string, put in parentheses, and
 * fall back to something else when it is empty — an empty script is refused before the loader is
 * asked. Anything that CHANGES the name (a suffix, its case) loads another file than the one checked.
 */
const LOADS_FROM_SETTINGS = new RegExp(
  String.raw`\bloadRemoteScript\s*(?:\?\.\s*)?\(\s*\{(?:[^{}]|\{[^{}]*\})*?(?:\bfileName|"fileName"|'fileName')\s*:\s*` +
    String.raw`(?:String\s*\(\s*${SCRIPT_READ}\s*\)|\(\s*${SCRIPT_READ}\s*\)|${SCRIPT_READ})(?:\s*(?:\|\||\?\?)\s*[^,{}()\n]{0,80})?(?=\s*[,}])`,
);
/** The settings themselves — never a member of another object (window.assistantQuizSettings is not
 *  the page's `const`). */
const SETTINGS_NAME = String.raw`(?<![\w$])(?<!\.\s*)assistantQuizSettings`;
const MEMBERS = String.raw`(?:\s*(?:\?\.|\.)\s*[\w$]+|\s*\[[^\]\n]{0,120}\])*`;
/** Code that would make the settings something else than the literal says. */
const CHANGES_SETTINGS = [
  new RegExp(String.raw`${SETTINGS_NAME}${MEMBERS}\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])`),
  new RegExp(String.raw`${SETTINGS_NAME}${MEMBERS}\s*(?:\+\+|--)`),
  /\bdelete\s+assistantQuizSettings\b/,
  /\bObject\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*assistantQuizSettings\b/,
];
/** The loader's list of required parts: its declaration — or, minified, the list inlined where it is read. */
const REQUIRED_LIST = /\brequiredFields\s*=\s*\[/g;
const REQUIRED_INLINE = /\[\s*(?:(?:"[\w$-]+"|'[\w$-]+')\s*,\s*)*(?:"[\w$-]+"|'[\w$-]+')\s*,?\s*\]\s*\.\s*(?:filter|every|some)\s*\(/g;
const VALIDATES = /\b(?:validateSettings|requiredFields)\b/;
/** Where the loader says its ad scripts come from: a parameter's default, or a name in the call (the
 *  value is read in the file itself — in the code a text is blank). */
const BASE_URL_DEFAULT = /\bbaseUrl\s*(?::\s*[\w$]+\s*)?=(?![=>])/g;
const BASE_URL_NAMED = /(?:\bbaseUrl|"baseUrl"|'baseUrl')\s*:/g;
/** What switches the ads off: the settings' own switch (as every live loader reads it), or off. */
const DISABLE_NAMED = /(?:\bdisable|"disable"|'disable')\s*:/g;
const DISABLE_DEFAULT = /\bdisable\s*(?::\s*[\w$]+\s*)?=(?![=>])/g;
const SETTINGS_SWITCH = /^\s*(?:(?:Boolean\s*\(|!!)\s*)?assistantQuizSettings\s*\??\.\s*config\s*(?:\??\.\s*disable\b|(?:\?\.\s*)?\[\s*(?:"disable"|'disable')\s*\])\s*\)?\s*(?=[,}])/;
const SWITCHED_ON = /^\s*(?:false|!1|0|null|undefined|void\s+0)\s*(?=[,})])/;
/** The longest script name a refusal repeats (a name is remote content). */
const NAME_ECHO_MAX = 80;
/** The longest regex literal the reading of a loader looks for (a longer "/…/" is read as divisions). */
const REGEX_MAX = 300;
/** Words after which a "/" opens a regex, not a division. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
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
/** A chat host as the card's catalog lists it. `pending`: its probe was still running when the
 *  catalog answered (the card reads the catalog again in a moment). */
export type AvChatHostOption = { host: string; site: string; live: boolean; liveReason?: string; pending?: true };
export type AvChatResolved = { ok: true; kind: "chat"; base: string; site: string } | { ok: false; error: string; status: number };

/** `failed` = the check could not be made (the route answers 502), else it is the buyer's fix (400). */
type Ready = { ready: true } | { ready: false; failed: boolean; error: string };

type Cached<T> = { at: number; value: T };
const hostCache = new Map<string, Cached<{ chat: true; gateway: string }>>();
const readyCache = new Map<string, number>();
const hintCache = new Map<string, Cached<Ready>>();
/** The card's memory of what DNS said of a chat.<site> that is no chat host: null = it has no chat
 *  CNAME, a row = the lookup could not be made. Never read by a launch. */
const dnsHintCache = new Map<string, Cached<AvChatHostOption | null>>();
/** The card's reading of a host while it runs: every read of the card joins it. */
const hintFlights = new Map<string, Promise<AvChatHostOption | null>>();
/** Hosts seen behind AV's chat gateway (this instance, bounded): a page of one is never taken for an
 *  article because a DNS check could not be made (lib/av-destination). */
const seenChatHosts = new Set<string>();
const SEEN_MAX = 1000;
/** Unknown loaders already told about in the log (bounded). */
const toldLoaders = new Set<string>();
const pageOkCache = new Map<string, number>();
/** The newest probe STARTED per host, while it is in flight. */
const probing = new Map<string, number>();
let probes = 0;

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
  if (!force && c && Date.now() - c.at < HOST_TTL_MS) {
    dnsHintCache.delete(h);
    return c.value;
  }
  hostCache.delete(h);
  let cnames: string[];
  try {
    cnames = await cnamesOf(h);
  } catch (e) {
    return { chat: false, failed: true, reason: `the DNS lookup of ${h} failed (${errText(e)})` };
  }
  dnsHintCache.delete(h); // DNS answered: what the card remembered of it is old news
  const gateway = gateways().find((g) => cnames.includes(g));
  if (!gateway) return { chat: false, failed: false };
  const verdict = { chat: true as const, gateway };
  hostCache.set(h, { at: Date.now(), value: verdict });
  if (seenChatHosts.size < SEEN_MAX) seenChatHosts.add(h);
  return verdict;
}

/** Was `host` seen behind AV's chat gateway by this instance (lib/av-destination)? */
export function avChatHostSeen(host: string): boolean {
  return seenChatHosts.has(normHost(host));
}

/** Where the line that `i` is on ends (its "\n" or "\r"), or the end of `src`. */
function lineEnd(src: string, i: number): number {
  for (let j = i; j < src.length; j++) if (src[j] === "\n" || src[j] === "\r") return j;
  return src.length;
}

/** Past the white space and the comments that start at `i`. */
function skipBlank(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      i = Math.min(src.length, lineEnd(src, i) + 1);
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
    else if (c === "\n" || c === "\r") break;
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
  // !0 / !1 are how a minifier writes true / false
  const word = /^(?:true|false|null|!0|!1|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$.(])/.exec(src.slice(i, i + 40));
  if (!word) throw new Error("not plain data");
  const w = word[0];
  return { value: w === "true" || w === "!0" ? true : w === "false" || w === "!1" ? false : w === "null" ? null : Number(w), end: i + w.length };
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
 * `src` with every comment, every quoted text and every regex literal blanked out — same length,
 * same line breaks, so an index into what is left (the code) is an index into `src`. A quoted plain
 * name ("script", 'fileName') stays: code names a property that way, and it is never code itself.
 */
function codeOnly(src: string): string {
  const blank = (from: number, to: number) => src.slice(from, to).replace(/[^\n]/g, " ");
  let out = "";
  // What came last in the code, kept as it goes (reading `out` back would flatten it every time): the
  // last character that is no white space, where it is, the word it ends, and where the last text or
  // regex (an operand) ended — a "/" right after an operand divides.
  let lastSig = -1;
  let lastChar = "";
  let word = "";
  let wordOpen = false;
  let operandEnd = -1;
  const regexMayStart = (): boolean => {
    if (operandEnd > lastSig) return false;
    if (lastSig < 0) return true;
    if (/[\w$]/.test(lastChar)) return REGEX_AFTER.has(word);
    return lastChar !== ")" && lastChar !== "]";
  };
  /** Past the regex literal that opens at `from` (its flags included), or -1: none closes on its line. */
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let j = from + 1; j < src.length && j <= from + REGEX_MAX; j++) {
      const c = src[j];
      if (c === "\n" || c === "\r") return -1;
      if (c === "\\") j++;
      else if (inClass) inClass = c !== "]";
      else if (c === "[") inClass = true;
      else if (c === "/") {
        let k = j + 1;
        while (k < src.length && /[a-z]/i.test(src[k])) k++;
        return k;
      }
    }
    return -1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      let end: number;
      if (src[i + 1] === "/") {
        end = lineEnd(src, i);
      } else {
        const close = src.indexOf("*/", i + 2);
        end = close < 0 ? src.length : close + 2;
      }
      out += blank(i, end);
      wordOpen = false;
      i = end;
      continue;
    }
    const regex = c === "/" && regexMayStart() ? regexEnd(i) : -1;
    if (regex > 0) {
      out += blank(i, regex);
      operandEnd = out.length;
      wordOpen = false;
      i = regex;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      // a quoted text ends with its line at the latest; a template may run over lines
      while (j < src.length && src[j] !== c && (c === "`" || (src[j] !== "\n" && src[j] !== "\r"))) j += src[j] === "\\" ? 2 : 1;
      const end = Math.min(src.length, j + 1);
      const text = src.slice(i, end);
      const name = c !== "`" && /^(["'])[\w$-]{1,40}\1$/.test(text);
      out += name ? text : blank(i, end);
      if (name) {
        lastSig = out.length - 1;
        lastChar = text[text.length - 1];
      }
      operandEnd = out.length;
      wordOpen = false;
      i = end;
    } else {
      out += c;
      if (/\s/.test(c)) wordOpen = false;
      else {
        lastSig = out.length - 1;
        lastChar = c;
        const inWord = /[\w$]/.test(c);
        word = inWord ? (wordOpen ? word + c : c) : "";
        wordOpen = inWord;
      }
      i += 1;
    }
  }
  return out;
}

/** `known` = the rest of the file is a loader the settings can be vouched for; `required` = the
 *  parts its page will not start without. */
type Loader = { known: true; required: readonly string[] } | { known: false; why: string };

/** The text of the quoted literal a value that starts at `at` is, or null when it is no literal. */
function literalAt(src: string, at: number): string | null {
  const i = skipBlank(src, at);
  if (src[i] !== '"' && src[i] !== "'") return null;
  try {
    return readText(src, i).value;
  } catch {
    return null;
  }
}

/** A list of required parts at `at`: a few plain names, or null. */
function partsAt(src: string, at: number): string[] | null {
  try {
    const parts = readData(src, at).value;
    if (Array.isArray(parts) && parts.length <= REQUIRED_MAX && parts.every((p) => typeof p === "string" && PART_NAME_RE.test(p))) return parts as string[];
  } catch {
    /* not plain data */
  }
  return null;
}

/** Past the "}" that closes the object opening at `open` in `code`, or -1. */
function objectEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

const originOf = (url: string): string => url.trim().toLowerCase().replace(/\/+$/, "");

/**
 * What follows the settings literal. The settings say what the page WILL do only under the loader
 * they were read for: it takes its ads from the file the settings name, off the CDN the launcher
 * checks, it leaves the settings as the literal set them, and what it requires before it starts can
 * be read (its own list — or none: the older loaders validate nothing and are judged by the list the
 * newer ones carry). AV_CHAT_LOADER_CHECK=off takes any loader as known — for a release the launcher
 * does not know yet; the settings are still judged.
 */
function loaderOf(rest: string): Loader {
  if (String(process.env.AV_CHAT_LOADER_CHECK ?? "").trim().toLowerCase() === "off") return { known: true, required: REQUIRED_SETTINGS };
  const code = codeOnly(rest);
  const call = LOADS_FROM_SETTINGS.exec(code);
  if (!call) return { known: false, why: "nothing in it loads the ad script the settings name" };
  if (CHANGES_SETTINGS.some((re) => re.test(code))) return { known: false, why: "it changes the settings after they are set" };

  // Where the ad scripts come from: named in the call, else the loader's default(s).
  const cdn = scriptCdn();
  const open = code.indexOf("{", call.index);
  const close = objectEnd(code, open);
  const inCall = close < 0 ? [] : [...code.slice(open, close).matchAll(BASE_URL_NAMED)].map((m) => literalAt(rest, open + (m.index ?? 0) + m[0].length));
  const defaults = [...code.matchAll(BASE_URL_DEFAULT)].map((m) => literalAt(rest, (m.index ?? 0) + m[0].length)).filter((v): v is string => v !== null);
  if (inCall.some((v) => v === null)) return { known: false, why: "where it takes its ad scripts from cannot be read" };
  const named = (inCall.length ? inCall : defaults) as string[];
  if (!named.length && !rest.includes(cdn)) return { known: false, why: "where it takes its ad scripts from cannot be read" };
  const other = named.find((v) => originOf(v) !== cdn);
  if (other !== undefined) {
    return { known: false, why: `its ad scripts come from ${originOf(other).slice(0, NAME_ECHO_MAX)}, the launcher checks ${cdn} — AV_CHAT_SCRIPT_CDN names the CDN to check` };
  }

  // What switches its ads off: the settings' switch only (the call's `disable`, else its default).
  const switches = close < 0 ? [] : [...code.slice(open, close).matchAll(DISABLE_NAMED)].map((m) => code.slice(open + (m.index ?? 0) + m[0].length, close));
  const switchDefaults = switches.length ? [] : [...code.matchAll(DISABLE_DEFAULT)].map((m) => code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200));
  if (switches.some((v) => !SETTINGS_SWITCH.test(v) && !SWITCHED_ON.test(v)) || switchDefaults.some((v) => !SWITCHED_ON.test(v))) {
    return { known: false, why: "its ads are switched off by something else than the settings" };
  }

  // What its page requires before it starts: ONE list, of a few plain names.
  const declared = [...code.matchAll(REQUIRED_LIST)];
  if (!declared.length && !VALIDATES.test(code)) return { known: true, required: REQUIRED_SETTINGS };
  const inline = declared.length ? [] : [...code.matchAll(REQUIRED_INLINE)];
  const lists = declared.length ? declared.map((m) => (m.index ?? 0) + m[0].length - 1) : inline.map((m) => m.index ?? 0);
  const required = lists.length === 1 ? partsAt(rest, lists[0]) : null;
  return required ? { known: true, required } : { known: false, why: "what its page requires cannot be read" };
}

/** An unknown loader is logged once per host and file, so a new release is noticed the day it lands. */
function tellUnknownLoader(host: string, why: string, js: string): void {
  if (process.env.NODE_ENV !== "production") return;
  const id = createHash("sha1").update(js).digest("hex").slice(0, 12);
  if (toldLoaders.has(`${host} ${id}`) || toldLoaders.size >= SEEN_MAX) return;
  toldLoaders.add(`${host} ${id}`);
  console.warn(`[av-chat] ${host}: its loader is not in a form the launcher knows (${why}) — file ${id}; AV_CHAT_LOADER_CHECK=off lets it through`);
}

/**
 * A chat host's settings out of its /worker.js: `const assistantQuizSettings = {…};` followed by
 * the loader. The literal is read as DATA, at its own level (a key, a script or a part nested
 * deeper never stands in for the host's; the loader below names `script` / `disable` too), and then
 * read the way the host's own loader reads it: a missing or blank `script` is no script,
 * Boolean(config.disable) switches the ads off, and `missing` lists the parts the loader requires
 * and finds falsy — an EMPTY list or object is there. `padded`: the script's name has blanks around
 * it (some loaders trim them, some do not). null = not that file, or not plain data.
 */
function chatSettings(js: string): { key: string; script: string; padded: boolean; disable: boolean; loader: Loader; missing: string[] } | null {
  const at = settingsStart(js);
  if (at < 0) return null;
  let settings: Record<string, unknown>;
  let end: number;
  try {
    const read = readData(js, at);
    settings = read.value as Record<string, unknown>;
    end = read.end;
  } catch {
    return null;
  }
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const config = settings.config && typeof settings.config === "object" ? (settings.config as Record<string, unknown>) : null;
  const loader = loaderOf(js.slice(end));
  return {
    key: text(settings.key),
    script: text(settings.script),
    padded: typeof settings.script === "string" && settings.script.trim() !== "" && settings.script !== settings.script.trim(),
    disable: Boolean(config?.disable),
    loader,
    // the chat key is the launcher's own requirement (asked first, whatever the list says)
    missing: (loader.known ? loader.required : []).filter((part) => part !== "key" && !settings[part]),
  };
}

/** Is the ad script the host names actually SERVED by AV's CDN? The address is built exactly as the
 *  host's loader builds it. A file the CDN does not have answers 403 (read live) or 404 in the
 *  CDN's OWN words (its storage's XML) — the buyer's fix; anything else that is not a served script
 *  — the same status from a block page or a proxy included — is a check that could not be made (it
 *  must not send the buyer to ActiveView about a script that may be fine). */
async function adScriptServed(host: string, script: string): Promise<Ready> {
  if (!SCRIPT_NAME_RE.test(script)) {
    const name = script.length > NAME_ECHO_MAX ? `${script.slice(0, NAME_ECHO_MAX)}…` : script;
    return { ready: false, failed: true, error: `destination_check_failed — the ad script of ${host} is named ${JSON.stringify(name)}, which is no file name` };
  }
  const url = `${scriptCdn()}/${script}.js`;
  let status: number;
  let type: string;
  let server: string;
  try {
    const res = await get(url, "application/javascript,*/*;q=0.8", SCRIPT_TIMEOUT_MS);
    status = res.status;
    type = res.headers.get("content-type") ?? "";
    server = res.headers.get("server") ?? "";
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    return { ready: false, failed: true, error: `destination_check_failed — the ad script of ${host} could not be checked (${url}: ${errText(e)})` };
  }
  if ((status === 403 || status === 404) && (/xml/i.test(type) || /amazons3/i.test(server))) {
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
  if (settings.padded) {
    const name = settings.script.length > NAME_ECHO_MAX ? `${settings.script.slice(0, NAME_ECHO_MAX)}…` : settings.script;
    return {
      ready: false,
      failed: true,
      error: `destination_check_failed — the ad script of ${host} is named " ${name} " — with blanks around it, which some of ActiveView's loaders trim and some do not, so the file its page loads cannot be vouched for — ask ActiveView to fix the name`,
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
  if (!settings.loader.known) {
    tellUnknownLoader(host, settings.loader.why, body);
    return {
      ready: false,
      failed: true,
      error: `destination_check_failed — the settings file of ${host} is not in a form the launcher knows (${settings.loader.why}), so its ads cannot be vouched for — ActiveView may have changed its chat loader: tell the developer`,
    };
  }
  if (settings.missing.length) {
    const more = settings.missing.length - PARTS_ECHO_MAX;
    const parts = `${settings.missing.slice(0, PARTS_ECHO_MAX).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    return {
      ready: false,
      failed: false,
      error: `chat_not_monetized — the settings of ${host} are incomplete (no ${parts}): its page stops before it loads the ad script, so the chat shows no ads — ask ActiveView to regenerate them`,
    };
  }
  return adScriptServed(host, settings.script);
}

/**
 * The launch's gate. Only a READY verdict is remembered (5 min): a host that was just activated,
 * approved or fixed is launchable at once, and a refusal is re-checked every time. When checks of
 * one host overlap, the memory is written from the reading that STARTED last — whichever ends last,
 * the one that started earlier read the host earlier — and a refusal takes the READY memory away
 * whatever its age (the next launch then reads the host itself).
 */
async function chatHostReady(host: string, force = false): Promise<Ready> {
  const seen = readyCache.get(host);
  if (!force && seen !== undefined && Date.now() - seen < READY_TTL_MS) return { ready: true };
  readyCache.delete(host);
  const mine = ++probes;
  probing.set(host, mine);
  const verdict = await probeChatHost(host);
  const newest = probing.get(host) === mine;
  if (newest) probing.delete(host);
  if (!verdict.ready) {
    readyCache.delete(host);
    if (newest) hintCache.set(host, { at: Date.now(), value: verdict });
  } else if (newest) {
    readyCache.set(host, Date.now());
    hintCache.delete(host);
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

/** A status that says the server is having a moment, not what the address is. */
const passing = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;

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
  if (passing(status)) return { ok: false, error: `destination_check_failed — ${base} answered ${status}: try again in a moment` };
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

/** The known chats whose hosts the card's hint probes too (lib/av-link AV_KNOWN_CHATS). */
let knownChats: readonly AvKnownChat[] = AV_KNOWN_CHATS;

/**
 * The card's hint: which of our sites have a chat host, and whether traffic may be bought for it.
 * The API lists no chats and a subdomain cannot be enumerated, so the conventional `chat.<site>` is
 * probed, plus the host of every KNOWN chat of the site (lib/av-link avChatProbeHosts — owner 30.09:
 * lp1.thecadrion.com); a chat on any other subdomain still resolves when its URL is pasted. A host
 * that is no chat host is left out; a host that could not be CHECKED is listed as such, never
 * dropped (that would read as "there is none"). What DNS said is remembered for a minute, here only:
 * the catalog is read on every card load and a DNS that does not answer costs its whole timeouts,
 * while a launch always asks DNS itself — and what a launch proved (the host IS a chat host) wins
 * over it. One reading per host runs at a time: a read that comes while one runs (the card's Retry
 * included) joins it. `force` re-reads past every cache (the card's Retry).
 */
export async function avChatHosts(sites: string[], force = false): Promise<AvChatHostOption[]> {
  const probed = await Promise.all(
    avChatProbeHosts(sites.map(normHost).filter(Boolean), knownChats).map(({ host, site }) => {
      let flight = hintFlights.get(host);
      if (!flight) {
        flight = chatHostForCard(site, host, force).finally(() => hintFlights.delete(host));
        hintFlights.set(host, flight);
      }
      return flight;
    }),
  );
  return probed.filter((h): h is AvChatHostOption => h !== null);
}

/** Is the host a chat host by what this instance proved (a fresh YES)? */
const provenChatHost = (host: string): boolean => {
  const c = hostCache.get(host);
  return Boolean(c && Date.now() - c.at < HOST_TTL_MS);
};

async function chatHostForCard(site: string, host: string, force: boolean): Promise<AvChatHostOption | null> {
  const remembered = dnsHintCache.get(host);
  if (!force && remembered && Date.now() - remembered.at < HINT_TTL_MS && !provenChatHost(host)) return remembered.value;
  let verdict = await avChatHost(host, force);
  // A launch may have proven the host while this question was failing: what it proved stands.
  if (!verdict.chat && verdict.failed && provenChatHost(host)) verdict = (hostCache.get(host) as Cached<{ chat: true; gateway: string }>).value;
  if (!verdict.chat) {
    const row = verdict.failed ? { host, site, live: false, liveReason: `destination_check_failed — ${verdict.reason}` } : null;
    dnsHintCache.set(host, { at: Date.now(), value: row });
    return row;
  }
  dnsHintCache.delete(host);
  const ready = await chatHostHint(host, force);
  return { host, site, live: ready.ready, ...(ready.ready ? {} : { liveReason: ready.error }) };
}

/** Test seam: the known chats the hint probes (the shipped registry otherwise). */
export function _setAvKnownChats(list: readonly AvKnownChat[]): void {
  knownChats = list;
}

/** Test seam: drop every per-instance cache. */
export function _resetAvChatCaches(): void {
  hostCache.clear();
  readyCache.clear();
  hintCache.clear();
  dnsHintCache.clear();
  hintFlights.clear();
  seenChatHosts.clear();
  toldLoaders.clear();
  pageOkCache.clear();
  probing.clear();
}
