"use client";

// Snapchat CLONE board (/snap/clone?ids=<campaign ids>&keys=<partner keys>) — the Google / TikTok
// cloner's shape: a sticky Settings column on the left (wave defaults: destination, copies, start
// paused · summary · Preview → Launch) and the selected SOURCE campaigns on the right, one panel each.
// Unlike those rails Snapchat has no LION weapon: the board reads every source back from Snapchat
// (POST /api/snap/sources — campaign, ad squad, ads with creative + media + moderation verdict),
// drafts the clone from it (snapCloneDraft: same goal / bid / budget / countries / age / devices /
// texts / landing; a NOTE for every setting the launcher cannot carry) and fires the very same wave
// as the launcher (POST /api/snap/launch): each copy is a NEW campaign on a NEW partner key, born
// PAUSED and activated once its ads exist. The source's media are reused by id on their own ad
// account and re-hosted from Snap's download link on another — nothing is uploaded from this tab,
// so the tab is safe to close as soon as the wave is accepted. Ads Snap REJECTED in the source are
// left out by default (a rerun of a rejected creative is a second strike for the whole org).

import { useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { useSnapCatalog, useSnapKeys, type SnapCatalogAccount } from "./use-snap";
import { useSnapTaskManager } from "./snap-task-manager";
import { snapCloneSend, snapCloneSettle, snapCloneTouch, snapCloneTouchRows } from "./snap-clone-core";
import { Select } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { makeGate } from "@/lib/launch-guards";
import { limitMoneyCents, moneyLabel, parseMoney } from "@/lib/types";
import type { RichOption } from "@/lib/catalog";
import {
  SNAP_BID_MAX,
  SNAP_BRAND_MAX,
  SNAP_BUDGET_MAX,
  SNAP_CLONE_MAX_SOURCES,
  SNAP_DEFAULT_BUDGET,
  SNAP_DIRECT_LANDINGS,
  SNAP_GEO_PRESETS,
  SNAP_HEADLINE_MAX,
  SNAP_MAX_COPIES,
  SNAP_MAX_SHOTS,
  SNAP_MEDIA_MAX_BYTES,
  SNAP_OBJECTIVES,
  snapBidKind,
  snapBidLabel,
  snapCampaignName,
  snapCloneDraft,
  snapCloneRefs,
  snapCurrencySymbol,
  snapDeviceShort,
  snapDirectLanding,
  snapGoalLabel,
  snapGoalNeedsPixel,
  snapLandingBase,
  snapLandingSegments,
  snapNicheFromLanding,
  snapObjectiveLabel,
  todaySaoPauloDotDDMM,
  type SnapCloneDraft,
} from "@/lib/snap-launch";
import type { SnapCloneSourceResult } from "@/lib/snap-clone-read";
import {
  AGE_OPTIONS,
  COUNTRY_OPTIONS,
  CTA_OPTIONS,
  Counted,
  DEVICE_OPTIONS,
  GOAL_OPTIONS,
  OBJECTIVE_OPTIONS,
  STRATEGY_OPTIONS,
  Seg,
  buildSnapShot,
  freshSnapCard,
  inp,
  micro,
  snapCardMediaCount,
  snapCardRefusal,
  snapCardSignature,
  type SnapCard,
  type SnapRemoteCreative,
} from "./snap-launch-card";
import { CheckIcon, ChevronsIcon, CopyIcon, EyeIcon, GlobeIcon, PlayIcon, PlusIcon, RetryIcon, TrashIcon, XIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

/** How often the key registry is re-read while builds are in flight (the launch board's rhythm). */
const KEYS_POLL_MS = 10_000;

/** One source campaign: what Snapchat answered about it, the clone drafted from it, and the clone's
 *  editable fields. `card.adAccount` "" = the wave's destination (the source's own account by
 *  default); `card.copies` "" = the wave's copies. */
type CloneRow = {
  id: string;
  /** What was asked: a Snapchat campaign id or a partner key. */
  ref: string;
  loading: boolean;
  /** The read itself failed (network / HTTP) — "Retry read" re-arms it. */
  failed?: string;
  result: SnapCloneSourceResult | null;
  draft: SnapCloneDraft | null;
  card: SnapCard;
  /** The buyer changed the row while its wave was still being accepted (snap-clone-core). */
  touched?: boolean;
  /** The full field set is open (objective, texts, targeting, landing). */
  more: boolean;
};

let rowSeq = 0;
const freshRow = (ref: string): CloneRow => ({ id: `cl-${++rowSeq}`, ref, loading: false, result: null, draft: null, card: { ...freshSnapCard(), copies: "" }, more: false });

/** The clone's card, drafted from the source (the wave decides account and copies until the row does). */
function cardFromDraft(d: SnapCloneDraft, brandFallback: string): SnapCard {
  const f = d.fields;
  return {
    ...freshSnapCard(),
    adAccount: "",
    pixel: f.pixel,
    profileId: f.profileId,
    objective: f.objective,
    optimizationGoal: f.optimizationGoal,
    bidStrategy: f.bidStrategy,
    bid: f.bid,
    budget: f.budget || SNAP_DEFAULT_BUDGET,
    headline: f.headline,
    brandName: f.brandName || brandFallback,
    cta: f.cta,
    geo: [...f.geo],
    minAge: f.minAge,
    deviceOs: f.deviceOs,
    landingUrl: f.landingUrl,
    suffix: f.suffix,
    copies: "",
    remote: d.creatives.map((c) => ({ ...c, on: c.pick })),
  };
}

type RowView = {
  row: CloneRow;
  /** The clone's card as it would fire (effective account, pixel, profile, copies, start paused). */
  eff: SnapCard;
  account: SnapCatalogAccount | null;
  /** The destination is the row's own pick (vs the wave's / the source's own). */
  ownAccount: boolean;
  /** The clone lands on another account than the source's (its media are re-hosted). */
  moves: boolean;
  currency: string;
  pixelOptions: RichOption[];
  pixelNeeded: boolean;
  noPixel: boolean;
  refusal: string | null;
  ready: boolean;
  why: string;
  copies: number;
  ads: number;
  keys: string[];
};

const fmtDay = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const mb = (bytes: number | null): string => (bytes == null ? "" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const REVIEW_TONE: Record<string, string> = {
  APPROVED: "border-launch/40 bg-launch/15 text-launch2",
  PENDING: "border-accent/40 bg-accent/15 text-[#9db8ff]",
  REJECTED: "border-danger/40 bg-danger/15 text-danger",
};

export function SnapCloneBoard({ user, initialRefs = [] }: { user?: SessionUser; initialRefs?: string[] }) {
  const { catalog, error: catError, retry: retryCatalog } = useSnapCatalog();
  const { keys, error: keysError, refresh: refreshKeys, poll: pollKeys } = useSnapKeys();
  const { setOpen, counts, refresh } = useSnapTaskManager();
  const defaults = catalog?.defaults;
  const username = user?.username ?? "";

  const [rows, setRows] = useState<CloneRow[]>(() => snapCloneRefs(initialRefs).map(freshRow));
  /** Wave destination: "" = every source's OWN account. */
  const [dest, setDest] = useState("");
  const [copies, setCopies] = useState("1");
  const [startPaused, setStartPaused] = useState(false);
  const [draftRefs, setDraftRefs] = useState("");
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SnapRemoteCreative | null>(null);
  const fireGate = useRef(makeGate());
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- the key registry follows the builds in flight (anyone's — the pool is shared) ----
  const activeBuilds = counts.active;
  const sawBuildsRef = useRef(false);
  useEffect(() => {
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

  // ---- sources: read back from Snapchat (POST /api/snap/sources), batched + debounced ----
  // A ref is claimed when its read starts; a FAILED read keeps its claim (re-arming it here would
  // loop against a dead Snap) — the row offers "Retry read" instead.
  const fetchedRef = useRef(new Set<string>());
  const brandRef = useRef("");
  useEffect(() => {
    brandRef.current = defaults?.brandName ?? "";
  }, [defaults]);
  useEffect(() => {
    const refs = [...new Set(rows.filter((r) => !r.result && !r.loading && !r.failed).map((r) => r.ref))].filter((ref) => !fetchedRef.current.has(ref));
    if (refs.length === 0) return;
    const timer = setTimeout(() => {
      refs.forEach((ref) => fetchedRef.current.add(ref));
      setRows((rs) => rs.map((r) => (refs.includes(r.ref) ? { ...r, loading: true } : r)));
      void (async () => {
        try {
          const res = await fetch("/api/snap/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refs }), signal: AbortSignal.timeout(130_000) });
          const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; sources?: SnapCloneSourceResult[] };
          if (!res.ok || !d?.ok) throw new Error(d?.error || `HTTP ${res.status}`);
          const byRef = new Map((d.sources ?? []).map((s) => [s.ref, s]));
          setRows((rs) =>
            rs.map((r) => {
              if (!refs.includes(r.ref)) return r;
              const s = byRef.get(r.ref);
              if (!s) return { ...r, loading: false, failed: "Snapchat answered without this source" };
              if (!s.source) return { ...r, loading: false, failed: undefined, result: s };
              const draft = snapCloneDraft(s.source);
              return { ...r, loading: false, failed: undefined, result: s, draft, card: cardFromDraft(draft, brandRef.current) };
            }),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setRows((rs) => rs.map((r) => (refs.includes(r.ref) ? { ...r, loading: false, failed: msg } : r)));
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [rows]);

  const retryRead = (r: CloneRow) => {
    fetchedRef.current.delete(r.ref);
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, failed: undefined, result: null, draft: null } : x)));
  };

  // ---- rows ----
  const patchRow = (id: string, p: Partial<CloneRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  /** An edit re-opens a row that already went out (its next Launch is a NEW wave, on purpose). */
  const patchCard = (id: string, p: Partial<SnapCard>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? snapCloneTouch({ ...r, card: { ...r.card, ...p } }) : r)));
    setPreviewed(false);
  };
  /** A Settings change is the same edit for every row that RIDES that default: cloned into one
   *  account, then another Destination picked here — the source must be ready again, no reload. */
  const touchRows = (rides?: (r: CloneRow) => boolean) => setRows((rs) => snapCloneTouchRows(rs, rides));
  const changeDest = (v: string) => {
    setDest(v);
    setPreviewed(false);
    touchRows((r) => !r.card.adAccount);
  };
  const settleRows = (ids: Iterable<string>, outcome: (id: string) => { state: "ok" | "error"; msg: string }) => {
    const set = new Set(ids);
    setRows((rs) => rs.map((r) => (set.has(r.id) ? snapCloneSettle(r, outcome(r.id)) : r)));
  };
  const addRefs = () => {
    const refs = snapCloneRefs(draftRefs);
    if (refs.length === 0) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.ref));
      return [...rs, ...refs.filter((ref) => !have.has(ref)).map(freshRow)].slice(0, SNAP_CLONE_MAX_SOURCES);
    });
    setDraftRefs("");
    setPreviewed(false);
  };
  const removeRow = (id: string) => {
    setRows((rs) => {
      const gone = rs.find((r) => r.id === id);
      const next = rs.filter((r) => r.id !== id);
      if (gone && !next.some((r) => r.ref === gone.ref)) fetchedRef.current.delete(gone.ref);
      return next;
    });
    setPreviewed(false);
  };
  const clearAll = () => {
    fetchedRef.current.clear();
    setRows([]);
    setPreviewed(false);
    setFireNote(null);
  };
  const setCreatives = (row: CloneRow, pick: (c: SnapRemoteCreative) => boolean) => patchCard(row.id, { remote: (row.card.remote ?? []).map((c) => ({ ...c, on: !c.issue && pick(c) })) });

  // ---- catalog ----
  const accountById = new Map((catalog?.accounts ?? []).map((a) => [a.id, a]));
  const catalogLoading = catalog === null && !catError;
  const accountOptions: RichOption[] = (catalog?.accounts ?? []).map((a) => {
    const off = a.status && a.status.toUpperCase() !== "ACTIVE" ? a.status : "";
    return { value: a.id, label: a.name || a.id, subLabel: a.id, meta: a.currency, tag: off || (a.pixelsError ? "px ?" : `${a.pixels.length} px`), tagTone: off || a.pixels.length === 0 ? "warn" : "dim" };
  });
  const profileOptions: RichOption[] = (catalog?.profiles ?? []).map((p) => ({ value: p.id, label: p.displayName || p.id, subLabel: p.id }));
  const destAccount = dest ? (accountById.get(dest) ?? null) : null;

  // ---- per-row derived view; keys handed out in row order from the registry's free list ----
  const freeKeys = keys?.free ?? [];
  const views: RowView[] = [];
  let keyCursor = 0;
  for (const row of rows) {
    const src = row.result?.source ?? null;
    const acctId = row.card.adAccount || dest || src?.adAccountId || "";
    const account = acctId ? (accountById.get(acctId) ?? null) : null;
    const pix = account?.pixels ?? [];
    const onAccount = (id: string) => Boolean(id) && pix.some((p) => p.id === id);
    const effPixel = (onAccount(row.card.pixel) ? row.card.pixel : "") || (pix.length === 1 ? pix[0].id : "") || (defaults?.pixel && onAccount(defaults.pixel) ? defaults.pixel : "");
    const needsPixel = snapGoalNeedsPixel(row.card.optimizationGoal);
    const pixelNeeded = Boolean(needsPixel && account && pix.length > 1 && !effPixel);
    const noPixel = Boolean(needsPixel && account && pix.length === 0);
    const profileId = row.card.profileId || defaults?.profile || "";
    const n = Math.min(SNAP_MAX_COPIES, Math.max(1, Math.round(Number(row.card.copies || copies) || 1)));
    const eff: SnapCard = { ...row.card, adAccount: acctId, pixel: effPixel, profileId, brandName: row.card.brandName || defaults?.brandName || "", startPaused, copies: String(n) };
    const refusal = src ? snapCardRefusal(eff, { pixelId: effPixel || undefined, profileId }) : null;
    const queued = row.card.state === "ok" || row.card.state === "sending";
    const ready = Boolean(src && account && !pixelNeeded && !noPixel && !refusal && !queued);
    const why = row.loading
      ? "reading the source from Snapchat…"
      : row.failed
        ? `read failed — ${row.failed}`
        : !row.result
          ? "waiting to read the source…"
          : row.result.error
            ? row.result.error
            : !acctId
              ? "pick a destination account"
              : !account
                ? acctId === src?.adAccountId
                  ? "the source's account is not one the launcher offers — pick a destination"
                  : "account not in our list"
                : noPixel
                  ? "no pixel on this account — choose Landing page view"
                  : pixelNeeded
                    ? "pick a Snap Pixel"
                    : refusal
                      ? refusal
                      : row.card.state === "ok"
                        ? "queued — change the destination or any setting to clone it again"
                        : "";
    const rowKeys = ready ? freeKeys.slice(keyCursor, keyCursor + n) : [];
    if (ready) keyCursor += n;
    views.push({
      row,
      eff,
      account,
      ownAccount: Boolean(row.card.adAccount),
      moves: Boolean(src && acctId && acctId !== src.adAccountId),
      currency: account?.currency ?? "",
      pixelOptions: pix.map((p) => ({ value: p.id, label: p.name || p.id, subLabel: p.id })),
      pixelNeeded,
      noPixel,
      refusal,
      ready,
      why,
      copies: n,
      ads: snapCardMediaCount(row.card),
      keys: rowKeys,
    });
  }
  const readyViews = views.filter((v) => v.ready);
  const totalShots = readyViews.reduce((s, v) => s + v.copies, 0);
  const totalAds = readyViews.reduce((s, v) => s + v.copies * v.ads, 0);
  const overShotCap = totalShots > SNAP_MAX_SHOTS;
  const keysShort = keys !== null && freeKeys.length < totalShots;
  const totalsByCur = new Map<string, number>();
  for (const v of readyViews) totalsByCur.set(v.currency || "USD", (totalsByCur.get(v.currency || "USD") ?? 0) + parseMoney(v.eff.budget) * v.copies);
  const fireBlocked = firing || readyViews.length === 0 || catalogLoading || Boolean(catError) || overShotCap || keysShort || keys === null;

  const jumpTo = (id: string) => {
    setHighlightId(null);
    window.setTimeout(() => {
      document.getElementById(`clrow-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 40);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  // ---- fire: ONE wave, the launcher's own route — nothing to upload, the server builds every copy ----
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const ready = views.filter((v) => v.ready);
    const sig = JSON.stringify(ready.map((v) => [v.row.result?.campaignId, snapCardSignature(v.eff)]));
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    const waveId = waveRef.current.id;
    const shots: ReturnType<typeof buildSnapShot>[] = [];
    const shotRow: string[] = [];
    for (const v of ready) {
      const src = v.row.result?.source;
      if (!src) continue;
      for (let j = 0; j < v.copies; j++) {
        shots.push(buildSnapShot(v.eff, { currency: v.currency, desiredKey: v.keys[j], accountName: v.account?.name, clone: { of: src.campaignId, key: v.row.draft?.key } }));
        shotRow.push(v.row.id);
      }
    }
    const sent = new Set(shotRow);
    setRows((rs) => rs.map((r) => (sent.has(r.id) ? snapCloneSend(r, "queuing on server…") : r)));
    try {
      const res = await fetch("/api/snap/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ waveId, shots }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null;
        setPreviewed(false);
        settleRows(sent, () => ({ state: "ok", msg: "queued — safe to close the tab (the server builds it) · change the destination or any setting to clone it again" }));
        refresh();
        refreshKeys();
        setOpen(true);
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        setFireNote(msg);
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotRow[Number(m[1]) - 1] : null;
        settleRows(sent, (id) => ({ state: "error", msg: culprit && id !== culprit ? "wave refused — fix the flagged row" : msg }));
        if (culprit) jumpTo(culprit);
      }
    } catch (e) {
      // No answer: the wave may or may not be accepted — the same waveId makes a retry a no-op on
      // the server if it was. The drawer tells which.
      const msg = `no answer from the server (${String((e as Error).message ?? e)}) — check Snap tasks before firing again; a retry of the same wave is safe`;
      setFireNote(msg);
      settleRows(sent, () => ({ state: "error", msg }));
      setOpen(true);
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const readFailed = views.filter((v) => v.row.failed || v.row.result?.error).length;
  const notReady = views.filter((v) => !v.ready && v.row.result?.source && v.row.card.state !== "ok").length;

  return (
    <>
      <Header partner="in" onPartnerChange={changePartner} user={user} platform="snapchat" />
      <SnapNav active="clone" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (wave defaults + Preview → Launch) — sticky, scrolls inside ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Settings</span>
                <span className="text-[10.5px] leading-snug text-faint">Wave defaults — every source rides these unless its panel sets its own.</span>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className={micro}>Destination</span>
                <SearchSelect
                  value={dest}
                  onChange={changeDest}
                  options={accountOptions}
                  placeholder="Each source's own account"
                  metaWhenClosed
                  emptyHint={catalogLoading ? "Loading accounts…" : "No accounts"}
                  ariaLabel="Destination ad account"
                />
                <p className="text-[10.5px] leading-snug text-faint">
                  {destAccount ? (
                    <>
                      Every clone lands on <span className="text-ink">{destAccount.name}</span> — its creatives are copied there from Snapchat.{" "}
                      <button type="button" onClick={() => changeDest("")} className="font-semibold text-[#9db8ff] hover:underline">
                        Use the sources&apos; own accounts
                      </button>
                    </>
                  ) : (
                    "Empty = each clone stays on its source's ad account and reuses its media as is."
                  )}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className={micro}>Copies per source</span>
                <input
                  value={copies}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setCopies(raw !== "" && Number(raw) > SNAP_MAX_COPIES ? String(SNAP_MAX_COPIES) : raw);
                    setPreviewed(false);
                    touchRows((r) => !r.card.copies);
                  }}
                  onBlur={() => {
                    if (copies === "" || Number(copies) < 1) setCopies("1");
                  }}
                  inputMode="numeric"
                  aria-label="Copies per source"
                  className={inp + " font-mono tabular-nums"}
                />
                <p className="text-[10.5px] leading-snug text-faint">1–{SNAP_MAX_COPIES} · each copy = its own campaign and partner key · a panel can set its own</p>
              </div>

              <label className="flex w-fit cursor-pointer items-center gap-2 text-[11.5px] text-dim">
                <input
                  type="checkbox"
                  checked={startPaused}
                  onChange={(e) => {
                    setStartPaused(e.target.checked);
                    setPreviewed(false);
                    touchRows();
                  }}
                  className="h-3.5 w-3.5 accent-[#FFFC00]"
                />
                Start paused (review in Ads Manager first)
              </label>

              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Sources ready</span>
                  <span className="font-mono tabular-nums">
                    {readyViews.length}/{rows.length}
                  </span>
                </div>
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
                  className="animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
                >
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Launching…" : `Clone ${totalShots}`}
                </button>
              ) : null}

              {fireNote ? <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">{fireNote}</div> : null}
              {catError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the Snapchat accounts — {catError}.</span>
                  <button type="button" onClick={retryCatalog} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25">
                    Retry
                  </button>
                </div>
              ) : null}
              {keysError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t read the key registry — {keysError}.</span>
                  <button type="button" onClick={refreshKeys} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25">
                    Retry
                  </button>
                </div>
              ) : null}
              {notReady > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{notReady} source{notReady === 1 ? " is" : "s are"} not ready — see the note on the panel.</p> : null}
              {readFailed > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{readFailed} source{readFailed === 1 ? "" : "s"} could not be read — see the panel.</p> : null}
              {overShotCap ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{totalShots} campaigns — one wave carries at most {SNAP_MAX_SHOTS}. Lower the copies or split the sources into two waves.</p> : null}
              {keysShort ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">Only {freeKeys.length} free key{freeKeys.length === 1 ? "" : "s"} for {totalShots} campaigns — release keys on the Keys page or lower the copies.</p> : null}

              {previewed ? (
                <div className="animate-pop-in flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/40 p-3">
                  <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                  {readyViews.map((v) => (
                    <button key={v.row.id} type="button" onClick={() => jumpTo(v.row.id)} className="text-left text-[11.5px] leading-snug text-dim hover:text-ink">
                      <span className="text-[#f3f0a3]">{v.row.draft?.key || v.row.result?.campaignId.slice(0, 8)}</span> → <span className="text-ink">{v.account?.name}</span> · ×{v.copies} · {v.ads} ad{v.ads === 1 ? "" : "s"} · {snapCurrencySymbol(v.currency || "USD")}
                      {moneyLabel(v.eff.budget)}/day · {v.eff.geo.join("+")}
                      {snapDeviceShort(v.eff.deviceOs) ? ` · ${snapDeviceShort(v.eff.deviceOs)}` : " · all devices"} · keys {v.keys.join(", ")}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-line pt-1.5 text-[11.5px] text-ink">
                    {totalShots} campaign{totalShots === 1 ? "" : "s"} · {totalAds} ad{totalAds === 1 ? "" : "s"} · ONE wave · nothing uploads from this tab — it is safe to close once accepted.
                  </div>
                </div>
              ) : null}
              <p className="text-center text-[10.5px] leading-relaxed text-faint">{rows.length === 0 ? "Add source campaigns" : previewed ? "Fires ONE wave · the server builds every copy" : "Preview first, then clone"}</p>
              {counts.active > 0 ? (
                <p className="text-center text-[10.5px] leading-relaxed text-faint">
                  {counts.active} Snapchat build{counts.active === 1 ? "" : "s"} in flight — the Snap tasks drawer tracks them.
                </p>
              ) : null}
            </div>
          </aside>

          {/* ---- Selected campaigns ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Selected campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{rows.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">Cloner · a new key per copy</span>
              <div className="ml-auto flex min-w-0 flex-1 items-center gap-2 sm:max-w-[560px]">
                <input
                  value={draftRefs}
                  onChange={(e) => setDraftRefs(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addRefs();
                  }}
                  placeholder="Snapchat campaign ids or keys glo-snp_NNN — comma / space separated"
                  aria-label="Add source campaigns"
                  className={inp + " min-w-0 flex-1 font-mono text-[12px]"}
                />
                <button type="button" onClick={addRefs} disabled={snapCloneRefs(draftRefs).length === 0 || rows.length >= SNAP_CLONE_MAX_SOURCES} className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[#FFFC00]/40 bg-[#FFFC00]/10 px-3 text-[12.5px] font-semibold text-[#f3f0a3] transition-all hover:bg-[#FFFC00]/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40">
                  <PlusIcon className="h-4 w-4" />
                  Add
                </button>
                {rows.length > 0 ? (
                  <button type="button" onClick={clearAll} className="flex h-9 shrink-0 items-center rounded-lg border border-line px-3 text-[12px] font-medium text-faint transition-colors hover:border-danger/40 hover:text-danger">
                    Clear all
                  </button>
                ) : null}
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="animate-pop-in flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-surface p-6 text-[12px] leading-relaxed text-dim">
                <p className="text-[13px] font-semibold text-ink">Clone a Snapchat campaign</p>
                <ol className="flex flex-col gap-1.5 pl-4 text-faint [list-style:decimal]">
                  <li>
                    Paste Snapchat campaign ids or partner keys above — or press <span className="text-ink">Clone</span> on the Keys page or in the Snap tasks drawer.
                  </li>
                  <li>The board reads each source back from Snapchat: ad squad, every ad with its creative, landing and Snap&apos;s review verdict.</li>
                  <li>Keep the source&apos;s account (its media are reused) or pick another one; set copies, budget, bid — anything else under “All settings”.</li>
                  <li>Preview, then Clone — every copy is a new campaign on a new partner key; the server builds them, the tab is safe to close.</li>
                </ol>
                <p className="text-faint">
                  A link opens this board pre-filled: <span className="font-mono text-dim">/snap/clone?ids=&lt;campaign id&gt;,…</span> or <span className="font-mono text-dim">/snap/clone?keys=glo-snp_012,…</span>
                </p>
              </div>
            ) : (
              views.map((v, i) => (
                <CloneRowPanel
                  key={v.row.id}
                  v={v}
                  index={i}
                  username={username}
                  dest={dest}
                  accountOptions={accountOptions}
                  profileOptions={profileOptions}
                  catalogLoading={catalogLoading}
                  highlight={highlightId === v.row.id}
                  onPatch={patchCard}
                  onRow={patchRow}
                  onRemove={removeRow}
                  onRetry={retryRead}
                  onPick={setCreatives}
                  onPreview={setPreview}
                />
              ))
            )}
          </section>
        </div>
      </main>
      {preview ? <CreativePreview c={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

// ---------- one source panel ----------

function CloneRowPanel({
  v,
  index,
  username,
  dest,
  accountOptions,
  profileOptions,
  catalogLoading,
  highlight,
  onPatch,
  onRow,
  onRemove,
  onRetry,
  onPick,
  onPreview,
}: {
  v: RowView;
  index: number;
  username: string;
  dest: string;
  accountOptions: RichOption[];
  profileOptions: RichOption[];
  catalogLoading: boolean;
  highlight: boolean;
  onPatch: (id: string, p: Partial<SnapCard>) => void;
  onRow: (id: string, p: Partial<CloneRow>) => void;
  onRemove: (id: string) => void;
  onRetry: (row: CloneRow) => void;
  onPick: (row: CloneRow, pick: (c: SnapRemoteCreative) => boolean) => void;
  onPreview: (c: SnapRemoteCreative) => void;
}) {
  const { row, eff } = v;
  const card = row.card;
  const res = row.result;
  const src = res?.source ?? null;
  const draft = row.draft;
  const patch = (p: Partial<SnapCard>) => onPatch(row.id, p);
  const sym = snapCurrencySymbol(v.currency || "USD");
  const kind = snapBidKind(card.bidStrategy);
  const q = src?.squad ?? null;
  const reviews = { APPROVED: 0, PENDING: 0, REJECTED: 0 } as Record<string, number>;
  for (const a of src?.ads ?? []) reviews[a.review] = (reviews[a.review] ?? 0) + 1;
  const landingBase = snapLandingBase(card.landingUrl)?.base ?? "";
  const firstKey = v.keys[0] ?? "";
  const segments = landingBase ? snapLandingSegments(landingBase, firstKey) : [];
  const niche = snapNicheFromLanding(card.landingUrl) || "Custom";
  const namePreview = snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel: card.geo.join("+"), key: firstKey || "glo-snp_???", user: username, tail: card.suffix, cloneOf: draft?.mark ?? "" });
  const geoSet = new Set(card.geo);
  const presetActive = (codes: string[]) => codes.length === card.geo.length && codes.every((c) => geoSet.has(c));
  const direct = snapDirectLanding(card.landingUrl);
  const stateTone = card.state === "error" ? "text-danger" : card.state === "ok" ? "text-launch2" : card.state === "sending" ? "text-[#9db8ff]" : "text-faint";
  const notes = draft?.notes ?? [];
  const remote = card.remote ?? [];
  const tooBigToMove = v.moves ? remote.filter((c) => c.on && ((c.sizeBytes ?? 0) > SNAP_MEDIA_MAX_BYTES || !c.url)) : [];

  return (
    <div id={`clrow-${row.id}`} className={"animate-row-in overflow-hidden rounded-2xl border bg-surface transition-shadow " + (highlight ? "border-[#FFFC00]/60 shadow-[0_0_0_2px_rgba(255,252,0,0.2)]" : "border-line")}>
      {/* ---- head: the source ---- */}
      <div className="flex items-start gap-2.5 border-b border-line/70 bg-surface2/30 px-3.5 py-2.5">
        <span className="pt-0.5 font-mono text-[12px] text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (v.ready ? "bg-launch2" : row.loading ? "animate-pulse bg-accent" : "bg-warn")} title={v.ready ? "Ready" : v.why} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11.5px] text-ink" title={src?.name || row.ref}>
            {src?.name || row.ref}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {draft?.key ? <span className="rounded bg-[#FFFC00]/15 px-1.5 py-[1px] font-mono text-[10px] font-semibold text-[#f3f0a3]">{draft.key}</span> : null}
            {src ? (
              <span className={"rounded border px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide " + (src.status === "ACTIVE" ? "border-launch/40 bg-launch/10 text-launch2" : "border-line bg-surface2 text-faint")}>{src.status || "—"}</span>
            ) : null}
            {src ? (
              <span className="rounded border border-line bg-surface px-1.5 py-[1px] font-mono text-[10px] text-faint" title={src.adAccountId}>
                {res?.accountName || src.adAccountId.slice(0, 8)}
              </span>
            ) : null}
            {res?.holder ? <span className="text-[10px] text-faint">key held by {res.holder}</span> : null}
            {src ? (
              <span className="font-mono text-[10px] text-faint" title={src.campaignId}>
                cmp {src.campaignId.slice(0, 8)}… · {fmtDay(src.createdAt)}
              </span>
            ) : (
              <span className="text-[10px] text-faint">{/^glo-snp_/.test(row.ref) ? "partner key → the campaign that holds it" : "Snapchat campaign id"}</span>
            )}
          </div>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">×{v.copies}</span>
        {src ? (
          <button type="button" onClick={() => onRow(row.id, { more: !row.more })} aria-expanded={row.more} title="All settings" className="flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-faint transition-colors hover:bg-raise hover:text-ink">
            <ChevronsIcon className={"h-4 w-4 transition-transform " + (row.more ? "" : "rotate-180")} />
            {row.more ? "Less" : "All settings"}
          </button>
        ) : null}
        <button type="button" onClick={() => onRemove(row.id)} aria-label="Remove source" title="Remove from the board" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger">
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* ---- not read (yet) ---- */}
      {!src ? (
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-3 text-[11.5px]">
          {row.loading || !res ? (
            !row.failed ? (
              <span className="flex items-center gap-2 text-faint">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                Reading the campaign from Snapchat…
              </span>
            ) : null
          ) : null}
          {row.failed || res?.error ? <span className="text-danger">{row.failed ? `Read failed — ${row.failed}` : res?.error}</span> : null}
          {row.failed || res?.error ? (
            <button type="button" onClick={() => onRetry(row)} className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff]">
              <RetryIcon className="h-3 w-3" />
              Retry read
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* source facts */}
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span className="text-faint">Source:</span>
            {q ? (
              <>
                <Fact>{snapGoalLabel(q.goal) || "—"}</Fact>
                <Fact>{snapBidLabel(q.bidStrategy, q.bidMicro ?? undefined, "USD")}</Fact>
                <Fact>{q.dailyBudgetMicro != null ? `$${moneyLabel(String(q.dailyBudgetMicro / 1_000_000))}/day` : q.lifetimeBudgetMicro != null ? `$${moneyLabel(String(q.lifetimeBudgetMicro / 1_000_000))} lifetime` : "—"}</Fact>
                <Fact>{q.countries.join("+") || "no geo"}</Fact>
                <Fact>{q.deviceOs.length ? q.deviceOs.join("+") : "all devices"}</Fact>
                <Fact>{q.minAge ? `${q.minAge}+` : "18+"}</Fact>
              </>
            ) : null}
            <Fact>{src.objectiveAuto ? `${snapObjectiveLabel(src.objective) || "Awareness"} (auto)` : snapObjectiveLabel(src.objective) || "—"}</Fact>
            <Fact>
              {src.ads.length} ad{src.ads.length === 1 ? "" : "s"}
              {reviews.APPROVED ? <span className="text-launch2"> · {reviews.APPROVED} approved</span> : null}
              {reviews.PENDING ? <span className="text-[#9db8ff]"> · {reviews.PENDING} in review</span> : null}
              {reviews.REJECTED ? <span className="text-danger"> · {reviews.REJECTED} rejected</span> : null}
            </Fact>
          </div>
          {notes.length ? (
            <ul className="flex flex-col gap-0.5 rounded-lg border border-warn/25 bg-warn/5 px-3 py-2 text-[10.5px] leading-snug text-warn">
              {notes.slice(0, 6).map((n) => (
                <li key={n}>• {n}</li>
              ))}
              {notes.length > 6 ? <li>• +{notes.length - 6} more</li> : null}
            </ul>
          ) : null}

          {/* ---- the clone: destination + delivery ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <div className="flex items-center justify-between gap-2">
                <span className={micro}>Destination</span>
                {v.ownAccount ? (
                  <button type="button" onClick={() => patch({ adAccount: "" })} className="text-[10px] font-semibold text-[#9db8ff] hover:underline">
                    {dest ? "use wave's" : "back to source's"}
                  </button>
                ) : (
                  <span className="text-[10px] text-faint">{dest ? "wave default" : "source's own"}</span>
                )}
              </div>
              <SearchSelect value={eff.adAccount} onChange={(val) => patch({ adAccount: val })} options={accountOptions} placeholder="Search account" metaWhenClosed accent={v.ownAccount} warn={!v.account} emptyHint={catalogLoading ? "Loading accounts…" : "No accounts"} ariaLabel="Destination ad account" size="sm" />
              {v.moves ? <span className="text-[10px] leading-snug text-faint">Another account than the source&apos;s — its creatives are copied there from Snapchat (≤32 MB each).</span> : null}
            </div>
            <div className="flex flex-col gap-1.5 lg:col-span-2">
              <span className={micro}>Optimization goal</span>
              <Select value={card.optimizationGoal} onChange={(e) => patch({ optimizationGoal: e.target.value })} options={GOAL_OPTIONS} aria-label="Optimization goal" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Bidding</span>
              <Select value={card.bidStrategy} onChange={(e) => patch({ bidStrategy: e.target.value, bid: snapBidKind(e.target.value) === kind ? card.bid : "" })} options={STRATEGY_OPTIONS} aria-label="Bidding strategy" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>{card.bidStrategy === "TARGET_COST" ? "Target cost" : "Max bid"}</span>
              {kind === "bid" ? (
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">{sym}</span>
                  <input value={card.bid} onChange={(e) => patch({ bid: limitMoneyCents(e.target.value, SNAP_BID_MAX) })} inputMode="decimal" placeholder="0,50" aria-label="Bid" className={inp + " pl-8"} />
                </div>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-line bg-surface2/40 px-3 text-[11.5px] text-faint">Automatic</div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Daily budget</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint">{sym}</span>
                <input value={card.budget} onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, SNAP_BUDGET_MAX) })} inputMode="decimal" placeholder={SNAP_DEFAULT_BUDGET} aria-label="Daily budget" className={inp + " pl-8"} />
              </div>
            </div>
          </div>
          {v.pixelNeeded || (snapGoalNeedsPixel(card.optimizationGoal) && v.pixelOptions.length > 1) ? (
            <div className="flex max-w-[360px] flex-col gap-1.5">
              <span className={micro}>Pixel</span>
              <SearchSelect value={eff.pixel} onChange={(val) => patch({ pixel: val })} options={v.pixelOptions} placeholder="Search pixel" warn={v.pixelNeeded} emptyHint="No pixels on this account" ariaLabel="Snap Pixel" size="sm" />
            </div>
          ) : null}

          {/* ---- creatives: the source's ads ---- */}
          <section className="flex flex-col gap-2 border-t border-line/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={micro}>Creatives</span>
              <span className="font-mono text-[10px] text-faint">
                {v.ads} of {remote.length} ride · one ad each
              </span>
              <div className="ml-auto flex items-center gap-1 text-[10.5px]">
                <span className="text-faint">pick</span>
                <button type="button" onClick={() => onPick(row, (c) => c.review !== "REJECTED" && c.adStatus.toUpperCase() !== "PAUSED")} className="rounded border border-line px-1.5 py-0.5 text-dim hover:border-line2 hover:text-ink">
                  default
                </button>
                <button type="button" onClick={() => onPick(row, (c) => c.review === "APPROVED")} className="rounded border border-line px-1.5 py-0.5 text-dim hover:border-line2 hover:text-ink">
                  approved
                </button>
                <button type="button" onClick={() => onPick(row, () => true)} className="rounded border border-line px-1.5 py-0.5 text-dim hover:border-line2 hover:text-ink">
                  all
                </button>
                <button type="button" onClick={() => onPick(row, () => false)} className="rounded border border-line px-1.5 py-0.5 text-dim hover:border-line2 hover:text-ink">
                  none
                </button>
              </div>
            </div>
            {remote.length === 0 ? (
              <p className="text-[11px] text-warn">The source carries no ads to clone.</p>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {remote.map((c) => (
                  <CreativeTile key={c.adId} c={c} moves={v.moves} onToggle={() => patch({ remote: remote.map((x) => (x.adId === c.adId ? { ...x, on: !x.on } : x)) })} onPreview={() => onPreview(c)} />
                ))}
              </div>
            )}
            {tooBigToMove.length ? <p className="text-[10.5px] text-warn">Creative{tooBigToMove.length === 1 ? "" : "s"} {tooBigToMove.map((c) => `#${c.n}`).join(", ")} cannot move to another account (over 32 MB or no download link) — switch {tooBigToMove.length === 1 ? "it" : "them"} off or keep the source&apos;s account.</p> : null}
            {reviews.REJECTED ? <p className="text-[10px] leading-snug text-faint">Ads Snap rejected in the source are off by default — a rejected creative sent again is one more strike against the whole organization.</p> : null}
          </section>

          {/* ---- name + copies ---- */}
          <section className="grid gap-3 border-t border-line/60 pt-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={micro}>Name tail</span>
              <input value={card.suffix} onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })} maxLength={80} placeholder="notes (optional)" aria-label="Campaign name tail" className={inp} />
              <p className="truncate font-mono text-[10px] text-faint" title={namePreview}>
                {namePreview}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Copies</span>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => patch({ copies: String(Math.max(1, v.copies - 1)) })} disabled={v.copies <= 1} className="h-9 w-9 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="Fewer copies">
                  −
                </button>
                <input
                  value={card.copies}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    patch({ copies: raw !== "" && Number(raw) > SNAP_MAX_COPIES ? String(SNAP_MAX_COPIES) : raw });
                  }}
                  placeholder={String(v.copies)}
                  inputMode="numeric"
                  aria-label="Copies of this source"
                  className={inp + " w-14 text-center"}
                />
                <button type="button" onClick={() => patch({ copies: String(Math.min(SNAP_MAX_COPIES, v.copies + 1)) })} disabled={v.copies >= SNAP_MAX_COPIES} className="h-9 w-9 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="More copies">
                  +
                </button>
              </div>
              <span className="text-[10px] text-faint">keys {v.keys.length ? v.keys.join(", ") : "—"}</span>
            </div>
          </section>

          {/* ---- all settings ---- */}
          {row.more ? (
            <section className="flex flex-col gap-4 rounded-xl border border-line/70 bg-surface2/20 p-3.5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex flex-col gap-1.5">
                  <span className={micro}>Objective</span>
                  <Select value={card.objective} onChange={(e) => patch({ objective: e.target.value })} options={OBJECTIVE_OPTIONS} aria-label="Campaign objective" />
                  <span className="text-[10px] leading-snug text-faint">{SNAP_OBJECTIVES.find((o) => o.value === card.objective)?.note ?? ""}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={micro}>Public Profile</span>
                  <SearchSelect value={eff.profileId} onChange={(val) => patch({ profileId: val })} options={profileOptions} placeholder="Search profile" warn={!eff.profileId} emptyHint={catalogLoading ? "Loading…" : "No Public Profile"} ariaLabel="Public Profile" size="sm" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={micro}>Call to action</span>
                  <Select value={card.cta} onChange={(e) => patch({ cta: e.target.value })} options={CTA_OPTIONS} aria-label="Call to action" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={micro}>Minimum age</span>
                  <Select value={card.minAge} onChange={(e) => patch({ minAge: e.target.value })} options={AGE_OPTIONS} aria-label="Minimum age" />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Counted label="Headline" value={card.headline} onChange={(val) => patch({ headline: val })} max={SNAP_HEADLINE_MAX} placeholder="Drive it home today" />
                <Counted label="Brand name" value={card.brandName} onChange={(val) => patch({ brandName: val })} max={SNAP_BRAND_MAX} placeholder="GC" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Countries</span>
                <MultiSelect id={`clgeo-${row.id}`} values={card.geo} onChange={(val) => patch({ geo: val })} options={COUNTRY_OPTIONS} placeholder="Countries — Snapchat has no worldwide targeting" chipMode="code" />
                <div className="flex flex-wrap gap-1">
                  {SNAP_GEO_PRESETS.map((p) => {
                    const on = presetActive(p.codes);
                    return (
                      <button key={p.label} type="button" onClick={() => patch({ geo: [...p.codes] })} aria-pressed={on} className={"rounded-md border px-2 py-1 text-[11px] font-medium transition-all active:scale-95 " + (on ? "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <span className={micro}>Devices</span>
                  <Seg options={DEVICE_OPTIONS} value={card.deviceOs} onChange={(k) => patch({ deviceOs: k })} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Landing</span>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Direct</span>
                  {SNAP_DIRECT_LANDINGS.map((l) => (
                    <button key={l.id} type="button" onClick={() => patch({ landingUrl: l.url })} aria-pressed={direct?.id === l.id} title={l.url} className={"rounded-md border px-2 py-1 text-[11px] font-medium transition-all active:scale-95 " + (direct?.id === l.id ? "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")}>
                      {l.niche}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                  <input value={card.landingUrl} onChange={(e) => patch({ landingUrl: e.target.value.trim() })} placeholder="https://fast-flow.org/ht/age-gate/digital-marketing/en/" aria-label="Landing URL" className={inp + " pl-9"} />
                </div>
              </div>
            </section>
          ) : null}

          {/* final link (always — it is what the partner attributes on) */}
          {segments.length ? (
            <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
              <div className="max-h-20 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                {segments.map((seg, k) => (
                  <span key={k} className={seg.role === "landing" ? "text-ink" : seg.role === "key" ? "font-semibold text-[#f3f0a3]" : seg.role === "sccid" ? "text-faint/60" : "text-faint"}>
                    {seg.text}
                  </span>
                ))}
              </div>
              <div className="border-t border-line bg-surface/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Final link · the clone&apos;s own key {firstKey || "(next free)"}</div>
            </div>
          ) : null}

          {card.state === "idle" && !v.ready && v.why ? <p className="text-[11px] leading-snug text-warn">{v.why}</p> : null}
          {card.state !== "idle" ? <p className={"break-words font-mono text-[11px] leading-snug " + stateTone}>{card.state === "sending" ? "Submitting…" : card.msg ?? "—"}</p> : null}
        </div>
      )}
    </div>
  );
}

function Fact({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-line bg-surface px-1.5 py-[1px] font-mono text-[10px] text-dim">{children}</span>;
}

/** One source ad as a 9:16 tile: number, review verdict, size; the tile toggles it, ▶ previews it.
 *  No video element per tile — a board of thirty sources would pass Chrome's media-player cap;
 *  the preview mounts ONE player on demand. */
function CreativeTile({ c, moves, onToggle, onPreview }: { c: SnapRemoteCreative; moves: boolean; onToggle: () => void; onPreview: () => void }) {
  const blocked = Boolean(c.issue);
  const cantMove = moves && (!c.url || (c.sizeBytes ?? 0) > SNAP_MEDIA_MAX_BYTES);
  const tone = REVIEW_TONE[c.review] ?? "border-line bg-surface2 text-faint";
  const title = [
    `#${c.n} ${c.name}`,
    c.width && c.height ? `${c.width}×${c.height}` : "",
    c.durationSec ? `${c.durationSec} s` : "",
    mb(c.sizeBytes),
    c.review ? `review: ${c.review}` : "",
    c.adStatus && c.adStatus !== "ACTIVE" ? `ad ${c.adStatus} in the source` : "",
    ...c.reasons,
    c.issue ? `cannot be cloned: ${c.issue}` : "",
    cantMove ? "cannot move to another account (over 32 MB or no download link)" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="flex w-[84px] shrink-0 flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        disabled={blocked}
        aria-pressed={c.on}
        title={title}
        className={
          "relative aspect-[9/16] w-full overflow-hidden rounded-lg border bg-surface2 transition-all " +
          (blocked ? "cursor-not-allowed border-dashed border-line opacity-50" : c.on ? (cantMove ? "border-warn ring-2 ring-warn/30" : "border-[#FFFC00]/60 ring-2 ring-[#FFFC00]/20") : "border-line opacity-60 hover:opacity-90")
        }
      >
        {c.kind === "image" && c.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-faint">
            <PlayIcon className="h-5 w-5" />
          </span>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/65 px-1 font-mono text-[9.5px] text-white">#{c.n}</span>
        <span className={"absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border " + (c.on ? "border-[#FFFC00]/70 bg-[#FFFC00]/80 text-black" : "border-white/40 bg-black/40 text-transparent")}>
          <CheckIcon className="h-3 w-3" />
        </span>
        {c.review ? <span className={"absolute bottom-1 left-1 right-1 truncate rounded border px-1 text-center text-[8.5px] font-semibold uppercase " + tone}>{c.review === "PENDING" ? "in review" : c.review.toLowerCase()}</span> : null}
      </button>
      <div className="flex items-center justify-between font-mono text-[9.5px] text-faint">
        <span className="truncate">{c.durationSec ? `${c.durationSec}s` : c.kind}</span>
        {c.url ? (
          <button type="button" onClick={onPreview} className="rounded px-1 text-[#9db8ff] hover:bg-accent/10" aria-label={`Preview creative #${c.n}`}>
            ▶
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One player for the whole board: the source file straight from Snap's storage. */
function CreativePreview({ c, onClose }: { c: SnapRemoteCreative; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Creative #${c.n}`}>
      <div className="relative flex max-h-full flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label="Close preview" className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-faint hover:text-ink">
          <XIcon className="h-4 w-4" />
        </button>
        {c.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.url} alt="" className="max-h-[80vh] max-w-[90vw] rounded-xl border border-line object-contain" />
        ) : (
          <video src={c.url} controls autoPlay playsInline className="max-h-[80vh] max-w-[90vw] rounded-xl border border-line bg-black" />
        )}
        <p className="max-w-[90vw] truncate font-mono text-[11px] text-dim">
          #{c.n} · {c.name} {c.width && c.height ? `· ${c.width}×${c.height}` : ""} {c.durationSec ? `· ${c.durationSec}s` : ""} {c.sizeBytes ? `· ${mb(c.sizeBytes)}` : ""}
        </p>
      </div>
    </div>
  );
}
