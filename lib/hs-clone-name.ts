// Pure naming helper for the HS LION duplicate rail — no runtime deps (node:test covers it).
//
// LION's `/duplicate/` builds the clone's WHOLE name itself (`[DD/MM] (ACR) API (CLONE) - (LABEL)
// - [ITS geo list] - <landing family> <lang> <name_suffix> <random5>`; verified live 09-08) and the
// only naming input its body takes is `name_suffix`. The source's tail ("MKDIGITAL - Alex-Tima -
// CREO - …") is NOT carried over, so an addition-only wire (just " - Nazar") lost every tag the
// buyer typed (owner report 09-09: "Alex-Tima disappears in LION"). The WHOLE edited tail rides
// now — LION's own name repeats its family word once, and the pump then puts the board's EXACT
// name on the campaign through a campaign-level Graph write (allowed even under the VD-C1 ad-set
// ward; LION syncs the Facebook name back into its lists within ~15-20 min).

/** LION appends the suffix verbatim; keep the wire bounded like the legacy single-shot path. */
export const LION_NAME_SUFFIX_MAX = 80;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The LION `name_suffix` for a duplicate shot = the board's whole edited tail, squashed and
 *  capped to the wire limit. Empty tail → nothing to append. */
export function lionWireSuffix(editedTail: string): string {
  return squash(editedTail ?? "").slice(0, LION_NAME_SUFFIX_MAX);
}
