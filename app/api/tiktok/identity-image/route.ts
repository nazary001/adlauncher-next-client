import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { tiktokRailEnabled } from "@/lib/tiktok-weapon";
import { geminiConfigured, geminiImage } from "@/lib/gemini";

export const runtime = "nodejs";
// One image generation: up to two models × two attempts of ≤90 s each in lib/gemini.
export const maxDuration = 300;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Letters, digits and plain punctuation only — the value is quoted into a model prompt. */
const clean = (v: unknown, max: number): string =>
  String(v ?? "")
    .replace(/[^\p{L}\p{N} .,&'+\-/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * POST { name, hint? } → a generated identity avatar for the TikTok launcher's "Generate" button
 * (LION's own launcher has one). The image comes back as base64 and joins the card exactly like an
 * uploaded file: nothing is hosted here — the board crops it to the 256×256 PNG and uploads it to
 * Blob only at launch, so an avatar the buyer regenerates five times leaves nothing behind.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!tiktokRailEnabled()) return bad("tiktok_rail_disabled", 404);
  if (!geminiConfigured()) return bad("gemini_not_configured — set GEMINI_API_KEY, or upload an avatar instead", 503);

  let body: { name?: unknown; hint?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("bad_json");
  }
  const name = clean(body.name, 60);
  if (!name) return bad("Type the identity name first — the avatar is drawn for it");
  const hint = clean(body.hint, 80);

  const prompt =
    `A square profile avatar for a social media publisher account called "${name}"` +
    (hint ? ` (topic: ${hint})` : "") +
    ". A single bold, simple emblem centred on a clean solid or softly graded background; flat modern design, " +
    "strong contrast, friendly and trustworthy, fills the frame and still reads at 64 pixels. " +
    "Absolutely no text, no letters, no numbers, no watermark, no borders, no photo of a person.";
  try {
    const img = await geminiImage(prompt, { aspectRatio: "1:1", imageSize: "1K" });
    return NextResponse.json({ ok: true, mime: img.mime, b64: img.buffer.toString("base64") });
  } catch (e) {
    return bad((e as Error).message, 502);
  }
}
