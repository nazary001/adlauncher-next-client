// Per-clone GEO/LOCALES override shared by the duplicate rails (pure — safe for client AND
// server). The MO clone board rebuilds its targeting from scratch (lib/clone-run), so this is
// an HS-duplicate concern: the FB Token rail patches the source ad set's targeting BEFORE
// creating the clone's, and the LION rail patches the born clone's ad set THROUGH the Graph —
// LION's public duplicate/ silently IGNORES targeting fields (probed live 08-20: country_codes
// accepted with HTTP 200, clone still targeted the source's geo; its `name` field is equally
// ignored, hence the Graph rename that rides with the patch).

type Json = Record<string, unknown>;

export type GeoOverride = {
  /** ["WW"] = worldwide (exclusive), else plain ISO-3166 codes. Empty = keep the source's geo. */
  countries: string[];
  /** FB locale ids. Empty = keep the source's locales. */
  localeIds: number[];
};

/** Wire → override. null = no override sent; {error} = reject the wave before any work. */
export function parseGeoOverride(
  rawCountries: unknown,
  rawLocales: unknown,
): GeoOverride | null | { error: string } {
  const countries = Array.isArray(rawCountries)
    ? rawCountries.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
    : [];
  const localeIds = Array.isArray(rawLocales)
    ? rawLocales.map((l) => parseInt(String(l), 10)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (countries.length === 0 && localeIds.length === 0) return null;
  if (countries.length > 60) return { error: "too_many_countries" };
  if (localeIds.length > 30) return { error: "too_many_locales" };
  for (const c of countries) {
    if (c !== "WW" && !/^[A-Z]{2}$/.test(c)) return { error: `country_code_invalid_${c}` };
  }
  if (countries.includes("WW") && countries.length > 1) return { error: "ww_is_exclusive" };
  return { countries, localeIds };
}

/**
 * A COPY of `targeting` with the override applied. Geo mirrors the launcher's targeting()
 * builder: WW → the worldwide country group MINUS Taiwan+Singapore (owner rule 2026-08-11 —
 * without a verified advertiser Meta never delivers there, it just demands declarations);
 * explicit lists replace the countries verbatim and drop a stale exclusion. Locales replace
 * only when the override carries some.
 */
export function applyGeoOverride(targeting: Json, o: GeoOverride): Json {
  const t = JSON.parse(JSON.stringify(targeting ?? {})) as Json;
  if (o.countries.length) {
    const ww = o.countries.includes("WW");
    t.geo_locations = ww
      ? { location_types: ["home", "recent"], country_groups: ["worldwide"] }
      : { location_types: ["home", "recent"], countries: o.countries };
    if (ww) t.excluded_geo_locations = { countries: ["TW", "SG"] };
    else delete t.excluded_geo_locations;
  }
  if (o.localeIds.length) t.locales = o.localeIds;
  return t;
}

/** Self-declared "universal ads" categories a WW override needs on the ad set (the launcher's
 *  create path sends the same pair; further regions self-heal in createAdsetSelfHealing). */
export function geoOverrideRegionalCategories(o: GeoOverride): string[] {
  return o.countries.includes("WW") ? ["TAIWAN_UNIVERSAL", "SINGAPORE_UNIVERSAL"] : [];
}

/** Swap the `[CODES]` group of a LION-grammar name for the override's geo — the first bracket
 *  group after a `) - ` (the redirect label's close), which is exactly the COUNTRY slot:
 *  `[20/08] (GLO-01) API (CLONE) - (#ADX [HIGH]) - [MX] - …` → `… - [CA] - …`. Names their
 *  ecosystem parses geo from must never disagree with the patched targeting. */
export function relabelNameGeo(name: string, countries: string[]): string {
  if (!countries.length) return name;
  // ", " separator — byte-identical to hsNamePrefix's [CODES] grammar (lib/hs-launch), so the
  // partner's geo parser sees the same shape on relabeled clones as on launched campaigns.
  const label = countries.includes("WW") ? "WORLD" : countries.join(", ");
  return name.replace(/(\)\s*-\s*)\[[^\]]*\]/, `$1[${label}]`);
}
