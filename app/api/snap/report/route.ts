import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured } from "@/lib/lion";
import { lionSnapReport } from "@/lib/lion-snap";
import { snapRailEnabled } from "@/lib/snap-api";
import { snapKeyPool } from "@/lib/snap-launch";
import { EMPTY_SNAP_METRICS, isSnapReportPartial, snapReportDate } from "@/lib/snap-report";
import { listSnapKeys, type SnapKeyRow } from "@/lib/snap-keys";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * GET ?date= → LION's per-key revenue for that São Paulo day joined with the key registry: one
 * row per pool key (100), bound or not. `partial` flags today (still accumulating + forecast).
 * The registry is best-effort here (a Strapi blip must not hide the revenue): bindings come back
 * null with `registryError` set.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!lionConfigured()) return bad("lion_not_configured", 500);
  const date = snapReportDate(new URL(req.url).searchParams.get("date"));
  if (!date) return bad("bad_date (today | yesterday | YYYY-MM-DD, not in the future)");

  let report;
  try {
    report = await lionSnapReport(date);
  } catch (e) {
    return bad(`lion_unavailable: ${(e as Error).message}`, 502);
  }
  let bindings = new Map<string, SnapKeyRow>();
  let registryError: string | undefined;
  try {
    bindings = new Map((await listSnapKeys()).map((r) => [r.key, r]));
  } catch (e) {
    registryError = (e as Error).message;
  }
  const rows = snapKeyPool().map((key) => ({ key, metrics: report.byKey[key] ?? EMPTY_SNAP_METRICS, binding: bindings.get(key) ?? null }));
  return NextResponse.json({
    ok: true,
    date,
    partial: isSnapReportPartial(date),
    affiliate: report.affiliate,
    totals: report.totals,
    rows,
    ...(registryError ? { registryError } : {}),
  });
}
