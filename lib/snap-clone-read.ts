// Snapchat cloner — server side of POST /api/snap/sources: the link's refs (campaign ids and partner
// keys) → the live campaigns read back from Snapchat, one clone SOURCE each. Keys resolve through
// the registry (the campaign the key is bound to NOW); every chain is read as campaign → ad squads →
// ads, and the creatives / media of each account involved come from ONE library listing per account
// (cached) with a by-id read for anything it lacks. A source that cannot be read carries the reason;
// it never sinks the others.

import { SnapApiError, snapAccountCreativesRaw, snapAccountMediaRaw, snapAdAccounts, snapCampaignAdSquadsRaw, snapCampaignAdsRaw, snapCampaignRaw, snapCreativeRaw, snapMediaRaw } from "./snap-api";
import { isSnapKey, snapCloneResolve, snapSourceErrorText } from "./snap-launch";
import { buildSnapCloneSource, snapEnvelopeEntities, type SnapCloneSource } from "./snap-source";
import { listSnapKeys } from "./snap-keys";

export type SnapCloneSourceResult = {
  /** What the link / the board asked for (a campaign id or a partner key). */
  ref: string;
  /** The campaign it means ("" when a key resolves to none). */
  campaignId: string;
  /** For a key: who holds it in the registry. */
  holder?: string;
  accountName?: string;
  source?: SnapCloneSource;
  error?: string;
};

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
/** Campaign chains read at once (each is 1 + 2 parallel GETs) — the token's 10 rps is shared with the pump. */
const CHAIN_CONCURRENCY = 2;
const ACCOUNT_CONCURRENCY = 2;
const BY_ID_CONCURRENCY = 3;

async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const errorText = (e: unknown): string => snapSourceErrorText(e instanceof SnapApiError ? e.status : undefined, e instanceof Error ? e.message : String(e));

export async function readSnapCloneSources(refs: string[]): Promise<SnapCloneSourceResult[]> {
  // ---- refs → campaigns (keys through the registry, read only when a key was asked) ----
  let registry: { key: string; campaign_id?: string; user?: string }[] | null = [];
  let registryError = "";
  if (refs.some(isSnapKey)) {
    try {
      registry = await listSnapKeys();
    } catch (e) {
      registry = null;
      registryError = e instanceof Error ? e.message : String(e);
    }
  }
  const targets = snapCloneResolve(refs, registry, registryError);

  // ---- every distinct campaign: campaign → ad squads + ads ----
  const chains = new Map<string, { campaign: Rec; squads: Rec[]; ads: Rec[] } | { error: string }>();
  const ids = [...new Set(targets.map((t) => t.campaignId).filter(Boolean))];
  await eachLimit(ids, CHAIN_CONCURRENCY, async (id) => {
    try {
      const campaign = snapEnvelopeEntities(await snapCampaignRaw(id), "campaigns")[0];
      if (!campaign) throw new Error("Snapchat answered without the campaign");
      const [squadPages, adPages] = await Promise.all([snapCampaignAdSquadsRaw(id), snapCampaignAdsRaw(id)]);
      chains.set(id, { campaign, squads: squadPages.flatMap((p) => snapEnvelopeEntities(p, "adsquads")), ads: adPages.flatMap((p) => snapEnvelopeEntities(p, "ads")) });
    } catch (e) {
      chains.set(id, { error: errorText(e) });
    }
  });

  // ---- creatives + media: one library listing per account, then by id for what it lacks ----
  const creatives = new Map<string, Rec>();
  const media = new Map<string, Rec | { error: string }>();
  const okChains = [...chains.values()].filter((c): c is { campaign: Rec; squads: Rec[]; ads: Rec[] } => !("error" in c));
  const accounts = [...new Set(okChains.map((c) => str(c.campaign.ad_account_id)).filter(Boolean))];
  await eachLimit(accounts, ACCOUNT_CONCURRENCY, async (acct) => {
    // A failed listing is not fatal: every id it would have answered is read by id below.
    const [cr, md] = await Promise.allSettled([snapAccountCreativesRaw(acct), snapAccountMediaRaw(acct)]);
    if (cr.status === "fulfilled") for (const c of cr.value.flatMap((p) => snapEnvelopeEntities(p, "creatives"))) creatives.set(str(c.id), c);
    if (md.status === "fulfilled") for (const m of md.value.flatMap((p) => snapEnvelopeEntities(p, "media"))) media.set(str(m.id), m);
  });
  const wantCreatives = [...new Set(okChains.flatMap((c) => c.ads.map((a) => str(a.creative_id))).filter((id) => id && !creatives.has(id)))];
  await eachLimit(wantCreatives, BY_ID_CONCURRENCY, async (id) => {
    try {
      const c = snapEnvelopeEntities(await snapCreativeRaw(id), "creatives")[0];
      if (c) creatives.set(id, c);
    } catch {
      /* the ad then names the creative it could not read */
    }
  });
  const wantMedia = [
    ...new Set(
      okChains
        .flatMap((c) => c.ads.map((a) => str(creatives.get(str(a.creative_id))?.top_snap_media_id)))
        .filter((id) => id && !media.has(id)),
    ),
  ];
  await eachLimit(wantMedia, BY_ID_CONCURRENCY, async (id) => {
    try {
      const m = snapEnvelopeEntities(await snapMediaRaw(id), "media")[0];
      media.set(id, m ?? { error: `media ${id} could not be read` });
    } catch (e) {
      media.set(id, { error: `media ${id}: ${errorText(e)}` });
    }
  });

  // ---- assemble, in the order asked ----
  const accountName = new Map((await snapAdAccounts().catch(() => [])).map((a) => [a.id, a.name]));
  return targets.map((t) => {
    if (t.error || !t.campaignId) return { ref: t.ref, campaignId: t.campaignId, ...(t.holder ? { holder: t.holder } : {}), error: t.error || "unresolved" };
    const chain = chains.get(t.campaignId);
    if (!chain || "error" in chain) return { ref: t.ref, campaignId: t.campaignId, ...(t.holder ? { holder: t.holder } : {}), error: chain?.error ?? "not read" };
    const source = buildSnapCloneSource({ campaign: chain.campaign, squads: chain.squads, ads: chain.ads, creatives, media });
    return {
      ref: t.ref,
      campaignId: t.campaignId,
      ...(t.holder ? { holder: t.holder } : {}),
      accountName: accountName.get(source.adAccountId) ?? "",
      source,
    };
  });
}
