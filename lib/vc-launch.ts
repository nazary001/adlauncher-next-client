// Server-only config + helpers for the VC (ValueClick) launch rail: an AIF-style direct Graph build —
// campaign→adset→creative→ad on VC's OWN token — with the buyer's VC landingpage link as the ad link
// (lib/vc-link). The catalogs (ad accounts + their pixels, fanpages) come from the same shared
// fb-graph machinery as MO/AIF/AV, bound to the rail's token and its own cache identity, so the
// partners' data can never bleed.
//
// WHICH token: the owner's pick on /tokens (slots vc.launch / vc.clone). VC has NO env default — an
// unassigned slot is a clean config error, never another partner's bearer. NOTE: the token VC itself
// holds (the landingpage Tracking token) is a Conversions-API-only dataset token — it cannot build
// campaigns; the launch token is a system user with ads_management on the VC cabinets (23.10: system
// user «Lecarthelaouforvc», app AV ANNA 10 — GC-for-VC-BR-742 … -762 + 10 fanpages).
// WHICH cabinets: only VC's by name (lib/vc-link isVcAccountName) — the picker, the fire-time check and
// the TOOL intersection all read the narrowed list, so a stray cabinet of the token is never offered.

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
import { TEAM } from "./team.ts";
import { isVcAccountName } from "./vc-link";

type Json = Record<string, unknown>;

/** Every /api/vc/* route answers 404 `vc_rail_disabled` on a team without VC (glo-02). */
export const vcRailEnabled = (): boolean => TEAM.partners.includes("vc");

export type VcRail = {
  /** Vault label — for task rows and the boards' badge. */
  label: string;
  id: string;
  fp: string;
  source: "registry" | "env";
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

export type VcRailResult = { ok: true; rail: VcRail } | { ok: false; error: string };

/**
 * The VC rail bound to the token the owner assigned for `rail`. An error is a clean config verdict the
 * route surfaces verbatim (no token assigned / assigned token unreadable).
 */
export async function vcRail(rail: TokenRail): Promise<VcRailResult> {
  const r = await resolveSlot(slotOf("vc", rail));
  const t = r.tokens[0];
  // resolveSlot's verdict already names the slot ("no_token — no token is assigned to VC · Launches …").
  if (!r.ok || !t) return { ok: false, error: r.error ?? "no_vc_token" };
  const token = t.token;
  const cat: TokenCatalog = { token, cacheKey: t.cacheKey };
  const vcAccounts = async (): Promise<TokenAdAccount[]> => (await tokenAdAccounts(cat)).filter((a) => isVcAccountName(a.name));
  return {
    ok: true,
    rail: {
      label: t.label,
      id: t.id,
      fp: t.fp,
      source: t.source,
      cat,
      fbGet: (path) => fbGet(path, token),
      fbPost: (path, params) => fbPost(path, params, token),
      createAdset: (path, payload) => createAdsetSelfHealing(path, payload, token),
      uploadVideo: (accountId, fileUrl, name) => uploadVideo(accountId, fileUrl, name, token),
      uploadImage: (accountId, buf) => uploadImage(accountId, buf, token),
      waitForVideo: (videoId) => waitForVideo(videoId, undefined, token),
      videoThumb: (videoId) => videoThumb(videoId, token),
      tokenAdAccounts: vcAccounts,
      isTokenAccount: async (accountId) => (await isTokenAccount(accountId, cat)) && (await vcAccounts()).some((a) => a.id === accountId),
      accountName: (accountId) => tokenAccountName(accountId, cat),
      accountPixels: (accountId) => accountPixels(accountId, cat),
      advertisablePages: () => advertisablePages(cat),
      isAdvertisablePage: (pageId) => isAdvertisablePage(pageId, cat),
      advertisablePageName: (pageId) => advertisablePageName(pageId, cat),
    },
  };
}
