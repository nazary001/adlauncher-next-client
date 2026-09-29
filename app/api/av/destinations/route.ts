import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { avRailEnabled } from "@/lib/av-launch";
import { AvApiError, avApiConfigured } from "@/lib/av-api";
import { avDestinationCatalog } from "@/lib/av-destination";

export const runtime = "nodejs";
// A cold catalog = /me + the sites' sitemaps + bounded <title> fills + the redirect list; warm
// calls answer from the per-instance caches (short TTLs, lib/av-destination).
export const maxDuration = 60;

/**
 * GET /api/av/destinations[?fresh=1]
 *
 * Everything the card's Destination picker shows: the AV sites (GET /me), each site's articles
 * (from its live sitemap, with real <title>s where fetched), and the redirect domains with their
 * paths + weights and liveness. Degrades per part — the card still gets the articles when the
 * redirect list fails, and vice versa (each with its own `articlesError` / `redirectsError`). Only
 * a total failure to reach ActiveView (sites won't load) is an error status.
 *
 * `?fresh=1` forces a re-fetch past the caches (the "Retry" affordance on the card).
 *
 * The chat hosts' probe gets 2.5 s; one still running then is listed as `pending` and kept alive
 * past the answer (after()), so its verdict is in the instance's memory for the card's next read.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!avRailEnabled()) {
    return NextResponse.json({ ok: false, error: "av_rail_disabled" }, { status: 404 });
  }
  if (!avApiConfigured()) {
    return NextResponse.json(
      { ok: false, error: "av_not_configured — AV_API_KEY is not set on the server" },
      { status: 500 },
    );
  }
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  try {
    const catalog = await avDestinationCatalog({ force: fresh, onPending: (probe) => after(probe) });
    return NextResponse.json({ ok: true, ...catalog });
  } catch (e) {
    // Sites (GET /me) failed to load — the whole catalog is unavailable. Surface ActiveView's own
    // mapped status (401 → 502 with the message is fine: the key is a server config problem).
    const err = e as AvApiError;
    const status = err instanceof AvApiError ? (err.status >= 500 ? err.status : 502) : 502;
    return NextResponse.json({ ok: false, error: err.message ?? String(e) }, { status });
  }
}
