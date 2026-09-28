"use client";

// Owner console: the AV (ActiveView) KEY REGISTRY + the "UTM Campaign Values" upload files.
// AV reports revenue per campaign only for keys registered in AV's UI (av001…, one key per campaign,
// the AIF-brand twin — see lib/av-keys / lib/av-link). This page shows every claimed key (who holds
// it, which campaign, which destination), lets the owner RELEASE a row (the registry row is deleted
// and the key returns to the pool — the FB campaign is NOT touched), and hands the owner the plain
// upload files to feed AV's "Upload file" form. The launchable range is the SERVER env
// AV_KEYS_REGISTERED (=poolMax here); 0 = the stub (nothing launchable until the pool is uploaded).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { AlertIcon, AvFlag, RetryIcon } from "./icons";
import { AV_KEY_POOL_MAX, avKeyCode, avKeysUploadFiles } from "@/lib/av-link";
import type { PartnerId } from "@/lib/partners";

// One registry row as GET /api/av/keys?rows=1 serves it (AvKeyRow minus documentId — the owner
// releases by KEY, never by the internal Strapi id).
type KeyRow = {
  key: string;
  status: "active" | "retired";
  user: string;
  claimed_at: number;
  via?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  ad_count?: number;
  ad_account?: string;
  destination?: string;
  name?: string;
  notes?: string;
  task_id?: string;
  source_campaign_id?: string;
};

type KeysView = {
  used: string[];
  next: string | null;
  /** = registered: the launchable range (av001…avN). 0 = the stub. */
  poolMax: number;
  registered: number;
  /** The codec ceiling (999) — the range the upload files can span. */
  codecMax: number;
  rows: KeyRow[];
};

const btn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ";
const btnGhost = btn + "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink";

const chip = (tone: "ok" | "warn" | "danger" | "dim" | "accent"): string =>
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold " +
  (tone === "ok"
    ? "border-launch/30 bg-launch/10 text-launch2"
    : tone === "warn"
      ? "border-warn/40 bg-warn/10 text-warn"
      : tone === "danger"
        ? "border-danger/40 bg-danger/10 text-danger"
        : tone === "accent"
          ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
          : "border-line bg-surface2 text-dim");

/** A down-arrow-into-tray glyph — a local icon so this page needn't touch the shared icons module. */
function DownloadIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function fmtWhen(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/** Blob download of one { name, content } file — no server round-trip, the keys are computed here. */
function downloadTextFile(name: string, content: string): void {
  try {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* a download blocked by the browser is the owner's environment, not a page fault */
  }
}

export function AvKeysBoard({ user }: { user: SessionUser }) {
  const [view, setView] = useState<KeysView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "retired">("all");
  // Upload-file span: default to the registered range (at least one 200-key file so the owner can
  // register the first batch from a fresh stub).
  const [target, setTarget] = useState<number>(200);
  const [targetTouched, setTargetTouched] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/av/keys?rows=1", { cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as Partial<KeysView> & { ok?: boolean; error?: string };
      if (!r.ok || !d.ok || !Array.isArray(d.used)) throw new Error(d.error || `HTTP ${r.status}`);
      setError(null);
      setView({
        used: d.used,
        next: typeof d.next === "string" ? d.next : null,
        poolMax: Number(d.poolMax) || 0,
        registered: Number(d.registered) || 0,
        codecMax: Number(d.codecMax) || AV_KEY_POOL_MAX,
        rows: Array.isArray(d.rows) ? d.rows : [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load() manages its own loading flag; the lint can't see past its async boundary, and on mount
    // `loading` already starts true so the initial setState bails out — no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Once the registry answers, snap the upload-file span to the registered range (bumped to 200 so
  // even a fresh stub offers the first file). The owner can still override it by hand.
  useEffect(() => {
    if (!view || targetTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTarget(Math.max(view.registered, 200));
  }, [view, targetTouched]);

  const registered = view?.registered ?? 0;
  const codecMax = view?.codecMax ?? AV_KEY_POOL_MAX;
  // Bound/Free count only keys WITHIN the launchable range (av001…av<registered>) — a key claimed
  // above a later-lowered AV_KEYS_REGISTERED must not eat a free slot (mirrors launcher-board's
  // in-range poolFree; out-of-range rows still show in the registry table below). Counting every
  // registry row here made Free undercount and disagree with the launcher (review find 09-28).
  const usedCodes = useMemo(() => new Set(view?.used ?? []), [view]);
  let inRangeBound = 0;
  for (let n = 1; n <= registered; n++) if (usedCodes.has(avKeyCode(n))) inRangeBound++;
  const bound = inRangeBound;
  const free = Math.max(0, registered - bound);
  const cleanTarget = Math.min(Math.max(1, Math.floor(target || 0)), codecMax);
  const files = useMemo(() => avKeysUploadFiles(1, cleanTarget), [cleanTarget]);

  const rows = view?.rows ?? [];
  const activeCount = rows.filter((r) => r.status === "active").length;
  const retiredCount = rows.filter((r) => r.status === "retired").length;
  const shown = rows.filter((r) => (statusFilter === "all" ? true : r.status === statusFilter));

  const release = async (key: string) => {
    setReleasing(key);
    try {
      const r = await fetch(`/api/av/keys?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setConfirmKey(null);
      await load();
    } catch (e) {
      window.alert(`Release failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReleasing(null);
    }
  };

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  return (
    <>
      <Header
        partner="av"
        onPartnerChange={changePartner}
        user={user}
        platform="console"
        consoleLabel={
          <>
            <AvFlag className="h-3.5 w-3.5" /> AV keys · ActiveView
          </>
        }
      />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          {/* ---- left: intro + status + registration flow + upload files ---- */}
          <section className="flex flex-col gap-4 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-112px)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex shrink-0 flex-col gap-1.5">
              <Link href="/" className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]">
                ← Back to launcher
              </Link>
              <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
                <AvFlag className="h-5 w-5" />
                AV keys
              </h1>
              <p className="text-[11.5px] leading-relaxed text-faint">
                The AV revenue pool: <span className="font-mono">av001…av{String(codecMax)}</span>, one key per
                campaign. A key earns reportable revenue in ActiveView only once it is registered under{" "}
                <em>UTM Campaign Values</em>. The launchable range is the server env{" "}
                <span className="font-mono">AV_KEYS_REGISTERED</span> — until it is set, launches and clones refuse{" "}
                <span className="font-mono">av_keys_not_registered</span>.
              </p>
            </div>

            {/* status strip */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-line bg-surface px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Registered</p>
                <p className="font-mono text-[15px] tabular-nums text-ink">
                  {registered}
                  <span className="text-[11px] text-faint"> / {codecMax}</span>
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Bound</p>
                <p className="font-mono text-[15px] tabular-nums text-ink">{bound}</p>
              </div>
              <div className="rounded-xl border border-line bg-surface px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Free</p>
                <p className="font-mono text-[15px] tabular-nums text-launch2">{free}</p>
              </div>
            </div>

            {view && registered === 0 ? (
              <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {/* One text node for the flex row — bare text + an inline <span> would each become a flex item (columns). */}
                <p className="min-w-0">
                  No AV keys are registered in ActiveView yet — the rail is a stub. Upload the pool below, then set{" "}
                  <span className="font-mono">AV_KEYS_REGISTERED</span> to the highest registered number and restart the server (on Vercel: redeploy).
                </p>
              </div>
            ) : view ? (
              <div className="flex flex-wrap gap-1.5">
                <span className={chip("accent")}>{activeCount} active</span>
                {retiredCount ? <span className={chip("warn")}>{retiredCount} retired</span> : null}
                {view.next ? (
                  <span className={chip("dim")}>
                    next <span className="font-mono">{view.next}</span>
                  </span>
                ) : (
                  <span className={chip("danger")}>pool exhausted</span>
                )}
              </div>
            ) : null}

            {/* registration flow */}
            <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface/60 p-3.5">
              <p className="text-[13px] font-semibold text-ink">How to register the pool</p>
              <ol className="flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-dim">
                <li>
                  <span className="mr-1.5 font-mono text-faint">1.</span> ActiveView → <em>UTM Campaign Values</em> →{" "}
                  <span className="text-ink">+ UTM Campaign value</span>.
                </li>
                <li>
                  <span className="mr-1.5 font-mono text-faint">2.</span> Website{" "}
                  <span className="font-mono">thecadrion.com</span>, Method <span className="text-ink">Upload file</span>.
                </li>
                <li>
                  <span className="mr-1.5 font-mono text-faint">3.</span> Upload one file below (≤200 keys, ≤50 KB per
                  file — TXT/CSV/XLSX accepted).
                </li>
                <li>
                  <span className="mr-1.5 font-mono text-faint">4.</span> Set the server env{" "}
                  <span className="font-mono">AV_KEYS_REGISTERED</span> to the highest registered number and restart the server (on Vercel: redeploy).
                </li>
              </ol>
            </div>

            {/* upload files */}
            <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface/60 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold text-ink">Upload files</p>
                <label className="flex items-center gap-1.5 text-[10.5px] text-faint">
                  up to
                  <input
                    type="number"
                    min={1}
                    max={codecMax}
                    value={target}
                    onChange={(e) => {
                      setTargetTouched(true);
                      setTarget(Number(e.target.value));
                    }}
                    className="h-7 w-[74px] rounded-lg border border-line bg-surface2 px-2 text-right font-mono text-[12px] text-ink outline-none focus:border-accent/60"
                  />
                </label>
              </div>
              <p className="text-[10.5px] leading-relaxed text-faint">
                One key per line, <span className="font-mono">av001</span> up to{" "}
                <span className="font-mono">{`av${String(cleanTarget).padStart(3, "0")}`}</span> — split into{" "}
                {files.length} file{files.length === 1 ? "" : "s"} of ≤200 keys (AV&apos;s per-upload cap).
              </p>
              <div className="flex flex-col gap-1.5">
                {files.map((f) => {
                  const n = f.content.trim() ? f.content.trim().split("\n").length : 0;
                  return (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => downloadTextFile(f.name, f.content)}
                      className={btnGhost + " h-9 justify-between"}
                    >
                      <span className="flex items-center gap-1.5">
                        <DownloadIcon className="h-3.5 w-3.5" />
                        <span className="font-mono text-[11px]">{f.name}</span>
                      </span>
                      <span className="text-[10.5px] text-faint">{n} keys</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* ---- right: the registry table ---- */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", "active", "retired"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setStatusFilter(f)}
                    aria-pressed={statusFilter === f}
                    className={
                      "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors " +
                      (statusFilter === f ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim hover:text-ink")
                    }
                  >
                    {f[0].toUpperCase() + f.slice(1)}
                    <span className="ml-1 font-mono text-[10px] opacity-70">
                      {f === "all" ? rows.length : f === "active" ? activeCount : retiredCount}
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => void load()} disabled={loading} className={btnGhost + " ml-auto"}>
                <RetryIcon className="h-3.5 w-3.5" />
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {error ? (
              <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-red-300">
                <AlertIcon className="h-4 w-4 shrink-0" />
                Could not load the registry: {error}
                <button type="button" onClick={() => void load()} className={btnGhost + " ml-auto"}>
                  <RetryIcon className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
              <table className="w-full text-[12px]">
                <thead className="bg-surface2/50 text-[10px] uppercase tracking-[0.12em] text-faint">
                  <tr>
                    {["Key", "Status", "Buyer", "Via", "Campaign", "Destination", "Claimed", "Notes", ""].map((h, i) => (
                      <th key={h || "release"} className={"whitespace-nowrap px-3 py-2 text-left font-semibold " + (i === 8 ? "text-right" : "")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.key} className="border-t border-line/60 hover:bg-raise/40">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[#9db8ff]">{r.key}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            "rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase " +
                            (r.status === "active" ? "bg-launch/15 text-launch2" : "bg-warn/15 text-warn")
                          }
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-dim">{r.user || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-faint">{r.via || "—"}</td>
                      <td className="max-w-[220px] px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-ink" title={r.name || ""}>
                            {r.name || "—"}
                          </p>
                          <p className="truncate font-mono text-[10px] text-faint">
                            {r.campaign_id ? `cmp ${r.campaign_id}` : "no campaign id"}
                            {r.ad_count ? ` · ${r.ad_count} ad${r.ad_count === 1 ? "" : "s"}` : ""}
                            {r.ad_account ? ` · acct ${r.ad_account}` : ""}
                          </p>
                        </div>
                      </td>
                      <td className="max-w-[260px] px-3 py-2">
                        {r.destination ? (
                          <a
                            href={r.destination}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={r.destination}
                            className="block truncate font-mono text-[10.5px] text-dim hover:text-[#9db8ff]"
                          >
                            {r.destination.replace(/^https?:\/\//, "")}
                          </a>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[10.5px] text-faint">{fmtWhen(r.claimed_at)}</td>
                      <td className="max-w-[180px] px-3 py-2">
                        <p className="truncate text-[10.5px] italic text-faint" title={r.notes || ""}>
                          {r.notes || "—"}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {confirmKey === r.key ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void release(r.key)}
                              disabled={releasing === r.key}
                              className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[10.5px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
                            >
                              {releasing === r.key ? "Releasing…" : "Confirm"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmKey(null)}
                              disabled={releasing === r.key}
                              className="rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-dim transition-colors hover:text-ink disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmKey(r.key)}
                            className="rounded-md border border-danger/30 px-2 py-1 text-[10.5px] font-medium text-danger transition-colors hover:bg-danger/10"
                          >
                            Release
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-10 text-center text-[12px] text-faint">
                        {loading ? "Loading the registry…" : error ? "Registry unavailable." : "No keys claimed yet."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <p className="text-[10.5px] leading-relaxed text-faint">
              Release deletes the registry row and returns the key to the pool — the FB campaign is NOT touched, so
              pause/delete it in Ads Manager if it still runs. A <span className="text-warn">retired</span> key owns a
              campaign that a launch created before failing; releasing it frees the key while the (paused) campaign
              stays on FB. Every claim is atomic over Strapi (the key is unique), so two launches never take the same
              one.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
