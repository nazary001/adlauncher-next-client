"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useHs } from "./use-hs";
import { useHsTaskManager } from "./hs-task-manager";
import { limitMoney, moneyLabel, parseMoney } from "@/lib/types";
import { geoSummary } from "@/lib/catalog";
import { todaySaoPauloDDMM } from "@/lib/hs-launch";
import type { PartnerId } from "@/lib/partners";
import { CopyIcon, EyeIcon, PlusIcon, TrashIcon } from "./icons";
import type { SessionUser } from "./user-menu";

const MAX_COPIES = 20;
const MAX_SOURCES = 30;

/** One source campaign row: LION-read facts + the editable overrides. */
type Row = {
  id: string;
  campaignId: string;
  /** LION details/targeting — null while loading, "UNREADABLE" status = duplicate would die too. */
  info: {
    name: string;
    status: string;
    countries: string[];
    budget: number | null; // MAJOR $ (LION reads are major)
    bid: number | null;
    bidStrategy: string;
    adsCount: number;
  } | null;
  loading: boolean;
  bid: string; // editable override; "" = inherit from source (safe default)
  budget: string; // editable, display string → cents on the wire
  suffix: string;
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

const STRATEGY_SHORT: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "lowest",
  LOWEST_COST_WITH_BID_CAP: "bid cap",
  COST_CAP: "cost cap",
  LOWEST_COST_WITH_MIN_ROAS: "min ROAS",
};

/** Split a LION name by its validated grammar: the STRUCTURED prefix
 *  `[DD/MM] (ACR) API[ (CLONE)] - (LABEL) - [CODES] - [LANG] - ...` stays fixed (re-dated to
 *  today, "(CLONE)" ensured — that part LION owns), while the free-text TAIL after it is the
 *  buyer's to replace. Unparseable names fall back to everything-is-tail. */
function splitLionName(sourceName: string, ddmm: string): { prefix: string; tail: string } {
  const m =
    /^((?:\[\d{2}\/\d{2}\])\s*\([^)]*\)\s*API(?:\s*\(CLONE\))?\s*-\s*\([^)]*\)\s*(?:-\s*\[[^\]]*\]\s*)*-\s*)([\s\S]*)$/.exec(
      sourceName,
    );
  if (!m) return { prefix: "", tail: sourceName };
  let prefix = m[1].replace(/^\[\d{2}\/\d{2}\]/, `[${ddmm}]`);
  if (!/\(CLONE\)/.test(prefix)) prefix = prefix.replace(/API/, "API (CLONE)");
  return { prefix, tail: m[2].trim() };
}

const freshRow = (campaignId: string, n: number): Row => ({
  id: `r${Date.now()}-${n}`,
  campaignId,
  info: null,
  loading: false,
  bid: "",
  budget: "10",
  suffix: "", // becomes the source's old TAIL once LION answers — an editable replacement
  state: "idle",
});

/**
 * HS duplicator, structured like LION's own duplicator UI: a Settings column (destination binds
 * + global copies + Preview→Duplicate) and a Selected Campaigns table whose rows show the REAL
 * source facts read from LION (name, countries, original budget/bid, creatives) next to the
 * editable Bid/Budget/Suffix overrides. Submits go through /api/hs/duplicate; successful tasks
 * land in the HS Task Manager already "submitted" and auto-activate after COMPLETED.
 */
export function HsCloneBoard({
  user,
  partner,
  initialIds = [],
}: {
  user?: SessionUser;
  partner: PartnerId;
  /** Source campaign ids handed over in the link (?ids=…) — one prefilled row each. */
  initialIds?: string[];
}) {
  const hs = useHs(true);
  const { enqueueSubmitted, setOpen } = useHsTaskManager();

  const [profile, setProfile] = useState("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [pixel, setPixel] = useState("");
  const [copies, setCopies] = useState("1");
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [draftId, setDraftId] = useState("");
  const counter = useRef(1);
  const [rows, setRows] = useState<Row[]>(() => {
    const seeded = initialIds
      .filter((id) => /^\d{5,}$/.test(id))
      .slice(0, MAX_SOURCES)
      .map((cid, i) => freshRow(cid, i + 1));
    return seeded;
  });

  const data = profile ? hs.dataFor(profile) : undefined;
  const pixels = profile && account ? hs.pixelsFor(profile, account) : undefined;

  const pickProfile = (slug: string) => {
    setProfile(slug);
    setAccount("");
    setPage("");
    setPixel("");
    setPreviewed(false);
    if (slug) hs.ensureProfile(slug);
  };
  const pickAccount = (id: string) => {
    setAccount(id);
    setPixel("");
    setPreviewed(false);
    if (profile && id) hs.ensurePixels(profile, id);
  };

  const patchRow = useCallback(
    (id: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))),
    [],
  );
  const addSources = () => {
    const ids = [...new Set(draftId.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)))];
    if (ids.length === 0) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.campaignId));
      const fresh = ids
        .filter((id) => !have.has(id))
        .map((id) => freshRow(id, ++counter.current));
      return [...rs, ...fresh].slice(0, MAX_SOURCES);
    });
    setDraftId("");
    setPreviewed(false);
  };
  const removeRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setPreviewed(false);
  };

  // ---- source facts from LION (details + targeting), batched + debounced ----
  const fetchedRef = useRef(new Set<string>());
  useEffect(() => {
    const want = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && !r.info && !r.loading);
    const ids = [...new Set(want.map((r) => r.campaignId.trim()))].filter((id) => !fetchedRef.current.has(id));
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      ids.forEach((id) => fetchedRef.current.add(id));
      setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: true } : r)));
      void (async () => {
        try {
          const res = await fetch("/api/hs/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const d = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            sources?: Array<{
              campaignId: string;
              name: string;
              status: string;
              countries: string[];
              budget: number | null;
              bid: number | null;
              bidStrategy: string;
              adsCount: number;
            }>;
          };
          const byId = new Map((d.sources ?? []).map((s) => [s.campaignId, s]));
          setRows((rs) =>
            rs.map((r) => {
              const s = byId.get(r.campaignId.trim());
              if (!s) return ids.includes(r.campaignId.trim()) ? { ...r, loading: false } : r;
              return {
                ...r,
                loading: false,
                info: {
                  name: s.name,
                  status: s.status,
                  countries: s.countries,
                  budget: s.budget,
                  bid: s.bid,
                  bidStrategy: s.bidStrategy,
                  adsCount: s.adsCount,
                },
                // Prefill the editable bid with the source's own (LION-UI does the same); the
                // buyer clearing it back to "" means "inherit".
                bid: r.bid || (s.bid != null ? String(s.bid).replace(".", ",") : ""),
                // Prefill the editable TAIL with the source's old one (grammar split).
                suffix: r.suffix || splitLionName(s.name, todaySaoPauloDDMM()).tail,
              };
            }),
          );
        } catch {
          ids.forEach((id) => fetchedRef.current.delete(id)); // retry on next edit
          setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: false } : r)));
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [rows]);

  const bindsReady = Boolean(profile && account && page && pixel);
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  const validRows = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && parseMoney(r.budget) >= 1);
  const unreadable = rows.filter((r) => r.info?.status === "UNREADABLE").length;
  const totalClones = validRows.length * copiesN;

  async function duplicateAll() {
    if (!bindsReady || validRows.length === 0 || firing) return;
    setFiring(true);
    try {
      for (const r of rows) {
        const cid = r.campaignId.trim();
        if (!/^\d{5,}$/.test(cid) || parseMoney(r.budget) < 1) continue;
        patchRow(r.id, { state: "sending", msg: undefined });
        try {
          const res = await fetch("/api/hs/duplicate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              profile,
              account,
              page,
              pixel,
              campaignId: cid,
              copies: copiesN,
              budget: r.budget,
              bid: r.bid.trim(),
              // Full name = fixed grammar prefix + the buyer's tail (replaces the old one).
              // When the source couldn't be read there's no prefix — LION rebuilds the name.
              ...(r.info?.name
                ? { name: `${splitLionName(r.info.name, todaySaoPauloDDMM()).prefix}${r.suffix.trim()}`.trim() }
                : {}),
            }),
          });
          const d = (await res.json().catch(() => ({}))) as { ok?: boolean; taskIds?: string[]; error?: string };
          if (d?.ok && Array.isArray(d.taskIds) && d.taskIds.length > 0) {
            const label = r.info?.name || `#${cid}`;
            enqueueSubmitted(
              d.taskIds.map((taskId, i) => ({
                name: `${label}${d.taskIds!.length > 1 ? ` · copy ${i + 1}/${d.taskIds!.length}` : ""}`,
                profile,
                geo: r.info?.countries.length ? geoSummary(r.info.countries) : "inherited",
                budget: r.budget,
                lionTaskId: String(taskId),
              })),
            );
            patchRow(r.id, { state: "ok", msg: `${d.taskIds.length} task${d.taskIds.length === 1 ? "" : "s"} → HS Tasks` });
          } else {
            // LION's preflight reason is the actionable text ("No valid creative URL…" =
            // object-story source, not duplicable; "Page not found in account data"; …).
            patchRow(r.id, { state: "error", msg: d?.error ?? `HTTP ${res.status}` });
          }
        } catch (e) {
          patchRow(r.id, { state: "error", msg: String((e as Error).message ?? e) });
        }
        // polite pacing between LION submits, matching the launch queue's spirit
        await new Promise((done) => setTimeout(done, 400));
      }
      setOpen(true); // the drawer shows live creation stages + auto-activation
    } finally {
      setFiring(false);
    }
  }

  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    // Cross-rail switch (HS duplicator ↔ MO clone board) is a different server component tree.
    window.location.assign(url.toString());
  };

  return (
    <>
      <Header partner={partner} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---- Settings (LION-duplicator structure: binds + copies + preview→duplicate) ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                Settings
              </span>
              <Field label="Profile">
                <SearchSelect
                  value={profile}
                  onChange={pickProfile}
                  options={hs.profiles ?? []}
                  placeholder="Search profile"
                  emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
                />
              </Field>
              <Field label="Account">
                <SearchSelect
                  value={account}
                  onChange={pickAccount}
                  options={data?.accounts ?? []}
                  placeholder="Search account"
                  emptyHint={!profile ? "Pick a profile first" : data ? "No enabled accounts" : "Loading…"}
                />
              </Field>
              <Field label="Page">
                <SearchSelect
                  value={page}
                  onChange={(v) => {
                    setPage(v);
                    setPreviewed(false);
                  }}
                  options={data?.pages ?? []}
                  placeholder="Search page"
                  emptyHint={!profile ? "Pick a profile first" : data ? "No pages" : "Loading…"}
                />
              </Field>
              <Field label="Pixel">
                <SearchSelect
                  value={pixel}
                  onChange={(v) => {
                    setPixel(v);
                    setPreviewed(false);
                  }}
                  options={(pixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                  placeholder="Search pixel"
                  emptyHint={!account ? "Pick an account first" : pixels ? "No pixels on this account" : "Loading…"}
                />
              </Field>
              <Field label="Number of copies" hint="per source campaign">
                <input
                  value={copies}
                  onChange={(e) => {
                    setCopies(e.target.value.replace(/\D/g, "").slice(0, 2));
                    setPreviewed(false);
                  }}
                  inputMode="numeric"
                  aria-label="Number of copies"
                  className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] font-mono tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
              </Field>

              <button
                type="button"
                onClick={() => setPreviewed(true)}
                disabled={!bindsReady || validRows.length === 0}
                className={
                  "mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 " +
                  "bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
                  "hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] " +
                  "disabled:cursor-not-allowed disabled:opacity-40 " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>
              {previewed ? (
                <button
                  type="button"
                  onClick={() => void duplicateAll()}
                  disabled={!bindsReady || validRows.length === 0 || firing}
                  className={
                    "animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl " +
                    "bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] " +
                    "shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 " +
                    "hover:shadow-[0_10px_36px_rgba(16,185,129,0.5)] hover:brightness-110 active:scale-[0.98] " +
                    "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
                  }
                >
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Submitting…" : `Duplicate ${totalClones} clone${totalClones === 1 ? "" : "s"}`}
                </button>
              ) : null}
              <p className="text-center text-[10.5px] leading-relaxed text-faint">
                {bindsReady
                  ? previewed
                    ? "Submits to LION · clones activate automatically"
                    : "Preview first, then duplicate"
                  : "Pick profile · account · page · pixel"}
              </p>
            </div>
          </aside>

          {/* ---- Selected campaigns ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Selected campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {validRows.length}
              </span>
              {unreadable > 0 ? (
                <span className="rounded-md border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger">
                  {unreadable} unreadable — their duplicates would fail too
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
              <table className="w-full min-w-[960px] text-left">
                <thead>
                  <tr className="border-b border-line text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-2 py-2 font-semibold">Name (fixed) + suffix</th>
                    <th className="px-2 py-2 font-semibold">Countries</th>
                    <th className="px-2 py-2 text-right font-semibold">Orig budget</th>
                    <th className="px-2 py-2 text-right font-semibold">Orig bid</th>
                    <th className="px-2 py-2 text-center font-semibold">Ads</th>
                    <th className="px-2 py-2 font-semibold">Bid</th>
                    <th className="px-2 py-2 font-semibold">Budget $</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className="border-b border-line/60 align-top last:border-b-0">
                      <td className="px-3 py-3 font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</td>
                      <td className="min-w-[320px] px-2 py-2.5">
                        {/* Like the launcher's name field: the LION-rebuilt part is FIXED (muted),
                            only the trailing suffix is the buyer's to edit. */}
                        <div className="rounded-md border border-line bg-surface2 px-2.5 py-1.5">
                          <p className="font-mono text-[10px] text-faint">#{r.campaignId}</p>
                          <p className="mt-0.5 break-words text-[11.5px] leading-snug text-dim" title={r.info?.name}>
                            {r.loading ? (
                              "Loading from LION…"
                            ) : r.info?.status === "UNREADABLE" ? (
                              <span className="text-danger">LION can’t read this campaign</span>
                            ) : r.info?.name ? (
                              splitLionName(r.info.name, todaySaoPauloDDMM()).prefix || r.info.name
                            ) : (
                              "—"
                            )}
                          </p>
                          <input
                            value={r.suffix}
                            onChange={(e) => patchRow(r.id, { suffix: e.target.value })}
                            placeholder="tail — edit to rename the clone"
                            aria-label="Name suffix"
                            maxLength={80}
                            className="mt-1.5 h-7 w-full rounded border border-line bg-surface px-2 text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                          />
                        </div>
                      </td>
                      <td className="px-2 py-3 text-[11.5px] text-dim">
                        {r.info?.countries.length ? geoSummary(r.info.countries) : r.info ? "inherited" : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-mono text-[11.5px] tabular-nums text-dim">
                        {r.info?.budget != null ? `$${moneyLabel(r.info.budget)}` : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-mono text-[11.5px] tabular-nums text-dim">
                        {r.info?.bid != null
                          ? String(r.info.bid).replace(".", ",")
                          : r.info?.bidStrategy
                            ? (STRATEGY_SHORT[r.info.bidStrategy] ?? "—")
                            : "—"}
                      </td>
                      <td className="px-2 py-3 text-center font-mono text-[11.5px] text-dim">
                        {r.info ? r.info.adsCount : "—"}
                      </td>
                      <td className="w-[110px] px-2 py-2.5">
                        <input
                          value={r.bid}
                          onChange={(e) => patchRow(r.id, { bid: limitMoney(e.target.value, 10000) })}
                          // LION's REST reads expose adset_bid for cap sources (prefilled) but NOT
                          // a MIN_ROAS goal — empty inherits the source's own goal on duplicate.
                          placeholder={
                            r.info?.bidStrategy === "LOWEST_COST_WITH_MIN_ROAS" ? "inherits ROAS goal" : "inherit"
                          }
                          aria-label="Bid / ROAS goal"
                          className={cellInput}
                        />
                      </td>
                      <td className="w-[100px] px-2 py-2.5">
                        <input
                          value={r.budget}
                          onChange={(e) => patchRow(r.id, { budget: limitMoney(e.target.value, 10000) })}
                          aria-label="Daily budget"
                          className={cellInput}
                        />
                      </td>
                      <td className="max-w-[180px] px-2 py-3">
                        <span
                          className={
                            "block truncate text-[11px] " +
                            (r.state === "error"
                              ? "text-danger"
                              : r.state === "ok"
                                ? "text-launch2"
                                : r.state === "sending"
                                  ? "text-[#9db8ff]"
                                  : "text-faint")
                          }
                          title={r.msg}
                        >
                          {r.state === "sending" ? "Submitting…" : (r.msg ?? "—")}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <button
                          type="button"
                          aria-label="Remove row"
                          onClick={() => removeRow(r.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addSources();
                  }}
                  placeholder="Campaign ID(s) — paste one or a comma list"
                  aria-label="Add source campaign ids"
                  className="h-8 w-[280px] rounded-md border border-line bg-surface2 px-2 font-mono text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
                <button
                  type="button"
                  onClick={addSources}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[11.5px] font-medium text-faint transition-colors hover:border-accent/50 hover:text-[#9db8ff]"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>
              <p className="text-[10.5px] text-faint">
                Empty Bid = inherits the source’s (MIN_ROAS sources carry a ROAS decimal) · targeting & creatives inherit
              </p>
            </div>

            {/* preview — what exactly will be fired */}
            {previewed ? (
              <div className="animate-pop-in rounded-2xl border border-line bg-surface p-4">
                <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                <div className="flex flex-col gap-1.5">
                  {validRows.map((r) => (
                    <p key={r.id} className="text-[12px] text-dim">
                      <span className="text-ink">
                        {r.info?.name
                          ? `${splitLionName(r.info.name, todaySaoPauloDDMM()).prefix}${r.suffix.trim()}`.slice(0, 110)
                          : `#${r.campaignId}`}
                      </span>{" "}
                      → {copiesN} cop{copiesN === 1 ? "y" : "ies"} @ ${moneyLabel(r.budget)}/day
                      {r.bid.trim() ? ` · bid ${r.bid}` : " · bid inherited"}
                    </p>
                  ))}
                  <p className="mt-1 border-t border-line pt-2 text-[12px] text-ink">
                    {totalClones} clone{totalClones === 1 ? "" : "s"} → {account} · page {page} · pixel {pixel}
                  </p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
