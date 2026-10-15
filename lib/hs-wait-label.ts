// What an HS Task Manager row says while LION works on a submitted launch/clone. Pure leaf
// (tests/hs-wait-label.test.ts loads it under `node --test`).
//
// Server-queued rows (srv) are never polled by the browser: the queue's follow-up writes LION's
// creation status onto the row as its `stage` (lib/hs-follow-core), and this turns that stage
// into words. Before 15.10 every such row read "On LION: …" from submit to finish — 6–15 minutes
// of nothing, which buyers read as "stuck" (owner's screenshot 15.10).

/** LION creation-status → the row's stage key (the segmented bar's slots). */
export const LION_STATUS_STAGE: Record<string, string> = {
  PENDING: "queue",
  CREATING_CAMPAIGN: "campaign",
  CREATING_ADSET: "adset",
  CREATING_ADS: "ads",
};

/** The clone exists on Facebook; the follow-up is waiting for LION's store to see it so it can be
 *  flipped ACTIVE (lib/hs-follow-core). Aliased onto the bar's last slot by the task manager. */
export const ACTIVATE_STAGE = "activate";

const STAGE_LABEL: Record<string, string> = {
  queue: "Queued on LION",
  campaign: "Creating campaign",
  adset: "Creating ad set",
  ads: "Creating ads",
  [ACTIVATE_STAGE]: "Created on LION · activating",
};

/** A done row that still carries a note (the follow-up could not flip the clone ACTIVE within
 *  its window — the chain exists, the buyer flips it by hand). The drawer never showed a done
 *  row's error text, so the note was a database-only fact (review 15.10) — this surfaces it. */
export function doneRowNote(t: { status?: string | null; error?: string | null; lionNote?: string | null }): string | null {
  if (t.status !== "done") return null;
  // A legacy client-polled row keeps its own failed flip in lionNote (the owner's live row never
  // adopts the store copy that carries it as error).
  const note = (t.error ?? t.lionNote ?? "").trim();
  return note ? note : null;
}

export function lionWaitLabel(t: { srv?: boolean | number | null; stage?: string | null; lionStatus?: string | null }): string {
  // A legacy client-polled row learned the status itself.
  const polled = t.lionStatus ? STAGE_LABEL[LION_STATUS_STAGE[t.lionStatus] ?? ""] : undefined;
  if (polled) return polled;
  if (!t.srv) return `On LION: ${t.lionStatus ?? "…"}`;
  return STAGE_LABEL[t.stage ?? ""] ?? "Waiting for LION";
}
