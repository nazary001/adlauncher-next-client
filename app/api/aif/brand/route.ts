import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { AIF_POOL_MAX, aifBrandCode } from "@/lib/partners";
import { fetchUsedBrands } from "@/lib/aif-claim";

// Server-only: the Strapi token never reaches the browser.
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

function nextFree(used: string[]): string | null {
  const set = new Set(used);
  for (let n = 1; n <= AIF_POOL_MAX; n++) {
    const c = aifBrandCode(n);
    if (!set.has(c)) return c;
  }
  return null;
}

/**
 * GET → { used, next, poolMax } — the launcher board previews AIF brand assignment from this,
 * skipping taken brands (test01..test700). The actual claim is server-side in /api/aif/launch
 * (lib/aif-claim, race-safe) — this endpoint only feeds the optimistic card previews, exactly
 * like /api/gcm does for MO.
 */
export async function GET(req: Request) {
  // Belt-and-suspenders: proxy-gated, but self-checks the session so a matcher regression can't
  // expose the registry.
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!STRAPI || !TOKEN) {
    return NextResponse.json({ error: "strapi_not_configured" }, { status: 500 });
  }
  try {
    const used = (await fetchUsedBrands()).sort();
    return NextResponse.json({ used, next: nextFree(used), poolMax: AIF_POOL_MAX });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
