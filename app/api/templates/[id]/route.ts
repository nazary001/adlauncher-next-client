import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { storeConfigured } from "@/lib/store";
import { canManageTemplate, parseTemplatePatch } from "@/lib/templates";
import { deleteTemplate, findTemplate, updateTemplate } from "@/lib/template-store";

export const runtime = "nodejs";

/**
 * One campaign template, by its documentId.
 *
 * PATCH  { name?, description?, fields? } → { ok, template }   DELETE → { ok }
 * Both: the template's creator, or an owner-role login (lib/roles) — anyone else gets 403. The
 * session's own verdict is computed HERE on every write; the client's buttons only mirror it.
 * 404 when the template is gone, 409 template_exists on a rename onto a name the creator already
 * uses, 502 when the store is unreachable.
 */
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
const unavailable = (e?: unknown) =>
  NextResponse.json({ ok: false, error: "store_unavailable", message: e instanceof Error ? e.message : undefined }, { status: 502 });
const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** A Strapi-style documentId: 24 chars [a-z0-9]. Anything else is not a template of ours. */
const parseTemplateId = (raw: string | undefined): string | null => (raw && /^[a-z0-9]{24}$/.test(raw) ? raw : null);

type Ctx = { params: Promise<{ id: string }> };

/** The session + the template + the right to change it, or the refusal to answer with. */
async function gate(req: Request, ctx: Ctx) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return { refuse: unauthorized() };
  if (!storeConfigured()) return { refuse: unavailable() };
  const id = parseTemplateId((await ctx.params).id);
  if (!id) return { refuse: NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 }) };
  let template;
  try {
    template = await findTemplate(id);
  } catch (e) {
    return { refuse: unavailable(e) };
  }
  if (!template) return { refuse: notFound() };
  if (!canManageTemplate({ username: session.username, owner: isOwnerSession(session) }, template)) {
    return { refuse: NextResponse.json({ ok: false, error: "forbidden", message: "only the template's creator or an owner can change it" }, { status: 403 }) };
  }
  return { session, id, template };
}

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await gate(req, ctx);
  if ("refuse" in g) return g.refuse;
  const body = await req.json().catch(() => null);
  const parsed = parseTemplatePatch(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const r = await updateTemplate(g.id, parsed.patch, g.session.username);
    if (!r.ok) return r.error === "not_found" ? notFound() : NextResponse.json(r, { status: 409 });
    return NextResponse.json({ ok: true, template: r.template });
  } catch (e) {
    return unavailable(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await gate(req, ctx);
  if ("refuse" in g) return g.refuse;
  try {
    const gone = await deleteTemplate(g.id);
    return gone ? NextResponse.json({ ok: true }) : notFound();
  } catch (e) {
    return unavailable(e);
  }
}
