// Server-only config + helpers for the AIF (Airfind Rewarded Web) launch rail: an MO-style
// direct Graph build — campaign→adset→creative→ad on OUR AIF system-user token — with the
// partner's RW page as the ad link (lib/partners aifLaunch branch). The catalogs (ad accounts,
// fanpages, per-account pixels) come from the same shared fb-graph machinery as MO, just bound
// to this token and its own cache identity, so the two partners' data can never bleed.

import {
  type FanPage,
  type TokenAdAccount,
  type TokenCatalog,
  FbError,
  accountPixels,
  advertisablePageName,
  advertisablePages,
  createAdsetSelfHealing,
  fbGet,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  tokenAccountName,
  tokenAdAccounts,
} from "./fb-graph";
import { uploadImage, uploadVideo, videoThumb, waitForVideo } from "./fb-media";
import { type Bound, pickAifPixel } from "./partners";

type Json = Record<string, unknown>;

// The write token: the AIF partner's system user. Server-only — never reaches the browser.
const AIF_FB_TOKEN = process.env.FB_AIF_LAUNCH_TOKEN ?? "";

export const aifTokenConfigured = (): boolean => AIF_FB_TOKEN.length > 0;
/** Raw bearer for lib/clone-run's parameterized Graph calls (server-only, never to the browser). */
export const aifRawToken = (): string => AIF_FB_TOKEN;

/** This rail's catalog identity: own in-process caches + own app-cache row (`aif-adaccounts`). */
const CAT: TokenCatalog = { token: AIF_FB_TOKEN, cacheKey: "aif" };

/** Graph calls on the AIF token — same client (backoff, budget, error mapping) as the MO rail,
 *  only the bearer differs. The media/adset helpers bind the token so routes never handle it. */
export const aifFbGet = (path: string): Promise<Json> => fbGet(path, AIF_FB_TOKEN);
export const aifFbPost = (path: string, params: Json): Promise<Json> => fbPost(path, params, AIF_FB_TOKEN);
export const aifCreateAdset = (path: string, payload: Json): Promise<Json> =>
  createAdsetSelfHealing(path, payload, AIF_FB_TOKEN);
export const aifUploadVideo = (accountId: string, fileUrl: string, name: string): Promise<string> =>
  uploadVideo(accountId, fileUrl, name, AIF_FB_TOKEN);
export const aifUploadImage = (accountId: string, buf: Buffer): Promise<string> =>
  uploadImage(accountId, buf, AIF_FB_TOKEN);
export const aifWaitForVideo = (videoId: string): Promise<void> => waitForVideo(videoId, undefined, AIF_FB_TOKEN);
export const aifVideoThumb = (videoId: string): Promise<string> => videoThumb(videoId, AIF_FB_TOKEN);

// Catalogs — feed both the UI pickers (/api/aif/adaccounts, /api/aif/fanpages) and the
// per-launch server-side validation, exactly like the MO rail.
export const aifTokenAdAccounts = (): Promise<TokenAdAccount[]> => tokenAdAccounts(CAT);
export const aifIsTokenAccount = (accountId: string): Promise<boolean> => isTokenAccount(accountId, CAT);
export const aifAccountName = (accountId: string): Promise<string> => tokenAccountName(accountId, CAT);
export const aifAccountPixels = (accountId: string): Promise<{ id: string; name: string }[]> =>
  accountPixels(accountId, CAT);

/** The conversion pixel of an AIF account, derived LIVE from the token's own data
 *  (act_<id>/adspixels — owner ask 2026-09-02: no hardcoded pixel id). Selection rule shared
 *  with the card's display (pickAifPixel). Throws a 400-shaped FbError naming the BM remedy
 *  when no pixel is derivable — conversion launches must refuse BEFORE anything is claimed or
 *  created rather than guess where Purchase optimization lands. */
export async function aifDerivedPixel(accountId: string): Promise<Bound> {
  const pixels = await accountPixels(accountId, CAT);
  const pick = pickAifPixel(pixels);
  if (!pick) {
    const names = pixels.map((p) => `${p.name} (${p.id})`).join(", ");
    throw new FbError(
      pixels.length === 0
        ? `no_pixel_on_account — share the AIF postback pixel to act_${accountId} in Business Manager first (or launch with Clicks optimization)`
        : `pixel_ambiguous — act_${accountId} carries ${pixels.length} pixels (${names}); leave exactly one (or a single AIF-named one) shared in BM`,
      { accountId },
      400,
    );
  }
  return pick;
}
export const aifAdvertisablePages = (): Promise<FanPage[]> => advertisablePages(CAT);
export const aifIsAdvertisablePage = (pageId: string): Promise<boolean> => isAdvertisablePage(pageId, CAT);
export const aifAdvertisablePageName = (pageId: string): Promise<string> => advertisablePageName(pageId, CAT);
