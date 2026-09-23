// The AIF (Airfind) ad-link contract — PURE (no React, no aliases), so the launch route, the
// card's preview and `node --test tests/aif-link.test.ts` share ONE builder.
//
// Two Airfind client accounts = two flows, one postback endpoint on our side:
//   rw   — "Google Rewarded Web" (clientId 52105, implementation guide in GC-coding/AIF, 2026-08):
//          https://content.honeyandhues.com/rewarded?destination=<slug>&clientId=52105&brand=testNN&ppid={{campaign.id}}[&pixel=<id>]
//   quiz — "Quiz Flow Rewarded Web" (clientId 52149, partner message 23.09.2026): the article page
//          itself in the quiz layout — the slug rides the PATH, the layout is a query flag:
//          https://swiftsearch.co/article/<slug>?layout=qcow&clientId=52149&brand=testNN&ppid={{campaign.id}}[&pixel=<id>]
//
// Both pages parse clientId/brand/ppid/fbclid the same way (read live 23.09: the quiz page
// hydrates `clientId:"52149", brand:"test01", ppid, fbclid → fbc`) and echo EVERY query param into
// the reward-granted postback → our CAPI forwarder (pb_capi.py on the HS box) gates on the clientId
// set and routes the Purchase by &pixel=. The brand pool test01..test700 is per client account on
// the partner's side; our aif-maps registry keeps ONE unique-brand space across both flows (a
// brand is never reused, whichever account it earns on — simplest audit trail; the pool is wide).
//
// The flow is a property of the ARTICLE — the catalog entry carries it (Landing.flow) — never a
// card field: restored drafts, task rows and clones (swapBrand/swapPixel are query-generic) need
// nothing new, and the server derives the flow from the same catalog it validates the slug
// against, so a crafted POST cannot point a brand at the wrong partner account.
import type { LinkSegment } from "./partners";

export type AifFlow = "rw" | "quiz";

export const AIF_RW_BASE = "https://content.honeyandhues.com/rewarded";
export const AIF_CLIENT_ID = "52105";
export const AIF_QUIZ_BASE = "https://swiftsearch.co/article";
export const AIF_QUIZ_CLIENT_ID = "52149";
export const AIF_QUIZ_LAYOUT = "qcow";

export const AIF_FLOWS: Record<AifFlow, { label: string; clientId: string; base: string }> = {
  rw: { label: "RW", clientId: AIF_CLIENT_ID, base: AIF_RW_BASE },
  quiz: { label: "Quiz Flow", clientId: AIF_QUIZ_CLIENT_ID, base: AIF_QUIZ_BASE },
};

/** A plausible Meta pixel id (same guard as the funnel's and partners.ts'). */
const isPixelId = (v?: string): v is string => !!v && /^\d{10,20}$/.test(v);

/** The flow an article launches on: its catalog entry's `flow`; unmarked or unknown slug → RW. */
export function aifFlowOf(landings: ReadonlyArray<{ slug: string; flow?: AifFlow }>, slug: string): AifFlow {
  return landings.find((l) => l.slug === slug)?.flow ?? "rw";
}

/**
 * The AIF link as ORDERED, role-tagged segments (the card colors each role; fullLandingUrl joins
 * them). The brand rides the shared `gcm` slot. `pixel` is appended only when it is a real id —
 * click launches carry none. FB macros stay literal (never URL-encoded), hence hand-built.
 */
export function aifLinkSegments(flow: AifFlow, slug: string, brand: string, pixel?: string): LinkSegment[] {
  if (!slug) return [];
  const segs: LinkSegment[] =
    flow === "quiz"
      ? [
          { text: `${AIF_QUIZ_BASE}/`, role: "base" },
          { text: slug, role: "slug" },
          { text: `?layout=${AIF_QUIZ_LAYOUT}&clientId=${AIF_QUIZ_CLIENT_ID}`, role: "params" },
          { text: "&brand=", role: "gcmKey" },
          { text: brand, role: "gcm" },
          { text: "&ppid={{campaign.id}}", role: "params" },
        ]
      : [
          { text: `${AIF_RW_BASE}?destination=`, role: "base" },
          { text: slug, role: "slug" },
          { text: `&clientId=${AIF_CLIENT_ID}`, role: "params" },
          { text: "&brand=", role: "gcmKey" },
          { text: brand, role: "gcm" },
          { text: "&ppid={{campaign.id}}", role: "params" },
        ];
  if (isPixelId(pixel)) segs.push({ text: `&pixel=${pixel}`, role: "pixel" });
  return segs;
}

/** The joined link (what the ad actually points at). Empty when there is no slug. */
export function aifLink(flow: AifFlow, slug: string, brand: string, pixel?: string): string {
  return aifLinkSegments(flow, slug, brand, pixel)
    .map((s) => s.text)
    .join("");
}
