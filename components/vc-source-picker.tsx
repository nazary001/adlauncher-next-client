"use client";

// The VC cloner's source list (owner ask 05.11: «клоны всех активных кампаний»; 17.11: the cloner itself is
// the shared clone board now). The other partners' clone boards get their source ids from the stats tool;
// VC has no such hand-off, so the board lists every ACTIVE campaign of the VC cabinets itself (GET
// /api/vc/sources — one read per cabinet with the VC token, the buyer's assigned cabinets only) and the
// buyer TICKS the ones to clone: a tick puts the campaign into "Selected Campaigns" as a full row (its own
// destination, targeting, bid, budget, copies), an untick takes it out. Nothing is ticked by default — a
// batch is what the buyer picked, never "everything that runs".
//
// One line per campaign (name · cabinet · budget · bid · event · geo · ads), a search over the name / id /
// cabinet, a cabinet filter, "Add shown" for the filtered set. The list scrolls inside its own box so the
// rows below stay in reach.

import { useMemo, useState } from "react";
import { bidTag, moneyLabel } from "@/lib/types";
import { type VcCloneSource, vcPixelName } from "@/lib/vc-clone";
import { AlertIcon, CheckIcon, ChevronDownIcon, RetryIcon, SearchIcon, XIcon } from "./icons";

export type VcSourceList = {
  sources: VcCloneSource[];
  /** Linked ids the read could not deliver, with why. */
  failed: { id: string; error: string }[];
  signer: string;
};

/** Read the VC sources: every ACTIVE campaign of the buyer's VC cabinets, or exactly `ids` (a deep link).
 *  Throws with the server's own reason (no token assigned, Meta's refusal) so the board can show it. */
export async function fetchVcSources(ids: string[] = []): Promise<VcSourceList> {
  const clean = ids.filter(Boolean);
  const res = await fetch(`/api/vc/sources${clean.length ? `?ids=${encodeURIComponent(clean.join(","))}` : ""}`, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    sources?: VcCloneSource[];
    signer?: string;
    failed?: string[];
    failures?: Record<string, string>;
  };
  if (!res.ok || !body.ok) throw new Error(body.error || `Failed to load VC campaigns (${res.status})`);
  return {
    sources: body.sources ?? [],
    failed: (body.failed ?? []).map((id) => ({ id, error: body.failures?.[id] || "not found / no access" })),
    signer: body.signer ?? "",
  };
}

/** What a source optimizes, in one word. */
function eventLabel(s: VcCloneSource): string {
  if (s.optimizationGoal === "LINK_CLICKS" || !s.conversionEvent) return "Clicks";
  const ev = s.conversionEvent.charAt(0) + s.conversionEvent.slice(1).toLowerCase();
  return s.pixelId ? `${ev} · ${vcPixelName(s.pixelId)}` : ev;
}

const chip = "inline-flex shrink-0 items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-faint";

export function VcSourcePicker({
  list,
  loading,
  error,
  picked,
  onToggle,
  onAdd,
  onRemove,
  onLoad,
  owner = false,
}: {
  /** null = not read yet (a deep link opens the board with its rows only — the list loads on demand). */
  list: VcSourceList | null;
  loading: boolean;
  error: string | null;
  /** Source campaign ids that are rows of the batch right now. */
  picked: ReadonlySet<string>;
  onToggle: (src: VcCloneSource, on: boolean) => void;
  onAdd: (srcs: VcCloneSource[]) => void;
  onRemove: (ids: string[]) => void;
  /** (Re)read the list. */
  onLoad: () => void;
  owner?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const sources = useMemo(() => list?.sources ?? [], [list]);
  const accounts = useMemo(() => {
    const seen = new Map<string, { name: string; n: number }>();
    for (const s of sources) {
      const cur = seen.get(s.accountId);
      if (cur) cur.n++;
      else seen.set(s.accountId, { name: s.accountName || `act_${s.accountId}`, n: 1 });
    }
    return [...seen].map(([id, v]) => ({ id, ...v }));
  }, [sources]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sources.filter(
      (s) => (!account || s.accountId === account) && (!q || s.name.toLowerCase().includes(q) || s.campaignId.includes(q) || s.accountName.toLowerCase().includes(q)),
    );
  }, [sources, query, account]);
  const shownPicked = shown.filter((s) => picked.has(s.campaignId)).length;
  const toAdd = shown.filter((s) => !picked.has(s.campaignId));
  const noToken = Boolean(error && /no_token/i.test(error));

  return (
    <div className="overflow-hidden rounded-2xl border border-line" data-vc-sources>
      {/* header: title + count, collapse, reload */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface2/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ChevronDownIcon className={"h-3.5 w-3.5 shrink-0 text-faint transition-transform " + (open ? "" : "-rotate-90")} />
          Active VC campaigns
        </button>
        {list ? (
          <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim" title="ACTIVE campaigns on your VC cabinets">
            {sources.length}
          </span>
        ) : null}
        {picked.size > 0 ? (
          <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-[#9db8ff]" title="Campaigns in the batch below">
            {picked.size} in the batch
          </span>
        ) : null}
        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-surface px-2 text-[11px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RetryIcon className="h-3 w-3" /> {list ? "Reload" : "Load the list"}
        </button>
      </div>

      {!open ? null : loading ? (
        <p className="px-3 py-8 text-center text-[12.5px] text-faint">Reading the VC cabinets…</p>
      ) : error ? (
        <div className="flex flex-col gap-1 px-3 py-4 text-[12px] leading-relaxed">
          <p className="flex items-center gap-2 font-semibold text-warn">
            <AlertIcon className="h-4 w-4 shrink-0" /> Couldn&apos;t read the VC campaigns
          </p>
          <p className="break-words font-mono text-[11.5px] text-dim">{error}</p>
          {noToken && owner ? <p className="text-dim">Assign the VC token under menu → FB tokens (VC · Clones or VC · Launches), then Reload.</p> : null}
        </div>
      ) : !list ? (
        <p className="px-3 py-6 text-center text-[12px] text-faint">
          The campaigns of the link are below. <span className="text-dim">Load the list</span> to add more from the VC cabinets.
        </p>
      ) : sources.length === 0 ? (
        <p className="px-3 py-8 text-center text-[12.5px] text-faint">No ACTIVE campaign on your VC cabinets right now.</p>
      ) : (
        <>
          {/* filter bar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <div className="relative min-w-[160px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name · id · cabinet"
                aria-label="Search the VC campaigns"
                className="h-8 w-full rounded-md border border-line bg-surface2 pl-7 pr-7 text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:text-ink"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <div className="relative">
              <select
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                aria-label="Cabinet filter"
                className="h-8 cursor-pointer appearance-none rounded-md border border-line bg-surface2 pl-2 pr-6 text-[11.5px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
              >
                <option value="" className="bg-surface text-ink">
                  All cabinets
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-surface text-ink">
                    {a.name} · {a.n}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
            </div>
            <button
              type="button"
              disabled={toAdd.length === 0}
              onClick={() => onAdd(toAdd)}
              title="Put every campaign shown here into the batch"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-accent/40 bg-accent/15 px-2.5 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Add shown{toAdd.length ? ` (${toAdd.length})` : ""}
            </button>
            <button
              type="button"
              disabled={shownPicked === 0}
              onClick={() => onRemove(shown.filter((s) => picked.has(s.campaignId)).map((s) => s.campaignId))}
              title="Take the campaigns shown here out of the batch"
              className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-2.5 text-[11.5px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Untick shown
            </button>
          </div>

          {/* the list — its own scroll box */}
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-faint">Nothing matches — clear the search or the cabinet filter.</p>
          ) : (
            <ul className="max-h-[300px] overflow-y-auto overscroll-contain" aria-label="Active VC campaigns">
              {shown.map((s) => {
                const on = picked.has(s.campaignId);
                const reusable = s.ads.filter((a) => a.kind !== "none").length;
                return (
                  <li key={s.campaignId} className="border-b border-line/60 last:border-b-0">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`${on ? "Remove" : "Add"} ${s.name}`}
                      onClick={() => onToggle(s, !on)}
                      className={
                        "flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-1.5 text-left transition-colors hover:bg-raise/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 " +
                        (on ? "bg-accent/[0.06]" : "")
                      }
                    >
                      <span
                        className={
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors " +
                          (on ? "border-accent bg-accent text-white" : "border-line2 bg-surface")
                        }
                      >
                        {on ? <CheckIcon className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-[1_1_240px] truncate text-[12px] text-ink" title={`${s.name} · #${s.campaignId}`}>
                        {s.name}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <span className={chip} title={`act_${s.accountId}`}>
                          {s.accountName || `act_${s.accountId}`}
                        </span>
                        <span className={chip}>${moneyLabel(s.budget)}/d</span>
                        <span className={chip}>{bidTag(s.bidStrategy, s.bidCap) || "auto"}</span>
                        <span className={chip}>{eventLabel(s)}</span>
                        <span className={chip}>{s.countries.length ? (s.countries.length > 3 ? `${s.countries.slice(0, 3).join(" ")} +${s.countries.length - 3}` : s.countries.join(" ")) : "no geo"}</span>
                        <span className={chip + (reusable === 0 ? " border-warn/40 text-warn" : "")} title={reusable === 0 ? "No reusable video or image ad — this campaign cannot be cloned" : undefined}>
                          {reusable} {reusable === 1 ? "ad" : "ads"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {list.failed.length ? (
            <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-warn">Not loaded: {list.failed.map((f) => `#${f.id} — ${f.error}`).join(" · ")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
