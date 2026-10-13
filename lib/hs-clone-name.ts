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

/** A clone is born by the CLONING team's LION key, whichever team launched the source (any team's
 *  campaign is a clone source since 13.10) — so the grammar prefix the board keeps from the source
 *  carries the cloning team's acronym, never the source's: `[DD/MM] (ELV-02) API …` → `[DD/MM]
 *  (GLO-02) API …`. Without it the board previewed — and the pump's Graph rename would write — a
 *  name that says another team launched the clone. Only the acronym slot right after the date is
 *  touched; a prefix that does not follow the grammar is returned as it is. */
export function withOwnAcr(prefix: string, acr: string): string {
  const own = acr.trim();
  return own ? prefix.replace(/^(\s*\[\d{2}\/\d{2}\]\s*)\([^)]*\)/, `$1(${own})`) : prefix;
}

/** LION appends the suffix verbatim; keep the wire bounded like the legacy single-shot path. */
export const LION_NAME_SUFFIX_MAX = 80;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The LION `name_suffix` for a duplicate shot = the board's whole edited tail, squashed and
 *  capped to the wire limit. Empty tail → nothing to append. */
export function lionWireSuffix(editedTail: string): string {
  return squash(editedTail ?? "").slice(0, LION_NAME_SUFFIX_MAX);
}
