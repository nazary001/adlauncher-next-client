import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { sessionFromCookieHeader } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Client-upload broker for creative videos. The browser hits this to get a short-lived,
 * single-upload token, then streams the file straight to Vercel Blob — never through the
 * function (whose request body is capped at ~4.5MB). Two callers hit this route:
 *   1. the browser requesting a token  → gated by the user session (cookie present)
 *   2. Blob's server-to-server "upload completed" callback → no cookie; verified by handleUpload's
 *      own signature check, so it must NOT be behind the proxy auth gate (excluded in proxy.ts).
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const json = await handleUpload({
      body,
      request: req,
      // Runs only for the browser's token request — enforce auth here.
      onBeforeGenerateToken: async () => {
        if (!sessionFromCookieHeader(req.headers.get("cookie"))) {
          throw new Error("unauthorized");
        }
        return {
          allowedContentTypes: ["video/mp4", "video/quicktime", "video/webm", "image/*"],
          maximumSizeInBytes: 500 * 1024 * 1024, // 500MB ceiling
          addRandomSuffix: true,
        };
      },
      // Blob calls this server-to-server once the upload lands. The launch route consumes the URL
      // directly, so there's nothing to do here.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
