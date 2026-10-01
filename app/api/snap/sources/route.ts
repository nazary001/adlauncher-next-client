import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { snapConfigured, snapRailEnabled } from "@/lib/snap-api";
import { snapCloneRefs } from "@/lib/snap-launch";
import { readSnapCloneSources } from "@/lib/snap-clone-read";

export const runtime = "nodejs";
// Up to 30 sources: ~3 reads per campaign + 2 library listings per account, a few by-id reads —
// bounded concurrency keeps it well inside the cap even on a cold cache.
export const maxDuration = 120;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST { refs: string[] } (or { ids, keys }) → the clone board's sources: every ref (a Snapchat
 * campaign id or a partner key glo-snp_NNN) read back from Snapchat as one clone source — the
 * campaign, its ad squad, its ads with creative + media + moderation verdict. Read-only. A ref that
 * cannot be read (deleted campaign, free key, Snap down) answers with its reason, never sinks the rest.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  let body: { refs?: unknown; ids?: unknown; keys?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const refs = snapCloneRefs(body.refs, body.ids, body.keys);
  if (refs.length === 0) return bad("no_refs — send Snapchat campaign ids or partner keys glo-snp_NNN");
  const sources = await readSnapCloneSources(refs);
  return NextResponse.json({ ok: true, sources });
}
