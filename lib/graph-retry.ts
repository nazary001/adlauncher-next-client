// Pure classifier for post-birth Graph writes on LION-born campaigns (the exact-name rename):
// which failures deserve another poll tick and which are final. No runtime imports — leaf module
// for `node --test` (tests/graph-retry.test.ts).

/** Graph errors worth another poll tick (the campaign / ad set still being born, throttling,
 *  Meta's transient "unknown error"); anything else — permission walls, business restrictions,
 *  an account no bearer sees, bad ids — never clears by waiting. */
export function isTransientGraphError(message: string | null | undefined): boolean {
  const msg = String(message ?? "");
  if (!msg) return false;
  return /adset_not_born_yet|throttl|rate ?limit|request limit|\(#4\)|\(#17\)|\(#32\)|\(#613\)|80004|temporarily|try again later|unknown error/i.test(
    msg,
  );
}
