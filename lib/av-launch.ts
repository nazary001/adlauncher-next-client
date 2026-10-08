// Server-only config + helpers for the AV (ActiveView) launch rail: an AIF-style direct Graph build —
// campaign→adset→creative→ad on AV's OWN token — with an AV destination (article / redirect path, see
// lib/av-destination) and an AV key in utm_campaign (lib/av-keys). The catalogs (ad accounts,
// fanpages) come from the same shared fb-graph machinery as MO/AIF, bound to the rail's token and its
// own cache identity, so the partners' data can never bleed.
//
// WHICH token: the owner's pick on /tokens (slots av.launch / av.clone). AV has NO env default (owner
// call 28.09: a new, separate token) — an unassigned slot is a clean config error, never another
// partner's bearer. Every helper below is BOUND to one resolved rail, so routes never handle a
// bearer directly.

import {
  type FanPage,
  type TokenAdAccount,
  type TokenCatalog,
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
import { avRegisteredCount } from "./av-link";
import { TEAM } from "./team.ts";

type Json = Record<string, unknown>;

/** Server twin of the build-time switcher gate (NEXT_PUBLIC_* is inlined into both bundles): every
 *  /api/av/* route answers 404 `av_rail_disabled` without it — the rail is dormant, not half-open. */
export const avRailEnabled = (): boolean => TEAM.partners.includes("av") && process.env.NEXT_PUBLIC_AV_ENABLED === "1";

/** How many pool keys (av001…avN) the owner registered in AV's "UTM Campaign Values" — the ONLY
 *  launchable keys. Unset / 0 = the stub: no AV launch or clone can claim a key. */
export const avKeysRegistered = (): number => avRegisteredCount(process.env.AV_KEYS_REGISTERED);

export type AvRail = {
  /** Vault label — for task rows and the boards' badge. */
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
  advertisablePages: () => Promise<FanPage[]>;
  isAdvertisablePage: (pageId: string) => Promise<boolean>;
  advertisablePageName: (pageId: string) => Promise<string>;
};

export type AvRailResult = { ok: true; rail: AvRail } | { ok: false; error: string };

/**
 * The AV rail bound to the token the owner assigned for `rail`. An error is a clean config verdict the
 * route surfaces verbatim (no token assigned / assigned token unreadable).
 */
export async function avRail(rail: TokenRail): Promise<AvRailResult> {
  const r = await resolveSlot(slotOf("av", rail));
  const t = r.tokens[0];
  // resolveSlot's verdict already names the slot ("no_token — no token is assigned to AV · Launches …").
  if (!r.ok || !t) return { ok: false, error: r.error ?? "no_av_token" };
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
      advertisablePages: () => advertisablePages(cat),
      isAdvertisablePage: (pageId) => isAdvertisablePage(pageId, cat),
      advertisablePageName: (pageId) => advertisablePageName(pageId, cat),
    },
  };
}
