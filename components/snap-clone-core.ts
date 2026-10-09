// Pure row-state rules of the Snapchat CLONE board (components/snap-clone-board.tsx). No React, no
// browser, no "@/" imports — so the Node test runner loads it by relative path.
//
// A source row that went out is CLOSED ("ok"): Preview → Clone pressed twice must never build the
// same copies twice. It becomes a draft again when the buyer changes what it would send — on the row
// itself OR in the wave's Settings it rides (destination, copies per source, start paused) — at any
// moment, including the seconds its wave is still being accepted.
//
// Owner report 08.10: "когда делаешь запуск в 1 аккаунт, потом выбираешь другой — не даёт запустить,
// нужно перезагружать страничку". The Settings controls changed what the row would send and never
// re-opened it: the row stayed "queued", Generate preview stayed disabled, only a reload helped.

/** The part of a clone row these rules read and write. `touched` = the buyer changed the row while
 *  its wave was still being accepted (the answer of that wave must not close it). */
export type SnapCloneRowState = { card: { state: string; msg?: string }; touched?: boolean };

const draft = <R extends SnapCloneRowState>(row: R): R => ({ ...row, touched: false, card: { ...row.card, state: "idle", msg: undefined } });

/** The buyer changed what this row would send: a row that went out (or was refused) is a draft
 *  again; a row whose wave is still out stays "sending" and remembers the change; a draft is
 *  returned as is (the same object). */
export function snapCloneTouch<R extends SnapCloneRowState>(row: R): R {
  const state = row.card.state;
  if (state === "ok" || state === "error") return draft(row);
  // A HELD row ("unsure": its wave got no answer and the server is being asked — wave-hold-core)
  // is touched like a sending one: it stays held, and if the server turns out to have the wave the
  // edited row becomes a draft (what is on screen is not what went out), never a closed clone.
  if ((state === "sending" || state === "unsure") && !row.touched) return { ...row, touched: true };
  return row;
}

/** A WAVE-level change (Settings): every row `rides` picks — the rows that take that default — is
 *  touched. A row with its own value sends exactly what it sent before, so it stays closed
 *  (re-opening it would fire the very same clone twice). The SAME array when nothing changes. */
export function snapCloneTouchRows<R extends SnapCloneRowState>(rows: R[], rides: (row: R) => boolean = () => true): R[] {
  let changed = false;
  const next = rows.map((r) => {
    if (!rides(r)) return r;
    const t = snapCloneTouch(r);
    if (t !== r) changed = true;
    return t;
  });
  return changed ? next : rows;
}

/** The row leaves with a wave: what it carries is what is on screen NOW, so an older change no
 *  longer counts. */
export function snapCloneSend<R extends SnapCloneRowState>(row: R, msg: string): R {
  return { ...row, touched: false, card: { ...row.card, state: "sending", msg } };
}

/** The wave's answer for a row it carried. Accepted and unchanged → closed. Accepted but changed
 *  meanwhile → a draft: what is on screen is NOT what went out (the Snap tasks drawer shows the
 *  clone that did). A refusal is always shown. */
export function snapCloneSettle<R extends SnapCloneRowState>(row: R, outcome: { state: "ok" | "error"; msg: string }): R {
  if (outcome.state === "ok" && row.touched) return draft(row);
  return { ...row, touched: false, card: { ...row.card, state: outcome.state, msg: outcome.msg } };
}
