// Node's built-in runner (v24 strips types natively): `node --test tests/handoff-core.test.ts`.
// The pure reducer behind the hand-off store — wave grouping by time, re-begin of an existing id,
// patch of an unknown id, the pending / demand selectors, what survives a dismiss, and clearing
// error / retry with null. No React, no DOM — every transition is a plain function.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialHandoffState,
  reduceBegin,
  reducePatch,
  reduceDropAcceptedOfWave,
  reduceDropAcceptedOutside,
  reduceDismiss,
  pendingCount,
  demandMap,
  WAVE_WINDOW_MS,
  type HandoffInit,
  type HandoffState,
} from "../components/handoff-core.ts";

const init = (id: string, over: Partial<HandoffInit> = {}): HandoffInit => ({
  id,
  scope: "mo",
  label: `Campaign ${id}`,
  sources: [`blob:${id}`],
  ...over,
});

const beginAt = (state: HandoffState, now: number, ...ids: HandoffInit[]) => reduceBegin(state, ids, now);

test("first begin opens wave 1 and bumps the nonce", () => {
  const s = reduceBegin(initialHandoffState, [init("a"), init("b")], 1000);
  assert.equal(s.wave, 1);
  assert.equal(s.beginNonce, 1);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].phase, "uploading");
  assert.equal(s.items[0].wave, 1);
  assert.equal(s.lastBeginAt, 1000);
});

test("begins within the window join one wave; a later begin starts the next", () => {
  let s = beginAt(initialHandoffState, 1000, init("a"));
  s = beginAt(s, 1000 + WAVE_WINDOW_MS, init("b")); // exactly on the edge → same wave
  assert.equal(s.wave, 1);
  assert.equal(s.items.every((it) => it.wave === 1), true);

  // The window anchors to the PREVIOUS begin (b, at 1000 + WAVE_WINDOW_MS), so c must be more than
  // one window past THAT to open a new wave — a card-by-card loop keeps extending the same wave.
  s = beginAt(s, 1000 + 2 * WAVE_WINDOW_MS + 2, init("c"));
  assert.equal(s.wave, 2);
  assert.equal(s.items.find((it) => it.id === "c")?.wave, 2);
  assert.equal(s.beginNonce, 3); // every begin bumps it, same wave or not
});

test("re-begin of an existing id resets its phase and keeps its place and addedAt", () => {
  let s = beginAt(initialHandoffState, 1000, init("a"), init("b"));
  s = reducePatch(s, "a", { phase: "failed", error: "boom", retry: () => {} });
  const addedAt = s.items[0].addedAt;

  s = beginAt(s, 5000, init("a", { label: "Renamed" }));
  assert.equal(s.items.length, 2, "no duplicate row");
  assert.equal(s.items[0].id, "a", "kept its position (oldest first)");
  assert.equal(s.items[0].phase, "uploading");
  assert.equal(s.items[0].error, undefined, "error cleared");
  assert.equal(s.items[0].retry, undefined, "retry cleared");
  assert.equal(s.items[0].label, "Renamed", "statics refreshed");
  assert.equal(s.items[0].addedAt, addedAt, "position anchor preserved");
  assert.equal(s.items[0].wave, 2, "joined the current wave");
});

test("patch of an unknown id returns the same state reference", () => {
  const s = beginAt(initialHandoffState, 1000, init("a"));
  const after = reducePatch(s, "ghost", { phase: "accepted" });
  assert.equal(after, s);
});

test("patch clears error and retry with null, keeps omitted fields", () => {
  let s = beginAt(initialHandoffState, 1000, init("a"));
  const retry = () => {};
  s = reducePatch(s, "a", { phase: "failed", error: "network", retry });
  assert.equal(s.items[0].error, "network");
  assert.equal(s.items[0].retry, retry);

  s = reducePatch(s, "a", { error: null, retry: null });
  assert.equal(s.items[0].error, undefined);
  assert.equal(s.items[0].retry, undefined);
  assert.equal(s.items[0].phase, "failed", "omitted phase left untouched");
});

test("pendingCount counts uploading | sending, overall and per scope", () => {
  let s = beginAt(initialHandoffState, 1000, init("a", { scope: "mo" }), init("b", { scope: "hs" }), init("c", { scope: "mo" }));
  s = reducePatch(s, "a", { phase: "sending" });
  s = reducePatch(s, "b", { phase: "accepted" }); // accepted no longer pending
  assert.equal(pendingCount(s.items), 2, "a(sending) + c(uploading)");
  assert.equal(pendingCount(s.items, "mo"), 2);
  assert.equal(pendingCount(s.items, "hs"), 0);
});

test("demandMap is per account, only for uploading | sending items that carry an account", () => {
  let s = beginAt(
    initialHandoffState,
    1000,
    init("a", { account: "111" }),
    init("b", { account: "111" }),
    init("c", { account: "222" }),
    init("d"), // no account
  );
  s = reducePatch(s, "c", { phase: "accepted" }); // accepted drops out of demand
  const m = demandMap(s.items);
  assert.equal(m.get("111"), 2);
  assert.equal(m.has("222"), false, "accepted item is no longer demand");
  assert.equal(m.size, 1, "the account-less item contributes nothing");
});

test("dismiss removes a failed item but never an in-flight one", () => {
  let s = beginAt(initialHandoffState, 1000, init("a"), init("b"));
  s = reducePatch(s, "a", { phase: "failed", error: "boom" });

  const afterInflight = reduceDismiss(s, "b"); // b is still uploading
  assert.equal(afterInflight, s, "an uploading item survives dismiss");

  const afterFail = reduceDismiss(s, "a");
  assert.equal(afterFail.items.length, 1);
  assert.equal(afterFail.items[0].id, "b");
});

test("dropAcceptedOfWave removes only the accepted items of that wave", () => {
  let s = beginAt(initialHandoffState, 1000, init("a"), init("b"));
  s = beginAt(s, 5000, init("c")); // wave 2
  s = reducePatch(s, "a", { phase: "accepted" });
  s = reducePatch(s, "b", { phase: "failed", error: "x" });
  s = reducePatch(s, "c", { phase: "accepted" });

  const after = reduceDropAcceptedOfWave(s, 1);
  assert.deepEqual(
    after.items.map((it) => it.id),
    ["b", "c"],
    "wave-1 accepted gone; wave-1 failed and wave-2 accepted kept",
  );
  assert.equal(reduceDropAcceptedOfWave(after, 1), after, "no-op returns the same reference");
});

test("reduceDropAcceptedOutside: accepted items no overlay is showing are dropped; pending and failed always stay", () => {
  let s = reduceBegin(initialHandoffState, [init("a"), init("b"), init("c")], 1000); // wave 1
  s = reduceBegin(s, [init("d"), init("e")], 5000); // wave 2 (well past the join window)
  const w1 = s.items.find((i) => i.id === "a")!.wave;
  const w2 = s.items.find((i) => i.id === "d")!.wave;
  assert.notEqual(w1, w2);
  s = reducePatch(s, "a", { phase: "accepted" });
  s = reducePatch(s, "b", { phase: "failed", error: "x" });
  s = reducePatch(s, "d", { phase: "accepted" });
  // the overlay shows wave 2: wave 1's accepted item goes, wave 2's stays to be seen
  const showing2 = reduceDropAcceptedOutside(s, w2);
  assert.deepEqual(showing2.items.map((i) => i.id), ["b", "c", "d", "e"]);
  // nothing shown at all (the buyer hid the screen): every accepted item goes
  const hidden = reduceDropAcceptedOutside(s, null);
  assert.deepEqual(hidden.items.map((i) => i.id), ["b", "c", "e"]);
  assert.equal(hidden.items.find((i) => i.id === "b")?.phase, "failed", "a failure is never dropped silently");
  // nothing to drop → the very same state (no spurious re-render)
  assert.equal(reduceDropAcceptedOutside(hidden, null), hidden);
});
