import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";

// Server-only: the Strapi token never reaches the browser.
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
// 2-digit codes only (01–99) — the buy-link contract is gcm=NN, so never emit "100".
const POOL_MAX = 99;

const pad = (n: number) => String(n).padStart(2, "0");

async function fetchUsed(): Promise<string[]> {
  const res = await fetch(
    `${STRAPI}/api/gcm-maps?fields[0]=gcm&pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`strapi ${res.status}`);
  const body = await res.json();
  return (body.data ?? []).map((r: { gcm?: string }) => String(r.gcm ?? "")).filter(Boolean);
}

function nextFree(used: string[]): string | null {
  const set = new Set(used);
  for (let n = 1; n <= POOL_MAX; n++) {
    const c = pad(n);
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
  if (!STRAPI || !TOKEN) {
    return NextResponse.json({ error: "strapi_not_configured" }, { status: 500 });
  }
  try {
    const used = (await fetchUsed()).sort();
    return NextResponse.json({ used, next: nextFree(used), poolMax: POOL_MAX });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

/**
 * POST → atomically claim a code at launch time. Strapi's `gcm` is unique, so a duplicate
 * create is rejected at the database level — two campaigns can never share a code.
 * On conflict returns 409 with the next free code so the caller retries. (Invoked by the
 * FB-launch flow; not fired while merely editing the form.)
 */
export async function POST(req: Request) {
  // State-changing (creates a Strapi row, consumes the 01–99 pool) → self-check the session, same
  // as /api/launch, so a proxy-matcher regression can't let an unauthenticated caller claim/burn codes.
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!STRAPI || !TOKEN) {
    return NextResponse.json({ error: "strapi_not_configured" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gcm = String(body.gcm ?? "");
  if (!/^\d{2}$/.test(gcm)) {
    return NextResponse.json({ ok: false, reason: "bad_code" }, { status: 400 });
  }
  const data = {
    gcm,
    platform: "facebook",
    status: "active",
    campaign_id: body.campaign_id ?? null,
    adset_id: body.adset_id ?? null,
    ad_id: body.ad_id ?? null,
    campaign_name: body.campaign_name ?? null,
    landing: body.landing ?? null,
    notes: body.notes ?? "claimed via adlauncher",
  };
  const res = await fetch(`${STRAPI}/api/gcm-maps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (res.ok) return NextResponse.json({ ok: true, gcm });
  // unique violation (or other reject) → surface next free so the caller can retry
  const used = await fetchUsed().catch(() => []);
  return NextResponse.json(
    { ok: false, reason: "taken", gcm, next: nextFree(used) },
    { status: 409 },
  );
}
