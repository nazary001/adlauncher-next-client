// Pure naming helper for the HS LION duplicate rail — no runtime deps (node:test covers it).
//
// LION's `/duplicate/` builds the clone's WHOLE name itself (`[DD/MM] (ACR) API (CLONE) - (LABEL)
// - [CC] - <landing family> <lang> <random5>`) and the only naming input its body takes is
// `name_suffix`, appended verbatim at the end (partner API docs 09-08; the `name` field the board
// used to send is not in the contract and was silently dropped — every clone since 08-14 lost the
// buyer's tail, e.g. "… Digital-marketing en Qzd9L" instead of "… - Taras").
//
// The board's editable tail defaults to `<source tail> - <owner>` and the buyer may edit it, so the
// wire must carry only what they ADDED beyond the source's own tail — sending the whole tail would
// double the family LION already wrote ("… en Qzd9L AGE-GATE - Digital-marketing en qTnTL - Taras").

/** LION appends the suffix verbatim; keep the wire bounded like the legacy single-shot path. */
export const LION_NAME_SUFFIX_MAX = 80;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * What the buyer added to the source's tail = the LION `name_suffix` for a duplicate shot.
 * - `"<source tail> - Taras"` → `"Taras"` (the default tail; multi-part additions keep their dashes)
 * - a tail rewritten wholesale (no longer starts with the source tail) → sent as typed
 * - a tail equal to the source tail, or empty → `""` (nothing to append)
 * Matching is case-insensitive and whitespace-tolerant; the result is capped to the wire limit.
 */
export function lionNameSuffix(editedTail: string, sourceTail: string): string {
  const edited = squash(editedTail ?? "");
  const source = squash(sourceTail ?? "");
  if (!edited) return "";
  let rest = edited;
  if (source && edited.toLowerCase().startsWith(source.toLowerCase())) {
    rest = edited.slice(source.length).replace(/^\s*-?\s*/, "");
  }
  return squash(rest).slice(0, LION_NAME_SUFFIX_MAX);
}
