import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionTokenConfigured } from "@/lib/lion";
import { lionSnapReportDays } from "@/lib/lion-snap";
import { snapRailEnabled } from "@/lib/snap-api";
import { snapKeyPool } from "@/lib/snap-launch";
import { eachDay } from "@/lib/date-range";
import { EMPTY_SNAP_METRICS, isSnapReportPartial, mergeSnapReports, snapDayOf, snapReportRange, snapRevenueBefore } from "@/lib/snap-report";
import { listSnapKeys, type SnapKeyRow } from "@/lib/snap-keys";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * GET ?date= | ?from=&to= → LION's per-key revenue for that São Paulo day — or for every day of the
 * range, summed — joined with the key registry: one row per pool key (500), bound or not. `partial`
 * flags a range that reaches today (still accumulating + forecast). `daily` is the same money per
 * day; a day LION did not answer for is named in `missingDays` and left out of the sums (only a
 * range with NO day read is an error). The registry is best-effort here (a Strapi blip must not
 * hide the revenue): bindings come back null with `registryError` set. A key claimed INSIDE the
 * range carries `revenueBeforeClaim` when it earned before that day (an earlier holder's campaign).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  // The report needs only the bearer — lionConfigured() would also demand LION_ACR (the FB rail's account).
  if (!lionTokenConfigured()) return bad("lion_not_configured", 500);
  const sp = new URL(req.url).searchParams;
  const range = snapReportRange({ date: sp.get("date"), from: sp.get("from"), to: sp.get("to") });
  if ("error" in range) return bad(range.error);

  // Side by side: the registry's patience (Strapi pages) must not stack on top of a slow range of
  // LION days — together they would outlive maxDuration.
  const [days, registry] = await Promise.all([
    lionSnapReportDays(eachDay(range)),
    listSnapKeys().then(
      (list) => ({ list, error: undefined }),
      (e: unknown) => ({ list: [] as SnapKeyRow[], error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const report = mergeSnapReports(days);
  if (report.missing.length === report.daily.length) return bad(`lion_unavailable: ${report.missing[0]?.error ?? "no answer"}`, 502);
  const bindings = new Map(registry.list.map((r) => [r.key, r]));
  const registryError = registry.error;
  const rows = snapKeyPool().map((key) => {
    const binding = bindings.get(key) ?? null;
    const before = binding?.claimed_at && range.from !== range.to ? snapRevenueBefore(days, key, snapDayOf(binding.claimed_at)) : 0;
    return { key, metrics: report.byKey[key] ?? EMPTY_SNAP_METRICS, binding, ...(before > 0 ? { revenueBeforeClaim: before } : {}) };
  });
  return NextResponse.json({
    ok: true,
    // `date` is the single-day answer's old name — kept for every reader that asks for one day.
    ...(range.from === range.to ? { date: range.from } : {}),
    from: range.from,
    to: range.to,
    partial: isSnapReportPartial(range.to),
    affiliate: report.affiliate,
    totals: report.totals,
    rows,
    daily: report.daily,
    ...(report.missing.length ? { missingDays: report.missing } : {}),
    ...(registryError ? { registryError } : {}),
  });
}
