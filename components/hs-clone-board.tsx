"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useHs } from "./use-hs";
import { useHsTaskManager } from "./hs-task-manager";
import { decorateAccountOptions, fmtCountdown, useAcctLimits } from "./use-acct-limit";
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

/** Default tail = the source's old tail + " - <owner>" (the buyer duplicating it), matching the
 *  historical LION naming ("… Cars en Alex Nazar"). Editable afterwards; skips the append when
 *  the tail already ends with the owner name so a re-fetch can't double it. */
function withOwner(tail: string, owner: string): string {
  const o = owner.trim();
  if (!o) return tail;
  if (!tail) return o;
  return tail.toLowerCase().endsWith(o.toLowerCase()) ? tail : `${tail} - ${o}`;
}

/** Geo from the NAME's grammar (the `[CODES]` group after the redirect label) — the display
 *  fallback for sources whose targeting/ answers an empty country list (worldwide runs). */
function geoFromName(name: string, summary: (codes: string[]) => string): string {
  const m = /API(?:\s*\(CLONE\))?\s*-\s*\([^)]*\)\s*-\s*\[([^\]]*)\]/.exec(name);
  if (!m) return "";
  const codes = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  if (codes.length === 0) return "";
  if (codes.length === 1 && /^world$/i.test(codes[0])) return "World";
  return summary(codes);
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
  const { setOpen } = useHsTaskManager();

  const [profile, setProfile] = useState("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [pixel, setPixel] = useState("");
  const [copies, setCopies] = useState("1");
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  // Duplicate rail: LION's clone weapon (default) vs OUR FB token building each tree directly on
  // the Graph (owner ask 08-18 — same channel pair as the launcher). Survives refreshes; the
  // token option unlocks only once the server says the rail is provisioned.
  const [dupChannel, setDupChannel] = useState<"lion" | "token">("lion");
  useEffect(() => {
    try {
      const v = localStorage.getItem("adlauncher.hs.dupchannel");
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "token" || v === "lion") setDupChannel(v);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, []);
  const changeDupChannel = (ch: "lion" | "token") => {
    setDupChannel(ch);
    setPreviewed(false);
    try {
      localStorage.setItem("adlauncher.hs.dupchannel", ch);
    } catch {
      /* storage disabled */
    }
  };
  const [draftId, setDraftId] = useState("");
  const counter = useRef(1);
  // One waveId per PREPARED wave (same binds + same shots): a retry-click after a lost answer
  // re-sends the same id, and the server's wave claim makes the re-POST a no-op instead of a
  // second pump (double campaigns). Cleared on confirmed success; regenerated when the wave
  // content changes.
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  const [rows, setRows] = useState<Row[]>(() => {
    const seeded = initialIds
      .filter((id) => /^\d{5,}$/.test(id))
      .slice(0, MAX_SOURCES)
      .map((cid, i) => freshRow(cid, i + 1));
    return seeded;
  });

  const data = profile ? hs.dataFor(profile) : undefined;
  const pixels = profile && account ? hs.pixelsFor(profile, account) : undefined;

  // A one-pixel account needs no picking — the field DERIVES the lone id (no effect write: the
  // react-compiler lint rejects sync setState in effects, and a derived value can't ever lag the
  // list), but only once the page is picked (owner ask 08-13 — the pixel belongs at the fanka
  // step, not right after the account). A real user pick (multi list) still wins via state.
  const onlyPixel = Array.isArray(pixels) && pixels.length === 1 ? pixels[0].id : "";
  const effectivePixel = pixel || (page ? onlyPixel : "");

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
                // Prefill the editable TAIL with the source's old one + the owner's name.
                suffix: r.suffix || withOwner(splitLionName(s.name, todaySaoPauloDDMM()).tail, user?.username ?? ""),
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
  }, [rows, user?.username]);

  const bindsReady = Boolean(profile && account && page && effectivePixel);
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  const validRows = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && parseMoney(r.budget) >= 1);
  const unreadable = rows.filter((r) => r.info?.status === "UNREADABLE").length;
  const totalClones = validRows.length * copiesN;
  // Account launch limit (5 campaigns / 30 min): the wave binds ONE account, so an over-capacity
  // fire is blocked here with the countdown (the server precheck would 429 it anyway).
  const limits = useAcctLimits();
  const acctRemaining = account ? Math.max(0, limits.limit - limits.countFor(account)) : null;
  const acctOver = acctRemaining !== null && totalClones > acctRemaining;
  const acctResetAt = account ? limits.resetAtFor(account) : null;

  // The server pump takes the whole wave in ONE call and paces/polls/activates it after the
  // response (fire-and-forget, owner ask 08-14) — its shot cap must fit the pump's time budget.
  // The token rail builds one full Graph tree per shot (much heavier than a LION submit), so its
  // wave cap is tighter (mirrors the server's MAX_TOKEN_SHOTS).
  const MAX_SHOTS_PER_FIRE = 45;
  const MAX_TOKEN_SHOTS_PER_FIRE = 10;
  const effDupChannel: "lion" | "token" = dupChannel === "token" && hs.tokenLaunch ? "token" : "lion";

  async function duplicateAll() {
    if (!bindsReady || validRows.length === 0 || firing || acctOver || limits.staleBuild) return;
    const cap = effDupChannel === "token" ? MAX_TOKEN_SHOTS_PER_FIRE : MAX_SHOTS_PER_FIRE;
    if (totalClones > cap) {
      alert(
        `That's ${totalClones} clones — the ${effDupChannel === "token" ? "FB Token rail builds" : "server fires"} at most ${cap} per wave. ` +
          "Lower the copies or remove some rows and fire in waves.",
      );
      return;
    }
    setFiring(true);
    // ONE batch POST: the server stamps every row into the shared store, answers immediately and
    // keeps working in the background — jittered single-copy submits, status polling and clone
    // activation all happen server-side, so the tab may be closed right after this resolves.
    const shots = validRows.flatMap((r) => {
      const cid = r.campaignId.trim();
      const geo = r.info?.countries.length
        ? geoSummary(r.info.countries)
        : r.info?.name
          ? geoFromName(r.info.name, geoSummary) || "inherited"
          : "inherited";
      const label = r.info?.name || `#${cid}`;
      return Array.from({ length: copiesN }, (_, copy) => ({
        campaignId: cid,
        budget: r.budget,
        bid: r.bid.trim(),
        // Fallback for the server's bid scaling (its own details/ re-read wins) — the bid
        // rides in HUMAN units and is scaled to LION's Meta-native wire unit server-side.
        ...(r.info?.bidStrategy ? { bidStrategy: r.info.bidStrategy } : {}),
        geo,
        // Full name = fixed grammar prefix + the buyer's tail (replaces the old one).
        // When the source couldn't be read there's no prefix — LION rebuilds the name.
        ...(r.info?.name
          ? { name: `${splitLionName(r.info.name, todaySaoPauloDDMM()).prefix}${r.suffix.trim()}`.trim() }
          : {}),
        label: copiesN > 1 ? `${label} · copy ${copy + 1}/${copiesN}` : label,
      }));
    });
    validRows.forEach((r) => patchRow(r.id, { state: "sending", msg: "queuing on server…" }));
    // The channel is part of the wave's identity — a LION wave retried on the token rail (or
    // vice versa) is a DIFFERENT wave and must not be swallowed by the idempotency claim.
    const sig = JSON.stringify({ channel: effDupChannel, profile, account, page, pixel: effectivePixel, shots });
    if (!waveRef.current || waveRef.current.sig !== sig) {
      waveRef.current = { sig, id: crypto.randomUUID() };
    }
    try {
      const res = await fetch(effDupChannel === "token" ? "/api/hs/token-duplicate" : "/api/hs/duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, account, page, pixel: effectivePixel, shots, waveId: waveRef.current.id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; queued?: number; error?: string };
      if (d?.ok) {
        waveRef.current = null; // accepted — the next wave is a new wave
        // Preflight answers now land on the task rows (shared store), not here — the drawer is
        // the place to watch; the board rows just confirm the hand-off.
        validRows.forEach((r) =>
          patchRow(r.id, { state: "ok", msg: `${copiesN}/${copiesN} queued — safe to close the tab` }),
        );
        setOpen(true); // the drawer mirrors the server's progress from the shared store
      } else {
        const msg = d?.error ?? `HTTP ${res.status}`;
        validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
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
                  options={decorateAccountOptions(data?.accounts ?? [], limits)}
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
                  value={effectivePixel}
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

              {/* duplicate rail: LION's clone weapon vs our FB token building each tree on the
                  Graph — same channel pair (and the same provisioning gate) as the launcher. */}
              <div className="mt-1 flex flex-col gap-1">
                <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                  {(
                    [
                      { key: "lion" as const, label: "LION API", ready: true },
                      { key: "token" as const, label: "FB Token", ready: hs.tokenLaunch },
                    ]
                  ).map((opt) => {
                    const active = dupChannel === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        disabled={!opt.ready}
                        aria-pressed={active}
                        title={opt.ready ? undefined : "FB token not configured on the server (FB_HS_LAUNCH_TOKEN)"}
                        onClick={() => changeDupChannel(opt.key)}
                        className={
                          "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 " +
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                          (active
                            ? "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                            : "text-dim hover:text-ink") +
                          (opt.ready ? "" : " cursor-not-allowed opacity-40")
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-center text-[10px] leading-relaxed text-faint">
                  {effDupChannel === "token"
                    ? `Our FB token rebuilds each tree · starts +30 min · max ${MAX_TOKEN_SHOTS_PER_FIRE}/wave`
                    : "LION's clone weapon builds on the weapon side"}
                </p>
              </div>

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
                  disabled={!bindsReady || validRows.length === 0 || firing || acctOver || limits.staleBuild}
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
              {bindsReady && acctOver ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  Account limit — only {acctRemaining} of {totalClones} clones fit this
                  account&apos;s 30-min window
                  {acctResetAt ? ` · resets in ${fmtCountdown(acctResetAt, limits.skew)}` : ""}.
                  Trim copies/rows or pick another account.
                </p>
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
                        {r.info?.countries.length
                          ? geoSummary(r.info.countries)
                          : r.info?.name
                            ? geoFromName(r.info.name, geoSummary) || "inherited"
                            : "—"}
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
                          // HUMAN units, same as LION's reads prefill them: ROAS decimal for
                          // MIN_ROAS sources (0,34 = 34%), $ for cap sources. The duplicate route
                          // scales to Meta-native wire units by the source's strategy — never
                          // type pre-scaled values here. Empty inherits the source's own bid.
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
                Empty Bid = inherits the source’s · MIN_ROAS sources take a ROAS decimal (0,34 = 34%), cap sources $ · targeting & creatives inherit
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
                    {totalClones} clone{totalClones === 1 ? "" : "s"} → {account} · page {page} · pixel {effectivePixel}
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
