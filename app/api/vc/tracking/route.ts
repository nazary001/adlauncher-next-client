import { NextResponse } from "next/server";
import { fbGet } from "@/lib/fb-graph";
import { vcRailEnabled } from "@/lib/vc-launch";
import { VC_EVENT, VC_PIXEL, VC_PORTAL_URL } from "@/lib/vc-link";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

type Quality = { events: { event: string; emq: number | null }[]; checkedAt: number } | { error: string; checkedAt: number };

// One dataset-quality read per instance per 10 minutes — the card only needs "is VC firing at all".
const QUALITY_TTL_MS = 10 * 60_000;
let qualityCache: { at: number; value: Quality } | null = null;

async function pixelQuality(token: string): Promise<Quality> {
  const now = Date.now();
  if (qualityCache && now - qualityCache.at < QUALITY_TTL_MS) return qualityCache.value;
  let value: Quality;
  try {
    // The Conversions API token carries exactly read_ads_dataset_quality on VC_PIXEL — enough for
    // Meta's dataset-quality API: which events arrive and their match quality.
    const body = await fbGet(
      `dataset_quality?dataset_id=${VC_PIXEL.id}&fields=${encodeURIComponent("web{event_name,event_match_quality{composite_score}}")}`,
      token,
    );
    const rows = (body.web as Array<{ event_name?: string; event_match_quality?: { composite_score?: number } }> | undefined) ?? [];
    value = {
      events: rows
        .filter((r) => typeof r.event_name === "string")
        .map((r) => ({ event: String(r.event_name), emq: typeof r.event_match_quality?.composite_score === "number" ? r.event_match_quality.composite_score : null })),
      checkedAt: now,
    };
  } catch (e) {
    value = { error: (e as Error).message ?? String(e), checkedAt: now };
  }
  qualityCache = { at: now, value };
  return value;
}

/**
 * GET /api/vc/tracking
 *
 * What a VC landingpage's Tracking must say so VC's Purchase lands on the pixel the launch optimizes
 * for: Pixel-ID = VC_PIXEL, Token = the Conversions API token of that pixel (server env
 * VC_CAPI_TOKEN — handed only to a signed-in buyer, who pastes it into VC exactly like before), and
 * Conversion-Event = Purchase. Plus a live read of which events the pixel has received (Meta's
 * dataset-quality API on the same token) so the card can say "no events yet". Gated by the proxy +
 * the team.
 */
export async function GET(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!vcRailEnabled()) {
    return NextResponse.json({ ok: false, error: "vc_rail_disabled" }, { status: 404 });
  }
  const token = (process.env.VC_CAPI_TOKEN ?? "").trim();
  return NextResponse.json(
    {
      ok: true,
      pixel: VC_PIXEL,
      event: VC_EVENT,
      portal: VC_PORTAL_URL,
      token: token || null,
      quality: token ? await pixelQuality(token) : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
