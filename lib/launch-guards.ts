// Failure-path guards shared by the launch surfaces. Deliberately dependency-free (no "@/"
// imports) so `node --test tests/launch-guards.test.ts` runs them straight off Node's type
// stripping — this module carries the DECISIONS; the routes/board own the I/O around them.

/** Single-flight latch for the board's Launch click: `enter()` wins exactly once until `exit()`.
 *  A double-click's second call lands inside launch()'s awaits (fresh-limits fetch) long before
 *  any state update re-renders the disabled button — React state can't close that window, a
 *  synchronous latch can. */
export function makeGate(): { enter(): boolean; exit(): void } {
  let held = false;
  return {
    enter: () => (held ? false : (held = true)),
    exit: () => {
      held = false;
    },
  };
}

export type LaunchFailureDisposition = { pauseNeeded: boolean; adsLive: number };

/** What a failed MO launch left behind on FB. The tree is born ACTIVE (owner decision 08-11), so
 *  any campaign that exists must be paused on failure — and the ads created before the failure
 *  (multi-creative loop, up to 5 since 08-20) are the part that actually spends. */
export function launchFailureDisposition(created: {
  campaign_id?: unknown;
  ad_id?: unknown;
  ad_ids?: unknown;
}): LaunchFailureDisposition {
  return {
    pauseNeeded: Boolean(created.campaign_id),
    adsLive: Array.isArray(created.ad_ids) ? created.ad_ids.length : created.ad_id ? 1 : 0,
  };
}

/** Suffix for the task's error message: whether money can still be moving and whether the buyer
 *  must open Ads Manager NOW. Empty when no campaign was created (nothing on FB to worry about). */
export function partialFailureNote(d: LaunchFailureDisposition, pausedOk: boolean): string {
  if (!d.pauseNeeded) return "";
  if (d.adsLive > 0) {
    return pausedOk
      ? ` — ${d.adsLive} ad(s) went live before the failure; the campaign is now PAUSED, nothing is spending`
      : ` — ${d.adsLive} ad(s) went LIVE before the failure and the campaign could NOT be confirmed paused: pause it in Ads Manager NOW`;
  }
  return pausedOk
    ? " — the campaign is PAUSED, nothing is spending"
    : " — the campaign has no ads (nothing spends) but could not be confirmed paused";
}

/** The HS duplicate deadline row for an unpatched geo-override clone. LION births clones with an
 *  unpredictable status (lib/lion.ts — "ACTIVE by afternoon"), so this text must never claim
 *  PAUSED unless a pause was actually confirmed. */
export function overrideDeadlineError(cloneId: string, pausedOk: boolean): string {
  return pausedOk
    ? `clone ${cloneId} created but the geo override was NOT applied in time — it is PAUSED; set the targeting in Ads Manager and activate, or delete and re-fire`
    : `clone ${cloneId} created but the geo override was NOT applied — and it could NOT be confirmed PAUSED, so it may be DELIVERING on the SOURCE geo: pause it in Ads Manager NOW, fix the targeting, then activate`;
}
