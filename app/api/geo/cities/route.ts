import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { TEAM } from "@/lib/team";
import { cityQuery } from "@/lib/city-targeting";
import { searchCities } from "@/lib/city-search-core";
import { cityDeps } from "@/lib/city-search";

export const runtime = "nodejs";
export const maxDuration = 30;

const noStore = { headers: { "cache-control": "no-store" } };

/**
 * GET /api/geo/cities?q=<2–60 chars>&cc=BR,MX
 *
 * The card's Cities picker (owner ask 18.11: launches on a specific city through TOOL). Meta city
 * keys from Graph `search?type=adgeolocation` (lib/city-search: the first live signer of a fixed
 * chain, 24 h cache, debounced client) — scoped to the card's countries (≤ 5 ISO-2, WW ignored).
 * Any signed-in buyer. Response: { ok, cities: {key, name, region, country}[] } | { ok:false, error }.
 */
export async function GET(req: Request) {
  if (!TEAM.cityTargeting) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, ...noStore });
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, ...noStore });

  const params = new URL(req.url).searchParams;
  const q = cityQuery(params.get("q"));
  if (!q) return NextResponse.json({ ok: false, error: "query_too_short — type at least 2 letters" }, { status: 400, ...noStore });
  const cc = [...new Set(String(params.get("cc") ?? "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => /^[A-Z]{2}$/.test(s) && s !== "WW"))];
  if (cc.length > 5) return NextResponse.json({ ok: false, error: "too_many_countries — city search takes up to 5 countries" }, { status: 400, ...noStore });

  const r = await searchCities(q, cc, cityDeps);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502, ...noStore });
  return NextResponse.json({ ok: true, cities: r.cities }, noStore);
}
