// City targeting through TOOL (owner ask 18.11: «добавим функцию запусков на конкретный город»).
//
// TOOL (tool.gctracking.xyz, openapi v1.0) has no city field: TargetingSpec.countries is ISO-2 only and
// required (minItems 1). Cities ride `targeting.raw` — "raw Marketing-API targeting fields over the
// normalized ones", status INFERRED (options.allow_inferred). Live dry_run 18.11 on a GC-HS cabinet:
// `raw.geo_locations` REPLACES the normalized geo_locations whole — countries:["BR"] + raw cities left
// only the cities in the plan; raw {countries:["MX"], cities:[…]} kept both; locales survived; no
// problems. So the stub country in `countries` never reaches Meta when cities ride.
//
// Rules (Meta refuses overlapping locations, so a country is EITHER whole OR its cities):
//   • every picked city sits in one of the card's countries — that country is then targeted by its
//     cities only; the card's other countries stay whole;
//   • WW never mixes with cities;
//   • one radius for every city of the card: 17–80 km (Meta's city range), or 0 = the city alone.
// City keys come from Graph search type=adgeolocation (app/api/geo/cities) — Meta's stable ids.
//
// Pure leaf (types only) — imported by the card, the search route and the TOOL builder alike.

import type { CityPick } from "./types.ts";

export type { CityPick };

/** The radius pick (km as digits). "0" = the city's own area, no radius. Meta: 17–80 km for cities. */
export const CITY_RADII: readonly { value: string; label: string }[] = [
  { value: "0", label: "City only" },
  { value: "17", label: "+17 km" },
  { value: "25", label: "+25 km" },
  { value: "40", label: "+40 km" },
  { value: "50", label: "+50 km" },
  { value: "65", label: "+65 km" },
  { value: "80", label: "+80 km" },
];
export const DEFAULT_CITY_RADIUS = "40";
/** Picker cap per card (Meta allows 250 cities per ad set; a launch card never needs that many). */
export const MAX_CITIES = 50;

const CITY_KEY = /^\d{1,15}$/;
const ISO2 = /^[A-Z]{2}$/;

/** The refusal every non-TOOL launch rail (LION, FB Token) gives a card carrying cities — it would
 *  otherwise go out on the whole countries, wider than the buyer asked. */
export const CITIES_NEED_TOOL = "cities_need_tool — city targeting launches only through TOOL; switch the rail to TOOL or remove the cities";

/** Does a (client-sent) card carry any city? Garbled = yes (the TOOL builder refuses it by name). */
export function hasCities(c: { cities?: unknown } | null | undefined): boolean {
  const v = c?.cities;
  return v != null && !(Array.isArray(v) && v.length === 0);
}

/** The card's radius → km (0 = city only). A missing pick reads as the default; a garbled one → null. */
export function cityRadiusKm(raw: unknown): number | null {
  const s = raw == null || raw === "" ? DEFAULT_CITY_RADIUS : String(raw).trim();
  return CITY_RADII.some((r) => r.value === s) ? Number(s) : null;
}

/** A card's cities, cleaned: well-formed rows only, one per key, capped. `null` = the field is
 *  present but garbled (not an array / a row without a numeric key or an ISO-2 country) — the server
 *  refuses such a card by name rather than silently dropping a city (wider targeting than asked). */
export function cleanCities(raw: unknown): CityPick[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: CityPick[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const key = String(o.key ?? "").trim();
    const country = String(o.country ?? "").trim().toUpperCase();
    if (!CITY_KEY.test(key) || !ISO2.test(country)) return null;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      country,
      name: String(o.name ?? "").trim().slice(0, 120) || key,
      region: String(o.region ?? "").trim().slice(0, 120),
    });
  }
  return out.length > MAX_CITIES ? null : out;
}

/** The city's short name for chips / summaries: Graph names read "Campinas, Sao Paulo" — the part
 *  before the first comma. */
export function cityShortName(c: Pick<CityPick, "name" | "key">): string {
  return (c.name.split(",")[0] ?? "").trim() || c.key;
}

/** Cities whose country the card no longer targets (the buyer removed it, or picked WW) — the card
 *  drops them the moment the country goes, so a city never outlives its country. */
export function orphanCities(cities: readonly CityPick[] | undefined, countries: readonly string[]): CityPick[] {
  if (!cities?.length) return [];
  if (countries.includes("WW")) return [...cities];
  return cities.filter((c) => !countries.includes(c.country));
}

/** Drawer / task-row geo label: "São Paulo +40 km, Campinas · BR" (+ the whole countries).
 *  `base` = the countries-only label (catalog.geoSummary) used when no city rides. */
export function cityGeoLabel(countries: readonly string[], cities: readonly CityPick[] | undefined, radius: unknown, base: string): string {
  if (!cities?.length) return base;
  const km = cityRadiusKm(radius);
  const names = cities.map(cityShortName);
  const shown = names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  const withCity = new Set(cities.map((c) => c.country));
  const whole = countries.filter((c) => c !== "WW" && !withCity.has(c));
  return `${shown}${km ? ` +${km} km` : ""}${whole.length ? ` · ${whole.join(", ")}` : ""}`;
}

export type CityGeo =
  | { ok: true; countries: string[]; geoLocations: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * The TOOL targeting geo for a card that picked cities: `countries` is TargetingSpec's required ISO-2
 * list (the card's whole countries, or — when every country is narrowed to its cities — the first
 * city's country as the stub TOOL needs; raw replaces it, see the header), `geoLocations` rides in
 * targeting.raw. Refuses (never sent) on WW, a city outside the card's countries, or a bad radius.
 */
export function cityGeoLocations(countries: readonly string[], cities: readonly CityPick[], radiusKm: number | null): CityGeo {
  if (!cities.length) return { ok: false, error: "cities_empty" };
  if (countries.includes("WW")) return { ok: false, error: "cities_with_worldwide — a city launch names its countries; World cannot mix with cities" };
  if (radiusKm == null) return { ok: false, error: "city_radius_invalid — pick City only or +17…+80 km" };
  const outside = cities.find((c) => !countries.includes(c.country));
  if (outside) {
    return { ok: false, error: `city_outside_geo: ${cityShortName(outside)} (${outside.country}) — add ${outside.country} to Geo or remove the city` };
  }
  const withCity = new Set(cities.map((c) => c.country));
  const whole = countries.filter((c) => !withCity.has(c));
  const geoLocations: Record<string, unknown> = {
    cities: cities.map((c) => (radiusKm > 0 ? { key: c.key, radius: radiusKm, distance_unit: "kilometer" } : { key: c.key })),
    location_types: ["home", "recent"],
  };
  if (whole.length) geoLocations.countries = whole;
  return { ok: true, countries: whole.length ? whole : [cities[0].country], geoLocations };
}

// ---- Graph search (type=adgeolocation) ---------------------------------------------------------

/** A search query worth sending: 2–60 chars after trimming. */
export function cityQuery(raw: unknown): string | null {
  const q = String(raw ?? "").replace(/\s+/g, " ").trim();
  return q.length >= 2 && q.length <= 60 ? q : null;
}

/** The Graph path of one city search (relative to the Graph base). English names (locale=en_US) — the
 *  signer's own UI language would otherwise name the country in Ukrainian (seen 18.11). */
export function citySearchPath(q: string, country: string | null, limit = 20): string {
  const cc = country && ISO2.test(country) ? `&country_code=${country}` : "";
  return `search?type=adgeolocation&location_types=${encodeURIComponent('["city"]')}&locale=en_US&limit=${limit}${cc}&q=${encodeURIComponent(q)}`;
}

/** Graph's search answer → city picks (city rows with a numeric key and an ISO-2 country only). */
export function parseGraphCities(body: unknown): CityPick[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: CityPick[] = [];
  const seen = new Set<string>();
  for (const d of data) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (o.type !== "city" || o.supports_city === false) continue;
    const key = String(o.key ?? "");
    const country = String(o.country_code ?? "").toUpperCase();
    if (!CITY_KEY.test(key) || !ISO2.test(country) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, country, name: String(o.name ?? "").trim() || key, region: String(o.region ?? "").trim() });
  }
  return out;
}
