// The two partner marker pools' codecs — import-free so lib/gcm-claim and lib/aif-claim (and their
// `node --test` live tests) load without lib/partners' React icon imports. lib/partners re-exports
// these; nothing else should duplicate them.

/** MagicOffers buy-link contract since 2026-08-10: gcm=1..200. */
export const GCM_POOL_MAX = 200;
/** Codes below 100 keep their canonical 2-digit zero-padded form (every live link and registry row
 *  uses it); 100–200 are plain 3-digit. */
export const gcmCode = (n: number): string => String(n).padStart(2, "0");

/** Airfind Rewarded Web brand pool test01..test700 (2-digit zero-padded below 10, per the partner's doc). */
export const AIF_POOL_MAX = 700;
export const aifBrandCode = (n: number): string => `test${String(n).padStart(2, "0")}`;
