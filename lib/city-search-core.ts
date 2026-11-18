// PURE core of the Meta city search (owner ask 18.11, city launches through TOOL) — the signer chain
// walk + the 24 h cache, driven through injected deps so `node --test` runs it with a fake Graph.
// The real deps (vault signers, fetch, Graph base) live in lib/city-search.ts.
//
// Few requests by design (owner rule 11.11 — «не делаем много запросов по токенам»): one Graph GET
// per (country, query), cached; a signer Meta refuses (auth / app blocked) is benched 30 min, a
// rate-limited one 5 min — never retried in a loop.

import { type CityPick, citySearchPath, parseGraphCities } from "./city-targeting.ts";

const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 2_000;
const DEAD_MS = 30 * 60_000;
const THROTTLED_MS = 5 * 60_000;
/** Graph codes that mean "this signer cannot search now": rate limits (bench briefly) vs auth / app
 *  blocked / permission (bench longer). Anything else is the query's own problem → no other signer. */
const RATE_CODES = new Set([4, 17, 32, 613, 80004]);
const DEAD_CODES = new Set([10, 102, 190, 200, 368]);

export type CitySigner = { fp: string; token: string };
export type CitySearchDeps = {
  /** The live signers in failover order (deduped by fingerprint). */
  signers: () => Promise<CitySigner[]>;
  /** One GET; throws only on network failure / timeout. */
  fetchJson: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
  /** Graph base, e.g. https://graph.facebook.com/v21.0 (no trailing slash). */
  base: () => string;
  now: () => number;
};
export type CitySearchResult = { ok: true; cities: CityPick[] } | { ok: false; error: string };

const cache = new Map<string, { at: number; cities: CityPick[] }>();
const benched = new Map<string, number>(); // signer fp → skip until

export function _resetCitySearch(): void {
  cache.clear();
  benched.clear();
}

/** One (country, query) search through the signer chain. `country` null = no country scope. */
async function searchOne(q: string, country: string | null, deps: CitySearchDeps): Promise<CitySearchResult> {
  const ck = `${country ?? "*"}|${q.toLowerCase()}`;
  const now = deps.now();
  const hit = cache.get(ck);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ok: true, cities: hit.cities };

  const signers = (await deps.signers()).filter((s) => (benched.get(s.fp) ?? 0) <= now);
  if (!signers.length) return { ok: false, error: "no_signer — no live FB token can run the city search right now" };
  const url = `${deps.base()}/${citySearchPath(q, country)}`;
  let last = "city search failed";
  for (const s of signers) {
    let r: { status: number; body: unknown };
    try {
      r = await deps.fetchJson(url, s.token);
    } catch (e) {
      last = (e as Error)?.name === "TimeoutError" ? "Graph timeout" : "Graph unreachable";
      continue; // network blip: try the next signer, bench nobody
    }
    const err = (r.body as { error?: { code?: number; message?: string } } | null)?.error;
    if (!err && r.status < 400) {
      const cities = parseGraphCities(r.body);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(ck, { at: now, cities });
      return { ok: true, cities };
    }
    const code = Number(err?.code);
    last = `(#${Number.isFinite(code) ? code : r.status}) ${err?.message ?? `HTTP ${r.status}`}`;
    if (RATE_CODES.has(code)) benched.set(s.fp, now + THROTTLED_MS);
    else if (DEAD_CODES.has(code) || r.status === 401 || r.status === 403) benched.set(s.fp, now + DEAD_MS);
    else return { ok: false, error: last }; // the query itself was refused — another signer won't help
  }
  return { ok: false, error: last };
}

/**
 * Cities matching `q` inside `countries` (ISO-2, ≤ 5; empty = anywhere). One search per country, in
 * order, merged; a city outside the asked countries is dropped (Graph's country scope re-checked).
 * Fails only when NO country could be searched.
 */
export async function searchCities(q: string, countries: readonly string[], deps: CitySearchDeps): Promise<CitySearchResult> {
  const scopes: (string | null)[] = countries.length ? [...countries] : [null];
  const out: CityPick[] = [];
  const seen = new Set<string>();
  let failure: string | null = null;
  let anyOk = false;
  for (const cc of scopes) {
    const r = await searchOne(q, cc, deps);
    if (!r.ok) {
      failure = r.error;
      continue;
    }
    anyOk = true;
    for (const c of r.cities) {
      if (seen.has(c.key) || (countries.length && !countries.includes(c.country))) continue;
      seen.add(c.key);
      out.push(c);
    }
  }
  return anyOk ? { ok: true, cities: out } : { ok: false, error: failure ?? "city search failed" };
}
