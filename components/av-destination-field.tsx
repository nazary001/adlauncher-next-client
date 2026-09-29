"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchSelect } from "./search-select";
import { TextInput } from "./ui";
import { AlertIcon, CheckIcon, PlusIcon, RetryIcon, XIcon } from "./icons";
import {
  type AvCheckAsked,
  type AvDestinationKind,
  type AvRowState,
  type AvTabPin,
  type AvVerdict,
  avChatUrl,
  avCheckOutcome,
  avDestinationBase,
  avDestinationKind,
  avFieldTab,
  avMappingLabel,
  avPinAfterPick,
  avRefusalOfHost,
  avVerdictStands,
} from "@/lib/av-link";
import type { AvArticleOption, AvDestinations } from "./use-av-destinations";
import type { AvChatHostOption, AvDestinationCatalog, AvRedirectOption, AvResolved } from "@/lib/av-destination";

// The card's AV Destination picker (WP-D). One card stores a BARE destination URL in
// Campaign.landing — an article of an AV site, a Redirect path (redirect.<site>/<path>), or a chat
// of AV's Chat Builder (chat.<site>/?asst=<id>). The field is segmented Article | Redirect path |
// AI chat; the article branch searches the live sitemap (or takes a pasted URL, live-checked), the
// redirect branch lists AV's paths and can create a new one, the chat branch takes the chat's pasted
// address (AV lists no chats) and shows whether the chat host is ready for traffic.
// Everything the catalog knows comes from useAvDestinations; the server re-resolves the pick on
// every launch, so this is a convenience layer, not the authority.
//
// The three panels stay MOUNTED (the inactive ones hidden): what the buyer typed, a verdict and a
// request in flight survive a look at another tab. Two answers arrive seconds after their click — a
// check's verdict and a created redirect path — and both go through lib/av-link avCheckOutcome
// before they may set the destination. A line that stays on screen is shown only for as long as
// what it says is still so (lib/av-link avVerdictStands): a success with the destination it set, and
// until a NEWER reading of the catalog lists its host as not ready; a refusal of the host until a
// newer reading lists it as ready; a "created, not applied" note until that path is picked.

/** Client mirror of lib/av-destination AV_PATH_RE (that module is server-only — it imports node:dns
 *  — so its value can't cross into this client bundle). The POST route re-validates with the real
 *  one; this only gives instant "bad slug" feedback in the New path form. */
const AV_PATH_HINT_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** A chat host's row in the catalog: ready for traffic, NOT ready (a launch will be refused), or
 *  not CHECKED (the probe could not be made, or is still running — that says nothing about the host). */
const hostState = (h: AvChatHostOption): Exclude<AvRowState, null> =>
  h.live ? "ready" : h.pending || (h.liveReason ?? "").startsWith("destination_check_failed") ? "unchecked" : "blocked";

/** A muted / informative / warning / danger inline notice — the field's catalog states share one look.
 *  `info` is a line the buyer acts on that is no warning (it reads as clearly as the rest). */
function Notice({ tone = "muted", children }: { tone?: "muted" | "info" | "warn" | "danger"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "border-danger/40 bg-danger/10 text-red-300"
      : tone === "warn"
        ? "border-warn/40 bg-warn/10 text-warn"
        : tone === "info"
          ? "border-line bg-surface2/40 text-dim"
          : "border-line bg-surface2/40 text-faint";
  return <div className={`rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${cls}`}>{children}</div>;
}

/** The small filled action button (matches the card's Add-by-URL control). */
function SmallButton({
  onClick,
  disabled,
  children,
  busy,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={
        "h-9 shrink-0 rounded-lg border px-3 text-[12px] font-semibold transition-all duration-150 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
        (!disabled && !busy
          ? "border-accent/40 bg-accent/15 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97]"
          : "cursor-not-allowed border-line bg-surface text-faint opacity-50")
      }
    >
      {busy ? "…" : children}
    </button>
  );
}

/** The Retry control the field's notices and rows share — inert while a refresh is in flight. */
function RetryButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "inline-flex shrink-0 items-center gap-1 rounded-md border border-line2 bg-raise px-2 py-0.5 text-[11px] font-semibold text-dim transition-colors " +
        (busy ? "cursor-not-allowed opacity-50" : "hover:text-ink")
      }
    >
      <RetryIcon className={"h-3 w-3" + (busy ? " animate-spin" : "")} />
      {busy ? "Checking…" : "Retry"}
    </button>
  );
}

/** A destination the panel's own controls do not show (it is not in their list): its address, a
 *  Clear, and what that means for the launch. */
function CurrentRow({ url, clearLabel, onClear, children }: { url: string; clearLabel: string; onClear: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] leading-snug text-ink" title={url}>
          {url}
        </span>
        <button type="button" aria-label={clearLabel} onClick={onClear} className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-ink">
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] leading-snug text-dim">{children}</p>
    </div>
  );
}

/** What the field looks like NOW — what a slow answer is compared against (lib/av-link
 *  avCheckOutcome). Written from effects and event handlers only, never during render. */
type Live = AvCheckAsked & { pinned: boolean };
type Resolved = Extract<AvResolved, { ok: true }>;
type Shape = { ok: true; base: string; host: string } | { ok: false; error: string };

/** Is the component still there when a slow answer lands? */
function useMounted(): React.RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** The latest value of something an answer needs to read when it LANDS (not as it was at the click). */
function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

const NO_ARTICLES: AvArticleOption[] = [];
const NO_CHATS: AvChatHostOption[] = [];

export function AvDestinationField({
  value,
  onChange,
  destinations,
}: {
  /** The bare destination URL stored in Campaign.landing ("" when unset). */
  value: string;
  onChange: (v: string) => void;
  /** The board's shared AV catalog hook (undefined only if mounted off the AV rail — defensive). */
  destinations: AvDestinations | undefined;
}) {
  const cat = destinations?.data ?? null;
  const loading = destinations?.loading ?? false;
  const error = destinations?.error ?? null;
  const articleOptions = destinations?.articleOptions ?? NO_ARTICLES;

  // What the current value IS (lib/av-link reads the address; a chat is known by its shape alone,
  // the rest needs the catalog) — decides which tab shows it as picked.
  const valueKind: AvDestinationKind = useMemo(
    () => (value ? avDestinationKind(value, { sites: (cat?.sites ?? []).map((s) => s.domain), redirectDomains: (cat?.redirects ?? []).map((r) => r.domain) }) : "article"),
    [value, cat],
  );

  // The tab follows what the destination is — a pick, a catalog that lands late, a value pushed
  // from outside the field (copy settings) — until the buyer opens another tab for that SAME
  // destination (lib/av-link avFieldTab / avPinAfterPick).
  const [opened, setOpened] = useState<AvTabPin>(null);
  const mode = avFieldTab(opened, value, valueKind);
  const pinned = Boolean(opened && opened.forValue === value);

  const live = useRef<Live>({ value, mode, picks: 0, pinned });
  useEffect(() => {
    live.current.value = value;
    live.current.mode = mode;
    live.current.pinned = pinned;
  }, [value, mode, pinned]);

  // Every destination set by hand goes through here: a pick counts even when it is undone later,
  // and a clear keeps the tab it was made from.
  function pick(v: string) {
    live.current.picks += 1;
    setOpened(avPinAfterPick(v, mode));
    onChange(v);
  }

  // What the catalog on screen says of a chat host — what a line under a paste box is weighed
  // against; `probes` names the hosts it speaks for (chat.<root site>).
  const siteDomains = cat ? cat.sites.map((s) => s.domain) : null;
  const probes = (siteDomains ?? []).filter((d) => !(siteDomains ?? []).some((o) => d.endsWith(`.${o}`))).map((d) => `chat.${d}`);
  const chats = cat?.chats ?? NO_CHATS;
  const rowOf = (host: string): AvRowState => {
    const h = chats.find((c) => c.host === host);
    return h ? hostState(h) : null;
  };
  // A chat just checked whose host the catalog does not list as ready (a stale row, no row, no
  // catalog yet): the catalog is read again — a host it cannot speak for excepted. As it is when the
  // answer LANDS.
  const rereadForChat = useLatest((host: string): boolean => {
    if ((siteDomains && !probes.includes(host)) || rowOf(host) === "ready") return false;
    destinations?.refresh(true);
    return true;
  });

  if (!destinations) {
    return <Notice tone="warn">AV destinations are unavailable on this rail.</Notice>;
  }

  const panel = (m: AvDestinationKind) => (mode === m ? "flex flex-col gap-2" : "hidden");

  return (
    <div className="flex flex-col gap-2">
      {/* segmented Article | Redirect path | AI chat */}
      <div role="group" aria-label="Destination type" className="grid grid-cols-3 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
        {(
          [
            { key: "article" as const, label: "Article" },
            { key: "redirect" as const, label: "Redirect path" },
            { key: "chat" as const, label: "AI chat" },
          ]
        ).map((opt) => {
          const active = mode === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              aria-pressed={active}
              onClick={() => setOpened({ forValue: value, mode: opt.key })}
              className={
                "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                (active
                  ? "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                  : "text-dim hover:text-ink")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* whole-request failure — the sites call itself failed; nothing to pick until it recovers */}
      {error && !cat ? (
        <Notice tone="danger">
          <div className="flex items-start gap-2">
            <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <RetryButton onClick={() => destinations.refresh(true)} busy={loading} />
          </div>
        </Notice>
      ) : null}
      {/* a refresh that failed while a catalog is on screen: what is shown is the LAST good one */}
      {error && cat ? (
        <Notice tone="warn">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">Could not refresh — showing the last catalog. {error}</span>
            <RetryButton onClick={() => destinations.refresh(true)} busy={loading} />
          </div>
        </Notice>
      ) : null}

      <div className={panel("article")}>
        <SearchSelect
          value={valueKind === "article" ? value : ""}
          onChange={(v) => pick(v)}
          options={articleOptions}
          placeholder="Search AV articles"
          emptyHint={loading && articleOptions.length === 0 ? "Loading articles…" : error && !cat ? "Couldn't load AV destinations — use Retry above" : cat?.articlesError ? "Articles unavailable — see below" : "No articles match"}
          facets
          warn={!value}
        />
        {cat?.articlesError ? (
          <Notice tone="warn">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                {destinations.stale.articles ? "Showing the last list — it could not be refreshed. " : ""}
                {cat.articlesError}
              </span>
              <RetryButton onClick={() => destinations.refresh(true)} busy={loading} />
            </div>
          </Notice>
        ) : null}

        {/* paste any AV destination URL — validated for shape + host, then checked on the server */}
        <PasteCheck
          label="Destination URL"
          placeholder="…or paste an AV article URL"
          value={value}
          shape={(raw) => avDestinationBase(raw)}
          foreign={(host) =>
            siteDomains && !siteDomains.some((d) => host === d || host.endsWith(`.${d}`))
              ? `Not an ActiveView site — ${host} is none of ${siteDomains.join(", ") || "our sites"}.`
              : null
          }
          check={destinations.check}
          live={live}
          reading={destinations.reads}
          rowOf={rowOf}
          onApply={(res) => {
            pick(res.base);
            return res.kind === "chat" && rereadForChat.current(hostOf(res.base));
          }}
          applied={(res) =>
            res.kind === "chat"
              ? `Chat host ready (it shows ads) — ${res.base} set as the destination. The chat id itself cannot be checked: open the chat once to confirm.`
              : `Live ${res.kind === "redirect" ? "redirect path" : "article"} on ${res.site} — set as the destination.`
          }
        />
      </div>

      <div className={panel("redirect")}>
        <RedirectPicker
          cat={cat}
          loading={loading}
          value={value}
          current={valueKind === "redirect" ? value : ""}
          onChange={pick}
          live={live}
          articleOptions={articleOptions}
          destinations={destinations}
        />
      </div>

      <div className={panel("chat")}>
        <ChatPicker
          chats={chats}
          siteDomains={siteDomains}
          loading={loading}
          failed={Boolean(error) && !cat}
          value={value}
          current={valueKind === "chat" ? value : ""}
          onChange={pick}
          live={live}
          reading={destinations.reads}
          rowOf={rowOf}
          reread={rereadForChat}
          destinations={destinations}
        />
      </div>
    </div>
  );
}

/**
 * The paste box the tabs share: shape → a cheap "is this host ours" guard → the server's verdict.
 * The verdict takes seconds, so its answer is applied only if the field is still as it was when
 * Check was pressed (lib/av-link avCheckOutcome): a destination picked meanwhile — or a buyer who
 * opened another tab — stands, and the answer is reported here instead; a box that went away (the
 * card was removed) writes nothing.
 */
function PasteCheck({
  label,
  placeholder,
  value,
  shape,
  foreign,
  check,
  live,
  onApply,
  onRefused,
  applied,
  note,
  reading,
  rowOf,
}: {
  /** The input's accessible name (its placeholder is not one). */
  label: string;
  placeholder: string;
  /** The stored destination — a success verdict is shown only while it IS the destination. */
  value: string;
  shape: (raw: string) => Shape;
  /** Why this host is none of ours, or null — a foreign host never needs a round trip. */
  foreign: (host: string) => string | null;
  check: AvDestinations["check"];
  live: React.RefObject<Live>;
  /** Set the destination; true when the box also had the catalog read again (that reading only
   *  shows what the rows said — it does not weigh the line). */
  onApply: (res: Resolved) => boolean | void;
  /** The server refused the address that was checked; true when the catalog is read again. */
  onRefused?: (base: string) => boolean | void;
  /** The words for an applied answer. */
  applied: (res: Resolved) => string;
  /** Shown under the box whatever the verdict — what a check cannot prove must not disappear
   *  exactly when the check succeeds. */
  note?: React.ReactNode;
  /** How many reads of the catalog have landed, and what the catalog says of a chat host: a line is
   *  weighed against LATER readings (lib/av-link avVerdictStands). */
  reading: number;
  rowOf: (host: string) => AvRowState;
}) {
  const [paste, setPaste] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<AvVerdict | null>(null);
  const mounted = useMounted();
  const readingNow = useLatest(reading);

  const pasted = paste.trim() ? shape(paste) : null;
  const canCheck = Boolean(pasted?.ok) && !checking;
  const shown = verdict && avVerdictStands(verdict, { value, reading, row: verdict.host ? rowOf(verdict.host) : null }) ? verdict : null;

  async function runCheck() {
    if (!pasted?.ok || checking) return;
    const why = foreign(pasted.host);
    if (why) {
      setVerdict({ ok: false, text: why, readAt: readingNow.current });
      return;
    }
    const was = { ...live.current };
    const host = pasted.host;
    setChecking(true);
    setVerdict(null);
    const res = await check(pasted.base);
    const outcome = avCheckOutcome(was, { ...live.current, mounted: mounted.current });
    setChecking(false);
    if (outcome === "drop") return;
    // The line stands through the reading on screen when the answer LANDS — and through the one the
    // box asks for because of the answer.
    const readAt = readingNow.current;
    if (!res.ok) {
      const reread = onRefused?.(pasted.base) === true;
      setVerdict({ ok: false, text: res.error, host, hostLevel: avRefusalOfHost(res.error, pasted.base), readAt: readAt + (reread ? 1 : 0) });
      return;
    }
    if (outcome === "superseded") {
      setVerdict({ ok: false, text: `${res.base} passed the check, but the destination or the tab was changed while it was being checked — not applied. Press Check again to use it.`, readAt });
      return;
    }
    const reread = onApply(res) === true;
    setVerdict({ ok: true, text: applied(res), forValue: res.base, host: res.kind === "chat" ? hostOf(res.base) : undefined, readAt: readAt + (reread ? 1 : 0) });
    setPaste("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <TextInput
          value={paste}
          aria-label={label}
          disabled={checking}
          onChange={(e) => {
            setPaste(e.target.value);
            setVerdict(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (canCheck) void runCheck();
            }
          }}
          maxLength={2000}
          placeholder={placeholder}
          className="font-mono text-[11.5px]"
        />
        <SmallButton onClick={() => void runCheck()} disabled={!canCheck} busy={checking}>
          Check
        </SmallButton>
      </div>
      <div role="status" aria-live="polite">
        {paste.trim() && pasted && !pasted.ok ? (
          <p className="text-[11px] leading-snug text-warn">{pasted.error}</p>
        ) : shown ? (
          <p className={"flex items-start gap-1.5 text-[11px] leading-snug " + (shown.ok ? "text-launch2" : "text-warn")}>
            {shown.ok ? <CheckIcon className="mt-px h-3.5 w-3.5 shrink-0" /> : <XIcon className="mt-px h-3.5 w-3.5 shrink-0" />}
            <span className="min-w-0 break-words">{shown.text}</span>
          </p>
        ) : null}
      </div>
      {note ? <p className="text-[11px] leading-snug text-dim">{note}</p> : null}
    </div>
  );
}

/** The AI chat tab. AV's API lists no chats (they are built in its dashboard, Chat Builder), so the
 *  chat's address is PASTED; the tab shows the chat host's state — a host that is not activated, or
 *  that shows no ads yet ("Pending monetization"), is not launchable and says why. */
function ChatPicker({
  chats,
  siteDomains,
  loading,
  failed,
  value,
  current,
  onChange,
  live,
  reading,
  rowOf,
  reread,
  destinations,
}: {
  chats: AvChatHostOption[];
  /** Our AV sites' domains; null while the catalog has not loaded (no client host guard then). */
  siteDomains: string[] | null;
  loading: boolean;
  /** The whole catalog failed to load — the top notice + Retry already speaks. */
  failed: boolean;
  /** The stored destination, whatever its kind. */
  value: string;
  /** The stored destination when it IS a chat, else "". */
  current: string;
  onChange: (v: string) => void;
  live: React.RefObject<Live>;
  /** How many reads of the catalog have landed, and what it says of a chat host (see PasteCheck). */
  reading: number;
  rowOf: (host: string) => AvRowState;
  /** Has the catalog read again for a chat just checked (see AvDestinationField); true when it did. */
  reread: React.RefObject<(host: string) => boolean>;
  destinations: AvDestinations;
}) {
  // The catalog probes chat.<site> of the ROOT sites only (a site's own subdomain has none).
  const probed = (siteDomains ?? []).filter((d) => !(siteDomains ?? []).some((o) => d.endsWith(`.${o}`))).map((d) => `chat.${d}`);
  // What is KNOWN about the picked chat's host: listed ready; listed not ready, or probed and not
  // found — its launch will be refused —; or not known here (not listed, or the probe could not be
  // made): the launch checks it.
  const currentHost = hostOf(current);
  const row = chats.find((h) => h.host === currentHost);
  const state: "ready" | "blocked" | "unknown" = !current
    ? "unknown"
    : row
      ? hostState(row) === "unchecked"
        ? "unknown"
        : (hostState(row) as "ready" | "blocked")
      : siteDomains && !failed && probed.includes(currentHost)
        ? "blocked"
        : "unknown";
  // An answer reads the catalog as it is when it LANDS: it may have loaded meanwhile.
  const rows = useLatest(chats);
  const retry = () => destinations.refresh(true);

  return (
    <>
      {chats.length === 0 ? (
        failed ? null : (
          <Notice>
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                {loading && !siteDomains
                  ? "Looking for the chat subdomain…"
                  : `No chat host found at ${probed.join(", ") || "chat.<site>"} — activate one in ActiveView → Chat Builder. A chat on another subdomain can still be pasted below.`}
              </span>
              {siteDomains ? <RetryButton onClick={retry} busy={loading} /> : null}
            </div>
          </Notice>
        )
      ) : (
        chats.map((h) => {
          const s = hostState(h);
          return (
            <div key={h.host} className="rounded-xl border border-line bg-surface2/30 p-2.5">
              <div className="flex items-center gap-2">
                <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (s === "ready" ? "bg-launch2 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : s === "blocked" ? "bg-warn" : "bg-faint")} />
                <span className="truncate font-mono text-[11.5px] text-dim">{h.host}</span>
                <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {s === "ready" ? "ready" : s === "blocked" ? "not ready" : h.pending ? "checking…" : "not checked"}
                </span>
                <RetryButton onClick={retry} busy={loading} />
              </div>
              {s !== "ready" ? (
                <div className="mt-2">
                  <Notice tone={s === "blocked" ? "warn" : "info"}>
                    {h.pending ? `${h.host} is slow to answer — its state is read again in a moment.` : (h.liveReason ?? "This chat host is not ready for traffic yet.")}
                  </Notice>
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {current ? (
        <div
          className={
            "flex flex-col gap-1 rounded-lg border px-3 py-2 " +
            (state === "blocked" ? "border-warn/40 bg-warn/10" : state === "ready" ? "border-accent/40 bg-accent/10" : "border-line bg-surface2/40")
          }
        >
          <div className="flex items-start gap-2">
            {state === "blocked" ? (
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            ) : state === "ready" ? (
              <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9db8ff]" />
            ) : null}
            <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] leading-snug text-ink" title={current}>
              {current}
            </span>
            <a
              href={current}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 rounded-md border border-line2 bg-raise px-2 py-0.5 text-[11px] font-semibold text-dim transition-colors hover:text-ink"
            >
              Open
            </a>
            <button
              type="button"
              aria-label="Clear the chat destination"
              onClick={() => onChange("")}
              className="shrink-0 rounded p-0.5 text-faint transition-colors hover:text-ink"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {state === "blocked" ? (
            <p className="text-[11px] leading-snug text-warn">
              {row ? "Its host is not ready" : `No chat host was found at ${currentHost}`} — a launch to this chat will be refused until it is.
            </p>
          ) : state === "unknown" ? (
            <p className="text-[11px] leading-snug text-dim">Its host is not checked here — the launch checks it.</p>
          ) : null}
        </div>
      ) : null}

      {/* paste the chat's address — either form AV serves; normalized, then checked on the server */}
      <PasteCheck
        label="Chat URL"
        placeholder={current ? "Paste another chat URL" : "Paste the chat URL from Chat Builder"}
        value={value}
        shape={(raw) => avChatUrl(raw)}
        foreign={(host) =>
          siteDomains && !siteDomains.some((d) => host.endsWith(`.${d}`)) ? `Not a chat of ours — ${host} is no subdomain of ${siteDomains.join(", ") || "our sites"}.` : null
        }
        check={destinations.check}
        live={live}
        onApply={(res) => {
          onChange(res.base);
          // What the catalog says of the host may be older than this check: have it read again.
          return reread.current(hostOf(res.base));
        }}
        onRefused={(base) => {
          if (!rows.current.some((h) => h.host === hostOf(base) && h.live)) return false;
          destinations.refresh(true);
          return true;
        }}
        applied={(res) => `Chat host ready (it shows ads) — ${res.base} set as the destination.`}
        reading={reading}
        rowOf={rowOf}
        note="Copy the address from ActiveView → Chat Builder → View your chat. ActiveView answers for ANY id, so a mistyped one cannot be caught here — open the chat once to confirm."
      />
    </>
  );
}

/** The Redirect tab: one block per AV redirect domain — a not-live domain shows its reason and
 *  offers nothing; a live one lists its paths (targets/weights) and a New path inline form. A
 *  destination of this kind that no live domain lists (a path deleted in ActiveView, a list that
 *  could not be read) is shown on its own, with a Clear. */
function RedirectPicker({
  cat,
  loading,
  value,
  current,
  onChange,
  live,
  articleOptions,
  destinations,
}: {
  cat: AvDestinationCatalog | null;
  loading: boolean;
  value: string;
  /** The stored destination when it IS a redirect path, else "". */
  current: string;
  onChange: (v: string) => void;
  live: React.RefObject<Live>;
  articleOptions: AvArticleOption[];
  destinations: AvDestinations;
}) {
  const redirects = cat?.redirects ?? [];
  const listed = redirects.some((rd) => rd.live && rd.paths.some((p) => p.url === current));
  // Why the path is not in a list below: its domain is not live (it is listed there, with nothing to
  // pick), the list is being read again (a path just created), or it is not listed at all.
  const onDeadDomain = redirects.some((rd) => !rd.live && rd.paths.some((p) => p.url === current));
  const unlisted =
    current && !listed ? (
      <CurrentRow url={current} clearLabel="Clear the redirect destination" onClear={() => onChange("")}>
        {onDeadDomain
          ? "Its redirect domain is not live — a launch to it will be refused until it is."
          : loading
            ? "Reading the list of paths again…"
            : "This path is not in the list below — the launch checks it."}
      </CurrentRow>
    ) : null;
  const unavailable = cat?.redirectsError ? (
    <Notice tone="warn">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          {destinations.stale.redirects ? "Showing the last list — it could not be refreshed. " : ""}
          {cat.redirectsError}
        </span>
        <RetryButton onClick={() => destinations.refresh(true)} busy={loading} />
      </div>
    </Notice>
  ) : null;

  if (redirects.length === 0) {
    // Whole-catalog load failure (no cat at all): the top danger notice + Retry already speaks —
    // don't also claim there are "no redirect domains", which reads as a genuinely empty catalog
    // rather than a failed load (review find 09-28).
    const empty = unavailable ?? (destinations.error && !cat ? null : <Notice>{loading ? "Loading redirect domains…" : "No ActiveView redirect domains for our sites yet."}</Notice>);
    return (
      <>
        {unlisted}
        {empty}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {unlisted}
      {unavailable}
      {redirects.map((rd) => (
        <RedirectDomainBlock key={rd.domainId} rd={rd} value={value} onChange={onChange} live={live} articleOptions={articleOptions} destinations={destinations} />
      ))}
    </div>
  );
}

function RedirectDomainBlock({
  rd,
  value,
  onChange,
  live,
  articleOptions,
  destinations,
}: {
  rd: AvRedirectOption;
  value: string;
  onChange: (v: string) => void;
  live: React.RefObject<Live>;
  articleOptions: AvArticleOption[];
  destinations: AvDestinations;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  /** A path that was created while the buyer moved on: said until a path is picked from this list. */
  const [created, setCreated] = useState<string | null>(null);
  const mounted = useMounted();

  const pathOptions = useMemo(
    () =>
      rd.paths.map((p) => ({
        value: p.url,
        label: p.path,
        subLabel: p.mappingsError ? p.mappingsError : p.mappings.length ? p.mappings.map(avMappingLabel).join(" · ") : "no targets yet",
      })),
    [rd.paths],
  );

  const slugOk = AV_PATH_HINT_RE.test(slug.trim());
  const canCreate = slugOk && Boolean(target) && !creating;

  // The POST takes seconds: the path is created either way, but it becomes the DESTINATION only if
  // the field is still as it was when Create was pressed (a destination picked meanwhile stands).
  async function create() {
    if (!canCreate) return;
    const asked = { ...live.current };
    setCreating(true);
    setCreateErr(null);
    setCreated(null);
    const res = await destinations.createPath({ domainId: rd.domainId, path: slug.trim(), targetUrl: target });
    const outcome = avCheckOutcome(asked, { ...live.current, mounted: mounted.current });
    setCreating(false);
    if (outcome === "drop") return;
    if (!res.ok) {
      setCreateErr(res.error);
      return;
    }
    if (outcome === "apply") onChange(res.url);
    else setCreated(res.url);
    setNewOpen(false);
    setSlug("");
    setTarget("");
  }

  return (
    <div className="rounded-xl border border-line bg-surface2/30 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={"h-1.5 w-1.5 shrink-0 rounded-full " + (rd.live ? "bg-launch2 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-warn")}
        />
        <span className="truncate font-mono text-[11.5px] text-dim">{rd.domain}</span>
        <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">
          {rd.live ? "live" : "not live"}
        </span>
      </div>

      {!rd.live ? (
        // Redirect isn't live yet (28.09: its CNAME target doesn't resolve) — say why and offer
        // nothing to pick. The article tab stays the way to launch until AV's wizard is finished.
        <Notice tone="warn">{rd.liveReason ?? "This redirect domain is not live yet — finish its activation in ActiveView."}</Notice>
      ) : (
        <div className="flex flex-col gap-2">
          <SearchSelect
            value={rd.paths.some((p) => p.url === value) ? value : ""}
            onChange={(v) => {
              setCreated(null); // a path picked from the list answers the note
              onChange(v);
            }}
            options={pathOptions}
            placeholder="Search redirect paths"
            emptyHint="No paths on this domain yet — create one below"
          />
          {created && created !== value ? (
            <p role="status" className="text-[11px] leading-snug text-warn">
              {created} was created, but the destination or the tab was changed meanwhile — not applied. Pick it from the list to use it.
            </p>
          ) : null}
          {!newOpen ? (
            <button
              type="button"
              onClick={() => {
                setNewOpen(true);
                setCreated(null);
              }}
              className={
                "flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2/50 py-1.5 " +
                "text-[11.5px] font-medium text-dim transition-colors hover:border-accent/40 hover:bg-accent/5 " +
                "hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New path
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">New redirect path</span>
                <button
                  type="button"
                  aria-label="Cancel"
                  onClick={() => {
                    setNewOpen(false);
                    setCreateErr(null);
                  }}
                  className="rounded p-0.5 text-faint transition-colors hover:text-ink"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-line bg-surface2 px-2">
                <span className="shrink-0 select-none font-mono text-[11px] text-faint">{rd.domain}/</span>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  maxLength={60}
                  placeholder="my-offer-01"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink placeholder:text-faint outline-none"
                />
              </div>
              <p className={"text-[10.5px] leading-snug " + (slug.trim() && !slugOk ? "text-warn" : "text-faint")}>
                lower-case letters, digits and dashes · 2–60 chars
              </p>
              <SearchSelect
                value={target}
                onChange={(v) => setTarget(v)}
                options={articleOptions}
                placeholder="Target article"
                emptyHint="No AV articles to target"
                facets
                size="sm"
              />
              {createErr ? <p className="text-[11px] leading-snug text-warn">{createErr}</p> : null}
              <SmallButton onClick={() => void create()} disabled={!canCreate} busy={creating}>
                Create path
              </SmallButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
