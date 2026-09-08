// Server-only minimal Gemini client for the Auto-launch rail (ad-copy + a fresh ad creative image).
// Raw REST against the Generative Language API — the same endpoint the MO-landing worker uses — so
// adlauncher needs no SDK dependency. Every call is time-bounded; failures throw a named error the
// prepare-launch route surfaces to the owner (nothing is claimed/created before this succeeds).

const KEY = process.env.GEMINI_API_KEY ?? "";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image";
const IMAGE_MODEL_FALLBACK = "gemini-2.5-flash-image";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

export const geminiConfigured = (): boolean => Boolean(KEY);

type JsonSchema = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Structured JSON generation (responseSchema-constrained). Returns the parsed object. */
export async function geminiJson<T = unknown>(prompt: string, schema: JsonSchema, timeoutMs = 45_000): Promise<T> {
  if (!KEY) throw new Error("gemini_not_configured — set GEMINI_API_KEY");
  const res = await fetch(`${API}/${TEXT_MODEL}:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as
    | { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } }
    | null;
  if (!res.ok) throw new Error(`gemini_text_${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini_text_empty");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("gemini_text_unparseable");
  }
}

export type GeneratedImage = { buffer: Buffer; mime: string };

/** True for a real raster header (JPEG/PNG/GIF/WebP) — the image models occasionally return a tiny
 *  SVG/text blob on refusal, which Meta's ad-image upload would then reject. */
function isRaster(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return true;
  return false;
}

/**
 * Generate one 16:9 ad creative image. Tries gemini-3-pro-image (2K), falls back to flash-image;
 * two attempts each. Returns the raw bytes + mime (the caller uploads them to Blob). Throws when
 * every attempt fails so the owner sees a clean error instead of a launch with no creative.
 */
export async function geminiImage(prompt: string): Promise<GeneratedImage> {
  if (!KEY) throw new Error("gemini_not_configured — set GEMINI_API_KEY");
  const attempts: Array<{ model: string; config: Record<string, unknown> }> = [
    { model: IMAGE_MODEL, config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } } },
    { model: IMAGE_MODEL_FALLBACK, config: { responseModalities: ["IMAGE"] } },
  ];
  let lastErr = "no image produced";
  for (const { model, config } of attempts) {
    for (let n = 0; n < 2; n++) {
      try {
        const res = await fetch(`${API}/${model}:generateContent?key=${KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: config }),
          signal: AbortSignal.timeout(90_000),
        });
        const body = (await res.json().catch(() => null)) as
          | { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>; error?: { message?: string } }
          | null;
        if (!res.ok) throw new Error(`img_${res.status}: ${String(body?.error?.message ?? "").slice(0, 120)}`);
        const inline = (body?.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData)?.inlineData;
        if (!inline?.data) throw new Error("no_inline_image");
        const buffer = Buffer.from(inline.data, "base64");
        if (buffer.length < 20_000 || !isRaster(buffer)) throw new Error("undersized_or_nonraster");
        return { buffer, mime: (inline.mimeType || "image/jpeg").split(";")[0] };
      } catch (e) {
        lastErr = String((e as Error)?.message ?? e);
        await sleep(2000);
      }
    }
  }
  throw new Error(`gemini_image_failed — ${lastErr}`);
}
