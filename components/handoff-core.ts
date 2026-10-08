// Pure reducer behind the hand-off store (components/launch-handoff.tsx). No React, no browser, no
// "@/" imports — so the Node test runner can load it by relative path and exercise every transition
// (wave grouping, re-begin, patch, dismiss, the pending / demand selectors) with no DOM.
//
// A hand-off item is one campaign being handed to the server after a Launch click:
//   uploading → sending → accepted   (or failed, with the reason and a retry the UI re-runs).
// Items handed over by one click share a WAVE; the overlay shows one wave at a time.
//
// The store in launch-handoff.tsx re-exports the item/phase/scope/init TYPES defined here, so this
// module owns the single definition and the contract's exported names stay byte-for-byte the same.

/** Which drawer the item's task lives in. */
export type HandoffScope = "mo" | "aif" | "av" | "hs" | "gg" | "sn" | "tt";

/**
 *  uploading  one or more of its files are not on the server yet
 *  sending    files are up; the job is being handed to the server
 *  accepted   the server has it — nothing depends on this tab any more
 *  failed     it will NOT launch unless retried (`error` says why; `retry` re-sends when present)
 */
export type HandoffPhase = "uploading" | "sending" | "accepted" | "failed";

export type HandoffItem = {
  /** The task id (unique across every scope). */
  id: string;
  scope: HandoffScope;
  /** Campaign name as the drawer will show it. */
  label: string;
  /** Secondary line, e.g. "US, CA · $10,00". */
  sub?: string;
  /** Every file this campaign waits on — creatives AND covers — as creative-uploads sources
   *  (session object URLs, or http(s) URLs that need no upload). */
  sources: string[];
  phase: HandoffPhase;
  error?: string;
  /** Numeric ad account id (no act_) — its launch-limit demand until the server has the job. */
  account?: string;
  /** Items handed over by one Launch click share a wave. */
  wave: number;
  addedAt: number;
  /** Present on a failed item that can be re-sent as is. */
  retry?: () => void;
  /** A failed item whose hand-off got NO verdict — the server may in fact have it. The screen then
   *  says "not confirmed" (never "not handed over"): Retry is safe, a fresh launch of the card is not. */
  uncertain?: boolean;
};

export type HandoffInit = {
  id: string;
  scope: HandoffScope;
  label: string;
  sub?: string;
  sources: string[];
  account?: string;
  /** Default "uploading". */
  phase?: HandoffPhase;
};

export type HandoffPatch = {
  phase?: HandoffPhase;
  error?: string | null;
  retry?: (() => void) | null;
  label?: string;
  uncertain?: boolean | null;
};

/** Begins within this window of the previous begin join the SAME wave — the boards enqueue a wave
 *  card by card in one synchronous loop, so every card of one Launch click lands here milliseconds
 *  apart and must be shown as one hand-off. A later click (a second wave) opens a fresh wave. */
export const WAVE_WINDOW_MS = 600;

export type HandoffState = {
  /** Oldest first; referentially stable until something changes. */
  items: readonly HandoffItem[];
  /** The wave the most recent begin belongs to (0 = nothing has begun yet; waves are 1-based). */
  wave: number;
  /** Wall-clock of the most recent begin — the window anchor for grouping. */
  lastBeginAt: number;
  /** Bumped by every begin (even a same-wave join) so the host can open the overlay on each click. */
  beginNonce: number;
};

export const initialHandoffState: HandoffState = {
  items: [],
  wave: 0,
  lastBeginAt: 0,
  beginNonce: 0,
};

const isPending = (p: HandoffPhase): boolean => p === "uploading" || p === "sending";

/** Register the campaigns of a Launch click. Calls within WAVE_WINDOW_MS of the previous begin join
 *  its wave; a later one opens the next wave. An id that is already listed is RESET to the given
 *  phase (default "uploading"), its error / retry cleared and its statics refreshed — a re-sent
 *  item keeps its place in the list but joins the current wave. Always a new state (beginNonce). */
export function reduceBegin(state: HandoffState, inits: readonly HandoffInit[], now: number): HandoffState {
  const joinWave = state.lastBeginAt !== 0 && now - state.lastBeginAt <= WAVE_WINDOW_MS;
  const wave = joinWave ? state.wave : state.wave + 1;

  const items = state.items.slice();
  for (const init of inits) {
    const phase = init.phase ?? "uploading";
    const at = items.findIndex((it) => it.id === init.id);
    const next: HandoffItem = {
      id: init.id,
      scope: init.scope,
      label: init.label,
      sub: init.sub,
      sources: init.sources,
      account: init.account,
      phase,
      error: undefined,
      retry: undefined,
      wave,
      // A re-sent item keeps its original position (addedAt); a new one is stamped now.
      addedAt: at >= 0 ? items[at].addedAt : now,
    };
    if (at >= 0) items[at] = next;
    else items.push(next);
  }

  return { items, wave, lastBeginAt: now, beginNonce: state.beginNonce + 1 };
}

/** Move one item along. `error: null` / `retry: null` clear the field; omitting a field keeps it.
 *  An unknown id leaves the state untouched (same reference — no spurious re-render / snapshot). */
export function reducePatch(state: HandoffState, id: string, patch: HandoffPatch): HandoffState {
  const at = state.items.findIndex((it) => it.id === id);
  if (at < 0) return state;

  const prev = state.items[at];
  const next: HandoffItem = { ...prev };
  if (patch.phase !== undefined) next.phase = patch.phase;
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.error !== undefined) next.error = patch.error === null ? undefined : patch.error;
  if (patch.retry !== undefined) next.retry = patch.retry === null ? undefined : patch.retry;
  if (patch.uncertain !== undefined) next.uncertain = patch.uncertain === true ? true : undefined;
  // "Not confirmed" is a property of a FAILED hand-off only — any other phase clears it.
  if (next.phase !== "failed") next.uncertain = undefined;

  const items = state.items.slice();
  items[at] = next;
  return { ...state, items };
}

/** Drop the ACCEPTED items of a wave — called when the overlay showing that wave is closed or
 *  auto-dismissed. Pending and failed items of the wave stay (they still need the buyer or the
 *  tab). Returns the same state when nothing was accepted. */
export function reduceDropAcceptedOfWave(state: HandoffState, wave: number): HandoffState {
  const items = state.items.filter((it) => !(it.wave === wave && it.phase === "accepted"));
  if (items.length === state.items.length) return state;
  return { ...state, items };
}

/** Drop every ACCEPTED item that is not part of the wave the overlay is showing (`keepWave`; null =
 *  nothing is shown). An accepted item only exists to be SEEN ticking over to "with the server"; once
 *  no overlay shows it (the buyer hid the screen before it finished, or a newer wave took the screen)
 *  nothing reads it any more — without this they pile up for the life of the tab. Pending and failed
 *  items always stay. Returns the same state when there is nothing to drop. */
export function reduceDropAcceptedOutside(state: HandoffState, keepWave: number | null): HandoffState {
  const items = state.items.filter((it) => !(it.phase === "accepted" && it.wave !== keepWave));
  if (items.length === state.items.length) return state;
  return { ...state, items };
}

/** Dismiss one item by id — but NEVER one that is still uploading / sending (the tab is holding its
 *  bytes; silently dropping it would strand the upload). Failed and accepted items can go. */
export function reduceDismiss(state: HandoffState, id: string): HandoffState {
  const at = state.items.findIndex((it) => it.id === id);
  if (at < 0 || isPending(state.items[at].phase)) return state;
  const items = state.items.slice();
  items.splice(at, 1);
  return { ...state, items };
}

/** How many items are not with the server yet (uploading | sending) — of one scope, or of all. */
export function pendingCount(items: readonly HandoffItem[], scope?: HandoffScope): number {
  let n = 0;
  for (const it of items) if (isPending(it.phase) && (!scope || it.scope === scope)) n++;
  return n;
}

/** Not-yet-accepted launch-limit demand per ad account: uploading | sending items that carry an
 *  account. A fresh Map each call — the store caches it and only swaps the reference on a change. */
export function demandMap(items: readonly HandoffItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    if (!it.account || !isPending(it.phase)) continue;
    m.set(it.account, (m.get(it.account) ?? 0) + 1);
  }
  return m;
}
