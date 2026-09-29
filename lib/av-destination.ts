// AV rail — WHERE an ad may point (server-only). Three destination kinds, one stored shape (a bare
// URL in Campaign.landing, lib/av-link avDestinationBase):
//   article  — a page of an AV site (the sites the API key reaches: GET /me). Picked from the site's
//              live sitemap (AV's CMS publishes every article there; an unknown path answers 404) or
//              pasted; a launch re-checks it answers 200.
//   redirect — a path of an AV Redirect domain (redirect.<site>/<path>, GET /v1/redirects): AV picks
//              the target by the path's weights and merges our tracking params into it. Launchable
//              only while the domain is LIVE (resolves + answers) — 28.09 its CNAME target did not
//              resolve, the activation wizard was unfinished.
//   chat     — a chat of AV's Chat Builder on a chat subdomain of the site (chat.<site>/<id>). The
//              API lists none, so the URL is pasted; the host is recognized by its CNAME and the chat
//              must answer 200 there (lib/av-chat).
// Every read is cached per instance (short TTLs) and degrades per part: the card still gets the
// articles when the redirect list fails, and vice versa, each with its reason.

import { lookup } from "node:dns/promises";
import { type AvMapping, type AvSite, AvApiError, avMe, avRedirectMappings, avRedirects } from "./av-api";
import { type AvChatHostOption, _resetAvChatCaches, avChatHosts, resolveAvChat } from "./av-chat";
import { avArticleTitle, avChatUrl, avDestinationBase } from "./av-link";

const UA = "Mozilla/5.0 (compatible; adlauncher-av/1.0)";
const SITES_TTL_MS = 10 * 60_000;
const SITEMAP_TTL_MS = 10 * 60_000;
const TITLE_TTL_MS = 6 * 60 * 60_000;
const REDIRECTS_TTL_MS = 60_000;
const LIVE_TTL_MS = 5 * 60_000;
const PAGE_OK_TTL_MS = 10 * 60_000;
const SITEMAP_FILES_MAX = 10;
const ARTICLES_MAX = 2000;
const TITLE_BUDGET_MS = 8_000;
const TITLE_CONCURRENCY = 8;

type Cached<T> = { at: number; value: T };
const sitesCache: { v?: Cached<AvSite[]> } = {};
const sitemapCache = new Map<string, Cached<string[]>>();
const titleCache = new Map<string, Cached<string>>();
const redirectsCache: { v?: Cached<AvRedirectOption[]> } = {};
const liveCache = new Map<string, Cached<{ live: boolean; reason?: string }>>();
const pageOkCache = new Map<string, number>();

export type AvArticle = { url: string; site: string; path: string; title: string; variant: string };
export type AvRedirectPathOption = { id: string; path: string; url: string; mappings: AvMapping[]; mappingsError?: string };
export type AvRedirectOption = {
  domainId: string;
  domain: string;
  /** The AV site this redirect domain belongs to (redirect.thecadrion.com → thecadrion.com). */
  site: string;
  live: boolean;
  liveReason?: string;
  paths: AvRedirectPathOption[];
};
export type { AvChatHostOption } from "./av-chat";
export type AvDestinationCatalog = {
  sites: AvSite[];
  articles: AvArticle[];
  articlesError?: string;
  redirects: AvRedirectOption[];
  redirectsError?: string;
  /** The sites' chat hosts (chat.<site> behind AV's chat gateway) with their liveness — the chats
   *  themselves are not listed anywhere, a chat URL is pasted. */
  chats: AvChatHostOption[];
};

const fresh = <T>(c: Cached<T> | undefined, ttl: number): c is Cached<T> => Boolean(c) && Date.now() - (c as Cached<T>).at < ttl;
const errText = (e: unknown): string => (e instanceof AvApiError ? e.message : (e as Error)?.message ?? String(e));

/** The AV sites the API key reaches (GET /me, cached 10 min). Throws AvApiError when AV refuses. */
export async function avSites(force = false): Promise<AvSite[]> {
  if (!force && fresh(sitesCache.v, SITES_TTL_MS)) return sitesCache.v.value;
  const me = await avMe();
  sitesCache.v = { at: Date.now(), value: me.sites };
  return me.sites;
}

/**
 * Where a host stands among our sites: `exact` = the listed site it IS (or its www), `parents` = the
 * listed sites it is a subdomain of, the ROOT-most first. Nothing here depends on the order of
 * GET /me. A host may have both: ActiveView may list a site's chat subdomain as a site of its own.
 */
function placeOfHost(host: string, sites: AvSite[]): { exact: AvSite | null; parents: AvSite[] } {
  const h = host.toLowerCase();
  const exact = sites.find((s) => h === s.domain || h === `www.${s.domain}`) ?? null;
  const parents = sites.filter((s) => h.endsWith(`.${s.domain}`) && h !== `www.${s.domain}`).sort((a, b) => a.domain.length - b.domain.length);
  return { exact, parents };
}

/** The site a host belongs to: the site it is (or its www), else the NEAREST listed site it is a
 *  subdomain of (redirect.blog.<site> belongs to blog.<site> when that is a site of its own). */
export function siteOfHost(host: string, sites: AvSite[]): AvSite | null {
  const { exact, parents } = placeOfHost(host, sites);
  return exact ?? parents.at(-1) ?? null;
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<{ status: number; text: string; finalUrl: string }> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" }, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  return { status: res.status, text, finalUrl: res.url || url };
}

const locs = (xml: string): string[] => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));

/** Every article URL of a site from its sitemap (index → page sitemaps), cached 10 min. */
async function siteArticleUrls(domain: string, force = false): Promise<string[]> {
  const c = sitemapCache.get(domain);
  if (!force && fresh(c, SITEMAP_TTL_MS)) return c.value;
  const root = await fetchText(`https://${domain}/sitemap.xml`);
  if (root.status !== 200) throw new Error(`sitemap of ${domain} answered ${root.status}`);
  let urls: string[] = [];
  if (/<sitemapindex/i.test(root.text)) {
    const files = locs(root.text).slice(0, SITEMAP_FILES_MAX);
    for (const f of files) {
      // Server fetches are restricted to THIS AV site (the host allowlist from /me). A sitemap index
      // is served by AV's CMS, so a <loc> could name any host (an internal address, a metadata
      // endpoint) — skip a sub-sitemap whose host is not the site, mirroring the allowlist already
      // applied to the article URLs below, so a foreign entry can't turn into a blind server-side
      // request (review find 09-28 — the fetch of `f` itself was previously unguarded).
      let fhost = "";
      try {
        fhost = new URL(f).hostname.toLowerCase();
      } catch {
        continue; // an unparseable <loc> is never fetched
      }
      if (fhost !== domain && fhost !== `www.${domain}`) continue;
      const part = await fetchText(f);
      if (part.status === 200) urls.push(...locs(part.text));
    }
  } else {
    urls = locs(root.text);
  }
  // An article has a path: the one root lib/av-link lets through is a chat's address (…/?asst=<id>),
  // which is never a page of the site.
  const clean = [...new Set(urls)]
    .map((u) => avDestinationBase(u))
    .filter((b): b is Extract<ReturnType<typeof avDestinationBase>, { ok: true }> => b.ok && b.path !== "/" && (b.host === domain || b.host === `www.${domain}`))
    .map((b) => b.base)
    .slice(0, ARTICLES_MAX);
  sitemapCache.set(domain, { at: Date.now(), value: clean });
  return clean;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)));

/** Fill real <title>s for the articles not cached yet — bounded (8 s total, 8 in flight); the rest
 *  keep the slug-derived title until a later read. This is a DISPLAY-time title scrape only: it must
 *  NOT seed pageOkCache. That cache is the launch/clone liveness signal (articleLive short-circuits on
 *  it), and articleLive only writes it AFTER proving the page answers 200 AND does not redirect off
 *  the AV site. A bulk 200 here (redirect:"follow", no finalHost check) would let a since-404'd or
 *  off-site-redirecting article resolve "live" for up to 10 min after a board load — defeating the
 *  per-launch re-check the rail advertises (review find 09-28). */
async function fillTitles(urls: string[]): Promise<void> {
  const todo = urls.filter((u) => !fresh(titleCache.get(u), TITLE_TTL_MS));
  if (todo.length === 0) return;
  const deadline = Date.now() + TITLE_BUDGET_MS;
  let i = 0;
  const worker = async () => {
    while (i < todo.length && Date.now() < deadline) {
      const u = todo[i++];
      try {
        const r = await fetchText(u, Math.max(1_000, Math.min(5_000, deadline - Date.now())));
        const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(r.text);
        if (r.status === 200 && m) titleCache.set(u, { at: Date.now(), value: decodeEntities(m[1]).replace(/\s+/g, " ").trim() });
        // Deliberately does NOT touch pageOkCache — only articleLive (finalHost-validated) may seed
        // the launch-liveness cache (see this function's header note).
      } catch {
        /* keep the derived title */
      }
    }
  };
  await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker));
}

/** Is the redirect domain live? DNS must resolve and HTTPS must answer at all (any status). 5 min. */
export async function avRedirectDomainLive(domain: string, force = false): Promise<{ live: boolean; reason?: string }> {
  // Offline-smoke seam (_e2e/_adl_av_smoke.mts): domains listed here count as live WITHOUT a DNS/HTTPS
  // probe. Ignored on production builds — prod liveness is always probed for real.
  if (process.env.NODE_ENV !== "production") {
    const forced = (process.env.AV_TEST_LIVE_REDIRECT_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (forced.includes(domain.toLowerCase())) return { live: true };
  }
  const c = liveCache.get(domain);
  if (!force && fresh(c, LIVE_TTL_MS)) return c.value;
  let v: { live: boolean; reason?: string };
  try {
    await lookup(domain);
    try {
      await fetch(`https://${domain}/`, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(6_000), headers: { "User-Agent": UA } });
      v = { live: true };
    } catch (e) {
      v = { live: false, reason: `${domain} resolves but does not answer over HTTPS yet (${(e as Error).message ?? e}) — finish the Redirect activation in ActiveView` };
    }
  } catch {
    v = { live: false, reason: `${domain} does not resolve yet — finish the Redirect activation (DNS validation) in ActiveView → Redirect` };
  }
  liveCache.set(domain, { at: Date.now(), value: v });
  return v;
}

/** Redirect domains with their paths + weights and liveness (cached 60 s). Throws on an API failure. */
export async function avRedirectCatalog(sites: AvSite[], force = false): Promise<AvRedirectOption[]> {
  if (!force && fresh(redirectsCache.v, REDIRECTS_TTL_MS)) return redirectsCache.v.value;
  const domains = await avRedirects();
  const out: AvRedirectOption[] = [];
  for (const d of domains) {
    const site = siteOfHost(d.name, sites);
    if (!site) continue; // a redirect domain of a site this key cannot see is not ours to launch on
    const live = await avRedirectDomainLive(d.name, force);
    const paths: AvRedirectPathOption[] = [];
    for (const p of d.paths) {
      const url = `https://${d.name}${p.path}`;
      try {
        paths.push({ id: p.id, path: p.path, url, mappings: await avRedirectMappings(p.id) });
      } catch (e) {
        paths.push({ id: p.id, path: p.path, url, mappings: [], mappingsError: errText(e) });
      }
    }
    out.push({ domainId: d.id, domain: d.name, site: site.domain, live: live.live, ...(live.reason ? { liveReason: live.reason } : {}), paths });
  }
  redirectsCache.v = { at: Date.now(), value: out };
  return out;
}

/** Drop the redirect list cache (after a path was created). */
export function invalidateAvRedirects(): void {
  redirectsCache.v = undefined;
}

/** Everything the card's Destination picker shows. Sites must load (else AvApiError); articles and
 *  redirects degrade independently with their own error text; the chat hosts are a probe that
 *  never throws (a host it could not check is listed with that reason) and runs alongside the
 *  rest — a chat host that does not answer must not hold the articles back. */
export async function avDestinationCatalog(opts: { force?: boolean; titles?: boolean } = {}): Promise<AvDestinationCatalog> {
  const sites = await avSites(opts.force);
  // chat.<site> is probed for the ROOT sites only: a site's own subdomain that AV lists as a site
  // (its chat host, say) has no chat.<subdomain> of its own.
  const roots = sites.filter((s) => !sites.some((o) => s.domain.endsWith(`.${o.domain}`))).map((s) => s.domain);
  const chats = avChatHosts(roots, opts.force).catch((): AvChatHostOption[] => []);
  const articles: AvArticle[] = [];
  const errors: string[] = [];
  for (const s of sites) {
    try {
      const urls = await siteArticleUrls(s.domain, opts.force);
      if (opts.titles !== false) await fillTitles(urls);
      for (const url of urls) {
        const path = new URL(url).pathname;
        const derived = avArticleTitle(path);
        articles.push({ url, site: s.domain, path, title: titleCache.get(url)?.value || derived.title, variant: derived.variant });
      }
    } catch (e) {
      errors.push(`${s.domain}: ${errText(e)}`);
    }
  }
  let redirects: AvRedirectOption[] = [];
  let redirectsError: string | undefined;
  try {
    redirects = await avRedirectCatalog(sites, opts.force);
  } catch (e) {
    redirectsError = errText(e);
  }
  return {
    sites,
    articles,
    ...(errors.length ? { articlesError: `articles unavailable — ${errors.join("; ")}` } : {}),
    redirects,
    ...(redirectsError ? { redirectsError: `redirect paths unavailable — ${redirectsError}` } : {}),
    chats: await chats,
  };
}

/** Does the article answer 200 on its own site (following redirects that stay on the site)? */
async function articleLive(base: string, site: AvSite): Promise<{ ok: true } | { ok: false; error: string }> {
  const seen = pageOkCache.get(base);
  if (seen && Date.now() - seen < PAGE_OK_TTL_MS) return { ok: true };
  try {
    const r = await fetchText(base, 10_000);
    const finalHost = (() => {
      try {
        return new URL(r.finalUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (r.status !== 200) return { ok: false, error: `destination_not_live — ${base} answered ${r.status} (renamed or unpublished in AV's CMS?)` };
    if (finalHost && !siteOfHost(finalHost, [site])) return { ok: false, error: `destination_invalid — ${base} redirects off the AV site (${finalHost})` };
    // A page that redirects to a CHAT (another host, an address that names a chat id) would put a
    // chat behind an article's verdict — past the chat's own gate (does its host show ads?).
    if (finalHost && finalHost !== new URL(base).hostname && avChatUrl(r.finalUrl).ok) {
      return { ok: false, error: `destination_invalid — ${base} redirects to a chat (${r.finalUrl}): launch the chat itself, from the AI chat tab` };
    }
    pageOkCache.set(base, Date.now());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `destination_check_failed — ${base} did not answer (${(e as Error).message ?? e})` };
  }
}

export type AvResolved =
  | { ok: true; kind: "article"; base: string; site: string }
  | { ok: true; kind: "redirect"; base: string; site: string; domainId: string; pathId: string; mappings: AvMapping[] }
  | { ok: true; kind: "chat"; base: string; site: string }
  | { ok: false; error: string; status: number };

/**
 * The server's verdict on a destination (launch + clone): shape → host belongs to an AV site (or one
 * of its redirect domains / its chat subdomain) → article answers 200 / redirect path exists and its
 * domain is live / chat answers 200 on its chat host.
 * `status` = the HTTP status the route should answer (400 = the buyer's fix, 502 = AV unreachable).
 */
export async function resolveAvDestination(raw: string): Promise<AvResolved> {
  const b = avDestinationBase(raw);
  if (!b.ok) return { ok: false, error: b.error, status: 400 };
  let sites: AvSite[];
  try {
    sites = await avSites();
  } catch (e) {
    return { ok: false, error: `destination_check_failed — ${errText(e)}`, status: 502 };
  }
  const { exact, parents } = placeOfHost(b.host, sites);
  const root = parents[0] ?? null;
  const owner = siteOfHost(b.host, sites);
  if (!owner) {
    return { ok: false, error: `destination_not_av — ${b.host} is not an ActiveView site of ours (${sites.map((s) => s.domain).join(", ") || "none"})`, status: 400 };
  }
  let redirects: AvRedirectOption[] = [];
  let redirectsFailed = "";
  try {
    redirects = await avRedirectCatalog(sites);
  } catch (e) {
    redirectsFailed = errText(e);
  }
  const rd = redirects.find((r) => r.domain === b.host);
  if (rd) {
    const live = await avRedirectDomainLive(rd.domain);
    if (!live.live) return { ok: false, error: `redirect_not_live — ${live.reason}`, status: 400 };
    const p = rd.paths.find((x) => x.path === b.path);
    if (!p) return { ok: false, error: `redirect_path_unknown — ${b.path} is not a path of ${rd.domain} (create it on the card first)`, status: 400 };
    return { ok: true, kind: "redirect", base: b.base, site: owner.domain, domainId: rd.domainId, pathId: p.id, mappings: p.mappings };
  }
  if (root) {
    // A subdomain of one of our sites that is no redirect domain we know: a Chat Builder host — its
    // CNAME says so, whatever the redirect list did and whether or not ActiveView ALSO lists the
    // host as a site of its own (a chat host must never reach an ad through the article branch,
    // past the chat's gate). Its verdict stands unless the host is simply not a chat host.
    const chat = await resolveAvChat(b, root.domain);
    if (chat.ok || !chat.error.startsWith("destination_not_av")) return chat;
    if (!exact) {
      // While the redirect list is unavailable the host may still be a redirect domain we could not
      // see — a failed check, not a refusal.
      if (redirectsFailed) return { ok: false, error: `destination_check_failed — redirect paths unavailable (${redirectsFailed})`, status: 502 };
      return chat;
    }
    // The host IS a listed site: its pages are articles — but an address that names a chat id is a
    // chat's, never an article's (a chat host whose CNAME we could not see, e.g. a proxied record).
    if (avChatUrl(b.base).ok) return chat;
  }
  const site = exact as AvSite;
  // On a site itself only a PAGE is a destination — a chat's address (root + ?asst=) belongs to a
  // chat subdomain, and here it is just the home page.
  if (b.path === "/") {
    return { ok: false, error: `destination_invalid — pick an article (or a redirect path), not the home page (a chat lives on the chat subdomain of ${site.domain})`, status: 400 };
  }
  const live = await articleLive(b.base, site);
  if (!live.ok) return { ok: false, error: live.error, status: live.error.startsWith("destination_check_failed") ? 502 : 400 };
  return { ok: true, kind: "article", base: b.base, site: site.domain };
}

/** A redirect path slug the buyer may create: lower-case letters/digits/dashes, 2–60 chars. */
export const AV_PATH_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Test seam: drop every per-instance cache. */
export function _resetAvDestinationCaches(): void {
  sitesCache.v = undefined;
  sitemapCache.clear();
  titleCache.clear();
  redirectsCache.v = undefined;
  liveCache.clear();
  pageOkCache.clear();
  _resetAvChatCaches();
}
