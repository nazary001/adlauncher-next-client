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

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** LION's landing family — the `<TEMPLATE> - <Niche> <ll>` it writes between the geo group and the
 *  suffix ("CAPTCHA-6 - Cars pt", "CAPTCHA - Digital-marketing es", "AGE-GATE - Digital-marketing
 *  en"). LION puts its OWN in front of whatever suffix it gets, so a tail that starts with one came
 *  from a LION-born name. */
const LION_FAMILY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\s+-\s+[A-Z][A-Za-z-]*\s+[a-z]{2}\b[\s-]*/;

/** Does this tail start with LION's landing family (the source was named by LION, not by us)? */
export const isLionBornTail = (tail: string): boolean => LION_FAMILY.test(squash(tail));

/** Drop every leading LION family from a tail — LION writes its own in front of the suffix again.
 *  Without it a clone of a LION-born clone read "CAPTCHA-6 - Cars pt CAPTCHA-6 - Cars pt CARS - …"
 *  (106 of 340 GLO-04 clones on 27.11, three times over on a clone of a clone of a clone). */
export function stripLionFamily(tail: string): string {
  let t = squash(tail);
  while (LION_FAMILY.test(t)) t = t.replace(LION_FAMILY, "").trim();
  return t;
}

/** LION's random tag at the end of a name it built ("… - Anna CFabg", "… - Taras 11zhO"): five
 *  letters/digits of mixed kinds, after a word of the same segment (never a whole " - " segment —
 *  that is a word the buyer typed, a login like "Taras" included). */
const LION_TAG = /([^\s-])\s+([A-Za-z0-9]{5})$/;
const mixedKinds = (s: string): boolean => [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length >= 2;
export function stripLionTag(tail: string): string {
  const t = squash(tail);
  const m = LION_TAG.exec(t);
  return m && mixedKinds(m[2]) ? t.slice(0, m.index + 1) : t;
}

/** A clone's default tail from its SOURCE's tail: a LION-born source's family and its random tag
 *  are LION's own words — they go, so the clone's name does not stack them (LION adds a fresh pair).
 *  A tail we named (FB-token renames, launches) is kept as it is. */
export function cleanSourceTail(tail: string): string {
  const t = squash(tail);
  return isLionBornTail(t) ? stripLionTag(stripLionFamily(t)) : t;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the tail already name the buyer — as a whole " - " segment, or as the last word? */
function namesOwner(tail: string, owner: string): boolean {
  if (!owner) return true;
  const segs = tail.split(/\s+-\s+/).map((s) => s.trim().toLowerCase());
  if (segs.includes(owner.toLowerCase())) return true;
  return new RegExp(`(?:^|\\s)${escapeRe(owner)}$`, "i").test(tail);
}

/** The LION `name_suffix` for a duplicate / JURO shot: the board's edited tail, squashed, without a
 *  leading LION family (LION writes its own in front), ending with the BUYER's login (the team reads
 *  who launched a clone from its name — owner 27.11: «добавляется ли имя баера»), capped to the wire
 *  limit so that the login survives the cut: a long source tail used to lose its end — the login —
 *  to the cap ("… | HSWEAPON | tuBEx | RECEN", 40 of 340 GLO-04 clones on 27.11). */
export function lionWireSuffix(editedTail: string, owner = ""): string {
  const o = squash(owner);
  let t = stripLionFamily(editedTail ?? "");
  if (o && !namesOwner(t, o)) t = t ? `${t} - ${o}` : o;
  if (t.length <= LION_NAME_SUFFIX_MAX) return t;
  const end = o && t.toLowerCase().endsWith(` - ${o.toLowerCase()}`) ? t.slice(t.length - o.length - 3) : "";
  return `${t.slice(0, LION_NAME_SUFFIX_MAX - end.length).replace(/[\s|-]+$/, "")}${end}`;
}
