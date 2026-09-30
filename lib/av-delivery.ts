// AV (ActiveView) delivery modes — pure and dependency-free apart from lib/types, so `node --test`
// runs it straight (lib/partners re-exports it; that file pulls React icons and can't be tested bare).
import type { Campaign } from "./types";
import { bidKind } from "./types";

/** The Meta pixel on the AV sites. ActiveView's own site script fires it (Campaign Analysis → Manage
 *  conversion, set 30.09): PageView on every page, Scroll at 50%, Purchase on every viewed ad slot —
 *  with no value while AV's telemetry is off, so min-ROAS still has nothing to optimize. */
export const AV_PIXEL = { id: "1830814271425766", name: "AV site pixel" } as const;

/** The pixel-less AV mode: Traffic / link clicks (LINK_CLICKS, no promoted_object). */
export const AV_OBJECTIVE = "OUTCOME_TRAFFIC";
/** The default AV mode: Sales, optimizing Purchase on AV_PIXEL. */
export const AV_SALES_OBJECTIVE = "OUTCOME_SALES";

export type AvDelivery = { objective: string; optimization: Campaign["optimization"]; pixel: string; conversionEvent?: string };

/**
 * What a card's optimization pick means on the AV rail (owner ask 30.09: "переключи запуски AV на
 * Purchase с этим пикселем, но сделай чтобы можно было выбирать или так или так"): conversions =
 * Sales optimizing Purchase on AV_PIXEL (a fresh card's default), clicks = Traffic / link clicks with
 * no pixel. Anything but "clicks" reads as conversions. The ONE mapping the card, the locks, the
 * launch route and AV clones all use.
 */
export function avDelivery(optimization: string): AvDelivery {
  return optimization === "clicks"
    ? { objective: AV_OBJECTIVE, optimization: "clicks", pixel: "" }
    : { objective: AV_SALES_OBJECTIVE, optimization: "conversions", pixel: AV_PIXEL.id, conversionEvent: "PURCHASE" };
}

/**
 * The AV lock for one card (applyPartnerLocks): objective, pixel and event converge to the card's
 * optimization pick (avDelivery), and min-ROAS — which needs purchase VALUE AV's Purchase events do
 * not carry — snaps to lowest cost in either mode. Empty patch = the card already conforms.
 */
export function avLockPatch(r: Campaign): Partial<Campaign> {
  const patch: Partial<Campaign> = {};
  const d = avDelivery(r.optimization);
  if (r.objective !== d.objective) patch.objective = d.objective;
  if (r.optimization !== d.optimization) patch.optimization = d.optimization;
  if (r.pixel !== d.pixel) patch.pixel = d.pixel;
  if (d.conversionEvent && r.conversionEvent !== d.conversionEvent) patch.conversionEvent = d.conversionEvent;
  if (bidKind(r.bidStrategy) === "roas") {
    patch.bidStrategy = "LOWEST_COST_WITHOUT_CAP";
    patch.bidCap = "";
  }
  return patch;
}

/**
 * The ad text an AV launch builds its creatives from (owner ask 30.09: "для AV поменяй местами …
 * headline должен передаваться как title, а title как headline"): AV swaps what the card's two text
 * fields feed. The shared creative mapping (fb-launch / the TOOL creatives: headline || title → the
 * ad's headline, title → the description when both differ) then puts the card's TITLE in the ad's
 * bold headline and its HEADLINE in the description. A card with only a Title — or the same text in
 * both — launches exactly as before. Spread it over the campaign ONLY where creatives are built.
 */
export function avAdText(c: Pick<Campaign, "title" | "headline">): Pick<Campaign, "title" | "headline"> {
  return { title: c.headline, headline: c.title };
}
