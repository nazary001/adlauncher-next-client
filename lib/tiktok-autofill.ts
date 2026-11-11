// "Change all campaigns" for the TikTok launcher (team ask 11.11: «такой же автофил как на ФБ … чтоб
// можно было менять гео, ссылку, тег, и остальное во всех компаниях — здесь автофил делает только
// полностью копию компании а не меняет переменные»): the ticked fields of ONE form land on every
// card of the board — the FB clone board's "Autofill all rows" (lib/hs-autofill) for cards. Pure —
// the board's cards stay the board's, this only says what each card becomes (and what Undo puts
// back), so `node --test tests/tiktok-autofill.test.ts` runs it straight off Node. The field
// semantics are the card's own: money in the field's cash-register spelling, a mode that takes no
// value carries no bid, a classic card holds ONE CTA, a new advertiser starts with a clean pixel,
// files keep their ids (the board hosts every file once, so one avatar on thirty cards is one upload).

import type { FileItem } from "./types.ts";
import {
  TIKTOK_BUDGET_MAX,
  TIKTOK_BUDGET_MIN,
  TIKTOK_CTAS_MAX,
  TIKTOK_TITLE_MAX,
  splitPipes,
  tiktokBidPlan,
  tiktokBudgetWire,
  tiktokLandingBase,
  tiktokModeKind,
} from "./tiktok-launch.ts";

/** The slice of a launcher card the autofill reads and writes (components/tiktok-launch-card
 *  TiktokCard is a superset — that file is a client component, this one stays import-pure). */
export type TiktokAutofillCard = {
  id: string;
  advertiser: string;
  pixel: string;
  budget: string;
  cbo: boolean;
  mode: string;
  bid: string;
  landingUrl: string;
  suffix: string;
  mosh: boolean;
  smartPlus: boolean;
  adText: string;
  ctas: string[];
  identityName: string;
  identityFiles: FileItem[];
  identityUrl: string;
  videoFiles: FileItem[];
  countries: string[];
  language: string;
  state: "idle" | "uploading" | "sending" | "ok" | "error" | "unsure";
  msg?: string;
  progress?: string;
};

/** What lands on every card. A field that is absent is not touched. */
export type TiktokAutofillPatch = {
  /** ISO-2 codes, or exactly ["WW"]. */
  countries?: string[];
  /** A language code; "" = no language segmentation. */
  language?: string;
  landingUrl?: string;
  /** The buyer's own tail of the campaign name — the team's "tag". "" clears it. */
  suffix?: string;
  /** Daily budget in the field's cash-register spelling ("20,00"). */
  budget?: string;
  /** The mode and the value it takes ("" under a mode that takes none). */
  bidding?: { mode: string; bid: string };
  /** `pixel` "" = each card resolves its own (a card already on this advertiser keeps its pick). */
  advertiser?: { advertiser: string; pixel: string };
  adText?: string;
  /** Picked CTAs, the first is the main one — a classic card takes only that one. */
  ctas?: string[];
  /** No `files` and no `url` = the name alone; every card keeps its own avatar. */
  identity?: { name: string; files: FileItem[]; url: string };
  videos?: FileItem[];
  smartPlus?: { on: boolean; cbo: boolean };
  mosh?: boolean;
};

/** The form's fields, in the order the form (and the banner note) shows them. */
export const TIKTOK_AUTOFILL_KEYS = ["countries", "language", "landing", "tag", "budget", "bidding", "advertiser", "adText", "cta", "identity", "videos", "smartPlus", "mosh"] as const;
export type TiktokAutofillKey = (typeof TIKTOK_AUTOFILL_KEYS)[number];

/** Every value of the form — seeded from one card ("Start from"), edited by the buyer. */
export type TiktokAutofillDraft = {
  advertiser: string;
  pixel: string;
  budget: string;
  mode: string;
  bid: string;
  landingUrl: string;
  suffix: string;
  mosh: boolean;
  smartPlus: boolean;
  cbo: boolean;
  adText: string;
  ctas: string[];
  identityName: string;
  identityFiles: FileItem[];
  identityUrl: string;
  videoFiles: FileItem[];
  countries: string[];
  language: string;
};

type CardField = Exclude<keyof TiktokAutofillCard, "id" | "state" | "msg" | "progress">;

/** Every card field an autofill can write. */
const CARD_FIELDS: readonly CardField[] = [
  "advertiser",
  "pixel",
  "budget",
  "cbo",
  "mode",
  "bid",
  "landingUrl",
  "suffix",
  "mosh",
  "smartPlus",
  "adText",
  "ctas",
  "identityName",
  "identityFiles",
  "identityUrl",
  "videoFiles",
  "countries",
  "language",
];

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameFiles = (a: readonly FileItem[], b: readonly FileItem[]): boolean => a.length === b.length && a.every((f, i) => f.id === b[i].id);
const copyFiles = (files: readonly FileItem[]): FileItem[] => files.map((f) => ({ ...f }));
const takesValue = (mode: string): boolean => tiktokModeKind(mode) !== "none";

export const tiktokAutofillEmpty = (p: TiktokAutofillPatch): boolean => Object.values(p).every((v) => v === undefined);

/** Cards the autofill reaches: every card that is not uploading or submitting right now. */
export function tiktokAutofillTakes(card: Pick<TiktokAutofillCard, "state">): boolean {
  return card.state !== "uploading" && card.state !== "sending";
}

/** The form's values when it starts from `card` — its own copies of the lists. */
export function tiktokAutofillDraft(card: TiktokAutofillCard | undefined): TiktokAutofillDraft {
  return {
    advertiser: card?.advertiser ?? "",
    pixel: card?.pixel ?? "",
    budget: card?.budget ?? "",
    mode: card?.mode ?? "NORMAL_WITH_BID",
    bid: card?.bid ?? "",
    landingUrl: card?.landingUrl ?? "",
    suffix: card?.suffix ?? "",
    mosh: card?.mosh ?? false,
    smartPlus: card?.smartPlus ?? false,
    cbo: card?.cbo ?? false,
    adText: card?.adText ?? "",
    ctas: [...(card?.ctas ?? [])],
    identityName: card?.identityName ?? "",
    identityFiles: copyFiles(card?.identityFiles ?? []),
    identityUrl: card?.identityUrl ?? "",
    videoFiles: copyFiles(card?.videoFiles ?? []),
    countries: [...(card?.countries ?? [])],
    language: card?.language ?? "",
  };
}

/** The patch of what was TICKED — never carrying what its own switches rule out (a bid under a mode
 *  that takes none, CBO without Smart+). */
export function tiktokAutofillPatch(d: TiktokAutofillDraft, ticked: ReadonlySet<TiktokAutofillKey>): TiktokAutofillPatch {
  const p: TiktokAutofillPatch = {};
  if (ticked.has("countries")) p.countries = [...d.countries];
  if (ticked.has("language")) p.language = d.language;
  if (ticked.has("landing")) p.landingUrl = d.landingUrl;
  if (ticked.has("tag")) p.suffix = d.suffix;
  if (ticked.has("budget")) p.budget = d.budget;
  if (ticked.has("bidding")) p.bidding = { mode: d.mode, bid: takesValue(d.mode) ? d.bid.trim() : "" };
  if (ticked.has("advertiser")) p.advertiser = { advertiser: d.advertiser, pixel: d.pixel };
  if (ticked.has("adText")) p.adText = d.adText;
  if (ticked.has("cta")) p.ctas = d.ctas.filter(Boolean);
  if (ticked.has("identity")) p.identity = { name: d.identityName, files: d.identityFiles, url: d.identityUrl };
  if (ticked.has("videos")) p.videos = d.videoFiles;
  if (ticked.has("smartPlus")) p.smartPlus = { on: d.smartPlus, cbo: d.smartPlus && d.cbo };
  if (ticked.has("mosh")) p.mosh = d.mosh;
  return p;
}

/**
 * One card after the patch — the SAME object when nothing changes (callers count changed cards by
 * identity). A changed queued / failed card becomes an idle draft again (the board's own edit rule:
 * a queued card is not launchable until it is edited); a held card keeps its hold.
 */
export function tiktokAutofillCard<T extends TiktokAutofillCard>(card: T, patch: TiktokAutofillPatch): T {
  if (!tiktokAutofillTakes(card)) return card;
  const next: T = { ...card };
  if (patch.countries && !sameList(card.countries, patch.countries)) next.countries = [...patch.countries];
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.landingUrl !== undefined) next.landingUrl = patch.landingUrl.trim();
  if (patch.suffix !== undefined) next.suffix = patch.suffix;
  if (patch.budget !== undefined) next.budget = patch.budget;
  if (patch.bidding) {
    next.mode = patch.bidding.mode;
    next.bid = takesValue(patch.bidding.mode) ? patch.bidding.bid : "";
  }
  if (patch.advertiser) {
    // Pixel, countries and languages are the advertiser's own — a new one starts with a clean pixel
    // (the card's own rule); a card that is already there keeps the pixel it picked.
    if (card.advertiser !== patch.advertiser.advertiser) {
      next.advertiser = patch.advertiser.advertiser;
      next.pixel = patch.advertiser.pixel;
    } else if (patch.advertiser.pixel) {
      next.pixel = patch.advertiser.pixel;
    }
  }
  if (patch.adText !== undefined) next.adText = patch.adText;
  if (patch.mosh !== undefined) next.mosh = patch.mosh;
  if (patch.smartPlus) {
    next.smartPlus = patch.smartPlus.on;
    next.cbo = patch.smartPlus.on && patch.smartPlus.cbo;
  }
  if (patch.ctas || patch.smartPlus) {
    // A classic card holds exactly ONE CTA (Smart+ off must not leave three behind), Smart+ up to three.
    const want = patch.ctas ? patch.ctas.filter(Boolean) : card.ctas;
    const ctas = want.slice(0, next.smartPlus ? TIKTOK_CTAS_MAX : 1);
    if (!sameList(card.ctas, ctas)) next.ctas = ctas;
  }
  if (patch.identity) {
    next.identityName = patch.identity.name;
    if (patch.identity.files.length > 0) {
      if (!sameFiles(card.identityFiles, patch.identity.files)) next.identityFiles = copyFiles(patch.identity.files);
      next.identityUrl = "";
    } else if (patch.identity.url) {
      if (card.identityFiles.length > 0) next.identityFiles = [];
      next.identityUrl = patch.identity.url;
    }
  }
  if (patch.videos && !sameFiles(card.videoFiles, patch.videos)) next.videoFiles = copyFiles(patch.videos);
  if (!CARD_FIELDS.some((k) => next[k] !== card[k])) return card;
  if (card.state !== "unsure") {
    next.state = "idle";
    next.msg = undefined;
    next.progress = undefined;
  }
  return next;
}

/**
 * Every card after the patch, with how many changed and how many the autofill could not reach.
 * `only` = the picked cards ("Apply to"); a card outside it is neither changed nor counted.
 */
export function tiktokAutofillCards<T extends TiktokAutofillCard>(
  cards: readonly T[],
  patch: TiktokAutofillPatch,
  only?: ReadonlySet<string>,
): { cards: T[]; changed: number; skipped: number } {
  let changed = 0;
  let skipped = 0;
  const out = cards.map((c) => {
    if (only && !only.has(c.id)) return c;
    if (!tiktokAutofillTakes(c)) {
      skipped++;
      return c;
    }
    const n = tiktokAutofillCard(c, patch);
    if (n !== c) changed++;
    return n;
  });
  return { cards: out, changed, skipped };
}

/** The card fields a patch writes (Smart+ also decides CBO and how many CTAs a card holds). */
function touchedFields(p: TiktokAutofillPatch): CardField[] {
  const f = new Set<CardField>();
  if (p.countries) f.add("countries");
  if (p.language !== undefined) f.add("language");
  if (p.landingUrl !== undefined) f.add("landingUrl");
  if (p.suffix !== undefined) f.add("suffix");
  if (p.budget !== undefined) f.add("budget");
  if (p.bidding) for (const k of ["mode", "bid"] as const) f.add(k);
  if (p.advertiser) for (const k of ["advertiser", "pixel"] as const) f.add(k);
  if (p.adText !== undefined) f.add("adText");
  if (p.ctas) f.add("ctas");
  if (p.identity) for (const k of ["identityName", "identityFiles", "identityUrl"] as const) f.add(k);
  if (p.videos) f.add("videoFiles");
  if (p.smartPlus) for (const k of ["smartPlus", "cbo", "ctas"] as const) f.add(k);
  if (p.mosh !== undefined) f.add("mosh");
  return [...f];
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => (typeof x === "object" && x && typeof b[i] === "object" && b[i] ? (x as FileItem).id === (b[i] as FileItem).id : x === b[i]));
};

/**
 * Undo: the fields THIS patch wrote go back to `before` on every card of `before` that still exists
 * and is not on its way out — what the buyer edited by hand since stays. A card whose content is
 * exactly the earlier content again gets its earlier state back (queued content is queued again);
 * otherwise it is a draft. A hold is neither lifted nor re-imposed by an undo. Cards added since
 * keep theirs.
 */
export function undoTiktokAutofill<T extends TiktokAutofillCard>(cards: readonly T[], before: readonly T[], patch: TiktokAutofillPatch): T[] {
  const byId = new Map(before.map((c) => [c.id, c]));
  const fields = touchedFields(patch);
  return cards.map((c) => {
    const b = byId.get(c.id);
    if (!b || !tiktokAutofillTakes(c)) return c;
    const next: T = { ...c };
    for (const k of fields) (next as TiktokAutofillCard)[k] = b[k] as never;
    if (c.state === "unsure" || b.state === "unsure") return next;
    if (CARD_FIELDS.every((k) => sameValue(next[k], b[k]))) {
      next.state = b.state;
      next.msg = b.msg;
      next.progress = b.progress;
    } else {
      next.state = "idle";
      next.msg = undefined;
      next.progress = undefined;
    }
    return next;
  });
}

/** "countries · landing · name tag" — what the banner says landed. */
export function tiktokAutofillNote(p: TiktokAutofillPatch): string {
  const parts: string[] = [];
  if (p.countries) parts.push("countries");
  if (p.language !== undefined) parts.push("language");
  if (p.landingUrl !== undefined) parts.push("landing");
  if (p.suffix !== undefined) parts.push("name tag");
  if (p.budget !== undefined) parts.push("budget");
  if (p.bidding) parts.push(takesValue(p.bidding.mode) ? "mode + bid" : "mode");
  if (p.advertiser) parts.push("advertiser");
  if (p.adText !== undefined) parts.push("ad text");
  if (p.ctas) parts.push("CTA");
  if (p.identity) parts.push("identity");
  if (p.videos) parts.push("creatives");
  if (p.smartPlus) parts.push("Smart+");
  if (p.mosh !== undefined) parts.push("MOSH");
  return parts.join(" · ");
}

/**
 * Why the form cannot be applied yet — null when it can. It refuses only what EVERY card would
 * refuse (the launcher's own validator rules, with the fix); what depends on a card — a country its
 * advertiser can't target, a bid above that card's budget — is said on the card, as after any edit.
 */
export function tiktokAutofillProblem(p: TiktokAutofillPatch): string | null {
  if (tiktokAutofillEmpty(p)) return "Tick at least one field";
  if (p.countries) {
    const codes = p.countries.map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean);
    if (codes.length === 0) return "Pick at least one country (or Worldwide)";
    if (codes.includes("WW")) {
      if (codes.length > 1) return "Worldwide (WW) cannot be mixed with countries — pick one or the other";
      if (p.language === "") return "Worldwide needs a language — pick one";
    } else {
      const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
      if (bad.length) return `Unknown country code${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}`;
    }
  }
  if (p.landingUrl !== undefined && !tiktokLandingBase(p.landingUrl)) return "Landing must be an https:// address on one of LION's allowed domains";
  if (p.budget !== undefined && !tiktokBudgetWire(p.budget)) return `Budget must be between ${TIKTOK_BUDGET_MIN} and ${TIKTOK_BUDGET_MAX} USD a day (TikTok refuses less than $${TIKTOK_BUDGET_MIN})`;
  if (p.bidding) {
    const plan = tiktokBidPlan({ kind: "launch", mode: p.bidding.mode, typedBid: p.bidding.bid, budget: p.budget });
    if ("refusal" in plan) return plan.refusal;
  }
  if (p.advertiser && !p.advertiser.advertiser) return "Pick an advertiser";
  if (p.adText !== undefined) {
    const texts = p.adText.includes("|") ? splitPipes(p.adText) : [squash(p.adText)].filter(Boolean);
    if (texts.length === 0) return "Type the ad text";
    const over = texts.find((t) => t.length > TIKTOK_TITLE_MAX);
    if (over) return `Ad text is ${over.length} characters — at most ${TIKTOK_TITLE_MAX}`;
  }
  if (p.ctas && p.ctas.filter(Boolean).length === 0) return "Pick a call to action";
  if (p.identity && !squash(p.identity.name)) return "Type the identity name";
  if (p.videos && p.videos.length === 0) return "The start campaign has no videos to copy — start from one that has";
  return null;
}
