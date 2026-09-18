"use client";

// One fresh TikTok campaign card for the TikTok launcher — rebuilt 2026-09-18 to mirror LION's own
// "Campaign Launcher" field-for-field (owner ask, the same move as the Google launcher on 14.09):
//   row 1  Advertiser · Pixel · Budget (+ CBO under Smart+) · Mode with its value in the same group
//   row 2  Landing URL
//   row 3  Campaign Name (view-only head LION builds + a custom tail) · MOSH · Smart+
//   ────   left: Ad Text · CTA · Identity Name · Identity Image (Upload / Generate + preview)
//          right: the creatives zone + "N video(s) uploaded"
//   ────   Countries · Language · Flag · Gender · Age
// LION's behaviours ride along: the card is LOCKED until an advertiser is picked (pixel, countries
// and languages are that advertiser's own), every field has a ✓ that lights when it is filled, a
// mode the pixel can't run reads "(not allowed)", and Smart+ turns Ad Text into up to five texts
// separated by `|`, CTA into a multi-pick (the first is the main one), shows CBO next to the budget
// and drops Gender / Age. Flag, Gender and Age are shown LOCKED: LION's external API fixes the
// audience (all genders, 18+) and takes no special-industry flag — the structure stays LION's, the
// card never promises what the wire can't carry.
// Every gate is delegated to the SAME validator the server runs (tiktokLaunchWire) on placeholder
// URLs, so the readiness dot can never disagree with LION's answer. Files stay session-local object
// URLs here and ride Vercel Blob only at launch.

import { useRef, useState } from "react";
import { Dropzone } from "./dropzone";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { CheckIcon, ChevronDownIcon, ChevronsIcon, CopyIcon, GlobeIcon, LockIcon, SparklesIcon, TrashIcon, UploadIcon, XIcon } from "./icons";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoney, limitMoneyCents, type FileItem } from "@/lib/types";
import {
  TIKTOK_AD_TEXTS_MAX,
  TIKTOK_BID_MAX,
  TIKTOK_BUDGET_MAX,
  TIKTOK_CTAS,
  TIKTOK_CTAS_MAX,
  TIKTOK_DEFAULT_BUDGET,
  TIKTOK_FIXED_AGE,
  TIKTOK_FIXED_GENDER,
  TIKTOK_IDENTITY_NAME_MAX,
  TIKTOK_LAUNCH_MODES,
  TIKTOK_ROAS_MAX,
  TIKTOK_TITLE_MAX,
  TIKTOK_VIDEOS_MAX,
  splitPipes,
  tiktokBudgetWire,
  tiktokDraftShot,
  tiktokLandingBase,
  tiktokLandingSegments,
  tiktokLaunchWire,
  tiktokModeKind,
  tiktokNameHeadPreview,
  tiktokNamePreview,
  tiktokNameSuffix,
  todaySaoPauloDotDDMM,
  type TiktokLaunchShotIn,
  type TiktokLocaleConfig,
} from "@/lib/tiktok-launch";
import type { TiktokConfigEntry } from "./use-tiktok";
import type { RememberedIdentity } from "./tiktok-identity";
import type { SessionUser } from "./user-menu";

/** TikTok's own ceiling for one ad video — refused on the card instead of after a long upload. */
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

/** One fresh-launch card. Money is HUMAN ("20,00"); assets are session object URLs until launch. */
export type TiktokCard = {
  id: string;
  collapsed: boolean;
  // row 1
  advertiser: string;
  pixel: string;
  budget: string;
  /** Smart+ only: the daily budget sits on the campaign (CBO). */
  cbo: boolean;
  mode: string;
  bid: string;
  // rows 2–3
  landingUrl: string;
  suffix: string;
  mosh: boolean;
  smartPlus: boolean;
  // creative
  /** One text; under Smart+ up to five separated by `|` (the first is the main one). */
  adText: string;
  /** Picked CTAs, the first is the main one (a classic card holds exactly one). */
  ctas: string[];
  identityName: string;
  /** An uploaded / generated avatar (session object URL) … */
  identityFiles: FileItem[];
  /** … or an avatar this browser already hosted (a remembered identity). */
  identityUrl: string;
  videoFiles: FileItem[];
  // targeting
  countries: string[];
  language: string;
  // launch lifecycle (per card)
  state: "idle" | "uploading" | "sending" | "ok" | "error";
  msg?: string;
  progress?: string;
};

// Client-side sequence for cards born AFTER mount (+ / Autofill / Duplicate). The FIRST card is
// created inside the board's useState initializer, which runs on the server AND the client — a
// sequence id there differed between the two renders and tripped React's hydration check on the
// Google launcher (live 09-14), so the first card gets a FIXED id.
let cardSeq = 1;
export const FIRST_TT_CARD_ID = "ttl-card-1";

export function freshTiktokCard(id?: string): TiktokCard {
  return {
    id: id ?? `ttl-card-${++cardSeq}`,
    collapsed: false,
    advertiser: "",
    pixel: "",
    budget: TIKTOK_DEFAULT_BUDGET,
    cbo: false,
    // LION's launcher opens on NORMAL_WITH_BID — the team's book is bid-capped ($0.10–0.90).
    mode: "NORMAL_WITH_BID",
    bid: "",
    landingUrl: "",
    suffix: "",
    mosh: false,
    smartPlus: false,
    adText: "",
    ctas: ["LEARN_MORE"],
    identityName: "",
    identityFiles: [],
    identityUrl: "",
    videoFiles: [],
    countries: [],
    language: "",
    state: "idle",
  };
}

/** Deep-ish clone (Duplicate, +, Autofill) — fresh arrays so a later edit can't bleed into the
 *  sibling. The FILES keep their ids on purpose: the board hosts every file once per tab, so twenty
 *  copies of one card upload their avatar and videos a single time. */
export function cloneTiktokCard(src: TiktokCard): TiktokCard {
  return {
    ...src,
    id: `ttl-card-${++cardSeq}`,
    collapsed: false,
    ctas: [...src.ctas],
    countries: [...src.countries],
    identityFiles: src.identityFiles.map((f) => ({ ...f })),
    videoFiles: src.videoFiles.map((f) => ({ ...f })),
    state: "idle",
    msg: undefined,
    progress: undefined,
  };
}

/** Hosted URLs of a card's files (resolved at launch). */
export type TiktokCardUpload = { identityUrl?: string; videoUrls?: string[] };

/** Build the shot. `upload` present = the real hosted URLs; absent = the DRY-RUN with placeholder
 *  https URLs so the SAME validator gates the card before anything is uploaded. */
export function buildTiktokShot(card: TiktokCard, ctx: { currency?: string; advertiserName?: string; upload?: TiktokCardUpload } = {}): TiktokLaunchShotIn {
  const identityImageUrl = ctx.upload?.identityUrl ?? (card.identityFiles.length ? "https://pending.local/identity.png" : card.identityUrl.trim());
  const videoUrls = ctx.upload?.videoUrls ?? card.videoFiles.map((_, i) => `https://pending.local/video-${i + 1}.mp4`);
  return tiktokDraftShot({
    advertiser: card.advertiser,
    pixel: card.pixel,
    mode: card.mode,
    budget: card.budget,
    bid: card.bid,
    suffix: card.suffix,
    landingUrl: card.landingUrl,
    identityName: card.identityName,
    identityImageUrl,
    adText: card.adText,
    ctas: card.ctas,
    videoUrls,
    countries: card.countries,
    language: card.language,
    mosh: card.mosh,
    smartPlus: card.smartPlus,
    cbo: card.cbo,
    currency: ctx.currency,
    label: `TikTok launch · ${ctx.advertiserName || "advertiser"}`,
  });
}

/** The card's blocking refusal from the shared validator (null when the wire is valid). Advertiser
 *  and pixel readiness are gated by the board (they need the catalogs); here a placeholder stands
 *  in for both so the validator reaches the creative. */
export function tiktokCardRefusal(card: TiktokCard, r: { pixelCode?: string; supportedModes?: string[]; config?: TiktokLocaleConfig } = {}): string | null {
  const big = card.videoFiles.findIndex((f) => f.size > VIDEO_MAX_BYTES);
  if (big >= 0) return `Video #${big + 1} is ${Math.round(card.videoFiles[big].size / 1024 / 1024)} MB — TikTok takes at most 500 MB per video`;
  const built = tiktokLaunchWire(buildTiktokShot(card), {
    advertiserId: card.advertiser || "0000000000",
    pixelCode: r.pixelCode || "PENDING",
    supportedModes: r.supportedModes,
    nameSuffix: "",
    config: r.config,
  });
  return "refusal" in built ? built.refusal : null;
}

/** Signature of a card's launch-relevant content — the wave id is cached per this so a retry after
 *  a lost answer re-sends the same id (the server claim makes it a no-op). */
export function tiktokCardSignature(card: TiktokCard): string {
  return JSON.stringify({
    a: card.advertiser,
    px: card.pixel,
    b: card.budget,
    cbo: card.cbo,
    m: card.mode,
    bd: card.bid,
    l: card.landingUrl,
    s: card.suffix,
    mo: card.mosh,
    sp: card.smartPlus,
    t: card.adText,
    cta: card.ctas,
    idn: card.identityName,
    idf: card.identityFiles.map((f) => f.id),
    idu: card.identityUrl,
    vf: card.videoFiles.map((f) => f.id),
    g: card.countries,
    lg: card.language,
  });
}

// ---------- shared classes ----------

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";
const btn =
  "flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line2 bg-raise px-3 text-[12px] font-semibold text-dim transition-all duration-150 " +
  "hover:border-accent/50 hover:bg-accent/10 hover:text-ink active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

const CTA_OPTIONS = TIKTOK_CTAS.map((c) => ({ value: c.value, label: c.value }));
const FALLBACK_COUNTRIES = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));

/** A tiny ⓘ that shows a wrapping native tooltip (the .tip bubble is nowrap — too narrow for a
 *  paragraph). Purely decorative; the label beside it carries the meaning. */
function InfoDot({ tip }: { tip: string }) {
  return (
    <span
      title={tip}
      role="img"
      aria-label={tip}
      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-line2 text-[8.5px] font-bold text-faint"
    >
      i
    </span>
  );
}

/** A field's label row: LION's launcher puts a ✓ beside every field and lights it once the field
 *  is filled — a filled card reads at a glance without opening anything. */
function FieldLabel({ label, ok, tip, right }: { label: string; ok: boolean; tip?: string; right?: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={micro}>{label}</span>
      {tip ? <InfoDot tip={tip} /> : null}
      <span className="ml-auto flex items-center gap-2">
        {right}
        <CheckIcon aria-hidden="true" className={"h-3 w-3 transition-colors duration-200 " + (ok ? "text-launch2" : "text-line2")} />
      </span>
    </span>
  );
}

/** A field LION's launcher shows but its external API fixes — visible, locked, and honest about why. */
function LockedField({ label, value, tip }: { label: string; value: string; tip: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel label={label} ok tip={tip} />
      <div title={tip} className="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface2/40 px-3 font-mono text-[11px] text-faint">
        <LockIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

// ---------- the card ----------

export function TiktokLaunchCard({
  card,
  index,
  user,
  advertiserOptions,
  config,
  onRetryConfig,
  acr = "",
  advertiserName,
  currency,
  effPixel,
  pixelNeeded,
  refusal,
  ready,
  advertisersLoading,
  highlight,
  locked = false,
  landings,
  identities,
  onForgetIdentity,
  onPatch,
  onDuplicate,
  onRemove,
  onToggleCollapse,
}: {
  card: TiktokCard;
  index: number;
  user?: SessionUser;
  advertiserOptions: RichOption[];
  /** The picked advertiser's config: loaded, failed, or undefined while loading / none picked. */
  config: TiktokConfigEntry | undefined;
  onRetryConfig: (advertiserId: string) => void;
  /** LION user's ACR (lower-cased) — printed in the name head and stamped as mb= on the link. */
  acr?: string;
  advertiserName: string;
  /** The advertiser's currency (every TikTok account is USD today) — the budget / bid unit. */
  currency: string;
  /** The pixel that will ride ("" while unresolved). */
  effPixel: string;
  pixelNeeded: boolean;
  refusal: string | null;
  ready: boolean;
  advertisersLoading: boolean;
  highlight?: boolean;
  /** A wave is uploading / firing: the card is frozen — the shot was cut from what is on screen,
   *  and an edit now would show one campaign while another goes out (the board ignores it too). */
  locked?: boolean;
  /** The team's live landings — suggestions for the landing field. */
  landings: string[];
  identities: RememberedIdentity[];
  onForgetIdentity: (id: RememberedIdentity) => void;
  onPatch: (id: string, p: Partial<TiktokCard>) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const patch = (p: Partial<TiktokCard>) => onPatch(card.id, p);
  const cfg = config && !("error" in config) ? config : null;
  const cfgError = config && "error" in config ? config.error : "";
  const cfgLoading = Boolean(card.advertiser) && !config;
  const kind = tiktokModeKind(card.mode);
  const unit = currency || "USD";
  // LION's launcher keeps every field but Advertiser disabled until an advertiser is picked.
  const fieldsLocked = !card.advertiser;
  const lockCls = fieldsLocked ? "pointer-events-none select-none opacity-45" : "";

  // ---- catalogs of the PICKED advertiser -----------------------------------------------------
  const pixelOptions: RichOption[] = (cfg?.pixels ?? []).map((p) => ({ value: p.pixelCode, label: p.pixelCode }));
  // Value optimisation (VO_HIGHEST_VALUE / VO_MIN_ROAS) is a property of the PIXEL, not of the account.
  const pixelModes = cfg?.pixels.find((p) => p.pixelCode === effPixel)?.supportedModes ?? [];
  const modeAllowed = (m: string) => !m.startsWith("VO_") || pixelModes.length === 0 || pixelModes.includes(m);
  const countryOptions = cfg ? [{ value: "WW", label: "Worldwide" }, ...cfg.countries.map((c) => ({ value: c.code, label: c.name || c.code }))] : [{ value: "WW", label: "Worldwide" }, ...FALLBACK_COUNTRIES];
  const langOptions: RichOption[] = [
    { value: "", label: "without language segmentation" },
    ...(cfg?.languages ?? []).map((l) => ({ value: l.code, label: l.name || l.code, meta: l.code })),
  ];
  const worldwide = card.countries.length === 1 && card.countries[0] === "WW";

  // ---- names and links -------------------------------------------------------------------------
  const landingBase = tiktokLandingBase(card.landingUrl);
  const landingSegments = tiktokLandingSegments(card.landingUrl, { acr, pixel: effPixel || undefined });
  const [landingCopied, setLandingCopied] = useState(false);
  const copyLanding = () => {
    if (!landingBase) return;
    void navigator.clipboard?.writeText(landingBase.base).then(() => {
      setLandingCopied(true);
      setTimeout(() => setLandingCopied(false), 1400);
    });
  };
  const headPreview = tiktokNameHeadPreview({ acr, countries: card.countries, language: card.language, landing: card.landingUrl });
  const bareSuffix = tiktokNameSuffix({ user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: card.suffix });
  const fullNamePreview = tiktokNamePreview({ head: headPreview, suffix: bareSuffix, kind: "launch", smartPlus: card.smartPlus ? (card.cbo ? "campaign" : "adgroup") : "" });

  const changeMode = (val: string) => patch({ mode: val, bid: tiktokModeKind(val) === kind ? card.bid : "" });
  // Smart+ off → a classic campaign: ONE CTA and no CBO (the Ad Text stays as typed — a classic
  // card sends it whole).
  const toggleSmartPlus = (on: boolean) => patch(on ? { smartPlus: true } : { smartPlus: false, cbo: false, ctas: card.ctas.slice(0, 1) });

  // ---- creative ----------------------------------------------------------------------------------
  const texts = card.smartPlus ? splitPipes(card.adText) : [card.adText.trim()].filter(Boolean);
  const overText = texts.find((t) => t.length > TIKTOK_TITLE_MAX);
  const adTextOk = texts.length > 0 && !overText && texts.length <= TIKTOK_AD_TEXTS_MAX && new Set(texts).size === texts.length;
  const [note, setNote] = useState("");
  const onVideoFiles = (files: FileItem[]) => {
    setNote("");
    const vids = files.filter((f) => f.kind === "video");
    if (vids.length > TIKTOK_VIDEOS_MAX) setNote(`A campaign takes at most ${TIKTOK_VIDEOS_MAX} videos — the first ${TIKTOK_VIDEOS_MAX} were kept.`);
    patch({ videoFiles: vids.slice(0, TIKTOK_VIDEOS_MAX) });
  };

  // ---- identity ----------------------------------------------------------------------------------
  const fileInput = useRef<HTMLInputElement>(null);
  const [generating, setGenerating] = useState(false);
  const identityPreview = card.identityFiles[0]?.url || (/^https:\/\//i.test(card.identityUrl) ? card.identityUrl : "");
  const identityText = card.identityFiles[0]?.name || (card.identityUrl ? "hosted avatar (remembered identity)" : "");
  const takeAvatar = (file: File) => {
    setNote("");
    if (!file.type.startsWith("image/")) return setNote("Identity image must be an image file (PNG / JPG).");
    patch({ identityFiles: [{ id: crypto.randomUUID(), name: file.name, size: file.size, kind: "image", url: URL.createObjectURL(file) }], identityUrl: "" });
  };
  const generateAvatar = async () => {
    if (generating) return;
    if (!card.identityName.trim()) return setNote("Type the identity name first — the avatar is drawn for it.");
    setNote("");
    setGenerating(true);
    try {
      // The landing's niche ("digital-marketing", "cars") steers the drawing; never the whole URL.
      const hint = (landingBase?.path.split("/").filter(Boolean).slice(-2, -1)[0] ?? "").replace(/-/g, " ");
      const res = await fetch("/api/tiktok/identity-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: card.identityName, hint }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; mime?: string; b64?: string; error?: string };
      if (!res.ok || !d?.ok || !d.b64) throw new Error(d?.error || `HTTP ${res.status}`);
      const bytes = Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0));
      const mime = d.mime || "image/png";
      takeAvatar(new File([bytes], `generated-${card.identityName.trim().replace(/[^\w-]+/g, "_").slice(0, 40)}.${mime.includes("jpeg") ? "jpg" : "png"}`, { type: mime }));
    } catch (e) {
      setNote(`Couldn't generate the avatar — ${String((e as Error).message ?? e)}. Upload one instead.`);
    } finally {
      setGenerating(false);
    }
  };
  const pickIdentity = (id: RememberedIdentity) => patch({ identityName: id.name, identityUrl: id.imageUrl, identityFiles: [] });

  const stateTone =
    card.state === "error" ? "text-danger" : card.state === "ok" ? "text-launch2" : card.state === "uploading" || card.state === "sending" ? "text-[#9db8ff]" : "text-faint";
  const videoCount = card.videoFiles.length;

  return (
    <div
      id={`ttcard-${card.id}`}
      aria-busy={locked || undefined}
      // `inert` takes the keyboard too — pointer-events alone would still let a focused field edit.
      inert={locked || undefined}
      className={
        "animate-row-in overflow-hidden rounded-2xl border bg-surface transition-shadow " +
        (locked ? "pointer-events-none select-none opacity-75 " : "") +
        (highlight ? "border-accent/60 shadow-[0_0_0_2px_rgba(122,150,255,0.28)]" : "border-line")
      }
    >
      {/* card header */}
      <div className="flex items-center gap-2.5 border-b border-line/70 bg-surface2/30 px-3.5 py-2.5">
        <span className="font-mono text-[12px] text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className={"h-2 w-2 shrink-0 rounded-full " + (ready ? "bg-launch2" : "bg-warn")} title={ready ? "Ready" : "Not ready"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink">{card.smartPlus ? (card.cbo ? "Smart+ CBO campaign" : "Smart+ campaign") : "TikTok campaign"}</p>
          <p className="truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
            {fullNamePreview}
          </p>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">
          {videoCount} video{videoCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => onToggleCollapse(card.id)}
          aria-label={card.collapsed ? "Expand" : "Collapse"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ChevronsIcon className={"h-4 w-4 transition-transform " + (card.collapsed ? "rotate-180" : "")} />
        </button>
        <button
          type="button"
          onClick={() => onDuplicate(card.id)}
          aria-label="Duplicate campaign"
          title="Duplicate this campaign"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CopyIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(card.id)}
          aria-label="Remove campaign"
          title="Delete card"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {card.collapsed ? (
        <div className="flex items-center gap-2 px-3.5 py-2.5 text-[11px] text-faint">
          <span className="truncate">
            {advertiserName || "no advertiser"} · {card.budget} {unit} · {videoCount} video{videoCount === 1 ? "" : "s"}
          </span>
          {card.state !== "idle" ? <span className={"ml-auto truncate font-mono text-[10.5px] " + stateTone}>{card.msg ?? "—"}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* ---- ROW 1 — Advertiser · Pixel · Budget (+CBO) · Mode + its value ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,3.2fr)_minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,3.6fr)]">
            <div className="flex flex-col gap-1.5">
              <FieldLabel label="Advertiser" ok={Boolean(card.advertiser)} />
              <SearchSelect
                value={card.advertiser}
                // Pixel, countries and languages belong to the advertiser — a new one starts clean.
                onChange={(v) => patch({ advertiser: v, pixel: "" })}
                options={advertiserOptions}
                placeholder="Select advertiser"
                warn={!card.advertiser}
                emptyHint={advertisersLoading ? "Loading advertisers…" : "No launch-eligible advertisers"}
                ariaLabel="Advertiser"
              />
            </div>
            <div className={"flex flex-col gap-1.5 " + lockCls} inert={fieldsLocked || undefined}>
              <FieldLabel label="Pixel" ok={Boolean(effPixel)} />
              <SearchSelect
                value={effPixel}
                onChange={(v) => patch({ pixel: v })}
                options={pixelOptions}
                placeholder={cfgLoading ? "Loading…" : "Select pixel"}
                warn={pixelNeeded}
                emptyHint={cfgLoading ? "Loading the advertiser's pixels…" : "No pixels on this advertiser"}
                ariaLabel="Pixel"
              />
            </div>
            <div className={"flex flex-col gap-1.5 " + lockCls} inert={fieldsLocked || undefined}>
              <FieldLabel
                label="Budget"
                ok={Boolean(tiktokBudgetWire(card.budget))}
                tip="Daily budget. TikTok refuses less than 20 — LION never raises it for you."
                right={
                  card.smartPlus ? (
                    <label className="flex cursor-pointer items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-dim" title="Smart+ CBO: the daily budget goes on the campaign and TikTok spreads it. Off, the budget stays on the ad group like a classic campaign.">
                      <input type="checkbox" checked={card.cbo} onChange={(e) => patch({ cbo: e.target.checked })} aria-label="CBO" className="h-3.5 w-3.5 accent-[#7a96ff]" />
                      CBO
                    </label>
                  ) : null
                }
              />
              <div className="relative">
                <input
                  value={card.budget}
                  onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, TIKTOK_BUDGET_MAX) })}
                  inputMode="decimal"
                  placeholder="0,00"
                  aria-label="Daily budget"
                  title="Daily budget — digits fill cents (2000 → 20,00)"
                  className={inp + " pr-12"}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">{unit}</span>
              </div>
            </div>
            <div className={"flex flex-col gap-1.5 " + lockCls} inert={fieldsLocked || undefined}>
              <FieldLabel
                label="Mode"
                ok={modeAllowed(card.mode) && (kind === "none" || card.bid.trim() !== "")}
                tip={"NORMAL_WITH_BID: manual bid required (conversion_bid_price). NORMAL_NO_BID: auto bid without a target price. VO_HIGHEST_VALUE: value optimisation, highest value. VO_MIN_ROAS: value optimisation with a target ROAS (roas_bid). The VO modes need a pixel with value optimisation — otherwise they read “(not allowed)”."}
              />
              <div className="flex gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <select value={card.mode} onChange={(e) => changeMode(e.target.value)} aria-label="Mode" className={inp + " cursor-pointer appearance-none pr-7 font-mono text-[11.5px]"}>
                    {TIKTOK_LAUNCH_MODES.map((m) => (
                      <option key={m.value} value={m.value} disabled={!modeAllowed(m.value)} className="bg-surface text-ink">
                        {modeAllowed(m.value) ? m.value : `${m.value} (not allowed)`}
                      </option>
                    ))}
                  </select>
                  <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                </div>
                {kind === "bid" || kind === "roas" ? (
                  <div className="relative w-[104px] shrink-0">
                    <input
                      value={card.bid}
                      onChange={(e) => patch({ bid: kind === "bid" ? limitMoneyCents(e.target.value, TIKTOK_BID_MAX) : limitMoney(e.target.value, TIKTOK_ROAS_MAX) })}
                      inputMode="decimal"
                      placeholder={kind === "roas" ? "1,2" : "0,00"}
                      aria-label={kind === "roas" ? "ROAS goal" : "Bid per conversion"}
                      title={kind === "roas" ? "Minimum ROAS as a multiplier — 1,2 = 120%" : "Bid per conversion — digits fill cents (46 → 0,46). Must stay below the daily budget."}
                      className={inp + " pr-10"}
                    />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">{kind === "roas" ? "ROAS" : unit}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {card.advertiser && (cfgError || cfgLoading || pixelNeeded || (cfg && cfg.pixels.length === 0)) ? (
            <p className="-mt-2 text-[10.5px] leading-snug text-faint">
              {cfgError ? (
                <span className="text-warn">
                  Couldn&apos;t read the advertiser — {cfgError}.{" "}
                  <button type="button" onClick={() => onRetryConfig(card.advertiser)} className="font-semibold text-[#9db8ff] underline-offset-2 hover:underline">
                    Retry
                  </button>
                </span>
              ) : cfgLoading ? (
                "Reading the advertiser's pixels, countries and languages…"
              ) : pixelNeeded ? (
                <span className="text-warn">This advertiser has several pixels — pick one.</span>
              ) : (
                <span className="text-warn">No usable pixel on this advertiser — LION can&apos;t launch here.</span>
              )}
            </p>
          ) : null}

          <div className={"flex flex-col gap-4 " + lockCls} inert={fieldsLocked || undefined}>
            {/* ---- ROW 2 — Landing URL ---- */}
            <section className="flex flex-col gap-1.5">
              <FieldLabel
                label="Landing URL"
                ok={Boolean(landingBase)}
                tip="Paste only the base URL. LION drops the query string and appends its own tracking (utm, mb, pixel, cl). The suggestions are the landings the team's TikTok campaigns run right now — every one is on LION's allowed domains."
              />
              <div className="relative">
                <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input
                  value={card.landingUrl}
                  onChange={(e) => patch({ landingUrl: e.target.value.trim() })}
                  list={`ttlandings-${card.id}`}
                  placeholder="https://choice-flow.org/ht..."
                  aria-label="Landing URL"
                  className={inp + " pl-9"}
                />
                <datalist id={`ttlandings-${card.id}`}>
                  {landings.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </div>
              {landingSegments.length ? (
                <div className="flex items-start gap-2 rounded-lg border border-line bg-surface2/50 px-3 py-1.5">
                  <p className="min-w-0 flex-1 select-all break-all font-mono text-[10.5px] leading-relaxed">
                    {landingSegments.map((seg, i) => (
                      <span key={i} className={seg.role === "slug" ? "text-ink" : seg.role === "pixel" ? "text-accent2" : "text-faint"}>
                        {seg.text}
                      </span>
                    ))}
                  </p>
                  <button
                    type="button"
                    onClick={copyLanding}
                    aria-label={landingCopied ? "Link copied to clipboard" : "Copy the bare landing"}
                    title="Final launch link — LION appends the tracking itself"
                    className={
                      "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[10.5px] font-semibold transition-all duration-200 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (landingCopied ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2" : "border-line2 bg-raise text-dim hover:border-accent/50 hover:text-ink")
                    }
                  >
                    {landingCopied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                    {landingCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
              {landingBase?.strippedQuery ? <p className="text-[10px] leading-snug text-faint">The pasted query was dropped — LION appends its own tracking.</p> : null}
            </section>

            {/* ---- ROW 3 — Campaign Name (view only + custom) · MOSH · Smart+ ---- */}
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_112px_112px]">
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  label="Campaign Name (view only)"
                  ok
                  tip="LION builds the head: HASH (a random hash) · (glo-01) the user acronym · [cluster|countries|language] · (the landing's slug). Everything after the | is yours. Smart+ adds a locked “Smart+” / “Smart+ CBO” tag."
                />
                <div className="flex flex-col gap-1.5 sm:flex-row">
                  <input
                    value={headPreview}
                    readOnly
                    tabIndex={-1}
                    aria-label="Campaign name head (LION generates it)"
                    className="h-9 w-full cursor-default truncate rounded-lg border border-line bg-surface2/30 px-3 font-mono text-[11px] text-faint outline-none sm:basis-[52%]"
                  />
                  <input
                    value={card.suffix}
                    onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })}
                    maxLength={80}
                    placeholder="Type your custom campaign name (anything you want)"
                    aria-label="Custom name tail"
                    className={inp + " sm:flex-1"}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel label="MOSH" ok tip="If true, LION makes small changes to each creative (borders, audio filters, etc.) so TikTok recognises it as a new video." />
                <div className="relative">
                  <select value={card.mosh ? "TRUE" : "FALSE"} onChange={(e) => patch({ mosh: e.target.value === "TRUE" })} aria-label="MOSH" className={inp + " cursor-pointer appearance-none pr-7 font-mono text-[11.5px]"}>
                    <option value="FALSE" className="bg-surface text-ink">
                      false
                    </option>
                    <option value="TRUE" className="bg-surface text-ink">
                      true
                    </option>
                  </select>
                  <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel label="Smart+" ok tip="When enabled, LION creates a Smart+ campaign: up to 5 ad texts, up to 3 CTAs, an optional CBO budget. Gender and age targeting are not used." />
                <label className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface2 text-[12px] text-dim transition-colors hover:border-line2">
                  <input type="checkbox" checked={card.smartPlus} onChange={(e) => toggleSmartPlus(e.target.checked)} aria-label="Smart+" className="h-3.5 w-3.5 accent-[#7a96ff]" />
                  {card.smartPlus ? "on" : "off"}
                </label>
              </div>
            </div>
            <p className="-mt-2 truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
              {fullNamePreview}
            </p>

            <hr className="border-line/60" />

            {/* ---- CREATIVE — left: texts + identity · right: the creatives zone ---- */}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel
                    label="Ad Text"
                    ok={adTextOk}
                    tip={card.smartPlus ? `Smart+: separate up to ${TIKTOK_AD_TEXTS_MAX} ad texts with |. The first one is the main text. Each up to ${TIKTOK_TITLE_MAX} characters.` : `The caption under the video — up to ${TIKTOK_TITLE_MAX} characters.`}
                    right={
                      <span className={"font-mono text-[10px] tabular-nums " + (overText || texts.length > TIKTOK_AD_TEXTS_MAX ? "text-warn" : "text-faint")}>
                        {card.smartPlus ? `${texts.length}/${TIKTOK_AD_TEXTS_MAX} texts` : `${card.adText.trim().length}/${TIKTOK_TITLE_MAX}`}
                      </span>
                    }
                  />
                  <input
                    value={card.adText}
                    onChange={(e) => patch({ adText: e.target.value.replace(/[\r\n]+/g, " ") })}
                    placeholder={card.smartPlus ? "Main text | Second text | Third text" : "Ad Text"}
                    aria-label="Ad text"
                    className={inp + (overText ? " border-warn/60" : "")}
                  />
                  {overText ? <p className="text-[10px] leading-snug text-warn">&ldquo;{overText.slice(0, 28)}…&rdquo; is over {TIKTOK_TITLE_MAX} characters</p> : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <FieldLabel
                    label="CTA"
                    ok={card.ctas.length > 0 && card.ctas.length <= TIKTOK_CTAS_MAX}
                    tip={card.smartPlus ? `Smart+: pick up to ${TIKTOK_CTAS_MAX} CTAs. The first selected is the main one.` : undefined}
                    right={card.smartPlus ? <span className="font-mono text-[10px] tabular-nums text-faint">{card.ctas.length}/{TIKTOK_CTAS_MAX}</span> : null}
                  />
                  {card.smartPlus ? (
                    <MultiSelect id={`ttctas-${card.id}`} values={card.ctas} onChange={(v) => patch({ ctas: v.slice(0, TIKTOK_CTAS_MAX) })} options={CTA_OPTIONS} placeholder="Pick CTAs — the first is the main one" />
                  ) : (
                    <div className="relative">
                      <select value={card.ctas[0] ?? ""} onChange={(e) => patch({ ctas: [e.target.value] })} aria-label="Call to action" className={inp + " cursor-pointer appearance-none pr-7 font-mono text-[11.5px]"}>
                        {CTA_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} className="bg-surface text-ink">
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                    </div>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_96px]">
                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel label="Identity Name" ok={Boolean(card.identityName.trim())} />
                      <input
                        value={card.identityName}
                        onChange={(e) => patch({ identityName: e.target.value.replace(/[\r\n]+/g, " ").slice(0, TIKTOK_IDENTITY_NAME_MAX) })}
                        placeholder="Identity Name"
                        aria-label="Identity display name"
                        className={inp}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel label="Identity Image" ok={Boolean(identityPreview)} tip="Any PNG / JPG — it is centre-cropped to a square 256×256 PNG at launch (what LION's own upload does)." />
                      <input value={generating ? "Generating…" : identityText} readOnly tabIndex={-1} placeholder="No image" aria-label="Identity image file" className={inp + " cursor-default truncate bg-surface2/40 font-mono text-[11px] text-dim"} />
                      <input
                        id={`ttidentity-${card.id}`}
                        ref={fileInput}
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) takeAvatar(f);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-row gap-2 sm:flex-col sm:justify-end">
                    <button type="button" onClick={() => fileInput.current?.click()} className={btn}>
                      <UploadIcon className="h-3.5 w-3.5" />
                      Upload
                    </button>
                    <button type="button" onClick={() => void generateAvatar()} disabled={generating} title="Draw an avatar for this identity name" className={btn}>
                      <SparklesIcon className="h-3.5 w-3.5" />
                      {generating ? "…" : "Generate"}
                    </button>
                  </div>
                  <span className="flex h-[96px] w-[96px] shrink-0 items-center justify-center self-end overflow-hidden rounded-full border border-line bg-surface2/50 text-[10px] text-faint">
                    {identityPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local blob / hosted avatar preview
                      <img src={identityPreview} alt="Identity avatar preview" className="h-full w-full object-cover" />
                    ) : (
                      "No image"
                    )}
                  </span>
                </div>
                {identities.length ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-faint">Recent:</span>
                    {identities.map((id) => {
                      const on = card.identityUrl === id.imageUrl && card.identityName === id.name && card.identityFiles.length === 0;
                      return (
                        <span key={`${id.name}|${id.imageUrl}`} className={"flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-1 text-[11px] " + (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim")}>
                          <button type="button" onClick={() => pickIdentity(id)} aria-pressed={on} title={`Use “${id.name}”`} className="flex items-center gap-1.5 rounded-full hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                            {/* eslint-disable-next-line @next/next/no-img-element -- hosted avatar thumb */}
                            <img src={id.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                            <span className="max-w-[140px] truncate">{id.name}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onForgetIdentity(id)}
                            aria-label={`Forget ${id.name}`}
                            title="Forget this identity"
                            className="flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                          >
                            <XIcon className="h-3 w-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <FieldLabel
                  label="Creatives"
                  ok={videoCount > 0}
                  tip={`1–${TIKTOK_VIDEOS_MAX} videos. ALL of them go into one ad group as a Smart Creative — TikTok rotates them itself. Vertical 9:16 fills the screen.`}
                />
                <Dropzone id={`ttvideos-${card.id}`} files={card.videoFiles} onChange={onVideoFiles} maxFiles={TIKTOK_VIDEOS_MAX} accept="video" portrait />
                <p className="text-[10.5px] text-faint">
                  {videoCount} video{videoCount === 1 ? "" : "s"} uploaded
                </p>
              </div>
            </div>
            {note ? <p className="-mt-1 text-[10.5px] leading-snug text-warn">{note}</p> : null}

            <hr className="border-line/60" />

            {/* ---- TARGETING — Countries · Language · Flag · Gender · Age ---- */}
            <div className={"grid gap-3 sm:grid-cols-2 " + (card.smartPlus ? "lg:grid-cols-[minmax(0,4fr)_minmax(0,2fr)_minmax(0,2fr)]" : "lg:grid-cols-[minmax(0,4fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,2fr)]")}>
              <div className="flex flex-col gap-1.5">
                <FieldLabel label="Countries" ok={card.countries.length > 0} tip="The list is the picked advertiser's own — LION refuses a country it can't target there. Worldwide stands alone and needs a language." />
                <MultiSelect id={`ttgeo-${card.id}`} values={card.countries} onChange={(v) => patch({ countries: v })} options={countryOptions} placeholder="Select countries" chipMode="code" exclusiveValues={["WW"]} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel label="Language" ok={!worldwide || Boolean(card.language)} />
                <SearchSelect value={card.language} onChange={(v) => patch({ language: v })} options={langOptions} placeholder="Select language" warn={worldwide && !card.language} emptyHint="No matches" ariaLabel="Language" />
              </div>
              <LockedField label="Flag" value="none" tip="Special industries (HOUSING / EMPLOYMENT / CREDIT): LION's external API takes no such flag, so a campaign launched from here carries none. Launch flagged campaigns from LION's own launcher." />
              {card.smartPlus ? null : (
                <>
                  <LockedField label="Gender" value={TIKTOK_FIXED_GENDER} tip="LION's external API fixes the audience to all genders — sending targeting is refused." />
                  <LockedField label="Age" value={TIKTOK_FIXED_AGE} tip="LION's external API fixes the audience to 18+ — sending targeting is refused." />
                </>
              )}
            </div>
            {worldwide && !card.language ? <p className="-mt-2 text-[10px] leading-snug text-warn">Worldwide needs a language.</p> : null}
          </div>

          {/* per-card gate note / launch state */}
          {card.state === "idle" && refusal && !fieldsLocked ? <p className="text-[11px] leading-snug text-warn">{refusal}</p> : null}
          {card.state !== "idle" ? (
            <p className={"break-words font-mono text-[11px] leading-snug " + stateTone}>
              {card.state === "uploading" ? card.progress ?? "Uploading…" : card.state === "sending" ? "Submitting…" : card.msg ?? "—"}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
