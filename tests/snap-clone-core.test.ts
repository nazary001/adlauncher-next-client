// Node's built-in runner (v24 strips types natively): `node --test tests/snap-clone-core.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat CLONE board — the row-state rules (components/snap-clone-core.ts): a source that went out
// is closed until the buyer changes what it would send, on the row OR in the wave's Settings, at any
// moment — also while its wave is still being accepted (owner report 08.10: "когда делаешь запуск в
// 1 аккаунт, потом выбираешь другой — не даёт запустить, нужно перезагружать страничку").
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapCloneSend, snapCloneSettle, snapCloneTouch, snapCloneTouchRows } from "../components/snap-clone-core.ts";

type Row = { id: string; touched?: boolean; card: { state: "idle" | "sending" | "ok" | "error"; msg?: string; adAccount: string; copies: string } };
const row = (id: string, state: Row["card"]["state"], extra: Partial<Row["card"]> = {}, touched?: boolean): Row => ({
  id,
  ...(touched === undefined ? {} : { touched }),
  card: { state, adAccount: "", copies: "", ...(state === "ok" ? { msg: "queued" } : state === "error" ? { msg: "refused" } : {}), ...extra },
});
/** The board's own predicates: which rows ride the wave's Destination / Copies per source. */
const ridesDest = (r: Row) => !r.card.adAccount;
const ridesCopies = (r: Row) => !r.card.copies;

test("touch: a row that went out (or was refused) becomes a draft again", () => {
  const ok = snapCloneTouch(row("a", "ok"));
  assert.equal(ok.card.state, "idle");
  assert.equal(ok.card.msg, undefined);
  const err = snapCloneTouch(row("b", "error"));
  assert.equal(err.card.state, "idle");
  assert.equal(err.card.msg, undefined);
});

test("touch: a draft is left alone — the very same object", () => {
  const idle = row("a", "idle");
  assert.equal(snapCloneTouch(idle), idle);
});

test("touch: a row whose wave is still being accepted stays 'sending' and remembers the change", () => {
  const sending = row("a", "sending");
  const t = snapCloneTouch(sending);
  assert.equal(t.card.state, "sending");
  assert.equal(t.touched, true);
  assert.equal(snapCloneTouch(t), t, "a second change in the same window changes nothing more");
});

test("the report: cloned into one account, then ANOTHER Destination picked in Settings → the source is a draft again", () => {
  const rows = [row("a", "ok")]; // rides the wave's Destination (no account of its own)
  const next = snapCloneTouchRows(rows, ridesDest);
  assert.equal(next[0].card.state, "idle");
  assert.equal(next[0].card.msg, undefined);
});

test("a wave-level change re-opens only the rows that RIDE it — a row with its own value sends the same, it stays closed", () => {
  const own = row("own", "ok", { adAccount: "acct-2" });
  const rides = row("rides", "ok");
  const draft = row("draft", "idle");
  const next = snapCloneTouchRows([own, rides, draft], ridesDest);
  assert.equal(next[0], own, "own destination: untouched (re-opening it would fire the same clone twice)");
  assert.equal(next[1].card.state, "idle");
  assert.equal(next[2], draft);
  // Copies per source: the same rule on the other default
  const ownCopies = row("c", "ok", { copies: "3" });
  const waveCopies = row("d", "ok");
  const byCopies = snapCloneTouchRows([ownCopies, waveCopies], ridesCopies);
  assert.equal(byCopies[0], ownCopies);
  assert.equal(byCopies[1].card.state, "idle");
});

test("a wave-level change with no predicate reaches every row (Start paused has no per-row value)", () => {
  const next = snapCloneTouchRows([row("a", "ok", { adAccount: "acct-2" }), row("b", "error"), row("c", "idle")]);
  assert.deepEqual(next.map((r) => r.card.state), ["idle", "idle", "idle"]);
});

test("touchRows answers the SAME array when nothing changes (no re-render)", () => {
  const rows = [row("a", "idle"), row("b", "ok", { adAccount: "acct-2" })];
  assert.equal(snapCloneTouchRows(rows, ridesDest), rows);
  assert.equal(snapCloneTouchRows([], ridesDest).length, 0);
});

test("send: the row leaves with its wave — an older 'touched' no longer counts", () => {
  const s = snapCloneSend(row("a", "idle", {}, true), "queuing on server…");
  assert.equal(s.card.state, "sending");
  assert.equal(s.card.msg, "queuing on server…");
  assert.equal(s.touched, false);
});

test("settle: an accepted wave closes the row it carried", () => {
  const s = snapCloneSettle(snapCloneSend(row("a", "idle"), "…"), { state: "ok", msg: "queued — safe to close the tab" });
  assert.equal(s.card.state, "ok");
  assert.equal(s.card.msg, "queued — safe to close the tab");
  assert.equal(s.touched, false);
});

test("settle: accepted, but the buyer changed the row meanwhile → what is on screen was never sent, it is a draft", () => {
  // Clone pressed → the next account picked while the request is still out → the answer lands.
  const sending = snapCloneSend(row("a", "idle"), "…");
  const [changed] = snapCloneTouchRows([sending], ridesDest);
  assert.equal(changed.card.state, "sending");
  const s = snapCloneSettle(changed, { state: "ok", msg: "queued" });
  assert.equal(s.card.state, "idle", "not closed: the destination on screen is not the one that went out");
  assert.equal(s.card.msg, undefined);
  assert.equal(s.touched, false);
});

test("settle: a refusal is always shown, changed meanwhile or not", () => {
  const changed = snapCloneTouch(snapCloneSend(row("a", "idle"), "…"));
  const s = snapCloneSettle(changed, { state: "error", msg: "wave refused — fix the flagged row" });
  assert.equal(s.card.state, "error");
  assert.equal(s.card.msg, "wave refused — fix the flagged row");
  assert.equal(s.touched, false);
});

test("the whole loop: clone → another Destination → clone again → closed on the second answer", () => {
  let rows = [row("a", "idle")];
  rows = rows.map((r) => snapCloneSend(r, "…"));
  rows = rows.map((r) => snapCloneSettle(r, { state: "ok", msg: "queued" }));
  assert.equal(rows[0].card.state, "ok");
  rows = snapCloneTouchRows(rows, ridesDest); // Settings → Destination: account 2
  assert.equal(rows[0].card.state, "idle");
  rows = rows.map((r) => snapCloneSend(r, "…"));
  rows = rows.map((r) => snapCloneSettle(r, { state: "ok", msg: "queued" }));
  assert.equal(rows[0].card.state, "ok");
});
