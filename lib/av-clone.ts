// AV clone rail — PURE helper (no runtime imports: only the SourceMedia TYPE, erased at load), so
// the clone route and `node --test tests/av-clone.test.ts` share ONE reader. lib/clone-run itself
// pulls in the Graph stack (and its `@/`-aliased chain), which `node --test` cannot resolve — this
// tiny module keeps the source-link extraction testable off Node directly.
//
// The AV clone (app/api/clone/run) re-resolves the SOURCE ad's link against ActiveView before it
// rebuilds a fresh AV link with a newly claimed key: a source pointing anywhere that is not an AV
// destination is refused, and the source's own utm_campaign is never kept.
import type { SourceMedia } from "./clone-run";

/**
 * The destination link a source creative points at — the video's CTA link (video_data
 * call_to_action.value.link) or the static image's link_data.link. "" when the source carries none
 * (e.g. a video with no CTA), which the clone route treats as "not an AV destination".
 */
export function sourceMediaLink(media: SourceMedia): string {
  if (media.kind === "image") {
    return typeof media.data.link === "string" ? media.data.link : "";
  }
  const cta = media.data.call_to_action as { value?: { link?: unknown } } | undefined;
  const link = cta?.value?.link;
  return typeof link === "string" ? link : "";
}

/**
 * The Meta platforms the SOURCE ad set runs on (targeting.publisher_platforms), for an AV clone built
 * through TOOL (owner ask 09.11: «сделай чтобы работал через Tool»): an AV launch picks its platforms on
 * the card (Facebook only by default, lib/publisher-platforms), and its clone keeps them — TOOL's
 * targeting.publisher_platforms takes the same words. No list on the source = automatic placements = [].
 * Words are lower-cased and deduped; anything that is not a plain word is dropped (TOOL refuses
 * an unknown platform by name). The Graph clone needs none of this: its ad set rebuilds the placement from
 * the row's FULL/COMPLIANCE code.
 */
export function sourcePlatformsOf(targeting: unknown): string[] {
  const list = (targeting as { publisher_platforms?: unknown } | null | undefined)?.publisher_platforms;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const p of list) {
    const w = typeof p === "string" ? p.trim().toLowerCase() : "";
    if (/^[a-z_]+$/.test(w) && !out.includes(w)) out.push(w);
  }
  return out;
}
