"use client";

// Google Ads LAUNCH board — the FB launcher's shape for fresh Demand Gen campaigns: a column of
// campaign CARDS (add / duplicate / remove / collapse) on the left, a sticky "Launch bay" on the
// right (per-card readiness, total/day per currency, Preview → Launch). Copies are made by the
// Autofill modal (one shot = one card), not a per-card multiplier — LION's own launcher texture.
// Like the clone board the create is SERVER-side: one POST /api/google/launch stamps the rows and
// an after() pump builds every campaign on LION, so once the wave is accepted the tab is safe to
// close. The one client-side phase is the creative UPLOAD (logo files / uploaded videos → Vercel
// Blob, per ad group) — while that runs the tab must stay open, so the unload guard + notice mount
// exactly then. Gating is delegated to googleLaunchWire (the server's own validator) so the bay can
// never disagree with LION's refusal.

import { useRef, useState } from "react";
import { Header } from "./header";
import { GoogleNav } from "./google-nav";
import { useGoogleCustomers, type GwCustomer } from "./use-google";
import { useGoogleTaskManager } from "./google-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { moneyLabel, parseMoney } from "@/lib/types";
import { googleBidPlan, type GoogleLaunchShotIn } from "@/lib/google-bid";
import { readCreative, safeBlobName, uploadCreativeFile } from "./blob-uploader";
import { UploadingNotice, useUnloadGuard } from "./upload-guard";
import { CopyIcon, EyeIcon, PlusIcon, SparklesIcon } from "./icons";
import {
  GoogleLaunchCard,
  buildLaunchShot,
  cloneLaunchCard,
  curSymbol,
  FIRST_CARD_ID,
  freshLaunchCard,
  launchCardRefusal,
  launchCardSignature,
  type AdGroup,
  type AdGroupUpload,
  type LaunchCard,
} from "./google-launch-card";
import { GoogleAutofillModal } from "./google-autofill-modal";
import { GoogleBulkAdGroupsModal } from "./google-bulk-adgroups-modal";
import type { RichOption } from "@/lib/catalog";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

/** Server-side wave cap (lib/google-wave GOOGLE_MAX_SHOTS) mirrored so an oversized wave is
 *  refused BEFORE Launch instead of every card flipping to error on the route's 400. One shot =
 *  one card, so this caps the ready-card count directly. */
const MAX_SHOTS = 45;
const MAX_CARDS = 45;

/** One card's derived, catalog-dependent view (account, pixel rule, currency, wire refusal). */
type CardView = {
  card: LaunchCard;
  target: GwCustomer | null;
  currency: string;
  effPixel: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  refusal: string | null;
  ready: boolean;
  why: string;
  pixelOptions: RichOption[];
};

export function GoogleLaunchBoard({ user }: { user?: SessionUser }) {
  const { customers, error: custError, retry: retryCustomers, acr } = useGoogleCustomers();
  const { setOpen, counts, refresh } = useGoogleTaskManager();

  const [cards, setCards] = useState<LaunchCard[]>(() => [freshLaunchCard(FIRST_CARD_ID)]);
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [autofillOpen, setAutofillOpen] = useState(false);
  const [bulkCardId, setBulkCardId] = useState<string | null>(null);
  const fireGate = useRef(makeGate());
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One waveId per prepared wave (same ready-card content): a retry after a lost answer re-sends
  // the same id, and the server's wave claim makes the re-POST a no-op instead of a second pump.
  const waveRef = useRef<{ sig: string; id: string } | null>(null);

  const username = user?.username ?? "";
  const customerById = new Map((customers ?? []).map((c) => [c.customerId, c]));
  const customersLoading = customers === null && !custError;
  const customersFailed = Boolean(custError);

  const customerOptions: RichOption[] = (customers ?? []).map((c) => ({
    value: c.customerId,
    label: c.name,
    subLabel: c.customerId,
    meta: c.currency,
    tag: `${c.pixels.length} px`,
    tagTone: c.pixels.length === 0 ? "warn" : "dim",
  }));
  const pixelOptionsFor = (t: GwCustomer | null): RichOption[] => (t?.pixels ?? []).map((p) => ({ value: p, label: p }));

  const patch = (id: string, p: Partial<LaunchCard>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
    setPreviewed(false);
  };
  // A per-ad-group edit merges at the board level (never through a stale card closure) so an async
  // logo-dims read or a fast second keystroke can't clobber a concurrent edit on the same card.
  const patchAdGroup = (cardId: string, agId: string, p: Partial<AdGroup>) => {
    setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, adGroups: c.adGroups.map((a) => (a.id === agId ? { ...a, ...p } : a)) } : c)));
    setPreviewed(false);
  };
  // A launch-lifecycle patch (upload progress / result) must NOT reset the preview.
  const setCardState = (id: string, p: Partial<LaunchCard>) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const add = () => {
    setCards((cs) => (cs.length >= MAX_CARDS ? cs : [...cs, freshLaunchCard()]));
    setPreviewed(false);
  };
  const duplicate = (id: string) => {
    setCards((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1 || cs.length >= MAX_CARDS) return cs;
      return [...cs.slice(0, i + 1), cloneLaunchCard(cs[i]), ...cs.slice(i + 1)];
    });
    setPreviewed(false);
  };
  const remove = (id: string) => {
    setCards((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
    setPreviewed(false);
  };
  const toggleCollapse = (id: string) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)));

  // ---- autofill: append N whole cards copied from card 1 (capped at MAX_CARDS) --------------
  const applyAutofill = (built: LaunchCard[]) => {
    setCards((cs) => [...cs, ...built].slice(0, MAX_CARDS));
    setAutofillOpen(false);
    setPreviewed(false);
  };
  // ---- bulk ad groups: replace or append a card's ad-group list --------------------------------
  const applyBulk = (groups: AdGroup[], replace: boolean) => {
    if (!bulkCardId || groups.length === 0) return;
    setCards((cs) => cs.map((c) => (c.id === bulkCardId ? { ...c, adGroups: replace ? groups : [...c.adGroups, ...groups] } : c)));
    setBulkCardId(null);
    setPreviewed(false);
  };

  // ---- per-card derived view (pure — no effects) ---------------------------------------------
  const view: CardView[] = cards.map((card) => {
    const target = card.customer ? customerById.get(card.customer) ?? null : null;
    const currency = target?.currency ?? "";
    const effPixel = card.pixel || (target && target.pixels.length === 1 ? target.pixels[0] : "");
    const pixelNeeded = Boolean(target && target.pixels.length > 1 && !effPixel);
    const noPixel = Boolean(target && target.pixels.length === 0);
    const refusal = launchCardRefusal(card);
    const ready = Boolean(card.customer && target && !pixelNeeded && !refusal);
    const why = !card.customer
      ? "pick a customer"
      : !target
        ? "account not launchable"
        : pixelNeeded
          ? "pick a conversion pixel"
          : refusal
            ? refusal
            : "";
    return { card, target, currency, effPixel, pixelNeeded, noPixel, refusal, ready, why, pixelOptions: pixelOptionsFor(target) };
  });

  const readyViews = view.filter((v) => v.ready);
  const totalShots = readyViews.length; // one shot = one card
  const overShotCap = totalShots > MAX_SHOTS;

  const totalsByCur = new Map<string, number>();
  for (const v of readyViews) {
    const cur = v.currency || "?";
    totalsByCur.set(cur, (totalsByCur.get(cur) ?? 0) + parseMoney(v.card.budget));
  }

  const uploadingN = cards.filter((c) => c.state === "uploading").length;
  useUnloadGuard(uploadingN > 0);

  const fireBlocked = firing || readyViews.length === 0 || customersLoading || customersFailed || overShotCap;

  // ---- launch bay row jump -------------------------------------------------------------------
  const jumpTo = (id: string) => {
    setCards((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null);
    window.setTimeout(() => {
      document.getElementById(`glcard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  // ---- fire ----------------------------------------------------------------------------------
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const ready = view.filter((v) => v.ready); // snapshot — the loop mutates card state below
    const sig = JSON.stringify(ready.map((v) => launchCardSignature(v.card)));
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    const waveId = waveRef.current.id;

    try {
      const shots: GoogleLaunchShotIn[] = [];
      const shotCard: string[] = []; // parallel to shots: the card id each shot came from
      for (const v of ready) {
        const c = v.card;
        // Upload every ad group's logo file + video files (per ad group so the wire's ads line up).
        const needsUpload = c.adGroups.some((ag) => (ag.logoMode === "file" && ag.logoFiles.length > 0) || (ag.videoMode === "files" && ag.videoFiles.length > 0));
        const uploaded: AdGroupUpload[] = [];
        let failed = false;
        if (needsUpload) {
          setCardState(c.id, { state: "uploading", progress: "Preparing uploads…" });
          try {
            for (let i = 0; i < c.adGroups.length; i++) {
              const ag = c.adGroups[i];
              const u: AdGroupUpload = {};
              if (ag.logoMode === "file" && ag.logoFiles.length > 0) {
                const f = ag.logoFiles[0];
                setCardState(c.id, { progress: `Ad group ${i + 1}: uploading logo…` });
                const file = await readCreative(f.url, f.name, "image", "Logo");
                u.logoUrl = await uploadCreativeFile(`google/${username}/${waveId}/${c.id}-ag${i}-logo-${safeBlobName(f.name, "logo.jpg")}`, file, "Logo");
              }
              if (ag.videoMode === "files" && ag.videoFiles.length > 0) {
                u.videoUrls = [];
                for (let j = 0; j < ag.videoFiles.length; j++) {
                  const f = ag.videoFiles[j];
                  setCardState(c.id, { progress: `Ad group ${i + 1}: video ${j + 1}/${ag.videoFiles.length}…` });
                  const file = await readCreative(f.url, f.name, "video", `Video ${j + 1}`);
                  const url = await uploadCreativeFile(`google/${username}/${waveId}/${c.id}-ag${i}-v${j}-${safeBlobName(f.name, "video.mp4")}`, file, `Video ${j + 1}`);
                  u.videoUrls.push(url);
                }
              }
              uploaded[i] = u;
            }
          } catch (e) {
            // This card's upload died — mark it and keep launching the others.
            setCardState(c.id, { state: "error", msg: String((e as Error).message ?? e) });
            failed = true;
          }
        }
        if (failed) continue;
        shots.push(buildLaunchShot(c, { currency: v.currency, accountName: v.target?.name, uploaded }));
        shotCard.push(c.id);
        setCardState(c.id, { state: "sending", msg: "queuing on server…" });
      }

      if (shots.length === 0) {
        setFireNote("Nothing was launched — every card failed to upload its creatives. Re-attach the files and try again.");
        return;
      }

      const res = await fetch("/api/google/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waveId: waveRef.current.id, shots }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; queued?: number; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null; // accepted — the next wave is a new wave
        setPreviewed(false);
        for (const id of shotCard) setCardState(id, { state: "ok", msg: "queued — safe to close the tab (LION builds it server-side)" });
        refresh();
        setOpen(true);
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        setFireNote(msg);
        // "shot N: …" pins the failure to one card; otherwise every contributing card carries it.
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotCard[Number(m[1]) - 1] : null;
        for (const id of shotCard) {
          setCardState(id, culprit ? (id === culprit ? { state: "error", msg } : { state: "error", msg: "wave refused — fix the flagged card" }) : { state: "error", msg });
        }
      }
    } catch (e) {
      setFireNote(String((e as Error).message ?? e));
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  // Leaving the Google platform entirely → a full navigation back to the Facebook board on the
  // picked partner (a different server component tree, not a client route within Google).
  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const noAccountCount = view.filter((v) => v.card.customer === "").length;
  const pixelNeededCount = view.filter((v) => v.pixelNeeded).length;
  const refusalCount = view.filter((v) => Boolean(v.card.customer) && v.target && !v.pixelNeeded && v.refusal).length;

  return (
    <>
      <Header partner="br" onPartnerChange={changePartner} user={user} platform="google" />
      <GoogleNav active="launch" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 xl:px-6">
          {/* ---- campaign cards ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{cards.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">Demand Gen</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutofillOpen(true)}
                  title="Make copies of campaign 01"
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3 text-[13px] font-medium text-dim transition-all duration-150 hover:border-accent/50 hover:text-ink active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <SparklesIcon className="h-4 w-4" />
                  Autofill
                </button>
                <button
                  type="button"
                  onClick={add}
                  disabled={cards.length >= MAX_CARDS}
                  className="flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>

            {view.map((v, i) => (
              <GoogleLaunchCard
                key={v.card.id}
                card={v.card}
                index={i}
                user={user}
                customerOptions={customerOptions}
                pixelOptions={v.pixelOptions}
                currency={v.currency}
                effPixel={v.effPixel}
                acr={acr}
                accountName={v.target?.name ?? ""}
                pixelNeeded={v.pixelNeeded}
                noPixel={v.noPixel}
                refusal={v.refusal}
                ready={v.ready}
                customersLoading={customersLoading}
                highlight={highlightId === v.card.id}
                onPatch={patch}
                onPatchAdGroup={patchAdGroup}
                onDuplicate={duplicate}
                onRemove={remove}
                onToggleCollapse={toggleCollapse}
                onBulk={setBulkCardId}
              />
            ))}

            <button
              type="button"
              onClick={add}
              disabled={cards.length >= MAX_CARDS}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line2 py-3 text-[13px] font-medium text-dim transition-all duration-200 hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          {/* ---- launch bay ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="flex shrink-0 items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Launch bay</span>
                <span
                  className={
                    "rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] " +
                    (readyViews.length === cards.length ? "border-launch/30 bg-launch/10 text-launch2" : "border-warn/25 bg-warn/5 text-warn")
                  }
                >
                  {readyViews.length}/{cards.length} ready
                </span>
              </div>

              <p className="text-[10.5px] leading-snug text-faint">
                Fresh Demand Gen campaigns — LION builds each one server-side. Logo/video uploads run from this tab; keep it open until they finish.
              </p>

              {/* per-card readiness rows */}
              <div className="-mx-2 flex flex-col">
                {view.map((v, i) => (
                  <button
                    key={v.card.id}
                    type="button"
                    onClick={() => jumpTo(v.card.id)}
                    title="Jump to this campaign"
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <span className="w-5 shrink-0 font-mono text-[10.5px] text-faint group-hover:text-[#9db8ff]">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{v.target?.name || "No account"}</span>
                      <span className={"block truncate text-[10.5px] " + (v.ready ? "text-faint" : "text-warn")}>
                        {v.ready ? `${v.currency || "?"} · ${v.card.adGroups.length} AG` : v.why}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-dim">
                      {curSymbol(v.currency)}
                      {moneyLabel(v.card.budget)}
                    </span>
                    <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (v.ready ? "bg-launch2" : "bg-warn")} />
                  </button>
                ))}
              </div>

              {/* totals */}
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Ready</span>
                  <span className="font-mono tabular-nums">{readyViews.length}</span>
                </div>
                {[...totalsByCur.entries()].map(([cur, total]) => (
                  <div key={cur} className="flex items-center justify-between">
                    <span className="text-faint">Total/day{totalsByCur.size > 1 ? ` (${cur})` : ""}</span>
                    <span className="font-mono tabular-nums">
                      {curSymbol(cur === "?" ? "" : cur)}
                      {moneyLabel(total)}
                    </span>
                  </div>
                ))}
              </div>

              <UploadingNotice n={uploadingN} compact />

              <button
                type="button"
                onClick={() => {
                  setPreviewed(true);
                  setFireNote(null);
                }}
                disabled={readyViews.length === 0}
                className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>

              {previewed ? (
                <button
                  type="button"
                  onClick={() => void fireWave()}
                  disabled={fireBlocked}
                  className="animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 hover:shadow-[0_10px_36px_rgba(16,185,129,0.5)] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
                >
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Launching…" : `Launch ${totalShots}`}
                </button>
              ) : null}

              {fireNote ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">{fireNote}</div>
              ) : null}

              {/* gates */}
              {customersFailed ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the Google accounts — {custError}.</span>
                  <button
                    type="button"
                    onClick={retryCustomers}
                    className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {noAccountCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {noAccountCount} campaign{noAccountCount === 1 ? " needs" : "s need"} a customer — every launch needs somewhere to land.
                </p>
              ) : null}
              {pixelNeededCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {pixelNeededCount} campaign{pixelNeededCount === 1 ? " needs" : "s need"} a conversion pixel — that account has several, pick one.
                </p>
              ) : null}
              {refusalCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {refusalCount} campaign{refusalCount === 1 ? " has" : "s have"} an incomplete creative — see the note on the card.
                </p>
              ) : null}
              {overShotCap ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {totalShots} campaigns — one wave carries at most {MAX_SHOTS}. Remove some or split into two waves.
                </p>
              ) : null}

              {/* preview list */}
              {previewed ? (
                <div className="animate-pop-in flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/40 p-3">
                  <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                  {readyViews.map((v) => {
                    const plan = googleBidPlan({ mode: "launch", override: v.card.bidStrategy, typedBid: v.card.bid.trim() });
                    const bidText = "refusal" in plan ? "—" : plan.label;
                    return (
                      <p key={v.card.id} className="text-[11.5px] leading-snug text-dim">
                        <span className="text-ink">{v.target?.name}</span> → {curSymbol(v.currency)}
                        {moneyLabel(v.card.budget)}/day · {v.card.adGroups.length} AG
                        <span className="text-[#9db8ff]"> · {bidText}</span>
                      </p>
                    );
                  })}
                  <div className="mt-1 border-t border-line pt-1.5 text-[11.5px] text-ink">
                    {totalShots} campaign{totalShots === 1 ? "" : "s"} · fires ONE wave to LION · the tab is safe to close once accepted (uploads finish first).
                  </div>
                </div>
              ) : null}

              {counts.active > 0 ? (
                <p className="text-center text-[10.5px] leading-relaxed text-faint">
                  {counts.active} Google build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.
                </p>
              ) : null}
            </div>
          </aside>
        </div>
      </main>

      <GoogleAutofillModal open={autofillOpen} source={cards[0] ?? null} onClose={() => setAutofillOpen(false)} onCreate={applyAutofill} />
      <GoogleBulkAdGroupsModal open={bulkCardId !== null} onClose={() => setBulkCardId(null)} onCreate={applyBulk} />
    </>
  );
}
