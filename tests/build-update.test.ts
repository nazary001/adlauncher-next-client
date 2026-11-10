// Node's built-in runner (v24 strips types natively): `node --test tests/build-update.test.ts`.
// What an open tab does when a deploy lands under it (owner ask 10.11: «чтобы дизайнерам не
// приходилось перезапускать странички … должна быть возможность работать и на старой версии …
// а уже после перезагрузки вступала в силу новая версия»). One pure decision is held here: the tab's
// own release against the one the server answers with → nothing / a quiet "update available" (the
// tab keeps launching) / "reload needed" (only when the deploy changed the wire old code speaks).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_WIRE_LEVEL,
  WIRE_LEVEL,
  legacyBuildField,
  liveRelease,
  releaseOf,
  updateState,
  worseUpdate,
  type Release,
} from "../lib/build-update.ts";

const OLD = "2026-11-10T08:00:00.000Z";
const NEW = "2026-11-10T12:30:00.000Z";
const rel = (build: string, level = 1): Release => ({ build, level });

test("the same build on both sides: nothing to say", () => {
  assert.equal(updateState(rel(OLD), rel(OLD)), "current");
});

test("another build is live, the wire is the same: the update is only OFFERED — the tab keeps working", () => {
  assert.equal(updateState(rel(OLD), rel(NEW)), "available");
});

test("another build is live and it raised the wire level: this tab must reload before it launches", () => {
  assert.equal(updateState(rel(OLD, 1), rel(NEW, 2)), "required");
  assert.equal(updateState(rel(OLD, 2), rel(NEW, 5)), "required");
});

test("a rollback (the live build is older, its level lower) is an offer too, never a block", () => {
  assert.equal(updateState(rel(NEW, 2), rel(OLD, 1)), "available");
});

test("a tab with no stamp of its own (a test bundle) never judges", () => {
  assert.equal(updateState(rel(""), rel(NEW, 9)), "current");
});

test("no answer about the live release: nothing changes", () => {
  assert.equal(updateState(rel(OLD), null), "current");
  assert.equal(updateState(rel(OLD), rel("")), "current");
});

test("the same build cannot demand a reload of itself, whatever level a garbled answer names", () => {
  assert.equal(updateState(rel(OLD, 1), rel(OLD, 7)), "current");
});

test("the live release is read from the answer's `release`", () => {
  assert.deepEqual(liveRelease({ ok: true, build: "", release: { build: NEW, level: 3 } }), rel(NEW, 3));
});

test("a release with no usable level is the legacy level, not a block", () => {
  for (const level of [undefined, null, "2", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(liveRelease({ release: { build: NEW, level } }), rel(NEW, LEGACY_WIRE_LEVEL), String(level));
  }
});

test("an answer of a server from before levels (only `build`) still names the live build", () => {
  assert.deepEqual(liveRelease({ ok: true, build: NEW }), rel(NEW, LEGACY_WIRE_LEVEL));
});

test("`release` outranks the legacy `build` (which the server blanks for old tabs on purpose)", () => {
  assert.deepEqual(liveRelease({ build: "", release: { build: NEW, level: 1 } }), rel(NEW, 1));
  assert.deepEqual(liveRelease({ build: OLD, release: { build: NEW, level: 2 } }), rel(NEW, 2));
});

test("garbage answers name no release", () => {
  for (const raw of [null, undefined, 7, "x", [], {}, { release: null }, { release: "x" }, { release: { build: 5 } }, { release: { build: "  " } }, { build: 12 }]) {
    assert.equal(liveRelease(raw), null, JSON.stringify(raw));
  }
});

test("this build's release: its stamp and the level it speaks", () => {
  assert.deepEqual(releaseOf(NEW), rel(NEW, WIRE_LEVEL));
  assert.deepEqual(releaseOf(undefined), rel("", WIRE_LEVEL));
  assert.deepEqual(releaseOf(NEW, 4), rel(NEW, 4));
});

// Tabs opened before 10.11.2026 run a bundle that hard-blocks itself whenever the answer's `build`
// differs from its own. They must keep working through every deploy that leaves the wire alone —
// and still be stopped by the first one that does not.
test("old tabs are told nothing while the wire is the one they speak", () => {
  assert.equal(legacyBuildField(rel(NEW, LEGACY_WIRE_LEVEL)), "");
});

test("old tabs get the stamp (their own block) once the wire moved past them", () => {
  assert.equal(legacyBuildField(rel(NEW, LEGACY_WIRE_LEVEL + 1)), NEW);
});

test("today's wire is the legacy one: this release does not lock the tabs that are open now", () => {
  assert.equal(WIRE_LEVEL, LEGACY_WIRE_LEVEL);
  assert.equal(legacyBuildField(releaseOf(NEW)), "");
});

test("a tab's state only ever gets worse until it reloads (a poll that saw less changes nothing)", () => {
  assert.equal(worseUpdate("current", "available"), "available");
  assert.equal(worseUpdate("available", "current"), "available");
  assert.equal(worseUpdate("available", "required"), "required");
  assert.equal(worseUpdate("required", "available"), "required");
  assert.equal(worseUpdate("required", "current"), "required");
  assert.equal(worseUpdate("current", "current"), "current");
});
