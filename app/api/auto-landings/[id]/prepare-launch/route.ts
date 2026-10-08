import { NextResponse } from "next/server";
import { creativesConfigured, putCreativeBytes } from "@/lib/creative-store";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { fetchLandingForLaunch, readJob } from "@/lib/auto-landings";
import { geminiConfigured, geminiImage, geminiJson } from "@/lib/gemini";
import {
  AD_COPY_SCHEMA,
  type AdCopy,
  type LaunchLanding,
  buildAdCopyPrompt,
  buildAutoCampaign,
  buildImagePrompt,
  defaultCountriesFor,
  normalizeAdCopy,
} from "@/lib/auto-launch";
import { fullLandingUrl, partnerConfig } from "@/lib/partners";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/auto-landings/{id}/prepare-launch — OWNER only.
 *
 * The "Launch campaign" button behind an Auto-landing row: generate everything a one-click MO launch
 * needs, WITHOUT firing. Gemini writes compliant ad copy + a fresh 16:9 creative scene; the image is
 * generated and stored in our S3 creative store (putCreativeBytes — content-addressed, the exact
 * surface /api/launch's isOwnCreativeUrl fence trusts), and a ready MO Campaign is assembled with
 * safe defaults. The board then shows a confirm dialog and, on Confirm, POSTs the returned campaign +
 * creative straight to /api/launch (the hardened rail: gcm-claim, account limiter, soc-signer, ACTIVE
 * tree, failure pause). Nothing is deleted per launch now, so a retry reuses this same creative.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!geminiConfigured()) {
    return NextResponse.json({ ok: false, error: "gemini_not_configured — set GEMINI_API_KEY" }, { status: 503 });
  }
  if (!creativesConfigured()) {
    return NextResponse.json({ ok: false, error: "creatives_not_configured — set CREATIVES_S3_* (bucket + signer credentials)" }, { status: 503 });
  }

  const { id } = await ctx.params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (job.status !== "published" || !job.slug) {
    return NextResponse.json({ ok: false, error: "not_published — only a published landing can be launched" }, { status: 409 });
  }

  // Prefer the published landing's polished title/subtitle for the ad copy; fall back to the job.
  const facts = await fetchLandingForLaunch(job.slug);
  const angle = job.notes.replace(/^Spike angle \([^)]*\):\s*/i, "").trim();
  const landing: LaunchLanding = {
    slug: job.slug,
    title: facts?.title || job.title,
    subtitle: facts?.subtitle || "",
    niche: facts?.niche || job.niche,
    lang: (facts?.lang || job.lang) === "es" ? "es" : "en",
    angle,
  };

  // 1) ad copy + 2) creative image (either failing aborts before any Blob is written)
  let copy: AdCopy;
  try {
    const raw = await geminiJson<Partial<AdCopy>>(buildAdCopyPrompt(landing), AD_COPY_SCHEMA);
    copy = normalizeAdCopy(raw);
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "copy", error: String((e as Error).message ?? e) }, { status: 502 });
  }

  // The generated image is stored in OUR S3 creative store (content-addressed), exactly where the
  // launch routes' fence (isOwnCreativeUrl) expects a creative to live — no per-launch deletion, the
  // bucket lifecycle is the cleanup. A buyer retrying a failed run reuses this same object.
  let creativeUrl: string;
  try {
    const img = await geminiImage(buildImagePrompt(copy.imagePrompt, landing.title));
    const ext = img.mime.includes("png") ? "png" : "jpg";
    creativeUrl = await putCreativeBytes(img.buffer, { type: img.mime, name: `auto-${job.slug}.${ext}` });
  } catch (e) {
    return NextResponse.json({ ok: false, stage: "image", error: String((e as Error).message ?? e) }, { status: 502 });
  }

  // 3) assemble the MO campaign with safe defaults
  const mo = partnerConfig("in");
  const ddmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit" })
    .format(new Date())
    .replace("/", ".");
  const accountId = (mo.defaultAccount?.id ?? "").replace(/^act_/, "");
  const pixelId = mo.preferredPixel?.id ?? "";
  const campaign = buildAutoCampaign(landing, copy, {
    ddmm,
    // Owner rule 2026-09-11: every auto-landing launch carries the "GC-Launcher Auto-landing" marker
    // in its campaign name (the niche keeps the row readable on the board / in reports).
    nameSuffix: `GC-Launcher Auto-landing - ${landing.niche.toLowerCase()}`,
    countries: defaultCountriesFor(landing.lang),
    budget: "10",
    accountId,
    pixelId,
    pageId: "", // the buyer picks the fanka in the confirm dialog
  });

  // 4) the signer is the OWNER'S pick on /tokens (mo.launch) — the confirm dialog shows it as a
  //    read-only "Signs as" badge; `channel` stays on the wire (empty) for open tabs.
  const suggestedChannel = "";

  // Preview link (real gcm is claimed at fire; NN is the placeholder the buyer sees)
  const linkPreview = fullLandingUrl(mo, landing.slug, "NN", true, pixelId);

  return NextResponse.json({
    ok: true,
    campaign,
    media: { url: creativeUrl, kind: "image" as const },
    linkPreview,
    suggested: {
      channel: suggestedChannel,
      account: mo.defaultAccount ?? null,
      pixel: mo.preferredPixel ?? null,
    },
    landing: { slug: landing.slug, title: landing.title, niche: landing.niche, lang: landing.lang },
  });
}
