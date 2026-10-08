import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { abortCreativeUpload, completeCreativeUpload, creativeRefusalStatus, creativesConfigured, planCreativeUpload } from "@/lib/creative-store";
import type { CreativeRequest } from "@/lib/creative-url";

// The bytes never pass through this function: it only SIGNS the browser's direct-to-S3 upload
// (presigned PUT / multipart) and finishes it. 30 s is plenty for the handful of S3 control calls a
// plan/complete makes — the slow part (the file transfer) is browser → S3, outside the function.
export const runtime = "nodejs";
export const maxDuration = 30;

const NOT_CONFIGURED = "creatives_not_configured — the media store is not set up on this deployment";

/**
 * POST /api/creatives — the signing endpoint for the S3 creative store (owner ask 08.10: stop moving
 * media through Vercel Blob). Actions `plan | complete | abort`, wire types in lib/creative-url.ts.
 * This route is also behind the proxy, but it self-checks the session the same way the large-body
 * launch routes do, so it is correct either way. Credentials and presigned URLs are NEVER logged.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!creativesConfigured()) return NextResponse.json({ ok: false, error: NOT_CONFIGURED }, { status: 503 });

  let body: CreativeRequest;
  try {
    body = (await req.json()) as CreativeRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request — malformed JSON" }, { status: 400 });
  }
  const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;

  try {
    if (action === "plan") {
      // The uploader's identity comes from the SESSION, never from the body: it namespaces the
      // content-addressed key, so "already uploaded" is only ever answered from this buyer's own objects.
      const r = await planCreativeUpload(body as Extract<CreativeRequest, { action: "plan" }>, { owner: String(session.username) });
      return NextResponse.json(r, { status: r.ok ? 200 : statusOf(r.error, action) });
    }
    if (action === "complete") {
      const r = await completeCreativeUpload(body as Extract<CreativeRequest, { action: "complete" }>);
      return NextResponse.json(r, { status: r.ok ? 200 : statusOf(r.error, action) });
    }
    if (action === "abort") {
      await abortCreativeUpload(body as Extract<CreativeRequest, { action: "abort" }>);
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: "bad_request — unknown action" }, { status: 400 });
  } catch (e) {
    // plan/complete/abort are written never to throw; a throw here is unexpected. Log a one-line
    // reason (never the body, a credential or a presigned URL) and fail as a store error.
    console.error(`[creatives] ${String(action)}: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: "store_error — the media store failed; press Retry" }, { status: 502 });
  }
}

/** Status for a refusal, logging a one-line reason whenever it is a 5xx (never for a 400). */
function statusOf(error: string, action: unknown): number {
  const status = creativeRefusalStatus(error);
  if (status >= 500) console.error(`[creatives] ${String(action)}: ${error.split("—")[0].trim()}`);
  return status;
}
