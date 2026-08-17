// Server-only config + helpers for the AIF (Airfind Rewarded Web) launch rail: an MO-style
// direct Graph build — campaign→adset→creative→ad on OUR AIF system-user token — with the
// partner's RW page as the ad link (lib/partners aifLaunch branch). The catalogs (ad accounts,
// fanpages, per-account pixels) come from the same shared fb-graph machinery as MO, just bound
// to this token and its own cache identity, so the two partners' data can never bleed.

import {
  type FanPage,
  type TokenAdAccount,
  type TokenCatalog,
  accountPixels,
  advertisablePageName,
  advertisablePages,
  createAdsetSelfHealing,
  fbGet,
  fbPost,
  isAdvertisablePage,
  isTokenAccount,
  tokenAdAccounts,
} from "./fb-graph";
import { uploadImage, uploadVideo, videoThumb, waitForVideo } from "./fb-media";

type Json = Record<string, unknown>;

// The write token: the AIF partner's system user. Server-only — never reaches the browser.
const AIF_FB_TOKEN = process.env.FB_AIF_LAUNCH_TOKEN ?? "";

export const aifTokenConfigured = (): boolean => AIF_FB_TOKEN.length > 0;

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
export const aifAccountPixels = (accountId: string): Promise<{ id: string; name: string }[]> =>
  accountPixels(accountId, CAT);
export const aifAdvertisablePages = (): Promise<FanPage[]> => advertisablePages(CAT);
export const aifIsAdvertisablePage = (pageId: string): Promise<boolean> => isAdvertisablePage(pageId, CAT);
export const aifAdvertisablePageName = (pageId: string): Promise<string> => advertisablePageName(pageId, CAT);
