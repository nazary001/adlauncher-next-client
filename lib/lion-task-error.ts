// LION's creation-status `error` — pure readers (no runtime deps; node:test covers them).
//
// Since late November (seen 26–27.11 on GLO-04) LION answers a failing task with a STRUCTURED error:
// a plain-language `message` of its own ("Minimum ROAS bidding is not available on this account"),
// Meta's wording in `title` / `detail` ("Minimum ROAS Isn't Available"), the numeric `code` /
// `subcode`, its advice in `fix`, and `is_transient`. The task itself keeps saying CREATING_* — LION
// retries in a loop. The wall matchers (lib/lion-dup-bid lionRoasWall, lib/juro juroBlockingError)
// were written against Meta's wording in `message`, so they stopped matching: on 26.11 72 GLO-04 rows
// (min ROAS ×60, an ad set Facebook refused ×12) waited out the follow-up's 3 h window and closed
// as "Still not finished on LION after 3 h" — LION was still on CREATING_* 20 h later.

export type LionTaskError =
  | {
      message?: string;
      title?: string;
      detail?: string;
      technical?: string;
      why?: string;
      fix?: string;
      step?: string;
      code?: number;
      subcode?: number;
      is_transient?: boolean;
      method?: string;
      date?: string;
    }
  | string
  | null
  | undefined;

const s = (v: unknown): string => (v == null ? "" : String(v).trim());

/** The error as ONE line the wall matchers read: LION's message, Meta's title / detail / technical
 *  wording and the subcode. The legacy string shape (and `{ message }` only) passes unchanged. */
export function lionErrorText(e: LionTaskError): string {
  if (!e) return "";
  if (typeof e === "string") return e.trim();
  const parts = [s(e.message), s(e.title), s(e.detail), s(e.technical)].filter(Boolean);
  if (e.subcode != null && s(e.subcode)) parts.push(`subcode ${s(e.subcode)}`);
  return [...new Set(parts)].join(" | ");
}

/** Facebook walls LION's task loop never gets past (seen on GLO-04 26–27.11: tasks on CREATING_*
 *  for hours with the same non-transient answer). An ACCOUNT wall holds for every shot bound to that
 *  account; the others are about this one shot. Not here on purpose: 3858081 (EU "advertiser name")
 *  — LION retries it with the page name and those tasks complete; 2446671 (min ROAS) — its own
 *  matchers settle it (family-wide); anything unknown keeps waiting as before. */
const FINAL_WALLS: Record<number, "account" | "shot"> = {
  1359188: "account", // The ad account has no payment method
  1885316: "account", // This ad account is restricted from advertising (disabled account)
  3858196: "shot", // Facebook refused to publish this ad set
  1487194: "shot", // The profile does not have permission for this action
};

/** A structured, non-transient error of a still-running task that LION will never get past —
 *  the reason for the row (LION's own words and advice), and how far it reaches. Null otherwise. */
export function lionFinalWall(e: LionTaskError): { reason: string; scope: "account" | "shot" } | null {
  if (!e || typeof e === "string") return null;
  if (e.is_transient !== false) return null;
  const scope = FINAL_WALLS[Number(e.subcode)];
  if (!scope) return null;
  const what = s(e.message) || s(e.title) || `Facebook error ${s(e.subcode)}`;
  const fix = s(e.fix);
  return { reason: `Facebook: ${what}${fix ? ` — ${fix}` : ""} (LION keeps retrying it and never finishes the task)`, scope };
}
