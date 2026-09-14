// Server-only config + helpers for the AIF (Airfind Rewarded Web) launch rail: an MO-style
// direct Graph build — campaign→adset→creative→ad on the AIF partner's system-user token — with
// the partner's RW page as the ad link (lib/partners aifLaunch branch). The catalogs (ad accounts,
// fanpages, per-account pixels) come from the same shared fb-graph machinery as MO, bound to the
// rail's token and its own cache identity, so the two partners' data can never bleed.
//
// WHICH token: the owner's pick on /tokens (lib/fb-tokens, 2026-09-14) — one for launches, one
// for clones; while a slot is unassigned, the FB_AIF_LAUNCH_TOKEN env var (today's behaviour).
// Every helper below is BOUND to one resolved rail, so routes never handle a bearer directly.

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
  tokenAccountName,
  tokenAdAccounts,
} from "./fb-graph";
import { uploadImage, uploadVideo, videoThumb, waitForVideo } from "./fb-media";
import { resolveSlot } from "./fb-tokens";
import { type TokenRail, slotOf } from "./fb-token-registry";

type Json = Record<string, unknown>;

export type AifRail = {
  /** Vault label / "AIF token (env)" — for task rows and the boards' badge. */
  label: string;
  id: string;
  fp: string;
  source: "registry" | "env";
  /** Raw bearer for lib/clone-run's parameterized Graph calls (server-only, never to the browser). */
  token: string;
  cat: TokenCatalog;
  fbGet: (path: string) => Promise<Json>;
  fbPost: (path: string, params: Json) => Promise<Json>;
  createAdset: (path: string, payload: Json) => Promise<Json>;
  uploadVideo: (accountId: string, fileUrl: string, name: string) => Promise<string>;
  uploadImage: (accountId: string, buf: Buffer) => Promise<string>;
  waitForVideo: (videoId: string) => Promise<void>;
  videoThumb: (videoId: string) => Promise<string>;
  tokenAdAccounts: () => Promise<TokenAdAccount[]>;
  isTokenAccount: (accountId: string) => Promise<boolean>;
  accountName: (accountId: string) => Promise<string>;
  accountPixels: (accountId: string) => Promise<{ id: string; name: string }[]>;
  advertisablePages: () => Promise<FanPage[]>;
  isAdvertisablePage: (pageId: string) => Promise<boolean>;
  advertisablePageName: (pageId: string) => Promise<string>;
};

export type AifRailResult = { ok: true; rail: AifRail } | { ok: false; error: string };

/**
 * The AIF rail bound to the token the owner assigned for `rail`. An error is a clean config
 * verdict the route surfaces verbatim (no token assigned / assigned token unreadable).
 */
export async function aifRail(rail: TokenRail): Promise<AifRailResult> {
  const r = await resolveSlot(slotOf("aif", rail));
  const t = r.tokens[0];
  if (!r.ok || !t) return { ok: false, error: r.error ?? "no_aif_token" };
  const token = t.token;
  const cat: TokenCatalog = { token, cacheKey: t.cacheKey };
  return {
    ok: true,
    rail: {
      label: t.label,
      id: t.id,
      fp: t.fp,
      source: t.source,
      token,
      cat,
      fbGet: (path) => fbGet(path, token),
      fbPost: (path, params) => fbPost(path, params, token),
      createAdset: (path, payload) => createAdsetSelfHealing(path, payload, token),
      uploadVideo: (accountId, fileUrl, name) => uploadVideo(accountId, fileUrl, name, token),
      uploadImage: (accountId, buf) => uploadImage(accountId, buf, token),
      waitForVideo: (videoId) => waitForVideo(videoId, undefined, token),
      videoThumb: (videoId) => videoThumb(videoId, token),
      tokenAdAccounts: () => tokenAdAccounts(cat),
      isTokenAccount: (accountId) => isTokenAccount(accountId, cat),
      accountName: (accountId) => tokenAccountName(accountId, cat),
      accountPixels: (accountId) => accountPixels(accountId, cat),
      advertisablePages: () => advertisablePages(cat),
      isAdvertisablePage: (pageId) => isAdvertisablePage(pageId, cat),
      advertisablePageName: (pageId) => advertisablePageName(pageId, cat),
    },
  };
}
