import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { TEAM } from "@/lib/team";
import { storeConfigured } from "@/lib/store";
import { parseTemplateInput } from "@/lib/templates";
import { createTemplate, listTemplates } from "@/lib/template-store";

export const runtime = "nodejs";

/**
 * Campaign templates — a buyer's saved card, re-usable by the whole team (owner ask 16.10).
 *
 * GET  ?partner=in → { ok, templates: CampaignTemplate[], me, owner }  — every login; the partner is
 *      optional (then every partner of the team). `owner` = this session has the owner role (may
 *      change / delete anyone's template — the server decides again on every write).
 * POST { name, description?, partner, fields } → 201 { ok, template }  — every login, under its own
 *      name. 400 on a bad body, 409 template_exists (+ the existing template — the UI offers to
 *      replace it) / template_limit, 502 when the store is unreachable.
 */
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const unavailable = (e?: unknown) =>
  NextResponse.json({ ok: false, error: "store_unavailable", message: e instanceof Error ? e.message : undefined }, { status: 502 });

export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return unauthorized();
  if (!storeConfigured()) return unavailable();
  const raw = new URL(req.url).searchParams.get("partner");
  let partner: string | undefined;
  if (raw !== null && raw.trim() !== "") {
    partner = raw.trim().toLowerCase();
    if (!(TEAM.partners as readonly string[]).includes(partner)) {
      return NextResponse.json({ ok: false, error: "partner_not_available" }, { status: 400 });
    }
  }
  try {
    const templates = await listTemplates(partner);
    return NextResponse.json({ ok: true, templates, me: session.username, owner: isOwnerSession(session) });
  } catch (e) {
    return unavailable(e);
  }
}

export async function POST(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return unauthorized();
  if (!storeConfigured()) return unavailable();
  const body = await req.json().catch(() => null);
  const parsed = parseTemplateInput(body, TEAM.partners);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const r = await createTemplate(parsed.value, session.username);
    if (!r.ok) return NextResponse.json(r, { status: 409 });
    return NextResponse.json({ ok: true, template: r.template }, { status: 201 });
  } catch (e) {
    return unavailable(e);
  }
}
