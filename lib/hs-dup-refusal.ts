// LION's duplicate/ preflight refusals, explained for the buyer who reads the row. Pure leaf (no
// runtime imports — tests/hs-dup-refusal.test.ts loads it under `node --test`).

/** "No valid creative URL found in campaign ads" is LION telling us it cannot rebuild a single
 *  ad of the SOURCE: the ad's page post (object story) is gone, or the creative is an object-story
 *  ad LION's duplicate cannot read media from. Deterministic per source — a retry answers the
 *  same (live 12–15.10: source 120249883063400760, 7 refusals across three buyers), so the row
 *  says what to do instead of looking like a LION hiccup. */
export function explainDupRefusal(reason: string): string {
  if (/no valid creative url/i.test(reason)) {
    return `${reason} — LION can't rebuild this source's ads (their post/creative is gone or unreadable), so every clone of it fails; pick another source`;
  }
  return reason;
}
