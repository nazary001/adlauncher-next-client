"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchSelect } from "./search-select";
import { TextInput } from "./ui";
import { AlertIcon, CheckIcon, PlusIcon, RetryIcon, XIcon } from "./icons";
import { type AvCheckAsked, type AvDestinationKind, avChatUrl, avCheckOutcome, avDestinationBase, avDestinationKind } from "@/lib/av-link";
import type { AvDestinations } from "./use-av-destinations";
import type { AvChatHostOption, AvRedirectOption, AvResolved } from "@/lib/av-destination";

// The card's AV Destination picker (WP-D). One card stores a BARE destination URL in
// Campaign.landing — an article of an AV site, a Redirect path (redirect.<site>/<path>), or a chat
// of AV's Chat Builder (chat.<site>/?asst=<id>). The field is segmented Article | Redirect path |
// AI chat; the article branch searches the live sitemap (or takes a pasted URL, live-checked), the
// redirect branch lists AV's paths and can create a new one, the chat branch takes the chat's pasted
// address (AV lists no chats) and shows whether the chat host is ready for traffic.
// Everything the catalog knows comes from useAvDestinations; the server re-resolves the pick on
// every launch, so this is a convenience layer, not the authority.

/** Client mirror of lib/av-destination AV_PATH_RE (that module is server-only — it imports node:dns
 *  — so its value can't cross into this client bundle). The POST route re-validates with the real
 *  one; this only gives instant "bad slug" feedback in the New path form. */
const AV_PATH_HINT_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Short, human target for a redirect mapping: the target article's last path segment + weight. */
function mappingLabel(m: { url: string; percentage: number }): string {
  let seg = "";
  try {
    const u = new URL(m.url);
    seg = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
  } catch {
    seg = m.url;
  }
  return `${m.percentage}% ${seg}`;
}

/** A muted / warning / danger inline notice — the field's catalog states share one look. */
function Notice({ tone = "muted", children }: { tone?: "muted" | "warn" | "danger"; children: React.ReactNode }) {
  const cls =
    tone === "danger"
      ? "border-danger/40 bg-danger/10 text-red-300"
      : tone === "warn"
        ? "border-warn/40 bg-warn/10 text-warn"
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

/** What the field looks like NOW — what a check's late answer is compared against (lib/av-link
 *  avCheckOutcome). Written from effects and event handlers only, never during render. */
type Live = AvCheckAsked;
type Resolved = Extract<AvResolved, { ok: true }>;
type Shape = { ok: true; base: string; host: string } | { ok: false; error: string };

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

  // Article options from the live sitemap, grouped by site (label = title, sub = path · variant).
  const articleOptions = useMemo(
    () =>
      (cat?.articles ?? []).map((a) => ({
        value: a.url,
        label: a.title || a.path,
        subLabel: a.variant ? `${a.path} · ${a.variant}` : a.path,
        group: a.site,
      })),
    [cat],
  );

  // What the current value IS (lib/av-link reads the address; a chat is known by its shape alone,
  // the rest needs the catalog) — decides which tab shows it as picked.
  const valueKind: AvDestinationKind = useMemo(
    () => (value ? avDestinationKind(value, { sites: (cat?.sites ?? []).map((s) => s.domain), redirectDomains: (cat?.redirects ?? []).map((r) => r.domain) }) : "article"),
    [value, cat],
  );

  // The tab follows what the destination is — a pick, a catalog that lands late, a value pushed
  // from outside the field (copy settings) — until the buyer opens another tab for that SAME
  // destination. A new destination takes the tab back.
  const [opened, setOpened] = useState<{ forValue: string; mode: AvDestinationKind } | null>(null);
  const mode = opened && opened.forValue === value ? opened.mode : valueKind;

  const live = useRef<Live>({ value, mode, picks: 0 });
  useEffect(() => {
    live.current.value = value;
    live.current.mode = mode;
  }, [value, mode]);

  // Every destination set by hand goes through here: a pick counts even when it is undone later.
  function pick(v: string) {
    live.current.picks += 1;
    onChange(v);
  }

  if (!destinations) {
    return <Notice tone="warn">AV destinations are unavailable on this rail.</Notice>;
  }

  const siteDomains = cat ? cat.sites.map((s) => s.domain) : null;

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

      {mode === "article" ? (
        <>
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
                <span className="min-w-0 flex-1">{cat.articlesError}</span>
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
            onApply={(res) => pick(res.base)}
            applied={(res) =>
              res.kind === "chat"
                ? `Chat host ready (it shows ads) — ${res.base} set as the destination. The chat id itself cannot be verified: open the chat once to confirm.`
                : `Live ${res.kind} on ${res.site} — set as the destination.`
            }
          />
        </>
      ) : mode === "redirect" ? (
        <RedirectPicker cat={cat} loading={loading} value={value} onChange={pick} articleOptions={articleOptions} destinations={destinations} />
      ) : (
        <ChatPicker
          chats={cat?.chats ?? []}
          siteDomains={siteDomains}
          loading={loading}
          failed={Boolean(error) && !cat}
          value={value}
          current={valueKind === "chat" ? value : ""}
          onChange={pick}
          live={live}
          destinations={destinations}
        />
      )}
    </div>
  );
}

/**
 * The paste box both tabs share: shape → a cheap "is this host ours" guard → the server's verdict.
 * The verdict takes seconds, so its answer is applied only if the field is still as it was when
 * Check was pressed (lib/av-link avCheckOutcome): a destination picked meanwhile stands, and a box
 * that went away (the buyer left the tab or the card) writes nothing.
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
  applied,
  note,
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
  onApply: (res: Resolved) => void;
  /** The words for an applied answer. */
  applied: (res: Resolved) => string;
  /** Shown under the box whatever the verdict — what a check cannot prove must not disappear
   *  exactly when the check succeeds. */
  note?: React.ReactNode;
}) {
  const [paste, setPaste] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string; forValue?: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pasted = paste.trim() ? shape(paste) : null;
  const canCheck = Boolean(pasted?.ok) && !checking;
  // A success names the destination it set: once the destination is another one, it is stale.
  const shown = verdict && (verdict.forValue === undefined || verdict.forValue === value) ? verdict : null;

  async function runCheck() {
    if (!pasted?.ok || checking) return;
    const why = foreign(pasted.host);
    if (why) {
      setVerdict({ ok: false, text: why });
      return;
    }
    const asked = { ...live.current };
    setChecking(true);
    setVerdict(null);
    const res = await check(pasted.base);
    const outcome = avCheckOutcome(asked, { ...live.current, mounted: mounted.current });
    if (outcome.act === "drop") return;
    setChecking(false);
    if (!res.ok) {
      setVerdict({ ok: false, text: res.error });
      return;
    }
    if (outcome.act === "superseded") {
      setVerdict({ ok: false, text: `${res.base} passed the check, but the destination was changed while it was being checked — not applied. Press Check again to use it.` });
      return;
    }
    onApply(res);
    setVerdict({ ok: true, text: applied(res), forValue: res.base });
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

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

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
  destinations: AvDestinations;
}) {
  // The picked chat's own host, when the catalog lists it: a chat on a host that is not ready is
  // stored, but its launch will be refused — the row must not read as "all set".
  const currentHost = current ? chats.find((h) => h.host === hostOf(current)) : undefined;
  const blocked = Boolean(currentHost && !currentHost.live);

  return (
    <div className="flex flex-col gap-2">
      {chats.length === 0 ? (
        failed ? null : (
          <Notice>
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                {loading
                  ? "Looking for the chat subdomain…"
                  : `No chat host found at ${(siteDomains ?? []).map((d) => `chat.${d}`).join(", ") || "chat.<site>"} — activate one in ActiveView → Chat Builder. A chat on another subdomain can still be pasted below.`}
              </span>
              {loading ? null : <RetryButton onClick={() => destinations.refresh(true)} />}
            </div>
          </Notice>
        )
      ) : (
        chats.map((h) => (
          <div key={h.host} className="rounded-xl border border-line bg-surface2/30 p-2.5">
            <div className="flex items-center gap-2">
              <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (h.live ? "bg-launch2 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-warn")} />
              <span className="truncate font-mono text-[11.5px] text-dim">{h.host}</span>
              <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.14em] text-faint">{h.live ? "ready" : "not ready"}</span>
              {!h.live ? <RetryButton onClick={() => destinations.refresh(true)} busy={loading} /> : null}
            </div>
            {!h.live ? (
              <div className="mt-2">
                <Notice tone="warn">{h.liveReason ?? "This chat host is not ready for traffic yet."}</Notice>
              </div>
            ) : null}
          </div>
        ))
      )}

      {current ? (
        <div className={"flex flex-col gap-1 rounded-lg border px-3 py-2 " + (blocked ? "border-warn/40 bg-warn/10" : "border-accent/40 bg-accent/10")}>
          <div className="flex items-start gap-2">
            {blocked ? <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" /> : <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9db8ff]" />}
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
          {blocked ? <p className="text-[11px] leading-snug text-warn">Its host is not ready — a launch to this chat will be refused until it is.</p> : null}
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
          // The host's row may still say what it said before this check — re-read it.
          if (chats.some((h) => h.host === hostOf(res.base) && !h.live)) destinations.refresh(true);
        }}
        applied={(res) => `Chat host ready (it shows ads) — ${res.base} set as the destination.`}
        note="Copy the address from ActiveView → Chat Builder → View your chat. ActiveView answers for ANY id, so a mistyped one cannot be caught here — open the chat once to confirm."
      />
    </div>
  );
}

/** The Redirect tab: one block per AV redirect domain — a not-live domain shows its reason and
 *  offers nothing; a live one lists its paths (targets/weights) and a New path inline form. */
function RedirectPicker({
  cat,
  loading,
  value,
  onChange,
  articleOptions,
  destinations,
}: {
  cat: import("@/lib/av-destination").AvDestinationCatalog | null;
  loading: boolean;
  value: string;
  onChange: (v: string) => void;
  articleOptions: { value: string; label: string; subLabel: string; group: string }[];
  destinations: AvDestinations;
}) {
  const redirects = cat?.redirects ?? [];

  if (cat?.redirectsError) {
    return (
      <Notice tone="warn">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">{cat.redirectsError}</span>
          <button
            type="button"
            onClick={() => destinations.refresh(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line2 bg-raise px-2 py-0.5 text-[11px] font-semibold text-dim transition-colors hover:text-ink"
          >
            <RetryIcon className="h-3 w-3" />
            Retry
          </button>
        </div>
      </Notice>
    );
  }
  if (redirects.length === 0) {
    // Whole-catalog load failure (no cat at all): the top danger notice + Retry already speaks —
    // don't also claim there are "no redirect domains", which reads as a genuinely empty catalog
    // rather than a failed load (review find 09-28).
    if (destinations.error && !cat) return null;
    return <Notice>{loading ? "Loading redirect domains…" : "No ActiveView redirect domains for our sites yet."}</Notice>;
  }

  return (
    <div className="flex flex-col gap-3">
      {redirects.map((rd) => (
        <RedirectDomainBlock
          key={rd.domainId}
          rd={rd}
          value={value}
          onChange={onChange}
          articleOptions={articleOptions}
          destinations={destinations}
        />
      ))}
    </div>
  );
}

function RedirectDomainBlock({
  rd,
  value,
  onChange,
  articleOptions,
  destinations,
}: {
  rd: AvRedirectOption;
  value: string;
  onChange: (v: string) => void;
  articleOptions: { value: string; label: string; subLabel: string; group: string }[];
  destinations: AvDestinations;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const pathOptions = rd.paths.map((p) => ({
    value: p.url,
    label: p.path,
    subLabel: p.mappingsError ? p.mappingsError : p.mappings.length ? p.mappings.map(mappingLabel).join(" · ") : "no targets yet",
  }));

  const slugOk = AV_PATH_HINT_RE.test(slug.trim());
  const canCreate = slugOk && Boolean(target) && !creating;

  async function create() {
    if (!canCreate) return;
    setCreating(true);
    setCreateErr(null);
    const res = await destinations.createPath({ domainId: rd.domainId, path: slug.trim(), targetUrl: target });
    setCreating(false);
    if (res.ok) {
      onChange(res.url);
      setNewOpen(false);
      setSlug("");
      setTarget("");
    } else {
      setCreateErr(res.error);
    }
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
            onChange={(v) => onChange(v)}
            options={pathOptions}
            placeholder="Search redirect paths"
            emptyHint="No paths on this domain yet — create one below"
          />
          {!newOpen ? (
            <button
              type="button"
              onClick={() => setNewOpen(true)}
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
