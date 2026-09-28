"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchSelect } from "./search-select";
import { TextInput } from "./ui";
import { AlertIcon, CheckIcon, PlusIcon, RetryIcon, XIcon } from "./icons";
import { avDestinationBase } from "@/lib/av-link";
import type { AvDestinations } from "./use-av-destinations";
import type { AvRedirectOption } from "@/lib/av-destination";

// The card's AV Destination picker (WP-D). One card stores a BARE destination URL in
// Campaign.landing — an article of an AV site, or a Redirect path (redirect.<site>/<path>). The
// field is segmented Article | Redirect path; the article branch searches the live sitemap (or
// takes a pasted URL, live-checked), the redirect branch lists AV's paths and can create a new one.
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

  // Which redirect domain (if any) the current value belongs to — decides the initial tab.
  const valueIsRedirect = useMemo(() => {
    if (!value || !cat) return false;
    return cat.redirects.some((r) => r.paths.some((p) => p.url === value));
  }, [value, cat]);

  const [mode, setMode] = useState<"article" | "redirect">("article");
  // One-time tab sync: a stored REDIRECT value opens on the Redirect tab once the catalog lands
  // (the initializer runs before any fetch, so it can only default to Article). The tab is the
  // buyer's after that.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current || !cat) return;
    syncedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (valueIsRedirect) setMode("redirect");
  }, [cat, valueIsRedirect]);

  // ---- pasted-URL live check (Article tab) ----
  const [paste, setPaste] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const pasteBase = paste.trim() ? avDestinationBase(paste) : null;
  const pasteHostOk =
    pasteBase?.ok && cat ? cat.sites.some((s) => pasteBase.host === s.domain || pasteBase.host.endsWith(`.${s.domain}`)) : false;
  const canCheck = Boolean(pasteBase?.ok) && !checking;

  async function runCheck() {
    if (!pasteBase?.ok || !destinations) return;
    // Cheap client guards first (shape is already ok here) — a non-AV host never needs a round trip.
    if (cat && !pasteHostOk) {
      setVerdict({ ok: false, text: `Not an ActiveView site — ${pasteBase.host} is none of ${cat.sites.map((s) => s.domain).join(", ") || "our sites"}.` });
      return;
    }
    setChecking(true);
    setVerdict(null);
    const res = await destinations.check(pasteBase.base);
    setChecking(false);
    if (res.ok) {
      onChange(res.base);
      setVerdict({ ok: true, text: `Live ${res.kind} on ${res.site} — set as the destination.` });
      setPaste("");
    } else {
      setVerdict({ ok: false, text: res.error });
    }
  }

  if (!destinations) {
    return <Notice tone="warn">AV destinations are unavailable on this rail.</Notice>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* segmented Article | Redirect path */}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
        {(
          [
            { key: "article" as const, label: "Article" },
            { key: "redirect" as const, label: "Redirect path" },
          ]
        ).map((opt) => {
          const active = mode === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              aria-pressed={active}
              onClick={() => setMode(opt.key)}
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
      ) : null}

      {mode === "article" ? (
        <>
          <SearchSelect
            value={valueIsRedirect ? "" : value}
            onChange={(v) => onChange(v)}
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
          ) : null}

          {/* paste any AV article URL — validated for shape + host, then live-checked */}
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <TextInput
                value={paste}
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
                placeholder="…or paste an AV article URL"
                className="font-mono text-[11.5px]"
              />
              <SmallButton onClick={() => void runCheck()} disabled={!canCheck} busy={checking}>
                Check
              </SmallButton>
            </div>
            {paste.trim() && pasteBase && !pasteBase.ok ? (
              <p className="text-[11px] leading-snug text-warn">{pasteBase.error}</p>
            ) : verdict ? (
              <p className={"flex items-start gap-1.5 text-[11px] leading-snug " + (verdict.ok ? "text-launch2" : "text-warn")}>
                {verdict.ok ? <CheckIcon className="mt-px h-3.5 w-3.5 shrink-0" /> : <XIcon className="mt-px h-3.5 w-3.5 shrink-0" />}
                <span>{verdict.text}</span>
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <RedirectPicker cat={cat} loading={loading} value={value} onChange={onChange} articleOptions={articleOptions} destinations={destinations} />
      )}
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
