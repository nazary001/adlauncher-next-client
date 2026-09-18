"use client";

// One fresh TikTok campaign card for the TikTok launcher. The FIELDS and their vocabulary are LION's
// own "Campaign Launcher" (owner ask 18.09: Advertiser · Pixel · Budget · Mode + its value · Landing
// URL · Campaign Name · MOSH · Smart+ · Ad Text · CTA · Identity Name / Image · Creatives · Countries ·
// Language · Flag · Gender · Age); the PRESENTATION is ours (redesign 18.09, owner ask: easier to
// read, adaptive, convenient):
//   header   index · the advertiser as the title · Ready / "N to fill" · the full name LION will write
//   strip    the to-do list: a chip per missing field that scrolls to it (or the launch progress)
//   blocks   Account & bidding · Landing & name · Creative · Audience — a name, one plain sentence and
//            the block's own status in a left rail on wide screens, stacked on narrow ones
// What reads differently from LION on purpose: a required-and-empty field wears an amber dot (the eye
// goes to what is LEFT, not to a dozen green ticks); Mode is four buttons that carry the human name
// AND LION's raw value; MOSH / Smart+ / CBO are switches that say what they do; the name is ONE
// control (the locked part LION writes + the buyer's note); a refusal about the bid is read under the
// bid. Flag, Gender and Age stay VISIBLE and locked in one line: LION's external API fixes the
// audience (all genders, 18+) and takes no special-industry flag — the card never promises what the
// wire can't carry. LION's behaviours ride along: everything but Advertiser is inert until an
// advertiser is picked (pixel, countries and languages are that advertiser's own), a mode the pixel
// can't run reads "(not allowed)", and Smart+ turns Ad Text into up to five texts separated by `|`,
// CTA into a multi-pick (the first is the main one), offers CBO and drops Gender / Age.
// Every gate is delegated to the SAME validator the server runs (tiktokLaunchWire) on placeholder
// URLs, so the readiness pill can never disagree with LION's answer. Files stay session-local object
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
const micro = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-dim select-none";
const btn =
  "flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line2 bg-raise px-3 text-[12px] font-semibold text-dim transition-all duration-150 " +
  "hover:border-accent/50 hover:bg-accent/10 hover:text-ink active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const iconBtn =
  "flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

const CTA_OPTIONS = TIKTOK_CTAS.map((c) => ({ value: c.value, label: c.value }));
const FALLBACK_COUNTRIES = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));

// ---------- building blocks ----------

/** A ⓘ whose explanation opens on hover AND on focus — a tap on a phone focuses it, where a native
 *  `title` never shows — and wraps like a paragraph (the shared .tip bubble is one nowrap line). */
function Hint({ tip }: { tip: string }) {
  return (
    <span className="group/hint relative inline-flex">
      <button
        type="button"
        aria-label={tip}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-line2 text-[9px] font-bold normal-case text-faint transition-colors hover:border-accent/50 hover:text-ink focus-visible:border-accent/60 focus-visible:text-ink focus-visible:outline-none"
      >
        i
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-[calc(100%+6px)] z-40 w-[min(300px,72vw)] rounded-lg border border-line2 bg-raise px-3 py-2 text-[11.5px] font-normal normal-case leading-relaxed tracking-normal text-dim opacity-0 shadow-[0_14px_36px_rgba(0,0,0,0.55)] transition-opacity duration-150 group-focus-within/hint:opacity-100 group-hover/hint:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

/** One field: its label, an amber dot while it is REQUIRED AND EMPTY (the eye goes to what is left,
 *  not to a dozen green ticks), an optional hint and counter, the control, and a note right under
 *  it — a refusal is read next to the field it is about, not at the bottom of the card. */
function Field({ label, need = false, tip, right, note, className = "", children }: { label: string; need?: boolean; tip?: string; right?: React.ReactNode; note?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={"flex min-w-0 flex-col gap-1.5 " + className}>
      <span className="flex min-h-4 items-center gap-1.5">
        <span className={micro}>{label}</span>
        {need ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Needed to launch" /> : null}
        {tip ? <Hint tip={tip} /> : null}
        {right ? <span className="ml-auto flex items-center gap-2">{right}</span> : null}
      </span>
      {children}
      {note ? <p className="text-[11px] leading-snug text-warn">{note}</p> : null}
    </div>
  );
}

/** A named block of the card. Wide screens put the name, one plain sentence and the block's status
 *  in a left rail and the fields beside it (from `xl`: below that the launch bay already takes a
 *  third of the row); narrower screens stack the same header on top. */
function Section({ id, title, blurb, left, locked, children }: { id?: string; title: string; blurb: string; left: number; locked?: boolean; children: React.ReactNode }) {
  return (
    <section
      id={id}
      inert={locked || undefined}
      className={"grid scroll-mt-36 gap-x-6 gap-y-3.5 border-t border-line/70 px-4 py-5 sm:px-5 xl:grid-cols-[168px_minmax(0,1fr)] " + (locked ? "pointer-events-none select-none opacity-40" : "")}
    >
      <header className="flex items-start justify-between gap-3 xl:flex-col xl:justify-start xl:gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-[11.5px] leading-snug text-faint">{blurb}</p>
        </div>
        {locked ? null : left === 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-launch/25 bg-launch/10 px-1.5 py-0.5 text-[10.5px] font-medium text-launch2">
            <CheckIcon className="h-3 w-3" />
            Set
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center rounded-md border border-warn/25 bg-warn/5 px-1.5 py-0.5 text-[10.5px] font-medium text-warn">{left} to fill</span>
        )}
      </header>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

/** An on/off option as a switch with its consequence spelled out (a real checkbox underneath, so
 *  the keyboard and screen readers get a native control). */
function SwitchTile({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={"flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-150 " + (checked ? "border-accent/45 bg-accent/[0.08]" : "border-line bg-surface2/50 hover:border-line2")}>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="peer sr-only" />
      <span aria-hidden="true" className={"mt-0.5 flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 " + (checked ? "bg-accent" : "bg-line2")}>
        <span className={"h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 " + (checked ? "translate-x-[14px]" : "")} />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        <span className="block text-[11px] leading-snug text-faint">{desc}</span>
      </span>
    </label>
  );
}

/** A value LION's launcher shows but its external API fixes — visible, locked, honest about why. */
function FixedChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface2/60 px-2 py-1 text-[10.5px]">
      <span className="text-faint">{label}</span>
      <span className="font-mono text-dim">{value}</span>
    </span>
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
  const dim = fieldsLocked ? "pointer-events-none select-none opacity-40" : "";

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
  const ownSuffix = tiktokNameSuffix({ user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: "" });

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

  const videoCount = card.videoFiles.length;

  // ---- what is still missing, block by block ---------------------------------------------------
  // The SAME facts the old per-field ticks read, turned around: the card lists what is LEFT. Every
  // entry knows the element to jump to, so the header's chips are a to-do list that scrolls.
  type Need = { label: string; target: string };
  const ids = {
    advertiser: `ttadv-${card.id}`,
    pixel: `ttpixel-${card.id}`,
    budget: `ttbudget-${card.id}`,
    mode: `ttmode-${card.id}`,
    bid: `ttbid-${card.id}`,
    landing: `ttlanding-${card.id}`,
    adText: `ttadtext-${card.id}`,
    ctas: `ttctas-${card.id}`,
    identityName: `ttidname-${card.id}`,
    identityImage: `ttidimage-${card.id}`,
    creative: `ttsec-creative-${card.id}`,
    geo: `ttgeo-${card.id}`,
    language: `ttlang-${card.id}`,
  };
  const modeOk = modeAllowed(card.mode);
  const bidMissing = (kind === "bid" || kind === "roas") && card.bid.trim() === "";
  const needAccount: Need[] = [
    ...(!card.advertiser ? [{ label: "Advertiser", target: ids.advertiser }] : []),
    ...(card.advertiser && !effPixel ? [{ label: "Pixel", target: ids.pixel }] : []),
    ...(!tiktokBudgetWire(card.budget) ? [{ label: "Budget", target: ids.budget }] : []),
    ...(!modeOk ? [{ label: "Mode", target: ids.mode }] : []),
    ...(modeOk && bidMissing ? [{ label: kind === "roas" ? "ROAS goal" : "Bid", target: ids.bid }] : []),
  ];
  const needLanding: Need[] = landingBase ? [] : [{ label: "Landing URL", target: ids.landing }];
  const needCreative: Need[] = [
    ...(videoCount === 0 ? [{ label: "Videos", target: ids.creative }] : []),
    ...(!adTextOk ? [{ label: "Ad text", target: ids.adText }] : []),
    ...(card.ctas.length === 0 || card.ctas.length > TIKTOK_CTAS_MAX ? [{ label: "CTA", target: ids.ctas }] : []),
    ...(!card.identityName.trim() ? [{ label: "Identity name", target: ids.identityName }] : []),
    ...(!identityPreview ? [{ label: "Identity image", target: ids.identityImage }] : []),
  ];
  const needAudience: Need[] = [
    ...(card.countries.length === 0 ? [{ label: "Countries", target: ids.geo }] : []),
    ...(worldwide && !card.language ? [{ label: "Language", target: ids.language }] : []),
  ];
  const needs = fieldsLocked ? needAccount.slice(0, 1) : [...needAccount, ...needLanding, ...needCreative, ...needAudience];
  const has = (list: Need[], label: string) => list.some((n) => n.label === label);
  const jump = (target: string) => {
    const el = document.getElementById(target);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) el.focus({ preventScroll: true });
  };
  // A refusal that is about the bid / ROAS is read under that field; anything else (and only once
  // nothing is plainly missing) is read in the header strip.
  const bidRefusal = refusal && !bidMissing && /\b(bid|roas)\b/i.test(refusal) ? refusal : "";

  const stateTone = card.state === "error" ? "border-danger/25 bg-danger/[0.06] text-danger" : card.state === "ok" ? "border-launch/25 bg-launch/[0.06] text-launch2" : "border-accent/25 bg-accent/[0.06] text-[#9db8ff]";
  const modeDef = TIKTOK_LAUNCH_MODES.find((m) => m.value === card.mode);
  const geoLabel = card.countries.join("+");
  const summary = [advertiserName || "no advertiser", `${card.budget} ${unit}/day`, `${videoCount} video${videoCount === 1 ? "" : "s"}`, geoLabel].filter(Boolean).join(" · ");
  const kindTitle = card.smartPlus ? (card.cbo ? "Smart+ CBO campaign" : "Smart+ campaign") : "TikTok campaign";

  return (
    <div
      id={`ttcard-${card.id}`}
      aria-busy={locked || undefined}
      // `inert` takes the keyboard too — pointer-events alone would still let a focused field edit.
      inert={locked || undefined}
      className={
        "animate-row-in rounded-2xl border bg-surface transition-shadow " +
        (locked ? "pointer-events-none select-none opacity-75 " : "") +
        (highlight ? "border-accent/60 shadow-[0_0_0_2px_rgba(122,150,255,0.28)]" : "border-line")
      }
    >
      {/* ---- header: what this card is, how far along it is, and its actions ---- */}
      <div className={"flex items-center gap-3 bg-surface2/30 px-4 py-3 sm:px-5 " + (card.collapsed ? "rounded-2xl" : "rounded-t-2xl")}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface2 font-mono text-[11px] text-dim">{String(index + 1).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-[13.5px] font-semibold text-ink">{advertiserName || kindTitle}</p>
            {advertiserName ? <span className="hidden shrink-0 text-[11px] text-faint sm:inline">{kindTitle}</span> : null}
            <span
              className={
                "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium " +
                (ready ? "border-launch/30 bg-launch/10 text-launch2" : card.state === "ok" ? "border-launch/20 bg-launch/5 text-launch2/80" : "border-warn/25 bg-warn/5 text-warn")
              }
              title={ready ? "Ready" : "Not ready"}
            >
              <span className={"h-1.5 w-1.5 rounded-full " + (ready || card.state === "ok" ? "bg-launch2" : "bg-warn")} />
              {ready ? "Ready" : card.state === "ok" ? "Queued" : needs.length ? `${needs.length} to fill` : "Not ready"}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint" title={fullNamePreview}>
            {fullNamePreview}
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-1.5 xl:flex">
          <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10.5px] text-dim">
            {card.budget} {unit}
          </span>
          {modeDef ? <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-dim">{modeDef.label}</span> : null}
          <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10.5px] text-dim">
            {videoCount} video{videoCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex shrink-0 items-center">
          <button type="button" onClick={() => onToggleCollapse(card.id)} aria-label={card.collapsed ? "Expand" : "Collapse"} aria-expanded={!card.collapsed} className={iconBtn}>
            <ChevronsIcon className={"h-4 w-4 transition-transform " + (card.collapsed ? "rotate-180" : "")} />
          </button>
          <button type="button" onClick={() => onDuplicate(card.id)} aria-label="Duplicate campaign" title="Duplicate this campaign" className={iconBtn}>
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
      </div>

      {/* ---- the strip: a launch in progress, or the to-do list that scrolls to each field ---- */}
      {card.state !== "idle" ? (
        <p className={"break-words border-t px-4 py-2.5 font-mono text-[11.5px] leading-snug sm:px-5 " + stateTone + (card.collapsed ? " rounded-b-2xl" : "")}>
          {card.state === "uploading" ? card.progress ?? "Uploading…" : card.state === "sending" ? "Submitting…" : card.msg ?? "—"}
        </p>
      ) : !ready && !card.collapsed ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-warn/15 bg-warn/[0.04] px-4 py-2.5 sm:px-5">
          <span className="text-[11.5px] font-medium text-warn">{fieldsLocked ? "Pick an advertiser to unlock the card — its pixels, countries and languages come from it." : needs.length ? "Still needed" : refusal ?? "Not ready yet"}</span>
          {fieldsLocked
            ? null
            : needs.map((n) => (
                <button
                  key={n.label}
                  type="button"
                  onClick={() => jump(n.target)}
                  className="rounded-md border border-warn/30 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn transition-colors hover:border-warn/60 hover:bg-warn/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40"
                >
                  {n.label}
                </button>
              ))}
        </div>
      ) : null}

      {card.collapsed ? (
        <p className="truncate border-t border-line/70 px-4 py-2.5 text-[11.5px] text-faint sm:px-5 xl:hidden">{summary}</p>
      ) : (
        <>
          {/* ================= ACCOUNT & BIDDING ================= */}
          <Section title="Account & bidding" blurb="Who pays, how much a day, and how TikTok bids." left={needAccount.length}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,0.8fr)]">
              <Field label="Advertiser" need={!card.advertiser} className="sm:col-span-2 xl:col-span-1">
                <SearchSelect
                  id={ids.advertiser}
                  value={card.advertiser}
                  // Pixel, countries and languages belong to the advertiser — a new one starts clean.
                  onChange={(v) => patch({ advertiser: v, pixel: "" })}
                  options={advertiserOptions}
                  placeholder="Select advertiser"
                  warn={!card.advertiser}
                  emptyHint={advertisersLoading ? "Loading advertisers…" : "No launch-eligible advertisers"}
                  ariaLabel="Advertiser"
                />
              </Field>
              <div className={dim} inert={fieldsLocked || undefined}>
                <Field label="Pixel" need={has(needAccount, "Pixel")}>
                  <SearchSelect
                    id={ids.pixel}
                    value={effPixel}
                    onChange={(v) => patch({ pixel: v })}
                    options={pixelOptions}
                    placeholder={cfgLoading ? "Loading…" : "Select pixel"}
                    warn={pixelNeeded}
                    emptyHint={cfgLoading ? "Loading the advertiser's pixels…" : "No pixels on this advertiser"}
                    ariaLabel="Pixel"
                  />
                </Field>
              </div>
              <div className={dim} inert={fieldsLocked || undefined}>
                <Field label="Budget" need={has(needAccount, "Budget")} tip="Daily budget. TikTok refuses less than 20 — LION never raises it for you." note={has(needAccount, "Budget") ? "At least 20,00 a day." : undefined}>
                  <div className="relative">
                    <input
                      id={ids.budget}
                      value={card.budget}
                      onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, TIKTOK_BUDGET_MAX) })}
                      inputMode="decimal"
                      placeholder="0,00"
                      aria-label="Daily budget"
                      title="Daily budget — digits fill cents (2000 → 20,00)"
                      className={inp + " pr-16 font-mono tabular-nums"}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">{unit}/day</span>
                  </div>
                </Field>
              </div>
            </div>
            {card.advertiser && (cfgError || cfgLoading || pixelNeeded || (cfg && cfg.pixels.length === 0)) ? (
              <p className="-mt-1 text-[11px] leading-snug text-faint">
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

            <div className={"grid gap-3 lg:grid-cols-[minmax(0,1fr)_176px] " + dim} inert={fieldsLocked || undefined}>
              <Field
                label="Mode"
                need={has(needAccount, "Mode")}
                tip={"NORMAL_WITH_BID: manual bid required (conversion_bid_price). NORMAL_NO_BID: auto bid without a target price. VO_HIGHEST_VALUE: value optimisation, highest value. VO_MIN_ROAS: value optimisation with a target ROAS (roas_bid). The VO modes need a pixel with value optimisation — otherwise they read “not allowed”."}
                note={!modeOk ? "This pixel has no value optimisation — pick another mode or pixel." : undefined}
              >
                <div id={ids.mode} role="radiogroup" aria-label="Mode" className="grid grid-cols-2 gap-1.5 min-[1400px]:grid-cols-4">
                  {TIKTOK_LAUNCH_MODES.map((m) => {
                    const allowed = modeAllowed(m.value);
                    const on = card.mode === m.value;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={m.value}
                        disabled={!allowed}
                        onClick={() => changeMode(m.value)}
                        className={
                          "flex min-w-0 flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 " +
                          (on ? "border-accent/55 bg-accent/[0.12]" : "border-line bg-surface2/60 hover:border-line2")
                        }
                      >
                        <span className={"text-[12.5px] font-semibold " + (on ? "text-ink" : "text-dim")}>{m.label}</span>
                        <span className="w-full truncate font-mono text-[9.5px] text-faint">{allowed ? m.value : `${m.value} (not allowed)`}</span>
                      </button>
                    );
                  })}
                </div>
                {modeDef ? <p className="text-[11px] leading-snug text-faint">{modeDef.hint}</p> : null}
              </Field>
              {kind === "bid" || kind === "roas" ? (
                <Field label={kind === "roas" ? "ROAS goal" : "Bid per conversion"} need={bidMissing} note={bidRefusal || (bidMissing ? (kind === "roas" ? "Set the minimum ROAS, e.g. 1,2." : "Set the bid, e.g. 0,46.") : undefined)}>
                  <div className="relative">
                    <input
                      id={ids.bid}
                      value={card.bid}
                      onChange={(e) => patch({ bid: kind === "bid" ? limitMoneyCents(e.target.value, TIKTOK_BID_MAX) : limitMoney(e.target.value, TIKTOK_ROAS_MAX) })}
                      inputMode="decimal"
                      placeholder={kind === "roas" ? "1,2" : "0,00"}
                      aria-label={kind === "roas" ? "ROAS goal" : "Bid per conversion"}
                      title={kind === "roas" ? "Minimum ROAS as a multiplier — 1,2 = 120%" : "Bid per conversion — digits fill cents (46 → 0,46). Must stay below the daily budget."}
                      className={inp + " pr-12 font-mono tabular-nums" + (bidMissing || bidRefusal ? " border-warn/50" : "")}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">{kind === "roas" ? "ROAS" : unit}</span>
                  </div>
                </Field>
              ) : (
                <Field label="Bid">
                  <div className="flex h-9 items-center rounded-lg border border-dashed border-line px-3 text-[11.5px] text-faint">TikTok sets it</div>
                </Field>
              )}
            </div>
          </Section>

          {/* ================= LANDING & NAME ================= */}
          <Section title="Landing & name" blurb="Where the ad leads and how the campaign is called in LION." left={needLanding.length} locked={fieldsLocked}>
            <Field
              label="Landing URL"
              need={has(needLanding, "Landing URL")}
              tip="Paste only the base URL. LION drops the query string and appends its own tracking (utm, mb, pixel, cl). The suggestions are the landings the team's TikTok campaigns run right now — every one is on LION's allowed domains."
            >
              <div className="relative">
                <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input
                  id={ids.landing}
                  value={card.landingUrl}
                  onChange={(e) => patch({ landingUrl: e.target.value.trim() })}
                  list={`ttlandings-${card.id}`}
                  placeholder="https://choice-flow.org/ht..."
                  aria-label="Landing URL"
                  className={inp + " pl-9"}
                />
                <datalist id={`ttlandings-${card.id}`}>
                  {[...new Set(landings)].map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </div>
              {landingSegments.length ? (
                <div className="flex items-start gap-2 rounded-lg border border-line bg-black/20 px-3 py-2">
                  <p className="max-h-[4.6rem] min-w-0 flex-1 select-all overflow-y-auto break-all font-mono text-[10.5px] leading-relaxed">
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
              {landingBase?.strippedQuery ? <p className="text-[11px] leading-snug text-faint">The pasted query was dropped — LION appends its own tracking.</p> : null}
            </Field>

            <Field
              label="Campaign name"
              tip="LION builds the locked part: HASH (a random hash) · (glo-01) the user acronym · [cluster|countries|language] · (the landing's slug). Everything after the | is yours. Smart+ adds a locked “Smart+” / “Smart+ CBO” tag."
            >
              {/* ONE control: the part LION writes (locked) and the part the buyer types, side by side
                  on a wide card and stacked on a narrow one. The full name is printed in the header. */}
              <div className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface2 transition-[border-color,box-shadow] duration-150 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 hover:border-line2 md:flex-row">
                <span className="flex min-w-0 items-center gap-1.5 border-b border-line/70 bg-black/25 px-3 py-2 md:max-w-[56%] md:border-b-0 md:border-r" title={`${headPreview} | ${ownSuffix}`}>
                  <LockIcon className="h-3 w-3 shrink-0 text-faint" />
                  <span className="truncate font-mono text-[11px] text-faint">{headPreview}</span>
                </span>
                <input
                  value={card.suffix}
                  onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })}
                  maxLength={80}
                  placeholder="Your own note — a creo, a test, anything"
                  aria-label="Custom name tail"
                  className="h-9 min-w-0 flex-1 bg-transparent px-3 text-[13px] text-ink outline-none placeholder:text-faint"
                />
              </div>
              <p className="text-[11px] leading-snug text-faint">
                LION writes the locked part; <span className="font-mono text-dim">{ownSuffix}</span> goes before your note.
              </p>
            </Field>

            <div className={"grid gap-2.5 " + (card.smartPlus ? "md:grid-cols-3" : "md:grid-cols-2")}>
              <SwitchTile label="MOSH" desc="LION slightly alters each video (borders, audio) so TikTok reads it as new." checked={card.mosh} onChange={(on) => patch({ mosh: on })} />
              <SwitchTile label="Smart+" desc={`Up to ${TIKTOK_AD_TEXTS_MAX} ad texts and ${TIKTOK_CTAS_MAX} CTAs; gender and age aren't used.`} checked={card.smartPlus} onChange={toggleSmartPlus} />
              {card.smartPlus ? <SwitchTile label="CBO" desc="The daily budget sits on the campaign and TikTok spreads it; off — on the ad group." checked={card.cbo} onChange={(on) => patch({ cbo: on })} /> : null}
            </div>
          </Section>

          {/* ================= CREATIVE ================= */}
          <Section id={ids.creative} title="Creative" blurb="The videos, the caption under them and who the ad speaks as." left={needCreative.length} locked={fieldsLocked}>
            <Field
              label="Creatives"
              need={has(needCreative, "Videos")}
              tip={`1–${TIKTOK_VIDEOS_MAX} videos. ALL of them go into one ad group as a Smart Creative — TikTok rotates them itself. Vertical 9:16 fills the screen.`}
              right={<span className="font-mono text-[10.5px] tabular-nums text-faint">{videoCount}/{TIKTOK_VIDEOS_MAX}</span>}
            >
              <Dropzone id={`ttvideos-${card.id}`} files={card.videoFiles} onChange={onVideoFiles} maxFiles={TIKTOK_VIDEOS_MAX} accept="video" portrait />
              <p className="text-[11px] leading-snug text-faint">
                {videoCount} video{videoCount === 1 ? "" : "s"} uploaded{videoCount > 1 ? " — all in one ad group, TikTok rotates them" : ""}
              </p>
            </Field>

            <div className="grid gap-x-5 gap-y-4 xl:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-4">
                <Field
                  label="Ad text"
                  need={has(needCreative, "Ad text")}
                  tip={card.smartPlus ? `Smart+: separate up to ${TIKTOK_AD_TEXTS_MAX} ad texts with |. The first one is the main text. Each up to ${TIKTOK_TITLE_MAX} characters.` : `The caption under the video — up to ${TIKTOK_TITLE_MAX} characters.`}
                  right={
                    <span className={"font-mono text-[10.5px] tabular-nums " + (overText || texts.length > TIKTOK_AD_TEXTS_MAX ? "text-warn" : "text-faint")}>
                      {card.smartPlus ? `${texts.length}/${TIKTOK_AD_TEXTS_MAX} texts` : `${card.adText.trim().length}/${TIKTOK_TITLE_MAX}`}
                    </span>
                  }
                  note={overText ? `“${overText.slice(0, 28)}…” is over ${TIKTOK_TITLE_MAX} characters` : undefined}
                >
                  <input
                    id={ids.adText}
                    value={card.adText}
                    onChange={(e) => patch({ adText: e.target.value.replace(/[\r\n]+/g, " ") })}
                    placeholder={card.smartPlus ? "Main text | Second text | Third text" : "The caption under the video"}
                    aria-label="Ad text"
                    className={inp + (overText ? " border-warn/60" : "")}
                  />
                  {card.smartPlus && texts.length > 1 ? (
                    <ol className="flex flex-col gap-1">
                      {texts.map((t, i) => (
                        <li key={`${i}-${t}`} className="flex items-baseline gap-2 text-[11.5px] leading-snug text-dim">
                          <span className="w-9 shrink-0 font-mono text-[10px] text-faint">{i === 0 ? "main" : `#${i + 1}`}</span>
                          <span className={"min-w-0 break-words " + (t.length > TIKTOK_TITLE_MAX ? "text-warn" : "")}>{t}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </Field>

                <Field
                  label="CTA"
                  need={has(needCreative, "CTA")}
                  tip={card.smartPlus ? `Smart+: pick up to ${TIKTOK_CTAS_MAX} CTAs. The first selected is the main one.` : undefined}
                  right={card.smartPlus ? <span className="font-mono text-[10.5px] tabular-nums text-faint">{card.ctas.length}/{TIKTOK_CTAS_MAX}</span> : null}
                >
                  {card.smartPlus ? (
                    <MultiSelect id={ids.ctas} values={card.ctas} onChange={(v) => patch({ ctas: v.slice(0, TIKTOK_CTAS_MAX) })} options={CTA_OPTIONS} placeholder="Pick CTAs — the first is the main one" />
                  ) : (
                    <div className="relative">
                      <select id={ids.ctas} value={card.ctas[0] ?? ""} onChange={(e) => patch({ ctas: [e.target.value] })} aria-label="Call to action" className={inp + " cursor-pointer appearance-none pr-7 font-mono text-[12px]"}>
                        {CTA_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} className="bg-surface text-ink">
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                    </div>
                  )}
                </Field>
              </div>

              {/* identity: the avatar IS the upload target; the name sits beside it */}
              <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface2/40 p-3">
                <div className="flex items-start gap-3">
                  <button
                    id={ids.identityImage}
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    aria-label={identityPreview ? "Replace the identity image" : "Upload an identity image"}
                    title="Any PNG / JPG — it is centre-cropped to a square 256×256 PNG at launch"
                    className={
                      "group/av relative flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-full border bg-surface2 text-faint transition-colors duration-150 hover:border-accent/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (identityPreview ? "border-line2" : "border-dashed " + (has(needCreative, "Identity image") ? "border-warn/50" : "border-line2"))
                    }
                  >
                    {identityPreview ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local blob / hosted avatar preview
                      <img src={identityPreview} alt="Identity avatar preview" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex flex-col items-center gap-0.5 text-[10px] leading-none">
                        <UploadIcon className="h-4 w-4" />
                        {generating ? "…" : "Avatar"}
                      </span>
                    )}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Field label="Identity name" need={has(needCreative, "Identity name")}>
                      <input
                        id={ids.identityName}
                        value={card.identityName}
                        onChange={(e) => patch({ identityName: e.target.value.replace(/[\r\n]+/g, " ").slice(0, TIKTOK_IDENTITY_NAME_MAX) })}
                        placeholder="The account name viewers see"
                        aria-label="Identity display name"
                        className={inp}
                      />
                    </Field>
                    <Field label="Identity image" need={has(needCreative, "Identity image")} tip="Any PNG / JPG — it is centre-cropped to a square 256×256 PNG at launch (what LION's own upload does). Generate draws one for the identity name.">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => fileInput.current?.click()} className={btn}>
                          <UploadIcon className="h-3.5 w-3.5" />
                          Upload
                        </button>
                        <button type="button" onClick={() => void generateAvatar()} disabled={generating} title="Draw an avatar for this identity name" className={btn}>
                          <SparklesIcon className="h-3.5 w-3.5" />
                          {generating ? "Generating…" : "Generate"}
                        </button>
                        <span data-identity-file className="min-w-0 flex-1 basis-32 truncate font-mono text-[10.5px] text-faint" title={identityText}>
                          {generating ? "drawing the avatar…" : identityText || "no image yet"}
                        </span>
                      </div>
                    </Field>
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
                {identities.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-2.5">
                    <span className="text-[10.5px] text-faint">Recent:</span>
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
            </div>
            {note ? <p className="-mt-1 text-[11px] leading-snug text-warn">{note}</p> : null}
          </Section>

          {/* ================= AUDIENCE ================= */}
          <Section title="Audience" blurb="Where the ads run. LION's API fixes the rest." left={needAudience.length} locked={fieldsLocked}>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
              <Field label="Countries" need={has(needAudience, "Countries")} tip="The list is the picked advertiser's own — LION refuses a country it can't target there. Worldwide stands alone and needs a language.">
                <MultiSelect id={ids.geo} values={card.countries} onChange={(v) => patch({ countries: v })} options={countryOptions} placeholder="Select countries" chipMode="code" exclusiveValues={["WW"]} />
              </Field>
              <Field label="Language" need={has(needAudience, "Language")} note={has(needAudience, "Language") ? "Worldwide needs a language." : undefined}>
                <SearchSelect id={ids.language} value={card.language} onChange={(v) => patch({ language: v })} options={langOptions} placeholder="Select language" warn={worldwide && !card.language} emptyHint="No matches" ariaLabel="Language" />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-dashed border-line px-3 py-2">
              <LockIcon className="h-3 w-3 shrink-0 text-faint" />
              <span className="text-[11px] text-faint">Fixed by LION&apos;s API</span>
              <FixedChip label="Flag" value="none" />
              {card.smartPlus ? null : (
                <>
                  <FixedChip label="Gender" value={TIKTOK_FIXED_GENDER} />
                  <FixedChip label="Age" value={TIKTOK_FIXED_AGE} />
                </>
              )}
              <Hint tip={"LION's external API fixes the audience to all genders, 18+, and takes no special-industry flag (HOUSING / EMPLOYMENT / CREDIT) — sending targeting is refused. Launch flagged campaigns from LION's own launcher." + (card.smartPlus ? " Smart+ doesn't use gender or age at all." : "")} />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
