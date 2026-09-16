"use client";

// One Snapchat web-campaign card for the launcher (the Google card's structure, Snap's fields):
// SETUP (ad account · pixel · Public Profile · name tail) · DELIVERY (goal · bidding · bid ·
// budget · start paused) · CREATIVE (ONE vertical video/image ≤32 MB · headline ≤34 · brand ≤32 ·
// CTA) · TARGETING (countries + presets · min age) · LANDING (partner niche or custom https, the
// final link with the NEXT free key highlighted) · COPIES (N campaigns = N keys). Every gate is
// delegated to the SAME validator the server runs (snapLaunchWire) so the readiness dot can never
// disagree with the route's refusal. Files stay session object URLs here and ride Vercel Blob at
// launch (the board uploads, one file per card, reused by every copy).

import { useState } from "react";
import { Dropzone } from "./dropzone";
import { Select } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { CheckIcon, ChevronsIcon, CopyIcon, GlobeIcon, TrashIcon } from "./icons";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoneyCents, type FileItem } from "@/lib/types";
import {
  SNAP_BID_MAX,
  SNAP_BID_STRATEGIES,
  SNAP_BRAND_MAX,
  SNAP_BUDGET_MAX,
  SNAP_CTAS,
  SNAP_DEFAULT_BUDGET,
  SNAP_GEO_PRESETS,
  SNAP_HEADLINE_MAX,
  SNAP_LANDINGS,
  SNAP_MAX_COPIES,
  SNAP_MEDIA_MAX_BYTES,
  SNAP_MIN_AGES,
  SNAP_OPTIMIZATION_GOALS,
  snapBidKind,
  snapCampaignName,
  snapCurrencySymbol,
  snapGoalNeedsPixel,
  snapLandingBase,
  snapLandingSegments,
  snapLandingUrl,
  snapLaunchWire,
  todaySaoPauloDotDDMM,
  type SnapLaunchShotIn,
} from "@/lib/snap-launch";
import type { SessionUser } from "./user-menu";

export const FIRST_SNAP_CARD_ID = "sn-1";
let cardSeq = 1;

export type SnapCard = {
  id: string;
  collapsed: boolean;
  suffix: string;
  adAccount: string;
  pixel: string;
  profileId: string;
  optimizationGoal: string;
  bidStrategy: string;
  bid: string;
  budget: string;
  startPaused: boolean;
  headline: string;
  brandName: string;
  cta: string;
  /** ONE creative (video mp4/mov or image png/jpg), session object URL until launch. */
  files: FileItem[];
  /** Pixel size read client-side after the drop (Snap wants 1080×1920, 9:16). */
  mediaDims: { w: number; h: number } | null;
  geo: string[];
  minAge: string;
  landingId: "dmi" | "cars" | "custom";
  landingUrl: string;
  /** "1".."20" — N campaigns from this card, each with its own key. */
  copies: string;
  state: "idle" | "uploading" | "sending" | "ok" | "error";
  msg?: string;
  progress?: string;
};

export function freshSnapCard(id?: string, defaults: { adAccount?: string; pixel?: string; profileId?: string; brandName?: string } = {}): SnapCard {
  return {
    id: id ?? `sn-${++cardSeq}`,
    collapsed: false,
    suffix: "",
    adAccount: defaults.adAccount ?? "",
    pixel: defaults.pixel ?? "",
    profileId: defaults.profileId ?? "",
    optimizationGoal: "PIXEL_PURCHASE",
    bidStrategy: "AUTO_BID",
    bid: "",
    budget: SNAP_DEFAULT_BUDGET,
    startPaused: false,
    headline: "",
    brandName: defaults.brandName ?? "",
    cta: "MORE",
    files: [],
    mediaDims: null,
    geo: ["US"],
    minAge: "18",
    landingId: "dmi",
    landingUrl: "",
    copies: "1",
    state: "idle",
  };
}

export function cloneSnapCard(src: SnapCard): SnapCard {
  return { ...src, id: `sn-${++cardSeq}`, collapsed: false, geo: [...src.geo], files: src.files.map((f) => ({ ...f })), state: "idle", msg: undefined, progress: undefined };
}

export function snapCardCopies(card: SnapCard): number {
  const n = Math.round(Number(card.copies) || 1);
  return Math.min(SNAP_MAX_COPIES, Math.max(1, n));
}

/** Hard creative gates: exactly one file, ≤32 MB. (9:16 is a soft note — Snap has the last word.) */
export function snapMediaIssue(card: SnapCard): string | null {
  const f = card.files[0];
  if (!f) return "Attach one vertical video (mp4/mov) or image (png/jpg)";
  if (f.kind !== "video" && f.kind !== "image") return "The creative must be a video or an image";
  if (f.size > SNAP_MEDIA_MAX_BYTES) return `Creative is ${Math.round(f.size / 1024 / 1024)} MB — Snapchat single upload takes at most 32 MB`;
  return null;
}

/** Soft 9:16 note (null when it fits or is unknown). */
export function snapDimsNote(dims: { w: number; h: number } | null): string | null {
  if (!dims || !dims.w || !dims.h) return null;
  const ratio = dims.w / dims.h;
  if (Math.abs(ratio - 9 / 16) > 0.02) return `${dims.w}×${dims.h} is not 9:16 — Snap wants 1080×1920 (it may crop or refuse)`;
  if (dims.w < 1080 || dims.h < 1920) return `${dims.w}×${dims.h} is under 1080×1920 — Snap may refuse it`;
  return null;
}

/** The wire shot (real at launch with `mediaUrl`, otherwise the DRY-RUN with a placeholder). */
export function buildSnapShot(card: SnapCard, ctx: { currency?: string; mediaUrl?: string; desiredKey?: string; accountName?: string }): SnapLaunchShotIn {
  const f = card.files[0];
  return {
    label: `Snap launch · ${ctx.accountName || "account"}`,
    adAccount: card.adAccount,
    ...(card.pixel ? { pixel: card.pixel } : {}),
    ...(card.profileId ? { profileId: card.profileId } : {}),
    optimizationGoal: card.optimizationGoal,
    bidStrategy: card.bidStrategy,
    bid: card.bid.trim(),
    budget: card.budget,
    startPaused: card.startPaused,
    headline: card.headline.trim(),
    brandName: card.brandName.trim(),
    cta: card.cta,
    mediaUrl: ctx.mediaUrl ?? (f?.kind === "image" ? "https://pending.local/creative.jpg" : "https://pending.local/creative.mp4"),
    mediaKind: f?.kind === "image" ? "image" : "video",
    ...(f?.name ? { mediaName: f.name } : {}),
    geo: card.geo,
    minAge: card.minAge,
    landingId: card.landingId,
    landingUrl: card.landingId === "custom" ? card.landingUrl.trim() : "",
    ...(ctx.desiredKey ? { desiredKey: ctx.desiredKey } : {}),
    suffix: card.suffix.trim(),
    ...(ctx.currency ? { currency: ctx.currency } : {}),
  };
}

/** The card's blocking refusal (null = launchable): creative gates first, then the shared validator. */
export function snapCardRefusal(card: SnapCard, ctx: { pixelId?: string; profileId: string }): string | null {
  const media = snapMediaIssue(card);
  if (media) return media;
  const built = snapLaunchWire(buildSnapShot(card, {}), {
    adAccountId: card.adAccount || "pending",
    pixelId: ctx.pixelId,
    profileId: ctx.profileId,
    name: "preview",
    key: "glo-snp_001",
    mediaId: "pending",
    startTimeIso: new Date(0).toISOString(),
  });
  return "refusal" in built ? built.refusal : null;
}

export function snapCardSignature(card: SnapCard): string {
  return JSON.stringify({
    a: card.adAccount,
    px: card.pixel,
    pr: card.profileId,
    g: card.optimizationGoal,
    bs: card.bidStrategy,
    bd: card.bid,
    b: card.budget,
    sp: card.startPaused,
    h: card.headline,
    br: card.brandName,
    c: card.cta,
    f: card.files.map((x) => x.id),
    geo: card.geo,
    age: card.minAge,
    l: card.landingId,
    lu: card.landingUrl,
    n: card.copies,
    s: card.suffix,
  });
}

/** Pixel size of a dropped creative (video metadata or image), null when unreadable. */
export function readMediaDims(f: FileItem): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (f.kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = f.url;
      return;
    }
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => resolve(null);
    v.src = f.url;
  });
}

// ---------- shared classes ----------

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";

const COUNTRY_OPTIONS = COUNTRIES.filter((c) => c.code !== "WW").map((c) => ({ value: c.code, label: c.name }));
const GOAL_OPTIONS = SNAP_OPTIMIZATION_GOALS.map((g) => ({ value: g.value, label: g.label }));
const STRATEGY_OPTIONS = SNAP_BID_STRATEGIES.map((s) => ({ value: s.value, label: s.label }));
const CTA_OPTIONS = SNAP_CTAS.map((c) => ({ value: c.value, label: c.label }));
const AGE_OPTIONS = SNAP_MIN_AGES.map((a) => ({ value: a, label: `${a}+` }));
const LANDING_OPTIONS: { key: SnapCard["landingId"]; label: string }[] = [...SNAP_LANDINGS.map((l) => ({ key: l.id, label: l.niche })), { key: "custom", label: "Custom URL" }];

function Seg<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="inline-grid grid-flow-col overflow-hidden rounded-lg border border-line bg-surface2/50 p-0.5">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(o.key)} className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " + (on ? "bg-[#FFFC00]/15 text-[#f3f0a3]" : "text-dim hover:text-ink")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Counted({ label, value, onChange, max, placeholder }: { label: string; value: string; onChange: (v: string) => void; max: number; placeholder: string }) {
  const over = value.trim().length > max;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={micro}>{label}</span>
        <span className={"font-mono text-[10px] tabular-nums " + (over ? "text-warn" : "text-faint")}>
          {value.trim().length}/{max}
        </span>
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))} placeholder={placeholder} aria-label={label} className={inp + (over ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")} />
    </div>
  );
}

// ---------- the card ----------

export function SnapLaunchCard({
  card,
  index,
  user,
  accountOptions,
  pixelOptions,
  profileOptions,
  currency,
  accountName,
  effPixel,
  pixelNeeded,
  noPixel,
  refusal,
  ready,
  catalogLoading,
  nextKeys,
  highlight,
  onPatch,
  onDuplicate,
  onRemove,
  onToggleCollapse,
}: {
  card: SnapCard;
  index: number;
  user?: SessionUser;
  accountOptions: RichOption[];
  pixelOptions: RichOption[];
  profileOptions: RichOption[];
  currency: string;
  accountName: string;
  /** The pixel that will ride (the card's pick, or the account's only pixel). */
  effPixel: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  refusal: string | null;
  ready: boolean;
  catalogLoading: boolean;
  /** The keys this card's copies would take, in order (from the board's registry view). */
  nextKeys: string[];
  highlight?: boolean;
  onPatch: (id: string, p: Partial<SnapCard>) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const patch = (p: Partial<SnapCard>) => onPatch(card.id, p);
  const kind = snapBidKind(card.bidStrategy);
  const sym = snapCurrencySymbol(currency || "USD");
  const copies = snapCardCopies(card);
  const needsPixel = snapGoalNeedsPixel(card.optimizationGoal);
  const [copied, setCopied] = useState(false);
  const [dropNote, setDropNote] = useState("");

  const landingBase = card.landingId === "custom" ? (snapLandingBase(card.landingUrl)?.base ?? "") : (SNAP_LANDINGS.find((l) => l.id === card.landingId)?.url ?? "");
  const firstKey = nextKeys[0] ?? "";
  const segments = landingBase ? snapLandingSegments(landingBase, firstKey) : [];
  const stripped = card.landingId === "custom" ? (snapLandingBase(card.landingUrl)?.strippedQuery ?? false) : false;
  const niche = card.landingId === "custom" ? "Custom" : (SNAP_LANDINGS.find((l) => l.id === card.landingId)?.niche ?? "");
  const namePreview = snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel: card.geo.join("+"), key: firstKey || "glo-snp_???", user: user?.username ?? "", tail: card.suffix });

  const copyLink = () => {
    if (!landingBase) return;
    void navigator.clipboard?.writeText(snapLandingUrl(landingBase, firstKey || "glo-snp_???")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const onFiles = (files: FileItem[]) => {
    const one = files.filter((f) => f.kind === "video" || f.kind === "image").slice(0, 1);
    setDropNote("");
    patch({ files: one, mediaDims: null });
    if (one[0]) void readMediaDims(one[0]).then((dims) => (dims ? patch({ mediaDims: dims }) : setDropNote("Couldn't read the creative's size — Snap will validate it")));
  };

  const geoSet = new Set(card.geo);
  const presetActive = (codes: string[]) => codes.length === card.geo.length && codes.every((c) => geoSet.has(c));
  const dimsNote = snapDimsNote(card.mediaDims);
  const stateTone = card.state === "error" ? "text-danger" : card.state === "ok" ? "text-launch2" : card.state === "uploading" || card.state === "sending" ? "text-[#9db8ff]" : "text-faint";

  return (
    <div id={`sncard-${card.id}`} className={"animate-row-in overflow-hidden rounded-2xl border bg-surface transition-shadow " + (highlight ? "border-[#FFFC00]/60 shadow-[0_0_0_2px_rgba(255,252,0,0.2)]" : "border-line")}>
      {/* header */}
      <div className="flex items-center gap-2.5 border-b border-line/70 bg-surface2/30 px-3.5 py-2.5">
        <span className="font-mono text-[12px] text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className={"h-2 w-2 shrink-0 rounded-full " + (ready ? "bg-launch2" : "bg-warn")} title={ready ? "Ready" : "Not ready"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink">Snapchat web campaign</p>
          <p className="truncate font-mono text-[10px] text-faint" title={namePreview}>
            {namePreview}
          </p>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">
          ×{copies}
        </span>
        <button type="button" onClick={() => onToggleCollapse(card.id)} aria-label={card.collapsed ? "Expand" : "Collapse"} className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <ChevronsIcon className={"h-4 w-4 transition-transform " + (card.collapsed ? "rotate-180" : "")} />
        </button>
        <button type="button" onClick={() => onDuplicate(card.id)} aria-label="Duplicate campaign" title="Duplicate this card" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <CopyIcon className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => onRemove(card.id)} aria-label="Remove campaign" title="Remove from the wave" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40">
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {card.collapsed ? (
        <div className="flex items-center gap-2 px-3.5 py-2.5 text-[11px] text-faint">
          <span className="truncate">
            {accountName || "no account"} · {niche} · {card.geo.join("+") || "no geo"} · {sym}
            {card.budget} · ×{copies}
          </span>
          {card.state !== "idle" ? <span className={"ml-auto truncate font-mono text-[10.5px] " + stateTone}>{card.msg ?? "—"}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          {/* ---- SETUP ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Ad account</span>
              <SearchSelect value={card.adAccount} onChange={(v) => patch({ adAccount: v, pixel: "" })} options={accountOptions} placeholder="Search account" metaWhenClosed warn={!card.adAccount} emptyHint={catalogLoading ? "Loading accounts…" : "No accounts"} ariaLabel="Ad account" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Pixel</span>
              <SearchSelect value={effPixel} onChange={(v) => patch({ pixel: v })} options={pixelOptions} placeholder="Search pixel" warn={pixelNeeded} emptyHint={!card.adAccount ? "Pick an account first" : "No pixels on this account"} ariaLabel="Snap Pixel" />
              <p className="text-[10px] leading-snug text-faint">
                {!card.adAccount ? "Pick an account first" : !needsPixel ? "This goal needs no pixel" : noPixel ? "No pixel — pick a non-pixel goal" : pixelNeeded ? "Several pixels — pick one" : "One pixel — auto-picked"}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Public Profile</span>
              <SearchSelect value={card.profileId} onChange={(v) => patch({ profileId: v })} options={profileOptions} placeholder="Search profile" warn={!card.profileId} emptyHint={catalogLoading ? "Loading…" : "No Public Profile — create one in Ads Manager"} ariaLabel="Public Profile" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Name tail</span>
              <input value={card.suffix} onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })} maxLength={80} placeholder="notes (optional)" aria-label="Campaign name tail" className={inp} />
            </div>
          </div>

          {/* ---- DELIVERY ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
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
                  <input value={card.bid} onChange={(e) => patch({ bid: limitMoneyCents(e.target.value, SNAP_BID_MAX) })} inputMode="decimal" placeholder="0,50" aria-label="Bid" title={`Bid in ${currency || "USD"} — digits fill cents (50 → 0,50)`} className={inp + " pl-8"} />
                </div>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-line bg-surface2/40 px-3 text-[11.5px] text-faint">Automatic — Snap sets the bid</div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Daily budget</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint">{sym}</span>
                <input value={card.budget} onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, SNAP_BUDGET_MAX) })} inputMode="decimal" placeholder={SNAP_DEFAULT_BUDGET} aria-label="Daily budget" title="Daily budget — digits fill cents (1000 → 10,00); Snap's floor is 5/day" className={inp + " pl-8"} />
              </div>
              <label className="flex w-fit cursor-pointer items-center gap-2 pt-1 text-[11px] text-dim">
                <input type="checkbox" checked={card.startPaused} onChange={(e) => patch({ startPaused: e.target.checked })} className="h-3.5 w-3.5 accent-[#FFFC00]" />
                Start paused (review in Ads Manager first)
              </label>
            </div>
          </div>

          {/* ---- CREATIVE ---- */}
          <section className="grid gap-3 border-t border-line/60 pt-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className={micro}>Creative</span>
                <span className="font-mono text-[10px] text-faint">{card.files[0] ? `${Math.round(card.files[0].size / 1024 / 1024)} MB` : "9:16 · ≤32 MB"}</span>
              </div>
              <Dropzone id={`media-${card.id}`} files={card.files} onChange={onFiles} maxFiles={1} accept="any" compact />
              {dimsNote ? <p className="text-[10px] leading-snug text-warn">{dimsNote}</p> : card.mediaDims ? <p className="text-[10px] leading-snug text-faint">{card.mediaDims.w}×{card.mediaDims.h} · 9:16 ✓</p> : <p className="text-[10px] leading-snug text-faint">One vertical video (mp4/mov, 3–180 s) or image (png/jpg), 1080×1920.</p>}
              {dropNote ? <p className="text-[10px] leading-snug text-warn">{dropNote}</p> : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Counted label="Headline" value={card.headline} onChange={(v) => patch({ headline: v })} max={SNAP_HEADLINE_MAX} placeholder="Drive it home today" />
              <Counted label="Brand name" value={card.brandName} onChange={(v) => patch({ brandName: v })} max={SNAP_BRAND_MAX} placeholder="GC" />
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Call to action</span>
                <Select value={card.cta} onChange={(e) => patch({ cta: e.target.value })} options={CTA_OPTIONS} aria-label="Call to action" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Minimum age</span>
                <Select value={card.minAge} onChange={(e) => patch({ minAge: e.target.value })} options={AGE_OPTIONS} aria-label="Minimum age" />
              </div>
            </div>
          </section>

          {/* ---- TARGETING ---- */}
          <section className="flex flex-col gap-1.5">
            <span className={micro}>Countries</span>
            <MultiSelect id={`geo-${card.id}`} values={card.geo} onChange={(v) => patch({ geo: v })} options={COUNTRY_OPTIONS} placeholder="Countries — Snapchat has no worldwide targeting" chipMode="code" />
            <div className="flex flex-wrap gap-1">
              {SNAP_GEO_PRESETS.map((p) => {
                const on = presetActive(p.codes);
                return (
                  <button key={p.label} type="button" onClick={() => patch({ geo: [...p.codes] })} aria-pressed={on} className={"rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 active:scale-95 " + (on ? "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ---- LANDING ---- */}
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className={micro}>Landing</span>
              <Seg options={LANDING_OPTIONS} value={card.landingId} onChange={(k) => patch({ landingId: k })} />
            </div>
            {card.landingId === "custom" ? (
              <div className="relative">
                <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input value={card.landingUrl} onChange={(e) => patch({ landingUrl: e.target.value.trim() })} placeholder="https://…" aria-label="Custom landing URL" className={inp + " pl-9"} />
              </div>
            ) : null}
            {segments.length ? (
              <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
                <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {segments.map((seg, i) => (
                    <span key={i} className={seg.role === "landing" ? "text-ink" : seg.role === "key" ? "font-semibold text-[#f3f0a3]" : seg.role === "sccid" ? "text-faint/60" : "text-faint"}>
                      {seg.text}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                  <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    Final link · key {firstKey || "next free"}{stripped ? " · pasted query dropped" : ""}
                    {card.landingId === "custom" ? " · revenue is reported only for the partner's pages" : ""}
                  </span>
                  <button type="button" onClick={copyLink} aria-label="Copy the final link" className={"group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-all duration-200 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " + (copied ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2" : "border-line2 bg-raise text-dim hover:border-accent/50 hover:bg-accent/10 hover:text-ink")}>
                    {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          {/* ---- COPIES ---- */}
          <section className="flex flex-wrap items-center gap-3 border-t border-line/60 pt-4">
            <span className={micro}>Copies</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => patch({ copies: String(Math.max(1, copies - 1)) })} disabled={copies <= 1} className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="Fewer copies">
                −
              </button>
              <input value={card.copies} onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                patch({ copies: raw !== "" && Number(raw) > SNAP_MAX_COPIES ? String(SNAP_MAX_COPIES) : raw });
              }} inputMode="numeric" aria-label="Number of copies" className={inp + " w-14 text-center"} />
              <button type="button" onClick={() => patch({ copies: String(Math.min(SNAP_MAX_COPIES, copies + 1)) })} disabled={copies >= SNAP_MAX_COPIES} className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="More copies">
                +
              </button>
            </div>
            <span className="text-[11px] text-faint">
              {copies} campaign{copies === 1 ? "" : "s"} · keys {nextKeys.length ? nextKeys.join(", ") : "—"}
            </span>
          </section>

          {card.state === "idle" && refusal ? <p className="text-[11px] leading-snug text-warn">{refusal}</p> : null}
          {card.state !== "idle" ? <p className={"break-words font-mono text-[11px] leading-snug " + stateTone}>{card.state === "uploading" ? card.progress ?? "Uploading…" : card.state === "sending" ? "Submitting…" : card.msg ?? "—"}</p> : null}
        </div>
      )}
    </div>
  );
}
