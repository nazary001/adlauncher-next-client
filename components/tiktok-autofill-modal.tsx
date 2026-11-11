"use client";

// Autofill for the TikTok launcher — two jobs behind the one header button:
//   Change all   the FB clone board's "Autofill all rows" for cards (team ask 11.11: «такой же автофил
//                как на ФБ … менять гео, ссылку, тег, и остальное во всех компаниях — здесь автофил
//                делает только полностью копию компании а не меняет переменные»): ONE form whose
//                TICKED fields land on every picked campaign of the board. The form starts from a
//                card's current values ("Start from", campaign 01 by default); ticking a field opens
//                its editor; everything that is not ticked stays as each card has it. lib/tiktok-
//                autofill says what each card becomes — this file is only the form.
//   Make copies  LION's "make N copies of card 1" (one shot = one card, so copies are whole cards,
//                not a per-card multiplier): how many, and which fields carry over from the FIRST
//                card; each new card starts from the launcher defaults and takes only the ticked
//                fields. Files copy with their ids (cloneTiktokCard), so twenty copies of one card
//                upload their avatar and videos a single time.
// The dialog is mounted per open, so every open starts from the board as it is now; both panels stay
// mounted while it is open, so switching the tab loses nothing typed.

import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, FilmIcon, MinusIcon, PlusIcon, SparklesIcon, XIcon } from "./icons";
import { MultiSelect } from "./multi-select";
import { SearchSelect } from "./search-select";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoney, limitMoneyCents } from "@/lib/types";
import {
  TIKTOK_AD_TEXTS_MAX,
  TIKTOK_BID_MAX,
  TIKTOK_BUDGET_MAX,
  TIKTOK_CTAS,
  TIKTOK_CTAS_MAX,
  TIKTOK_IDENTITY_NAME_MAX,
  TIKTOK_LAUNCH_MODES,
  TIKTOK_MAX_COPIES,
  TIKTOK_ROAS_MAX,
  TIKTOK_TITLE_MAX,
  tiktokCopies,
  tiktokLandingBase,
  tiktokModeKind,
  tiktokModeLabel,
} from "@/lib/tiktok-launch";
import {
  type TiktokAutofillDraft,
  type TiktokAutofillKey,
  type TiktokAutofillPatch,
  tiktokAutofillDraft,
  tiktokAutofillNote,
  tiktokAutofillPatch,
  tiktokAutofillProblem,
  tiktokAutofillTakes,
} from "@/lib/tiktok-autofill";
import { SwitchTile, cloneTiktokCard, freshTiktokCard, type TiktokCard } from "./tiktok-launch-card";
import type { TiktokConfigEntry } from "./use-tiktok";
import type { RememberedIdentity } from "./tiktok-identity";

type Props = {
  open: boolean;
  /** The board's cards, in board order. */
  cards: TiktokCard[];
  /** Card id → its advertiser's name ("" = none picked). */
  names: Record<string, string>;
  /** How many more cards the board can take (its card cap minus what is on it). */
  room: number;
  advertiserOptions: RichOption[];
  /** Configs of the advertisers picked on the board — the country / language / pixel lists. */
  configs: Record<string, TiktokConfigEntry>;
  /** The team's live landings — suggestions for the landing field. */
  landings: string[];
  identities: RememberedIdentity[];
  onClose: () => void;
  /** Make copies: the new cards to append. */
  onCreate: (cards: TiktokCard[]) => void;
  /** Change all: the patch and the ids of the cards it lands on. */
  onApply: (patch: TiktokAutofillPatch, ids: string[]) => void;
};

type Tab = "all" | "copies";

const no = (i: number): string => String(i + 1).padStart(2, "0");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint select-none";
const hint = "text-[11px] leading-snug text-faint";
const ghostBtn =
  "rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const goBtn =
  "flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
  "hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const tickBox = (on: boolean): string =>
  "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors " + (on ? "border-accent bg-accent text-white" : "border-line2 bg-surface");

const CTA_OPTIONS = TIKTOK_CTAS.map((c) => ({ value: c.value, label: c.value }));
const FALLBACK_COUNTRIES = COUNTRIES.filter((c) => c.code !== "WW").map((c) => ({ value: c.code, label: c.name }));

export function TiktokAutofillModal(props: Props) {
  if (!props.open || props.cards.length === 0) return null;
  return <AutofillDialog {...props} />;
}

function AutofillDialog(props: Props) {
  const { cards, onClose } = props;
  // One card: there is nothing to change "everywhere" yet — the first job is to make copies of it.
  const [tab, setTab] = useState<Tab>(cards.length > 1 ? "all" : "copies");

  useEffect(() => {
    // Capture phase: an open picker inside the form takes the first Escape (it closes its list), the
    // dialog the next one — read before the picker's own handler has flipped aria-expanded.
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.getAttribute?.("aria-expanded") === "true") return;
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const tabBtn = (t: Tab, label: string, sub: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={
        "flex min-w-0 flex-1 flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
        (tab === t ? "border-accent/50 bg-accent/[0.12]" : "border-line bg-surface2/50 hover:border-line2")
      }
    >
      <span className={"text-[13px] font-semibold " + (tab === t ? "text-ink" : "text-dim")}>{label}</span>
      <span className="w-full truncate text-[11px] text-faint">{sub}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tab === "all" ? "Autofill all campaigns" : "Autofill copies"}
        className="animate-pop-in relative flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <SparklesIcon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">Autofill</h2>
              <p className="mt-1 text-[12px] leading-snug text-dim">
                {tab === "all" ? (
                  <>
                    The ticked fields land on <span className="font-medium text-ink">every picked campaign</span>. Everything else stays as each card has it.
                  </>
                ) : (
                  <>
                    New cards copying the ticked fields from <span className="font-medium text-ink">campaign 01</span>.
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* what the autofill does */}
        <div role="tablist" aria-label="What Autofill does" className="flex gap-2 border-b border-line px-5 py-2.5">
          {tabBtn("all", "Change all campaigns", "geo · landing · tag · budget · bid …")}
          {tabBtn("copies", "Make copies", "new cards from campaign 01")}
        </div>

        <div className={tab === "all" ? "contents" : "hidden"}>
          <ChangeAllPanel {...props} />
        </div>
        <div className={tab === "copies" ? "contents" : "hidden"}>
          <CopiesPanel source={cards[0]} room={props.room} onClose={onClose} onCreate={props.onCreate} />
        </div>
      </div>
    </div>
  );
}

// ---------- Change all campaigns ----------

function ChangeAllPanel({ cards, names, advertiserOptions, configs, landings, identities, onClose, onApply }: Props) {
  const [seedId, setSeedId] = useState(() => cards[0].id);
  const [draft, setDraft] = useState<TiktokAutofillDraft>(() => tiktokAutofillDraft(cards[0]));
  const [ticked, setTicked] = useState<Set<TiktokAutofillKey>>(() => new Set());
  const [picked, setPicked] = useState<Set<string>>(() => new Set(cards.filter(tiktokAutofillTakes).map((c) => c.id)));
  /** Identity: send the avatar along with the name (off = the name alone, every card keeps its image). */
  const [withAvatar, setWithAvatar] = useState(true);

  const set = (p: Partial<TiktokAutofillDraft>) => setDraft((d) => ({ ...d, ...p }));
  const toggle = (k: TiktokAutofillKey) =>
    setTicked((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  /** Start over from another card's current values. */
  const reseed = (id: string) => {
    setSeedId(id);
    setDraft(tiktokAutofillDraft(cards.find((c) => c.id === id)));
    setTicked(new Set());
    setWithAvatar(true);
  };
  const togglePick = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const seedNo = no(Math.max(0, cards.findIndex((c) => c.id === seedId)));
  const cardLabel = (c: TiktokCard): string => `${names[c.id] || "No advertiser"}${c.countries.length ? ` · ${c.countries.join("+")}` : ""}`;
  const targets = cards.filter((c) => picked.has(c.id) && tiktokAutofillTakes(c));
  const queued = targets.filter((c) => c.state === "ok").length;

  // ---- catalogs: what the advertisers picked on the board offer (each card still checks its own) ----
  const loaded = [...new Set(cards.map((c) => c.advertiser).filter(Boolean))].flatMap((id) => {
    const e = configs[id];
    return e && !("error" in e) ? [e] : [];
  });
  const countryNames = new Map<string, string>();
  const langNames = new Map<string, string>();
  for (const cfg of loaded) {
    for (const c of cfg.countries) if (!countryNames.has(c.code)) countryNames.set(c.code, c.name || c.code);
    for (const l of cfg.languages) if (!langNames.has(l.code)) langNames.set(l.code, l.name || l.code);
  }
  const countryOptions = [{ value: "WW", label: "Worldwide" }, ...(countryNames.size ? [...countryNames].map(([value, label]) => ({ value, label })) : FALLBACK_COUNTRIES)];
  const langOptions: RichOption[] = [
    { value: "", label: "without language segmentation" },
    ...[...langNames].map(([value, label]) => ({ value, label, meta: value })),
    ...(draft.language && !langNames.has(draft.language) ? [{ value: draft.language, label: draft.language }] : []),
  ];
  const advEntry = draft.advertiser ? configs[draft.advertiser] : undefined;
  const advCfg = advEntry && !("error" in advEntry) ? advEntry : null;
  const pixelOptions: RichOption[] = (advCfg?.pixels ?? []).map((p) => ({ value: p.pixelCode, label: p.pixelCode }));

  const kind = tiktokModeKind(draft.mode);
  const avatar = draft.identityFiles[0]?.url || (/^https:\/\//i.test(draft.identityUrl) ? draft.identityUrl : "");
  const texts = draft.adText.split("|").map((t) => t.trim()).filter(Boolean);

  const patch = tiktokAutofillPatch(withAvatar ? draft : { ...draft, identityFiles: [], identityUrl: "" }, ticked);
  const problem = targets.length === 0 ? "Pick at least one campaign to apply to" : tiktokAutofillProblem(patch);

  const heading = (t: string) => <p className={micro + " px-1 pt-1.5"}>{t}</p>;
  /** One field: a checkbox row with the value it holds now; ticking it opens its editor. */
  const group = (k: TiktokAutofillKey, title: string, preview: string, body: React.ReactNode, off: string | null = null) => {
    const on = ticked.has(k) && !off;
    return (
      <section data-autofill={k} title={off ?? undefined} className={"rounded-xl border transition-colors " + (on ? "border-accent/40 bg-accent/[0.06]" : "border-line bg-surface2/40") + (off ? " opacity-60" : "")}>
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-label={`Set ${title} on every campaign`}
          disabled={Boolean(off)}
          onClick={() => toggle(k)}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className={tickBox(on)}>{on ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
          <span className={"shrink-0 text-[13px] font-semibold " + (on ? "text-ink" : "text-dim")}>{title}</span>
          <span className={"ml-auto min-w-0 max-w-[60%] truncate text-right font-mono text-[11px] " + (off ? "text-warn" : "text-faint")}>{off ?? preview}</span>
        </button>
        {on ? <div className="flex flex-col gap-2 px-3 pb-3 sm:pl-[40px]">{body}</div> : null}
      </section>
    );
  };

  const geoPreview = draft.countries.length === 0 ? "—" : draft.countries[0] === "WW" ? "Worldwide" : draft.countries.length <= 5 ? draft.countries.join("+") : plural(draft.countries.length, "country", "countries");
  const landingBase = tiktokLandingBase(draft.landingUrl);
  const advLabel = advertiserOptions.find((o) => o.value === draft.advertiser)?.label ?? (draft.advertiser || "—");

  return (
    <>
      {/* whose values the form starts from, and which cards it lands on */}
      <div className="flex flex-col gap-2.5 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={micro + " w-[76px] shrink-0 whitespace-nowrap"}>Start from</span>
          <div className="relative min-w-0 flex-1">
            <select
              value={seedId}
              onChange={(e) => reseed(e.target.value)}
              aria-label="Start from campaign"
              title="The form shows this campaign's values — picking another one starts the form over"
              className="h-8 w-full cursor-pointer appearance-none truncate rounded-md border border-line bg-surface2 px-2 pr-7 text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            >
              {cards.map((c, i) => (
                <option key={c.id} value={c.id} className="bg-surface text-ink">
                  {no(i)} · {cardLabel(c)}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
          </div>
        </div>
        {cards.length > 1 ? (
          <div className="flex items-start gap-3">
            <span className={micro + " w-[76px] shrink-0 whitespace-nowrap pt-1.5"}>Apply to</span>
            <div role="group" aria-label="Campaigns the autofill lands on" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {cards.map((c, i) => {
                const takes = tiktokAutofillTakes(c);
                const on = takes && picked.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Campaign ${no(i)}`}
                    disabled={!takes}
                    onClick={() => togglePick(c.id)}
                    title={takes ? `${no(i)} · ${cardLabel(c)}` : `${no(i)} is on its way out — not changed`}
                    className={
                      "h-6 min-w-7 rounded-md border px-1.5 font-mono text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-faint hover:border-line2 hover:text-dim")
                    }
                  >
                    {no(i)}
                  </button>
                );
              })}
              <span className="ml-1.5 flex items-center gap-1 text-[11.5px] text-faint">
                <button type="button" onClick={() => setPicked(new Set(cards.filter(tiktokAutofillTakes).map((c) => c.id)))} className="rounded px-1 py-0.5 font-medium text-dim transition-colors hover:text-ink">
                  All
                </button>
                ·
                <button type="button" onClick={() => setPicked(new Set())} className="rounded px-1 py-0.5 font-medium text-dim transition-colors hover:text-ink">
                  None
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* fields */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-5 py-3.5">
        {heading("Audience")}
        {group(
          "countries",
          "Countries",
          geoPreview,
          <>
            <MultiSelect id="ttaf-geo" values={draft.countries} onChange={(v) => set({ countries: v })} options={countryOptions} placeholder="Select countries" chipMode="code" exclusiveValues={["WW"]} />
            <p className={hint}>The [geo] in every campaign name follows. Each card checks the list against its own advertiser — a country it can&apos;t target there is flagged on that card. Worldwide stands alone and needs a language.</p>
          </>,
        )}
        {group(
          "language",
          "Language",
          draft.language || "no language",
          <>
            <SearchSelect id="ttaf-lang" value={draft.language} onChange={(v) => set({ language: v })} options={langOptions} placeholder="Select language" emptyHint="No matches" ariaLabel="Language for every campaign" />
            {langNames.size === 0 ? <p className={hint}>Languages come from an advertiser&apos;s own list — pick an advertiser on a campaign first to choose one here.</p> : null}
          </>,
        )}

        {heading("Landing & name")}
        {group(
          "landing",
          "Landing URL",
          landingBase ? `${landingBase.host}/${landingBase.path}` : draft.landingUrl || "—",
          <>
            <input
              id="ttaf-landing"
              value={draft.landingUrl}
              onChange={(e) => set({ landingUrl: e.target.value.trim() })}
              list="ttaf-landings"
              placeholder="https://choice-flow.org/ht..."
              aria-label="Landing URL for every campaign"
              className={inp}
            />
            <datalist id="ttaf-landings">
              {[...new Set(landings)].map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            <p className={hint}>Paste only the base URL — LION drops the query string and appends its own tracking. The (landing) in every campaign name follows.</p>
          </>,
        )}
        {group(
          "tag",
          "Name tag",
          draft.suffix || "(no tag)",
          <>
            <input
              id="ttaf-tag"
              value={draft.suffix}
              onChange={(e) => set({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })}
              maxLength={80}
              placeholder="Your own note — a creo, a test, anything"
              aria-label="Name tag for every campaign"
              className={inp}
            />
            <p className={hint}>The part of the campaign name that is yours — it goes after the date, your name and GC-Launcher. Empty clears the tag on every picked campaign.</p>
          </>,
        )}

        {heading("Account & bidding")}
        {group(
          "budget",
          "Budget",
          draft.budget ? `${draft.budget} USD/day` : "—",
          <div className="relative">
            <input
              id="ttaf-budget"
              value={draft.budget}
              onChange={(e) => set({ budget: limitMoneyCents(e.target.value, TIKTOK_BUDGET_MAX) })}
              inputMode="decimal"
              placeholder="20,00"
              aria-label="Daily budget for every campaign"
              title="Daily budget — digits fill cents (2000 → 20,00) · TikTok refuses less than 20"
              className={inp + " pr-16 font-mono tabular-nums"}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">USD/day</span>
          </div>,
        )}
        {group(
          "bidding",
          "Mode · Bid",
          `${tiktokModeLabel(draft.mode)}${kind === "bid" || kind === "roas" ? (draft.bid ? ` · ${kind === "roas" ? "ROAS " : ""}${draft.bid}` : " · bid ?") : ""}`,
          <>
            <div role="radiogroup" aria-label="Mode for every campaign" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {TIKTOK_LAUNCH_MODES.map((m) => {
                const on = draft.mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={m.value}
                    // Same rule as the card's own mode buttons: a change of kind clears the typed value.
                    onClick={() => set({ mode: m.value, bid: tiktokModeKind(m.value) === kind ? draft.bid : "" })}
                    className={
                      "flex min-w-0 flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (on ? "border-accent/55 bg-accent/[0.12]" : "border-line bg-surface2/60 hover:border-line2")
                    }
                  >
                    <span className={"text-[12.5px] font-semibold " + (on ? "text-ink" : "text-dim")}>{m.label}</span>
                    <span className="w-full truncate font-mono text-[9.5px] text-faint">{m.value}</span>
                  </button>
                );
              })}
            </div>
            {kind === "bid" || kind === "roas" ? (
              <div className="relative sm:max-w-[220px]">
                <input
                  id="ttaf-bid"
                  value={draft.bid}
                  onChange={(e) => set({ bid: kind === "bid" ? limitMoneyCents(e.target.value, TIKTOK_BID_MAX) : limitMoney(e.target.value, TIKTOK_ROAS_MAX) })}
                  inputMode="decimal"
                  placeholder={kind === "roas" ? "1,2" : "0,00"}
                  aria-label={kind === "roas" ? "ROAS goal for every campaign" : "Bid per conversion for every campaign"}
                  title={kind === "roas" ? "Minimum ROAS as a multiplier — 1,2 = 120%" : "Bid per conversion — digits fill cents (46 → 0,46). Must stay below the daily budget."}
                  className={inp + " pr-14 font-mono tabular-nums"}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] uppercase text-faint">{kind === "roas" ? "ROAS" : "USD"}</span>
              </div>
            ) : (
              <p className={hint}>TikTok sets the bid itself — a bid typed on a card is cleared.</p>
            )}
            <p className={hint}>The value modes (VO_…) need a pixel with value optimisation — a card whose pixel has none says so.</p>
          </>,
        )}
        {group(
          "advertiser",
          "Advertiser · Pixel",
          advLabel,
          <>
            <SearchSelect
              id="ttaf-adv"
              value={draft.advertiser}
              onChange={(v) => set({ advertiser: v, pixel: "" })}
              options={advertiserOptions}
              placeholder="Select advertiser"
              emptyHint="No launch-eligible advertisers"
              ariaLabel="Advertiser for every campaign"
            />
            {pixelOptions.length > 1 ? (
              <SearchSelect id="ttaf-pixel" value={draft.pixel} onChange={(v) => set({ pixel: v })} options={pixelOptions} placeholder="Pixel — or leave it to each card" emptyHint="No pixels on this advertiser" ariaLabel="Pixel for every campaign" />
            ) : null}
            <p className={hint}>
              {pixelOptions.length > 1
                ? "This advertiser has several pixels — pick one for every campaign, or leave it empty and pick on the cards."
                : pixelOptions.length === 1
                  ? `Its only pixel (${pixelOptions[0].value}) is used.`
                  : "The pixel is that advertiser's own: one pixel is used by itself, several are picked on the card."}{" "}
              Countries and languages are checked against the new advertiser on each card.
            </p>
          </>,
        )}

        {heading("Creative")}
        {group(
          "adText",
          "Ad text",
          draft.adText || "—",
          <>
            <input
              id="ttaf-adtext"
              value={draft.adText}
              onChange={(e) => set({ adText: e.target.value.replace(/[\r\n]+/g, " ") })}
              placeholder="The caption under the video"
              aria-label="Ad text for every campaign"
              className={inp}
            />
            <p className={hint}>
              Up to {TIKTOK_TITLE_MAX} characters{texts.length > 1 ? ` · ${texts.length} texts` : ` · ${draft.adText.trim().length}/${TIKTOK_TITLE_MAX}`}. A Smart+ campaign splits it on | (up to {TIKTOK_AD_TEXTS_MAX}, the first is the main one); a classic campaign sends it whole.
            </p>
          </>,
        )}
        {group(
          "cta",
          "CTA",
          draft.ctas.join(", ") || "—",
          <>
            <MultiSelect id="ttaf-ctas" values={draft.ctas} onChange={(v) => set({ ctas: v.slice(0, TIKTOK_CTAS_MAX) })} options={CTA_OPTIONS} placeholder="Pick CTAs — the first is the main one" />
            <p className={hint}>The first is the main one. A classic campaign takes only that one; a Smart+ campaign takes up to {TIKTOK_CTAS_MAX}.</p>
          </>,
        )}
        {group(
          "identity",
          "Identity",
          draft.identityName || "—",
          <>
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line2 bg-surface2 text-center text-[9px] leading-tight text-faint">
                {avatar && withAvatar ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local blob / hosted avatar preview
                  <img src={avatar} alt="Identity avatar preview" className="h-full w-full object-cover" />
                ) : (
                  "own avatars"
                )}
              </span>
              <input
                id="ttaf-idname"
                value={draft.identityName}
                onChange={(e) => set({ identityName: e.target.value.replace(/[\r\n]+/g, " ").slice(0, TIKTOK_IDENTITY_NAME_MAX) })}
                placeholder="The account name viewers see"
                aria-label="Identity name for every campaign"
                className={inp}
              />
            </div>
            {avatar ? (
              <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-dim">
                <input type="checkbox" checked={withAvatar} onChange={(e) => setWithAvatar(e.target.checked)} className="h-3.5 w-3.5 accent-[#7a96ff]" />
                Set this avatar too — off changes the name alone and every campaign keeps its own image
              </label>
            ) : (
              <p className={hint}>No avatar here — the name alone is set and every campaign keeps its own image. Start from a campaign that has one, or pick a recent identity, to set the avatar too.</p>
            )}
            {identities.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10.5px] text-faint">Recent:</span>
                {identities.map((id) => {
                  const on = withAvatar && draft.identityUrl === id.imageUrl && draft.identityName === id.name && draft.identityFiles.length === 0;
                  return (
                    <button
                      key={`${id.name}|${id.imageUrl}`}
                      type="button"
                      aria-pressed={on}
                      title={`Use “${id.name}”`}
                      onClick={() => {
                        set({ identityName: id.name, identityUrl: id.imageUrl, identityFiles: [] });
                        setWithAvatar(true);
                      }}
                      className={
                        "flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                        (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim hover:text-ink")
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- hosted avatar thumb */}
                      <img src={id.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                      <span className="max-w-[140px] truncate">{id.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>,
        )}
        {group(
          "videos",
          "Creatives",
          plural(draft.videoFiles.length, "video"),
          <>
            <div className="flex flex-wrap gap-1.5">
              {draft.videoFiles.map((f) => (
                <span key={f.id} title={f.name} className="inline-flex max-w-[190px] items-center gap-1 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10.5px] text-dim">
                  <FilmIcon className="h-3 w-3 shrink-0 text-faint" />
                  <span className="truncate">{f.name}</span>
                </span>
              ))}
            </div>
            <p className={hint}>
              Every picked campaign gets these {plural(draft.videoFiles.length, "video")} in place of its own. They are campaign {seedNo}&apos;s — pick another one in “Start from” to copy its videos instead. Nothing is uploaded twice.
            </p>
          </>,
          draft.videoFiles.length === 0 ? `campaign ${seedNo} has no videos` : null,
        )}

        {heading("Options")}
        {group(
          "smartPlus",
          "Smart+",
          draft.smartPlus ? (draft.cbo ? "on · CBO" : "on") : "off",
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <SwitchTile label="Smart+" desc={`On: up to ${TIKTOK_AD_TEXTS_MAX} ad texts and ${TIKTOK_CTAS_MAX} CTAs. Off: classic campaigns.`} checked={draft.smartPlus} onChange={(on) => set(on ? { smartPlus: true } : { smartPlus: false, cbo: false })} />
              {draft.smartPlus ? <SwitchTile label="CBO" desc="The daily budget sits on the campaign; off — on the ad group." checked={draft.cbo} onChange={(on) => set({ cbo: on })} /> : null}
            </div>
            {draft.smartPlus ? null : <p className={hint}>Off makes every picked campaign classic: it keeps its first CTA only and CBO is dropped.</p>}
          </>,
        )}
        {group(
          "mosh",
          "MOSH",
          draft.mosh ? "on" : "off",
          <SwitchTile label="MOSH" desc="LION slightly alters each video (borders, audio) so TikTok reads it as new." checked={draft.mosh} onChange={(on) => set({ mosh: on })} />,
        )}
      </div>

      {/* footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <p role="status" className={"min-w-0 flex-1 basis-56 text-[11px] leading-snug " + (problem && ticked.size > 0 ? "text-warn" : "text-faint")}>
          {ticked.size === 0
            ? "Tick a field and set its value — it lands on every picked campaign."
            : (problem ?? `Will set ${tiktokAutofillNote(patch)} on ${plural(targets.length, "campaign")}.${queued > 0 ? ` ${queued} already queued — a changed one becomes a draft again and can be launched as a new campaign.` : ""}`)}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button type="button" disabled={problem !== null} onClick={() => onApply(patch, targets.map((c) => c.id))} className={goBtn}>
            <SparklesIcon className="h-4 w-4" />
            Apply to {plural(targets.length, "campaign")}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- Make copies ----------

/** The fields the first card can push onto its copies — LION's Autofill list, in the card's order. */
type FieldKey = "advertiser" | "budget" | "mode" | "landing" | "name" | "mosh" | "smartPlus" | "adText" | "cta" | "identity" | "videos" | "countries" | "language";
const FIELDS: { key: FieldKey; label: string; preview: (c: TiktokCard) => string }[] = [
  { key: "advertiser", label: "Advertiser + Pixel", preview: (c) => (c.advertiser ? `${c.advertiser}${c.pixel ? ` · ${c.pixel}` : ""}` : "—") },
  { key: "budget", label: "Budget", preview: (c) => c.budget || "—" },
  { key: "mode", label: "Mode", preview: (c) => (c.bid ? `${c.mode} · ${c.bid}` : c.mode) },
  { key: "landing", label: "Landing URL", preview: (c) => c.landingUrl || "—" },
  { key: "name", label: "Campaign Name", preview: (c) => c.suffix || "(no custom tail)" },
  { key: "mosh", label: "MOSH", preview: (c) => String(c.mosh) },
  { key: "smartPlus", label: "Smart+", preview: (c) => (c.smartPlus ? (c.cbo ? "on · CBO" : "on") : "off") },
  { key: "adText", label: "Ad Text", preview: (c) => c.adText || "—" },
  { key: "cta", label: "CTA", preview: (c) => c.ctas.join(", ") || "—" },
  { key: "identity", label: "Identity", preview: (c) => c.identityName || "—" },
  { key: "videos", label: "Creatives", preview: (c) => `${c.videoFiles.length} video${c.videoFiles.length === 1 ? "" : "s"}` },
  { key: "countries", label: "Countries", preview: (c) => (c.countries[0] === "WW" ? "Worldwide" : c.countries.join("+") || "—") },
  { key: "language", label: "Language", preview: (c) => c.language || "none" },
];

/** Apply the ticked fields of `source` onto a fresh card. */
function copyFields(source: TiktokCard, selected: Set<FieldKey>): TiktokCard {
  const src = cloneTiktokCard(source); // fresh arrays + file objects, files keep their ids
  const card = freshTiktokCard();
  if (selected.has("advertiser")) {
    card.advertiser = src.advertiser;
    card.pixel = src.pixel;
  }
  if (selected.has("budget")) card.budget = src.budget;
  if (selected.has("mode")) {
    card.mode = src.mode;
    card.bid = src.bid;
  }
  if (selected.has("landing")) card.landingUrl = src.landingUrl;
  if (selected.has("name")) card.suffix = src.suffix;
  if (selected.has("mosh")) card.mosh = src.mosh;
  if (selected.has("smartPlus")) {
    card.smartPlus = src.smartPlus;
    card.cbo = src.cbo;
  }
  if (selected.has("adText")) card.adText = src.adText;
  // A classic card holds exactly ONE CTA — Smart+ left unticked must not smuggle three in.
  if (selected.has("cta")) card.ctas = card.smartPlus ? src.ctas : src.ctas.slice(0, 1);
  if (selected.has("identity")) {
    card.identityName = src.identityName;
    card.identityFiles = src.identityFiles;
    card.identityUrl = src.identityUrl;
  }
  if (selected.has("videos")) card.videoFiles = src.videoFiles;
  // Countries and languages are the ADVERTISER's own lists — without it they would point nowhere.
  if (selected.has("countries") && selected.has("advertiser")) card.countries = src.countries;
  if (selected.has("language") && selected.has("advertiser")) card.language = src.language;
  if (card.ctas.length === 0) card.ctas = ["LEARN_MORE"];
  return card;
}

function CopiesPanel({ source, room, onClose, onCreate }: { source: TiktokCard; room: number; onClose: () => void; onCreate: (cards: TiktokCard[]) => void }) {
  const [copies, setCopies] = useState("3");
  const [selected, setSelected] = useState<Set<FieldKey>>(() => new Set(FIELDS.map((f) => f.key)));

  const full = room <= 0;
  const cap = Math.max(1, Math.min(TIKTOK_MAX_COPIES, room));
  const n = Math.min(cap, tiktokCopies(copies));
  const advertiserOff = !selected.has("advertiser");
  const toggle = (k: FieldKey) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const create = () => onCreate(Array.from({ length: n }, () => copyFields(source, selected)));

  return (
    <>
      {/* number of copies */}
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className={micro}>Number of copies</span>
        <div className="flex items-center overflow-hidden rounded-lg border border-line bg-surface2">
          <button
            type="button"
            onClick={() => setCopies(String(Math.max(1, n - 1)))}
            disabled={n <= 1 || full}
            aria-label="Fewer copies"
            className="flex h-8 w-8 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:opacity-30"
          >
            <MinusIcon className="h-3.5 w-3.5" />
          </button>
          <input
            value={copies}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
              setCopies(raw !== "" && Number(raw) > cap ? String(cap) : raw);
            }}
            onBlur={() => {
              if (copies === "" || Number(copies) < 1) setCopies("1");
            }}
            disabled={full}
            inputMode="numeric"
            aria-label="Number of copies"
            className="w-10 bg-transparent px-1 text-center font-mono text-[13px] tabular-nums text-[#9db8ff] outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => setCopies(String(Math.min(cap, n + 1)))}
            disabled={n >= cap || full}
            aria-label="More copies"
            className="flex h-8 w-8 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:opacity-30"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* fields */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {FIELDS.map((f) => {
          const checked = selected.has(f.key);
          // Countries / Language are the advertiser's own lists — they can't travel without it.
          const orphan = advertiserOff && (f.key === "countries" || f.key === "language");
          return (
            <button
              key={f.key}
              type="button"
              role="checkbox"
              aria-checked={checked && !orphan}
              onClick={() => toggle(f.key)}
              disabled={orphan}
              title={orphan ? "Needs the advertiser — the list is that advertiser's own" : undefined}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-raise/60 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className={tickBox(checked && !orphan)}>{checked && !orphan ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
              <span className="flex-1 truncate text-[14px] text-ink">{f.label}</span>
              <span className="max-w-[50%] shrink-0 truncate text-right font-mono text-[12px] text-faint">{f.preview(source)}</span>
            </button>
          );
        })}
      </div>

      {/* footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <p className={"min-w-0 flex-1 basis-56 text-[11px] leading-snug " + (full ? "text-warn" : "text-faint")}>
          {full ? "The board is full — delete a campaign to make room for a copy." : "Then change geo, landing or the tag on all of them at once in “Change all campaigns”."}
        </p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button type="button" onClick={create} disabled={full} className={goBtn}>
            <SparklesIcon className="h-4 w-4" />
            Create {n} cop{n === 1 ? "y" : "ies"}
          </button>
        </div>
      </div>
    </>
  );
}
