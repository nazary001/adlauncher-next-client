import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { GCM_POOL_MAX, gcmCode } from "@/lib/partners";
import { fetchUsedGcms } from "@/lib/gcm-claim";
import { GCM_MAPS, insertFresh, storeConfigured } from "@/lib/store";

// Server-only: the store is never reached from the browser.
// Buy-link contract since 2026-08-10: gcm=1..200. Codes below 100 keep their canonical 2-digit
// zero-padded form (every live link and registry row uses it); 100–200 are plain 3-digit.
const POOL_MAX = GCM_POOL_MAX;

function nextFree(used: string[]): string | null {
  const set = new Set(used);
  for (let n = 1; n <= POOL_MAX; n++) {
    const c = gcmCode(n);
    if (!set.has(c)) return c;
  }
  return null;
}

/** GET → { used, next, poolMax } — the launcher assigns from this, skipping taken codes. */
export async function GET(req: Request) {
  // Belt-and-suspenders: this route is proxy-gated, but (like /api/launch) it self-checks the
  // session so a matcher regression can't expose the registry or let anyone burn codes.
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!storeConfigured()) {
    return NextResponse.json({ error: "strapi_not_configured" }, { status: 500 });
  }
  try {
    const used = (await fetchUsedGcms()).sort();
    return NextResponse.json({ used, next: nextFree(used), poolMax: POOL_MAX });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/**
 * POST → atomically claim a code at launch time. `gcm` carries a UNIQUE index, so a duplicate
 * insert is rejected at the database level — two campaigns can never share a code.
 * On conflict returns 409 with the next free code so the caller retries. (Invoked by the
 * FB-launch flow; not fired while merely editing the form.)
 */
export async function POST(req: Request) {
  // State-changing (creates a registry row, consumes the 01–200 pool) → self-check the session, same
  // as /api/launch, so a proxy-matcher regression can't let an unauthenticated caller claim/burn codes.
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!storeConfigured()) {
    return NextResponse.json({ error: "strapi_not_configured" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gcm = String(body.gcm ?? "");
  // Canonical pool codes only: "01".."99", "100".."200" — rejects out-of-range and non-canonical
  // spellings ("5", "099", "0100") so the registry never holds two shapes of one code.
  const n = /^\d{2,3}$/.test(gcm) ? parseInt(gcm, 10) : 0;
  if (n < 1 || n > POOL_MAX || gcmCode(n) !== gcm) {
    return NextResponse.json({ ok: false, reason: "bad_code" }, { status: 400 });
  }
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  const data = {
    gcm,
    platform: "facebook",
    status: "active",
    campaign_id: str(body.campaign_id),
    adset_id: str(body.adset_id),
    ad_id: str(body.ad_id),
    ad_ids: null,
    campaign_name: str(body.campaign_name),
    landing: str(body.landing),
    bound_at: null,
    history: null,
    notes: str(body.notes) ?? "claimed via adlauncher",
  };
  try {
    await insertFresh(GCM_MAPS, data);
    return NextResponse.json({ ok: true, gcm });
  } catch {
    // unique violation (or other reject) → surface next free so the caller can retry
    const used = await fetchUsedGcms().catch(() => [] as string[]);
    return NextResponse.json(
      { ok: false, reason: "taken", gcm, next: nextFree(used) },
      { status: 409 },
    );
  }
}
