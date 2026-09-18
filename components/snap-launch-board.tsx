"use client";

// Snapchat LAUNCH board — the Google launcher's shape: a column of campaign CARDS on the left, a
// sticky Launch bay on the right (readiness per card, keys the wave takes, total/day, Preview →
// Launch). One card = N copies = N campaigns = N partner keys; a card's creatives (any number) are
// the ads of each of its campaigns. The create is SERVER-side: one POST /api/snap/launch stamps the
// rows and an after() pump builds every campaign on Snapchat, so once the wave is accepted the tab
// is safe to close. The one client-side phase is the creative UPLOAD (every file of a card → Vercel
// Blob once, reused by every copy) — the unload guard + notice mount then.
// Gating is delegated to snapLaunchWire (the server's own validator) so the bay can never disagree
// with the route's refusal; the keys gate mirrors the registry (free keys ≥ shots).

import { useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { useSnapCatalog, useSnapKeys, type SnapCatalogAccount } from "./use-snap";
import { useSnapTaskManager } from "./snap-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { moneyLabel, parseMoney } from "@/lib/types";
import { SNAP_MAX_SHOTS, snapCurrencySymbol, snapGoalNeedsPixel, type SnapLaunchShotIn } from "@/lib/snap-launch";
import { readCreative, safeBlobName, uploadCreativeFile } from "./blob-uploader";
import { UploadingNotice, useUnloadGuard } from "./upload-guard";
import { CopyIcon, EyeIcon, PlusIcon } from "./icons";
import { FIRST_SNAP_CARD_ID, SnapLaunchCard, buildSnapShot, cloneSnapCard, freshSnapCard, snapCardCopies, snapCardRefusal, snapCardSignature, type SnapCard } from "./snap-launch-card";
import type { RichOption } from "@/lib/catalog";
import { SNAP_ENABLED, type PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

const MAX_CARDS = 45;
/** How often the key registry is re-read while the team's builds are in flight. */
const KEYS_POLL_MS = 10_000;
/** A card's creatives ride to Vercel Blob this many at a time. */
const UPLOAD_CONCURRENCY = 3;

type CardView = {
  card: SnapCard;
  account: SnapCatalogAccount | null;
  currency: string;
  effPixel: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  profileId: string;
  refusal: string | null;
  ready: boolean;
  why: string;
  copies: number;
  keys: string[];
  pixelOptions: RichOption[];
};

export function SnapLaunchBoard({ user }: { user?: SessionUser }) {
  const { catalog, error: catError, retry: retryCatalog } = useSnapCatalog();
  const { keys, error: keysError, refresh: refreshKeys, poll: pollKeys } = useSnapKeys();
  const { setOpen, counts, refresh } = useSnapTaskManager();

  const defaults = catalog?.defaults;
  const [cards, setCards] = useState<SnapCard[]>(() => [freshSnapCard(FIRST_SNAP_CARD_ID)]);
  const [previewed, setPreviewed] = useState(false);

  // The first card is born before the catalog answers, so the board defaults (SNAP_AD_ACCOUNT_ID,
  // SNAP_BRAND_NAME) reach it here, once, and only into fields nobody has touched: an empty account
  // takes the default when the catalog lists it, an empty brand takes the default brand. Pixel and
  // need no backfill — it falls back at render time below; the profile is filled when the catalog lists the default. The catalog is a one-shot load
  // (a manual retry aside), so a deliberately cleared field is not re-filled behind the user's back.
  useEffect(() => {
    if (!catalog) return;
    const d = catalog.defaults;
    const acct = d.adAccount && catalog.accounts.some((a) => a.id === d.adAccount) ? d.adAccount : "";
    const prof = d.profile && catalog.profiles.some((p) => p.id === d.profile) ? d.profile : "";
    if (!acct && !d.brandName && !prof) return;
    // Safe setState-in-effect: fills empty fields from a freshly loaded catalog — converges in one pass.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCards((cs) => {
      const next = cs.map((c) => {
        const p: Partial<SnapCard> = {};
        if (acct && !c.adAccount) p.adAccount = acct;
        if (prof && !c.profileId) p.profileId = prof;
        if (d.brandName && !c.brandName) p.brandName = d.brandName;
        return Object.keys(p).length ? { ...c, ...p } : c;
      });
      return next.some((c, i) => c !== cs[i]) ? next : cs;
    });
  }, [catalog]);

  // The keys view is a one-shot read and the pool changes AFTER a wave is accepted: the server pump
  // claims one key per copy over minutes, while refreshKeys() in fireWave fires before the first
  // claim. So while builds are in flight (anyone's — the pool is shared) the registry is re-read
  // every KEYS_POLL_MS and once more when the last one lands: the free count, the per-card key
  // preview and the "free keys ≥ shots" gate then describe the live pool. Inert when dormant.
  const activeBuilds = counts.active;
  const sawBuildsRef = useRef(false);
  useEffect(() => {
    if (!SNAP_ENABLED) return;
    if (activeBuilds > 0) {
      sawBuildsRef.current = true;
      const iv = window.setInterval(pollKeys, KEYS_POLL_MS);
      return () => window.clearInterval(iv);
    }
    if (sawBuildsRef.current) {
      sawBuildsRef.current = false;
      pollKeys();
    }
  }, [activeBuilds, pollKeys]);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const fireGate = useRef(makeGate());
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  const username = user?.username ?? "";

  const accountById = new Map((catalog?.accounts ?? []).map((a) => [a.id, a]));
  const catalogLoading = catalog === null && !catError;
  const accountOptions: RichOption[] = (catalog?.accounts ?? []).map((a) => {
    // A non-ACTIVE account (CLOSED, …) stays pickable — Snapchat is the authority at the create —
    // but wears its raw status as the warning tag instead of the pixel count.
    const off = a.status && a.status.toUpperCase() !== "ACTIVE" ? a.status : "";
    return {
      value: a.id,
      label: a.name || a.id,
      subLabel: a.id,
      meta: a.currency,
      tag: off || (a.pixelsError ? "px ?" : `${a.pixels.length} px`),
      tagTone: off || a.pixels.length === 0 ? "warn" : "dim",
    };
  });
  const profileOptions: RichOption[] = (catalog?.profiles ?? []).map((p) => ({ value: p.id, label: p.displayName || p.id, subLabel: p.id }));
  const pixelOptionsFor = (a: SnapCatalogAccount | null): RichOption[] => (a?.pixels ?? []).map((p) => ({ value: p.id, label: p.name || p.id, subLabel: p.id }));

  const patch = (id: string, p: Partial<SnapCard>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
    setPreviewed(false);
  };
  const setCardState = (id: string, p: Partial<SnapCard>) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const fresh = () => freshSnapCard(undefined, { adAccount: defaults?.adAccount, pixel: defaults?.pixel, profileId: defaults?.profile, brandName: defaults?.brandName });
  const add = () => {
    setCards((cs) => (cs.length >= MAX_CARDS ? cs : [...cs, fresh()]));
    setPreviewed(false);
  };
  const duplicate = (id: string) => {
    setCards((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1 || cs.length >= MAX_CARDS) return cs;
      return [...cs.slice(0, i + 1), cloneSnapCard(cs[i]), ...cs.slice(i + 1)];
    });
    setPreviewed(false);
  };
  const remove = (id: string) => {
    setCards((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
    setPreviewed(false);
  };
  const toggleCollapse = (id: string) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)));

  // ---- per-card derived view; keys are handed out in card order from the registry's free list ----
  // (a plain loop rather than a map with an outer cursor: the compiler's immutability rule forbids
  // reassigning a render-scope variable inside a callback)
  const freeKeys = keys?.free ?? [];
  const view: CardView[] = [];
  let keyCursor = 0;
  for (const card of cards) {
    const account = card.adAccount ? (accountById.get(card.adAccount) ?? null) : null;
    const currency = account?.currency ?? "";
    const needsPixel = snapGoalNeedsPixel(card.optimizationGoal);
    const effPixel = card.pixel || (account && account.pixels.length === 1 ? account.pixels[0].id : "") || (account && defaults?.pixel && account.pixels.some((p) => p.id === defaults.pixel) ? defaults.pixel : "");
    const pixelNeeded = Boolean(needsPixel && account && account.pixels.length > 1 && !effPixel);
    const noPixel = Boolean(needsPixel && account && account.pixels.length === 0);
    const profileId = card.profileId || defaults?.profile || "";
    const refusal = snapCardRefusal(card, { pixelId: effPixel || undefined, profileId });
    const copies = snapCardCopies(card);
    const ready = Boolean(card.adAccount && account && !pixelNeeded && !noPixel && !refusal);
    const cardKeys = ready ? freeKeys.slice(keyCursor, keyCursor + copies) : [];
    if (ready) keyCursor += copies;
    const why = !card.adAccount ? "pick an ad account" : !account ? "account not in our list" : noPixel ? "no pixel on this account — pick a non-pixel goal" : pixelNeeded ? "pick a Snap Pixel" : refusal ? refusal : "";
    view.push({ card, account, currency, effPixel, pixelNeeded, noPixel, profileId, refusal, ready, why, copies, keys: cardKeys, pixelOptions: pixelOptionsFor(account) });
  }

  const readyViews = view.filter((v) => v.ready);
  const totalShots = readyViews.reduce((n, v) => n + v.copies, 0);
  const totalAds = readyViews.reduce((n, v) => n + v.copies * v.card.files.length, 0);
  const overShotCap = totalShots > SNAP_MAX_SHOTS;
  const keysShort = keys !== null && freeKeys.length < totalShots;
  const totalsByCur = new Map<string, number>();
  for (const v of readyViews) totalsByCur.set(v.currency || "USD", (totalsByCur.get(v.currency || "USD") ?? 0) + parseMoney(v.card.budget) * v.copies);

  const uploadingN = cards.filter((c) => c.state === "uploading").length;
  useUnloadGuard(uploadingN > 0);
  const fireBlocked = firing || readyViews.length === 0 || catalogLoading || Boolean(catError) || overShotCap || keysShort || keys === null;

  const jumpTo = (id: string) => {
    setCards((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null);
    window.setTimeout(() => {
      document.getElementById(`sncard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  /** Every creative of one card → Vercel Blob, UPLOAD_CONCURRENCY at a time; URLs in card order.
   *  The first failure stops the workers from taking new files and rejects — a card launches with
   *  ALL its files or not at all. The reject waits for the uploads already in flight to settle
   *  (allSettled): the wave must not move on to the next card — nor the card show its error and the
   *  unload guard drop — while this card's bytes are still moving. */
  async function uploadCardCreatives(c: SnapCard, waveId: string): Promise<string[]> {
    const urls: string[] = c.files.map(() => "");
    let next = 0;
    let done = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < c.files.length) {
        const i = next++;
        const f = c.files[i];
        const label = c.files.length === 1 ? "Creative" : `Creative #${i + 1} (${f.name})`;
        try {
          const file = await readCreative(f.url, f.name, f.kind === "image" ? "image" : "video", label);
          urls[i] = await uploadCreativeFile(`snap/${username}/${waveId}/${c.id}-${i + 1}-${safeBlobName(f.name, f.kind === "image" ? "creative.jpg" : "creative.mp4")}`, file, label);
        } catch (e) {
          failed = true;
          throw e;
        }
        done += 1;
        if (!failed) setCardState(c.id, { state: "uploading", progress: c.files.length === 1 ? "Uploading the creative…" : `Uploading creatives… ${done}/${c.files.length}` });
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, c.files.length) }, worker));
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
    return urls;
  }

  // ---- fire: upload each ready card's creatives once, fan the copies out, one POST ----
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const ready = view.filter((v) => v.ready);
    const sig = JSON.stringify(ready.map((v) => snapCardSignature(v.card)));
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    const waveId = waveRef.current.id;
    try {
      const shots: SnapLaunchShotIn[] = [];
      const shotCard: string[] = [];
      for (const v of ready) {
        const c = v.card;
        if (c.files.length === 0) continue;
        let mediaUrls: string[] = [];
        setCardState(c.id, { state: "uploading", progress: c.files.length === 1 ? "Uploading the creative…" : `Uploading creatives… 0/${c.files.length}` });
        try {
          mediaUrls = await uploadCardCreatives(c, waveId);
        } catch (e) {
          setCardState(c.id, { state: "error", msg: String((e as Error).message ?? e) });
          continue;
        }
        for (let j = 0; j < v.copies; j++) {
          shots.push(buildSnapShot(c, { currency: v.currency, mediaUrls, desiredKey: v.keys[j], accountName: v.account?.name }));
          shotCard.push(c.id);
        }
        setCardState(c.id, { state: "sending", msg: "queuing on server…" });
      }
      if (shots.length === 0) {
        setFireNote("Nothing was launched — every card failed to upload its creatives. Re-attach the files and try again.");
        return;
      }
      const res = await fetch("/api/snap/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ waveId, shots }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null;
        setPreviewed(false);
        for (const id of new Set(shotCard)) setCardState(id, { state: "ok", msg: "queued — safe to close the tab (the server builds it)" });
        refresh();
        refreshKeys();
        setOpen(true);
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        setFireNote(msg);
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotCard[Number(m[1]) - 1] : null;
        for (const id of new Set(shotCard)) setCardState(id, culprit ? (id === culprit ? { state: "error", msg } : { state: "error", msg: "wave refused — fix the flagged card" }) : { state: "error", msg });
      }
    } catch (e) {
      setFireNote(String((e as Error).message ?? e));
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const noAccountCount = view.filter((v) => !v.card.adAccount).length;
  const pixelNeededCount = view.filter((v) => v.pixelNeeded || v.noPixel).length;
  const refusalCount = view.filter((v) => v.card.adAccount && v.account && !v.pixelNeeded && !v.noPixel && v.refusal).length;

  return (
    <>
      <Header partner="in" onPartnerChange={changePartner} user={user} platform="snapchat" />
      <SnapNav active="launch" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 xl:px-6">
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{cards.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">Snap Ads · web</span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={add} disabled={cards.length >= MAX_CARDS} className="flex h-9 items-center gap-2 rounded-lg border border-[#FFFC00]/40 bg-[#FFFC00]/10 px-3.5 text-[13px] font-semibold text-[#f3f0a3] transition-all duration-150 hover:bg-[#FFFC00]/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>
            {view.map((v, i) => (
              <SnapLaunchCard
                key={v.card.id}
                card={v.card}
                index={i}
                user={user}
                accountOptions={accountOptions}
                pixelOptions={v.pixelOptions}
                profileOptions={profileOptions}
                currency={v.currency}
                accountName={v.account?.name ?? ""}
                effPixel={v.effPixel}
                pixelNeeded={v.pixelNeeded}
                noPixel={v.noPixel}
                refusal={v.refusal}
                ready={v.ready}
                catalogLoading={catalogLoading}
                nextKeys={v.keys}
                highlight={highlightId === v.card.id}
                onPatch={patch}
                onDuplicate={duplicate}
                onRemove={remove}
                onToggleCollapse={toggleCollapse}
              />
            ))}
            <button type="button" onClick={add} disabled={cards.length >= MAX_CARDS} className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line2 py-3 text-[13px] font-medium text-dim transition-all duration-200 hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="flex shrink-0 items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Launch bay</span>
                <span className={"rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] " + (readyViews.length === cards.length ? "border-launch/30 bg-launch/10 text-launch2" : "border-warn/25 bg-warn/5 text-warn")}>
                  {readyViews.length}/{cards.length} ready
                </span>
              </div>
              <p className="text-[10.5px] leading-snug text-faint">Each copy takes one partner key and becomes its own campaign, born PAUSED and activated once its ads exist — one ad per creative on the card, any number. Creative uploads run from this tab; keep it open until they finish.</p>
              <div className="-mx-2 flex flex-col">
                {view.map((v, i) => (
                  <button key={v.card.id} type="button" onClick={() => jumpTo(v.card.id)} title="Jump to this campaign" className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <span className="w-5 shrink-0 font-mono text-[10.5px] text-faint group-hover:text-[#f3f0a3]">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{v.account?.name || "No account"}</span>
                      <span className={"block truncate text-[10.5px] " + (v.ready ? "text-faint" : "text-warn")}>{v.ready ? `×${v.copies} · ${v.card.files.length} ad${v.card.files.length === 1 ? "" : "s"} · ${v.keys.join(", ") || "keys pending"}` : v.why}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-dim">
                      {snapCurrencySymbol(v.currency || "USD")}
                      {moneyLabel(v.card.budget)}
                    </span>
                    <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (v.ready ? "bg-launch2" : "bg-warn")} />
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Campaigns</span>
                  <span className="font-mono tabular-nums">{totalShots}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-faint">Ads</span>
                  <span className="font-mono tabular-nums">{totalAds}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-faint">Free keys</span>
                  <span className={"font-mono tabular-nums " + (keysShort ? "text-warn" : "")}>{keys ? `${freeKeys.length}/${keys.poolMax}` : keysError ? "?" : "…"}</span>
                </div>
                {[...totalsByCur.entries()].map(([cur, total]) => (
                  <div key={cur} className="flex items-center justify-between">
                    <span className="text-faint">Total/day{totalsByCur.size > 1 ? ` (${cur})` : ""}</span>
                    <span className="font-mono tabular-nums">
                      {snapCurrencySymbol(cur)}
                      {moneyLabel(total)}
                    </span>
                  </div>
                ))}
              </div>
              <UploadingNotice n={uploadingN} compact />
              <button type="button" onClick={() => { setPreviewed(true); setFireNote(null); }} disabled={readyViews.length === 0} className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>
              {previewed ? (
                <button type="button" onClick={() => void fireWave()} disabled={fireBlocked} className="animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2">
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Launching…" : `Launch ${totalShots}`}
                </button>
              ) : null}
              {fireNote ? <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">{fireNote}</div> : null}
              {catError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the Snapchat accounts — {catError}.</span>
                  <button type="button" onClick={retryCatalog} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Retry
                  </button>
                </div>
              ) : null}
              {keysError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t read the key registry — {keysError}.</span>
                  <button type="button" onClick={refreshKeys} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Retry
                  </button>
                </div>
              ) : null}
              {catalog?.profilesError ? <p className="text-center text-[10.5px] leading-relaxed text-warn">Public Profile list unavailable ({catalog.profilesError}){defaults?.profile ? " — the default profile from SNAP_PROFILE_ID is used" : " — set SNAP_PROFILE_ID or retry"}.</p> : null}
              {noAccountCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{noAccountCount} campaign{noAccountCount === 1 ? " needs" : "s need"} an ad account.</p> : null}
              {pixelNeededCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{pixelNeededCount} campaign{pixelNeededCount === 1 ? " needs" : "s need"} a pixel decision — see the card.</p> : null}
              {refusalCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{refusalCount} campaign{refusalCount === 1 ? " is" : "s are"} incomplete — see the note on the card.</p> : null}
              {overShotCap ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{totalShots} campaigns — one wave carries at most {SNAP_MAX_SHOTS}. Lower the copies or split into two waves.</p> : null}
              {keysShort ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">Only {freeKeys.length} free key{freeKeys.length === 1 ? "" : "s"} for {totalShots} campaigns — release keys on the Keys page or lower the copies.</p> : null}
              {previewed ? (
                <div className="animate-pop-in flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/40 p-3">
                  <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                  {readyViews.map((v) => (
                    <p key={v.card.id} className="text-[11.5px] leading-snug text-dim">
                      <span className="text-ink">{v.account?.name}</span> → ×{v.copies} · {v.card.files.length} creative{v.card.files.length === 1 ? "" : "s"} · {snapCurrencySymbol(v.currency || "USD")}
                      {moneyLabel(v.card.budget)}/day · {v.card.geo.join("+")} · <span className="text-[#f3f0a3]">{v.keys.join(", ")}</span>
                    </p>
                  ))}
                  <div className="mt-1 border-t border-line pt-1.5 text-[11.5px] text-ink">{totalShots} campaign{totalShots === 1 ? "" : "s"} · {totalAds} ad{totalAds === 1 ? "" : "s"} · fires ONE wave · the tab is safe to close once accepted (uploads finish first).</div>
                </div>
              ) : null}
              {counts.active > 0 ? <p className="text-center text-[10.5px] leading-relaxed text-faint">{counts.active} Snapchat build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.</p> : null}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
