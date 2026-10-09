// ONE LION JURO shot — the body of /api/hs/jurar's phases 0 + 1, moved here verbatim so the
// durable queue can run it as a job (lib/launch-queue-runners hs.jurar): read the source's posts /
// targeting / bid once, resolve every wire piece with readable refusals, check the posts' pages
// against hs-tools, claim the account's launch slot, submit `/jurar/`, keep the fanka ledger. The
// poll + finish tail (the old phase 2) is the wave's hs.jurar.follow job (lib/hs-follow-core).
//
// Money rules kept exactly: a clean 4xx releases the slot and is a fact of the SOURCE × profile; a
// 5xx / transport failure after the submit is AMBIGUOUS — and unlike duplicate's PAUSED births a
// jurar campaign LION accepted despite the lost answer is born ACTIVE and spending, so the row says
// so and the shot is never re-sent.

import { hsWireBid } from "@/lib/hs-launch";
import { juroBidPlan, juroConversionEvent, juroStoryPages, juroWireCountries } from "@/lib/juro";
import { hsPageRefusal, reportPagesUsed } from "@/lib/hs-pages";
import { AcctLimitedError, acctKey, claimAcctSlot, releaseAcctSlot } from "@/lib/acct-limit";
import { LionError, type LionJuroSource, lionJurar, lionJuroSources } from "@/lib/lion";
import type { GeoOverride } from "@/lib/targeting-override";
import type { ShotBinds } from "@/lib/hs-shot-binds";

/** One validated JURO shot as the route resolved it (JSON — stored in the job; the profile's page
 *  catalog and locale names ride as plain arrays / records). */
export type HsJuroShot = {
  campaignId: string;
  budget: number;
  budgetRaw: string;
  bid: number | null;
  /** Per-row strategy switch ("" = the source's) — LION's /jurar/ takes bid_strategy natively. */
  bidStrategyOverride: string;
  bidLabel: string;
  suffix: string;
  /** The board's exact name for the post-birth Graph rename ("" = keep LION's own). */
  name: string;
  geo: string;
  label: string;
  override: GeoOverride | null;
  /** This shot's OWN destination (page always "" — JURO binds none). */
  binds: ShotBinds;
  accountName: string;
  /** The picked profile's page ids (jurar refuses a story whose page the profile doesn't list). */
  profilePages: string[];
  /** The profile's FB locales, id → name (an override's locale ids resolve to names from it). */
  localeNames: Record<string, string>;
};

export type HsJuroShotResult =
  | { outcome: "submitted"; lionTaskId: string }
  | { outcome: "refused"; error: string; family: boolean; accountFull: boolean; registryDown: boolean; retryable: boolean };

export type HsJuroShotDeps = {
  user: string;
  taskId: string;
  rowWrite: (fields: Record<string, unknown>) => void;
  now: () => number;
  log?: (msg: string) => void;
};

/** The family a refusal reaches: the same source may be fine on a row bound to another profile
 *  (per-row destinations, 09-08), so families are keyed per source AND profile. */
export const juroFamilyKey = (s: Pick<HsJuroShot, "campaignId" | "binds">): string => `${s.campaignId}|${s.binds.profile}`;

const SOURCE_TTL_MS = 5 * 60_000;
const sourceCache = new Map<string, { at: number; v: LionJuroSource }>();

/** The source's posts / targeting / bid — one details/ + targeting/ read per source, cached for the
 *  copies of a wave that run back to back. An UNREADABLE source is not cached (it may clear). */
async function juroSource(campaignId: string, now: number): Promise<LionJuroSource> {
  const hit = sourceCache.get(campaignId);
  if (hit && now - hit.at < SOURCE_TTL_MS) return hit.v;
  const all = await lionJuroSources([campaignId]);
  const src = all[campaignId];
  if (!src) throw new LionError(`LION returned nothing for source ${campaignId}`);
  if (src.status !== "UNREADABLE") {
    sourceCache.set(campaignId, { at: now, v: src });
    if (sourceCache.size > 500) sourceCache.delete(sourceCache.keys().next().value as string);
  }
  return src;
}

/** Per-shot jurar wire pieces resolved from the SOURCE. String = the actionable refusal. */
export function resolveJuroShotWire(
  s: HsJuroShot,
  src: LionJuroSource,
):
  | string
  | {
      stories: string[];
      pages: { pageId: string; delta: number }[];
      countries: string[];
      locales: { id: number; name: string }[];
      bidStrategy?: string;
      startingBid?: number;
      conversionEvent: string;
    } {
  if (src.status === "UNREADABLE") {
    return "LION can't read this source right now (deleted, or the fresh-campaign lag) — its JURO copy would die the same way";
  }
  if (src.stories.length === 0) return "source has no page posts (object stories) to relaunch";
  const pages = juroStoryPages(src.stories);
  if (!pages) return "source post ids are malformed — page underivable";
  const profilePages = new Set(s.profilePages);
  // jurar validates every story's page against the executor profile (live 08-25) — pre-check here
  // so the refusal names the page instead of LION's opaque reject.
  for (const p of pages) {
    if (!profilePages.has(p.pageId)) return `source page ${p.pageId} is not on the picked profile — pick a profile that carries this fanpage`;
  }
  // A [WORLD]-labelled source reads as no countries from targeting/ — the label rides as LION's
  // WORLD token (live 09-09); anything else empty is undecidable → refuse.
  const countries = juroWireCountries(s.override, src.countries, src.name);
  if (countries.length === 0) return "source geo unreadable — set a Targeting override on this row";
  // jurar has no bid inheritance: whatever rides the wire IS the new campaign's strategy — the
  // row's switch (09-08) or the source's. juroBidPlan owns the rules; the scaling is here.
  const plan = juroBidPlan({ sourceStrategy: src.bidStrategy, override: s.bidStrategyOverride, typedBid: s.bid, sourceBid: src.bid });
  if ("refusal" in plan) return plan.refusal;
  let startingBid: number | undefined;
  if (plan.human != null) {
    const wire = hsWireBid(plan.human, plan.strategy, "lion");
    if (wire == null) {
      return plan.kind === "roas" ? "roas goal ambiguous — type the decimal goal (0,30 = 30%)" : "bid not resolvable for this source — clear the Bid to use the source's";
    }
    startingBid = wire;
  }
  const locales =
    s.override && s.override.localeIds.length > 0 ? s.override.localeIds.map((id) => ({ id, name: s.localeNames[String(id)] ?? "" })) : src.locales;
  return {
    stories: src.stories,
    pages,
    countries,
    locales,
    bidStrategy: plan.wireStrategy,
    startingBid,
    // The pairing follows the EFFECTIVE strategy: a ROAS switch value-optimizes PURCHASE.
    conversionEvent: juroConversionEvent(plan.strategy),
  };
}

export async function runHsJuroShot(s: HsJuroShot, deps: HsJuroShotDeps): Promise<HsJuroShotResult> {
  const { user, rowWrite } = deps;
  const now = deps.now();
  const refuse = (error: string, o: { family?: boolean; accountFull?: boolean; registryDown?: boolean; retryable?: boolean } = {}): HsJuroShotResult => {
    rowWrite({ status: "error", error: error.slice(0, 1000), finished_at: deps.now() });
    return { outcome: "refused", error, family: o.family === true, accountFull: o.accountFull === true, registryDown: o.registryDown === true, retryable: o.retryable === true };
  };

  let src: LionJuroSource;
  try {
    src = await juroSource(s.campaignId, now);
  } catch (e) {
    // Nothing was sent: the source read itself failed — the copy is safe to try again later.
    return refuse(`lion_source_read_failed: ${(e as Error).message ?? e}`, { retryable: true });
  }
  const wire = resolveJuroShotWire(s, src);
  // A page/geo/bid refusal is a fact of the SOURCE for this profile — copies of the source bound
  // to the same profile refuse identically; other rows may carry another profile.
  if (typeof wire === "string") return refuse(wire, { family: true });
  // Owner rule 2026-09-07: JURO copies land on the source post's OWN fanka — it must be OK in
  // hs-tools like any picked page (family-scoped: every copy of this source refuses alike).
  const fankaRefusal = await hsPageRefusal("br", wire.pages.map((p) => ({ id: p.pageId })));
  if (fankaRefusal) return refuse(fankaRefusal.error, { family: true });

  let slotDoc: string | null = null;
  try {
    slotDoc = (
      await claimAcctSlot(acctKey(s.binds.account), {
        user,
        partner: "br",
        channel: "hs-juro",
        name: s.label || `JURO copy of ${s.campaignId}`,
        accountName: s.accountName || "",
      })
    ).documentId;
    const result = await lionJurar({
      profile_slug: s.binds.profile,
      account_id: s.binds.account,
      pixel_id: s.binds.pixel,
      object_story_ids: wire.stories,
      starting_budget: Math.round(s.budget * 100),
      country_codes: wire.countries,
      locales: wire.locales,
      name_suffix: s.suffix,
      ...(wire.bidStrategy ? { bid_strategy: wire.bidStrategy } : {}),
      ...(wire.startingBid != null ? { starting_bid: wire.startingBid } : {}),
      conversion_event: wire.conversionEvent,
    });
    const lionTaskId = (result.task_ids ?? []).map(String).filter(Boolean)[0];
    if (!lionTaskId) {
      await releaseAcctSlot(slotDoc);
      return refuse(result.reason || result.message || `LION rejected the jurar (${result.result ?? "no result"})`, { family: true });
    }
    rowWrite({ link: lionTaskId, started_at: deps.now(), stage: "queue", status: "running" });
    // Registry ledger, optimistically at submit: the copy re-creates one ad per source post ON THE
    // POST'S OWN PAGE (that's where jurar ads live — not on a bind page).
    await reportPagesUsed("br", wire.pages);
    return { outcome: "submitted", lionTaskId };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (e instanceof AcctLimitedError) return refuse(msg, { accountFull: true, retryable: true });
    if (/acct_limit_unavailable/.test(msg)) return refuse(msg, { registryDown: true, retryable: true });
    // Clean 4xx = LION refused, nothing was created (slot back, family settles). Anything else
    // (5xx/transport/timeout) is AMBIGUOUS — a jurar campaign LION accepted despite the lost
    // answer is born ACTIVE and spending, with no task id to reconcile. The row must say so.
    const clean4xx = e instanceof LionError && e.status !== undefined && e.status < 500;
    if (clean4xx) {
      await releaseAcctSlot(slotDoc);
      return refuse(`lion_jurar_failed: ${msg}`, { family: true });
    }
    return refuse(`lion_jurar_failed (AMBIGUOUS — a JURO campaign MAY have been created and born ACTIVE; check LION/Ads Manager before re-firing): ${msg}`);
  }
}
