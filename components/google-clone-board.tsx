"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./header";
import { GoogleNav } from "./google-nav";
import { AutoTextarea, Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useGoogleCustomers, type GwCustomer, type GoogleSourceInfo } from "./use-google";
import { GoogleSuspendedNote } from "./google-suspended-note";
import { useGoogleTaskManager } from "./google-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { limitMoney, limitMoneyCents, moneyCentsLabel, moneyLabel, parseMoney } from "@/lib/types";
import {
  GOOGLE_DEFAULT_BUDGET,
  GOOGLE_BID_STRATEGIES,
  GOOGLE_BUDGET_MAX,
  GOOGLE_CPA_MAX,
  GOOGLE_ROAS_MAX,
  googleBidKind,
  googleBidPlan,
  googleNamePreview,
  googleNameSuffix,
  moneyText,
  todaySaoPauloDotDDMM,
  type GoogleBidKind,
  type GoogleMode,
} from "@/lib/google-bid";
import { splitGoogleName } from "@/lib/google-source";
import { CheckIcon, CopyIcon, EyeIcon, LockIcon, MinusIcon, PlusIcon, RetryIcon, TrashIcon, XIcon } from "./icons";
import type { RichOption } from "@/lib/catalog";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

const MAX_COPIES = 20;
const MAX_SOURCES = 30;
/** How long a source may sit "fetching" in the board poller before we call the snapshot stuck
 *  (the server pump has a far longer budget — this is only the board's status view). */
const DATASET_POLL_TIMEOUT_MS = 4 * 60_000;
const DATASET_POLL_MS = 10_000;

/** Currency symbol by ISO code — the team's Google book is BRL/USD/EUR; anything else shows the
 *  bare code (an honest fallback beats a wrong glyph). */
const CUR_SYMBOL: Record<string, string> = { BRL: "R$", USD: "$", EUR: "€" };
const curSymbol = (code: string): string => CUR_SYMBOL[code] || code || "$";

/** One source-campaign row: the LION-read facts + the editable clone overrides. */
type Row = {
  id: string;
  campaignId: string;
  /** LION facts + the dataset snapshot state — null while the /sources read is in flight. */
  info: GoogleSourceInfo | null;
  loading: boolean;
  /** The /sources read failed (network/HTTP) — a manual "Retry read" re-arms it. */
  failed?: boolean;
  /** Picked bidding strategy ("" = inherit the source's; CLONE only — JURO keeps the source's). */
  bidStrategy: string;
  /** Editable bid, HUMAN ("" = inherit). CPA = cash-register money, ROAS = whole percent. */
  bid: string;
  /** Editable daily budget — cash-register "30,00" (limitMoneyCents), scaled to the wire server-side. */
  budget: string;
  /** The budget / bid still hold a MACHINE-derived value (seed or the source's own, currency-matched):
   *  they re-derive whenever the row's target currency changes (wave account, row override, mode).
   *  The first manual keystroke pins the field (false) — a buyer's number is never overwritten. */
  autoBudget: boolean;
  autoBid: boolean;
  /** Buyer's free tail — the team-pattern suffix is built around it (server + preview). */
  suffix: string;
  /** Row's OWN target account ("" = the wave default in Settings; CLONE only). */
  customer: string;
  /** Row's OWN conversion pixel ("" = the wave/auto pixel). */
  pixel: string;
  /** Row's OWN number of copies ("" = the wave default). */
  copies: string;
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

/**
 * Machine prefill of a row's budget/bid from its LION facts for the currency it will be billed in:
 * budget = the source's own (the team clones at the source's R$30) when the currencies match, else
 * the console default; bid = the source's bid (CLONE only — JURO inherits on the wire) when the
 * currencies match, NEVER across currencies (R$3,95 must not ride as $3.95). Only auto* fields move.
 */
function derivePrefill(r: Row, targetCurrency: string, mode: GoogleMode): Partial<Row> {
  const s = r.info;
  if (!s) return {};
  const match = Boolean(s.currency) && Boolean(targetCurrency) && s.currency === targetCurrency;
  const patch: Partial<Row> = {};
  if (r.autoBudget) patch.budget = match && s.budget != null ? moneyCentsLabel(s.budget) : moneyCentsLabel(GOOGLE_DEFAULT_BUDGET);
  if (r.autoBid) patch.bid = mode === "clone" && match && s.bid != null ? s.bid.toFixed(2).replace(".", ",") : "";
  return patch;
}

/** Server-side wave cap (lib/google-wave GOOGLE_MAX_SHOTS) mirrored here so an oversized wave is
 *  refused BEFORE Fire instead of every row flipping to error on the route's 400. (Not imported:
 *  that module pulls next/server into a client bundle.) */
const MAX_SHOTS = 45;

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

const cellSelect =
  "h-8 w-full cursor-pointer appearance-none rounded-md border border-line bg-surface2 px-2 pr-6 text-[11.5px] text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const idOk = (r: Row): boolean => /^\d{5,}$/.test(r.campaignId.trim());

const freshRow = (campaignId: string, n: number): Row => ({
  id: `gr${Date.now()}-${n}`,
  campaignId,
  info: null,
  loading: false,
  failed: false,
  bidStrategy: "",
  bid: "",
  // Cash-register seed ("10,00"); a source's own budget replaces it once LION answers (when the
  // currencies match). A bare "10" would re-read as 0,10 on the first keystroke.
  budget: moneyCentsLabel(GOOGLE_DEFAULT_BUDGET),
  autoBudget: true,
  autoBid: true,
  suffix: "",
  customer: "",
  pixel: "",
  copies: "",
  state: "idle",
});

/**
 * Google Ads clone / JURO board — the structure of the HS duplicator (a sticky Settings column
 * with the wave defaults + Preview→Fire, and a table of source rows with their real facts next to
 * the editable overrides), minus every FB-specific concept: no profiles, no fanpages, no token
 * rails, no account-limit widget, no geo/language override, no cross-currency bid guard beyond the
 * currency-match prefill, no Graph rename. Facts come from LION's Google metrics; the launch rides
 * the partner's google-weapon API through one server pump (fire-and-forget — the tab is safe to
 * close once the wave is accepted, the drawer mirrors the server's progress).
 */
export function GoogleCloneBoard({
  user,
  initialIds = [],
  initialMode,
}: {
  user?: SessionUser;
  /** Source campaign ids handed over in the link (?ids=…) — one prefilled row each. */
  initialIds?: string[];
  /** Board mode forced by the link (?mode=juro) — wins over the localStorage pick. */
  initialMode?: "clone" | "juro";
}) {
  const { customers, suspended, error: custError, retry: retryCustomers } = useGoogleCustomers();
  const { setOpen, counts, refresh } = useGoogleTaskManager();

  const [mode, setMode] = useState<GoogleMode>(initialMode ?? "clone");
  const [customer, setCustomer] = useState(""); // wave target account (CLONE)
  const [pixel, setPixel] = useState(""); // wave pixel
  const [copies, setCopies] = useState("1");
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const counterRef = useRef(1);
  const fireGate = useRef(makeGate());
  // One waveId per PREPARED wave (same mode + binds + shots): a retry-click after a lost answer
  // re-sends the same id, and the server's wave claim makes the re-POST a no-op instead of a
  // second pump. Cleared on confirmed success; regenerated when the wave content changes.
  const waveRef = useRef<{ sig: string; id: string } | null>(null);

  const [rows, setRows] = useState<Row[]>(() =>
    initialIds
      .filter((id) => /^\d{5,}$/.test(id))
      .slice(0, MAX_SOURCES)
      .map((cid, i) => freshRow(cid, i + 1)),
  );

  const customerById = useMemo(() => new Map((customers ?? []).map((c) => [c.customerId, c])), [customers]);

  // ---- mode (localStorage; ?mode= wins) ------------------------------------------------------
  useEffect(() => {
    try {
      const m = localStorage.getItem("adlauncher.google.mode");
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR); a
      // link-forced mode wins, so the remembered pick must not override it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!initialMode && (m === "clone" || m === "juro")) setMode(m);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, [initialMode]);

  const changeMode = (m: GoogleMode) => {
    setMode(m);
    setPreviewed(false);
    setFireNote(null);
    // The billing currency changes with the mode (CLONE = target account, JURO = the source's own):
    // machine-derived budgets/bids follow it; a buyer's own numbers stay.
    setRows((rs) =>
      rs.map((r) => {
        const cur = m === "clone" ? (customerById.get(r.customer || customer)?.currency ?? "") : (r.info?.currency ?? "");
        return { ...r, ...derivePrefill(r, cur, m) };
      }),
    );
    try {
      localStorage.setItem("adlauncher.google.mode", m);
    } catch {
      /* storage disabled */
    }
  };

  const patchRow = (id: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const addSources = () => {
    const ids = [...new Set(draftId.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)))];
    if (ids.length === 0) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.campaignId));
      const fresh = ids.filter((id) => !have.has(id)).map((id) => freshRow(id, ++counterRef.current));
      return [...rs, ...fresh].slice(0, MAX_SOURCES);
    });
    setDraftId("");
    setPreviewed(false);
  };

  const removeRow = (id: string) => {
    setRows((rs) => {
      const gone = rs.find((r) => r.id === id);
      const next = rs.filter((r) => r.id !== id);
      // Free the read claim + poll clock when no other row carries this id — a re-added id must be
      // read (and its dataset re-polled) again.
      const cid = gone?.campaignId.trim();
      if (cid && !next.some((r) => r.campaignId.trim() === cid)) {
        fetchedRef.current.delete(cid);
        fetchStartRef.current.delete(cid);
      }
      return next;
    });
    setPreviewed(false);
  };

  const clearAll = () => {
    fetchedRef.current.clear();
    fetchStartRef.current.clear();
    setRows([]);
    setPreviewed(false);
    setFireNote(null);
  };

  const retrySource = (r: Row) => {
    fetchedRef.current.delete(r.campaignId.trim());
    patchRow(r.id, { failed: false });
  };

  // ---- source facts from LION (POST /api/google/sources), batched + debounced ----------------
  const fetchedRef = useRef(new Set<string>());
  // id → first-seen-fetching timestamp (the board's own dataset poll deadline).
  const fetchStartRef = useRef(new Map<string, number>());
  useEffect(() => {
    const want = rows.filter((r) => idOk(r) && !r.info && !r.loading);
    const ids = [...new Set(want.map((r) => r.campaignId.trim()))].filter((id) => !fetchedRef.current.has(id));
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      ids.forEach((id) => fetchedRef.current.add(id));
      setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: true } : r)));
      void (async () => {
        try {
          const res = await fetch("/api/google/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const d = (await res.json().catch(() => ({}))) as { ok?: boolean; sources?: GoogleSourceInfo[] };
          if (!res.ok || !d?.ok) throw new Error(`HTTP ${res.status}`);
          const byId = new Map((d.sources ?? []).map((s) => [s.campaignId, s]));
          // Currency of the wave target NOW — the source bid/budget are prefilled ONLY when they
          // match (never across currencies: R$3,95 would ride as $3.95, audit-grade wrong).
          const waveCur = mode === "clone" ? ((customers ?? []).find((c) => c.customerId === customer)?.currency ?? "") : "";
          setRows((rs) =>
            rs.map((r) => {
              const s = byId.get(r.campaignId.trim());
              // Answered without this id → the same manual-Retry path as a failed call (no auto-loop).
              if (!s) return ids.includes(r.campaignId.trim()) ? { ...r, loading: false, failed: true } : r;
              if (s.dataset.state === "fetching" && !fetchStartRef.current.has(s.campaignId)) {
                fetchStartRef.current.set(s.campaignId, Date.now());
              }
              // JURO lands on the source's own account, so its currency always matches; CLONE
              // matches the row's own account over the wave target's. Only auto* fields move.
              const rowCur =
                mode === "clone" ? ((customers ?? []).find((c) => c.customerId === (r.customer || customer))?.currency ?? waveCur) : s.currency;
              const next = { ...r, loading: false, failed: false, info: s };
              return { ...next, ...derivePrefill(next, rowCur, mode) };
            }),
          );
        } catch {
          // Failed ids KEEP their claim (deleting it here would re-arm the effect on the very
          // setState it causes → an endless fetch loop against a dead LION). The row shows "read
          // failed" + a Retry button instead.
          setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: false, failed: true } : r)));
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [rows, customer, customers, mode]);

  // ---- dataset poll for "fetching" rows (POST /api/google/dataset) ---------------------------
  const setDataset = (id: string, ds: GoogleSourceInfo["dataset"]) =>
    setRows((rs) => rs.map((r) => (r.campaignId.trim() === id && r.info ? { ...r, info: { ...r.info, dataset: ds } } : r)));

  // Keyed on the SET of fetching ids so the interval only resets when that set actually changes
  // (typing a budget must not restart the poll clock).
  const fetchingKey = [...new Set(rows.filter((r) => r.info?.dataset.state === "fetching").map((r) => r.campaignId.trim()))]
    .sort()
    .join(",");
  useEffect(() => {
    if (!fetchingKey) return;
    const ids = fetchingKey.split(",");
    const now = Date.now();
    for (const id of ids) if (!fetchStartRef.current.has(id)) fetchStartRef.current.set(id, now);

    const poll = async () => {
      const t = Date.now();
      const timedOut = ids.filter((id) => t - (fetchStartRef.current.get(id) ?? t) > DATASET_POLL_TIMEOUT_MS);
      if (timedOut.length) {
        setRows((rs) =>
          rs.map((r) =>
            timedOut.includes(r.campaignId.trim()) && r.info?.dataset.state === "fetching"
              ? { ...r, info: { ...r.info, dataset: { state: "error", fetchedAt: null, error: "dataset not ready — re-fetch" } } }
              : r,
          ),
        );
        timedOut.forEach((id) => fetchStartRef.current.delete(id));
      }
      const live = ids.filter((id) => !timedOut.includes(id));
      if (live.length === 0) return;
      try {
        const res = await fetch("/api/google/dataset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: live }),
        });
        const d = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          datasets?: Record<string, { state: GoogleSourceInfo["dataset"]["state"]; fetchedAt: string | null; error?: string }>;
        };
        if (!res.ok || !d?.ok || !d.datasets) return;
        for (const id of live) {
          const u = d.datasets[id];
          if (!u) continue;
          if (u.state !== "fetching") fetchStartRef.current.delete(id);
          setDataset(id, { state: u.state, fetchedAt: u.fetchedAt ?? null, ...(u.error ? { error: u.error } : {}) });
        }
      } catch {
        /* transient — next tick retries */
      }
    };
    const iv = setInterval(() => void poll(), DATASET_POLL_MS);
    return () => clearInterval(iv);
  }, [fetchingKey]);

  /** Per-row "Re-fetch" — the source changed since the snapshot: force a fresh dataset/fetch. */
  const refetchSource = async (r: Row) => {
    const id = r.campaignId.trim();
    if (!r.info) return;
    fetchStartRef.current.set(id, Date.now());
    setDataset(id, { state: "fetching", fetchedAt: null });
    try {
      const res = await fetch("/api/google/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id], force: true }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        datasets?: Record<string, { state: GoogleSourceInfo["dataset"]["state"]; fetchedAt: string | null; error?: string }>;
      };
      const u = d?.datasets?.[id];
      if (res.ok && d?.ok && u) {
        if (u.state !== "fetching") fetchStartRef.current.delete(id);
        setDataset(id, { state: u.state, fetchedAt: u.fetchedAt ?? null, ...(u.error ? { error: u.error } : {}) });
      }
    } catch {
      setDataset(id, { state: "error", fetchedAt: null, error: "re-fetch failed — try again" });
    }
  };

  // ---- derived: copies, pixels, currencies ---------------------------------------------------
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  const rowCopies = (r: Row): number => {
    const n = Number(r.copies);
    return r.copies !== "" && Number.isFinite(n) && n >= 1 ? Math.min(MAX_COPIES, Math.round(n)) : copiesN;
  };

  const waveTarget: GwCustomer | null = mode === "clone" && customer ? customerById.get(customer) ?? null : null;
  const wavePixelAuto = waveTarget && waveTarget.pixels.length === 1 ? waveTarget.pixels[0] : "";
  const effWavePixel = pixel || wavePixelAuto;

  /** The account a row ships to: CLONE = its own pick over the wave default; JURO = the source's own. */
  const rowTarget = (r: Row): GwCustomer | null => {
    const id = mode === "clone" ? r.customer || customer : r.info?.accountId ?? "";
    return id ? customerById.get(id) ?? null : null;
  };
  /** Currency the row is billed in ("" until known). */
  const rowCurrency = (r: Row): string => {
    const t = rowTarget(r);
    return mode === "clone" ? t?.currency ?? "" : t?.currency || r.info?.currency || "";
  };
  /** The row's effective pixel (its own pick, the wave pixel when it rides the wave target, or the
   *  lone pixel of its account). */
  const rowEffPixel = (r: Row): string => {
    if (r.pixel) return r.pixel;
    const t = rowTarget(r);
    if (t && t.pixels.length === 1) return t.pixels[0];
    if (mode === "clone" && !r.customer) return effWavePixel;
    return "";
  };
  /** A row still owes a pixel pick: its account has several and none is chosen. */
  const rowPixelNeeded = (r: Row): boolean => {
    const t = rowTarget(r);
    return Boolean(t && t.pixels.length > 1 && !rowEffPixel(r));
  };

  const rowBidKind = (r: Row): GoogleBidKind | "unknown" =>
    mode === "clone" ? (r.bidStrategy ? googleBidKind(r.bidStrategy) : "unknown") : "unknown";
  const rowBidPlan = (r: Row) => googleBidPlan({ mode, override: mode === "clone" ? r.bidStrategy : "", typedBid: r.bid });

  // ---- fireable set + gates ------------------------------------------------------------------
  const customersLoading = customers === null && !custError;
  const customersFailed = Boolean(custError);
  const datasetBad = (r: Row): boolean => r.info?.dataset.state === "missing" || r.info?.dataset.state === "error";
  const candidateRows = rows.filter((r) => idOk(r) && parseMoney(r.budget) >= 1);
  const validRows = candidateRows.filter((r) => !datasetBad(r));
  const blockedDatasetRows = candidateRows.filter(datasetBad);
  const lowBudgetCount = rows.filter((r) => idOk(r) && parseMoney(r.budget) < 1).length;

  const needTarget = mode === "clone" && validRows.some((r) => !(r.customer || customer));
  const pixelNeededRows = validRows.filter(rowPixelNeeded);
  const bidRefusalRows = validRows.filter((r) => "refusal" in rowBidPlan(r));
  const totalCopies = validRows.reduce((sum, r) => sum + rowCopies(r), 0);

  const overShotCap = totalCopies > MAX_SHOTS;
  const fireBlocked =
    firing ||
    validRows.length === 0 ||
    customersLoading ||
    customersFailed ||
    needTarget ||
    pixelNeededRows.length > 0 ||
    blockedDatasetRows.length > 0 ||
    bidRefusalRows.length > 0 ||
    overShotCap;

  // Wave totals per currency (rows may bill in different currencies).
  const totalsByCur = new Map<string, number>();
  for (const r of validRows) {
    const cur = rowCurrency(r) || "?";
    totalsByCur.set(cur, (totalsByCur.get(cur) ?? 0) + parseMoney(r.budget) * rowCopies(r));
  }

  // ---- Settings picker options ---------------------------------------------------------------
  const customerOptions: RichOption[] = (customers ?? []).map((c) => ({
    value: c.customerId,
    label: c.name,
    subLabel: c.customerId,
    meta: c.currency,
    tag: `${c.pixels.length} px`,
    tagTone: c.pixels.length === 0 ? "warn" : "dim",
  }));
  const pixelOptionsFor = (t: GwCustomer | null): RichOption[] => (t?.pixels ?? []).map((p) => ({ value: p, label: p }));

  // ---- fire ----------------------------------------------------------------------------------
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const shots = validRows.flatMap((r) => {
      const cid = r.campaignId.trim();
      const n = rowCopies(r);
      const cur = rowCurrency(r);
      const shot = {
        campaignId: cid,
        budget: r.budget,
        bid: r.bid.trim(),
        bidStrategy: mode === "clone" ? r.bidStrategy : "",
        suffix: r.suffix.trim(),
        ...(r.customer ? { customer: r.customer } : {}),
        ...(r.pixel ? { pixel: r.pixel } : {}),
        ...(r.info?.name ? { sourceName: r.info.name } : {}),
        ...(r.info?.geo ? { geo: r.info.geo } : {}),
        ...(r.info?.accountId ? { sourceAccount: r.info.accountId } : {}),
        ...(cur ? { currency: cur } : {}),
      };
      return Array.from({ length: n }, () => ({ ...shot }));
    });
    const waveCustomer = mode === "clone" ? customer : "";
    const sig = JSON.stringify({ mode, customer: waveCustomer, pixel: effWavePixel, shots });
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    validRows.forEach((r) => patchRow(r.id, { state: "sending", msg: "queuing on server…" }));
    try {
      const endpoint = mode === "clone" ? "/api/google/clone" : "/api/google/juro";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waveId: waveRef.current.id,
          ...(waveCustomer ? { customer: waveCustomer } : {}),
          ...(effWavePixel ? { pixel: effWavePixel } : {}),
          shots,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; queued?: number; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null; // accepted — the next wave is a new wave
        setPreviewed(false);
        validRows.forEach((r) =>
          patchRow(r.id, { state: "ok", msg: `${rowCopies(r)}/${rowCopies(r)} queued — safe to close the tab (LION builds them server-side)` }),
        );
        refresh(); // pull the pump-stamped rows now instead of waiting for the next poll tick
        setOpen(true); // the drawer mirrors the server's progress from the shared store
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  // Leaving the Google platform entirely → a full navigation back to the Facebook board on the
  // picked partner (a different server component tree, not a client route within Google).
  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const modeLabel = mode === "clone" ? "Cloner" : "JURO";

  return (
    <>
      <Header partner="br" onPartnerChange={changePartner} user={user} platform="google" />
      <GoogleNav active="clone" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (wave defaults + Preview→Fire) — sticky AND internally scrollable ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Settings</span>
                <span className="text-[10.5px] leading-snug text-faint">
                  Wave defaults — every row rides these unless it sets its own account / pixel in the table.
                </span>
              </div>

              {/* mode: Cloner vs JURO */}
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {(
                  [
                    { key: "clone" as const, label: "Cloner" },
                    { key: "juro" as const, label: "JURO" },
                  ]
                ).map((opt) => {
                  const active = mode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => changeMode(opt.key)}
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
              <p className="text-center text-[10px] leading-relaxed text-faint">
                {mode === "clone"
                  ? "Duplicates the source Demand Gen campaign into the target account (born ENABLED)"
                  : "JURO copy on the source's OWN account — same offer, kept on its rail (born ENABLED)"}
              </p>

              {/* target account */}
              {mode === "clone" ? (
                <Field
                  label="Target account"
                  hint={
                    waveTarget
                      ? `${waveTarget.currency || "?"} · ${waveTarget.pixels.length} pixel${waveTarget.pixels.length === 1 ? "" : "s"}`
                      : "Where every clone lands — a row can override it"
                  }
                >
                  <SearchSelect
                    value={customer}
                    onChange={(v) => {
                      setCustomer(v);
                      setPixel("");
                      setPreviewed(false);
                      // Rows riding the wave default re-derive their machine budget/bid for the new currency.
                      const cur = customerById.get(v)?.currency ?? "";
                      setRows((rs) => rs.map((r) => (r.customer ? r : { ...r, ...derivePrefill(r, cur, "clone") })));
                    }}
                    options={customerOptions}
                    placeholder="Search account"
                    metaWhenClosed
                    emptyHint={customersLoading ? "Loading accounts…" : customersFailed ? "Couldn't load accounts" : "No accounts"}
                  />
                </Field>
              ) : (
                <Field label="Target account">
                  <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
                    <LockIcon className="h-3 w-3 shrink-0" />
                    Source&apos;s own account — JURO never moves accounts
                  </div>
                </Field>
              )}

              {/* pixel (wave) — CLONE only (JURO's pixel is per-row, on the source account) */}
              {mode === "clone" ? (
                <Field
                  label="Pixel"
                  hint={
                    !waveTarget
                      ? "Pick a target account first"
                      : waveTarget.pixels.length === 0
                        ? "no conversion pixel on this account — LION decides"
                        : waveTarget.pixels.length === 1
                          ? "one pixel — auto-picked"
                          : effWavePixel
                            ? undefined
                            : "several pixels — pick one"
                  }
                  error={waveTarget && waveTarget.pixels.length > 1 && !effWavePixel ? "This account has several conversion pixels — pick one." : undefined}
                >
                  <SearchSelect
                    value={effWavePixel}
                    onChange={(v) => {
                      setPixel(v);
                      setPreviewed(false);
                    }}
                    options={pixelOptionsFor(waveTarget)}
                    placeholder="Search pixel"
                    warn={Boolean(waveTarget && waveTarget.pixels.length > 1 && !effWavePixel)}
                    emptyHint={!waveTarget ? "Pick a target account first" : "No pixels on this account"}
                  />
                </Field>
              ) : null}

              {/* copies */}
              <Field label="Number of copies" hint={`default per source campaign · max ${MAX_COPIES} · a row can set its own`}>
                <input
                  value={copies}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setCopies(raw !== "" && Number(raw) > MAX_COPIES ? String(MAX_COPIES) : raw);
                    setPreviewed(false);
                  }}
                  onBlur={() => {
                    if (copies === "" || Number(copies) < 1) setCopies("1");
                  }}
                  inputMode="numeric"
                  aria-label="Number of copies"
                  className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] font-mono tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
              </Field>

              {/* wave summary */}
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Rows</span>
                  <span className="font-mono tabular-nums">{validRows.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-faint">Shots</span>
                  <span className="font-mono tabular-nums">{totalCopies}</span>
                </div>
                {[...totalsByCur.entries()].map(([cur, total]) => (
                  <div key={cur} className="flex items-center justify-between">
                    <span className="text-faint">Total/day{totalsByCur.size > 1 ? ` (${cur})` : ""}</span>
                    <span className="font-mono tabular-nums">
                      {curSymbol(cur === "?" ? "" : cur)}
                      {moneyLabel(total)}
                    </span>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  setPreviewed(true);
                  setFireNote(null);
                }}
                disabled={validRows.length === 0}
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
                  onClick={() => void fireWave()}
                  disabled={fireBlocked}
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
                  {firing ? "Submitting…" : `${mode === "clone" ? "Duplicate" : "JURO"} ${totalCopies}`}
                </button>
              ) : null}

              {fireNote ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">
                  {fireNote}
                </div>
              ) : null}

              {/* gates */}
              {customersFailed ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the Google accounts — {custError}.</span>
                  <button
                    type="button"
                    onClick={retryCustomers}
                    className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              <GoogleSuspendedNote suspended={suspended} />
              {needTarget ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  Pick a target account (or set one per row) — every clone needs somewhere to land.
                </p>
              ) : null}
              {pixelNeededRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {pixelNeededRows.length} row{pixelNeededRows.length === 1 ? " needs" : "s need"} a conversion pixel — that account has several,
                  pick one (in Settings or on the row).
                </p>
              ) : null}
              {blockedDatasetRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {blockedDatasetRows.length} source{blockedDatasetRows.length === 1 ? " isn't" : "s aren't"} in the launch dataset — LION never
                  saw {blockedDatasetRows.length === 1 ? "it" : "them"}, or the fetch errored. Remove {blockedDatasetRows.length === 1 ? "that row" : "those rows"} or Re-fetch.
                </p>
              ) : null}
              {overShotCap ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {totalCopies} shots — one wave carries at most {MAX_SHOTS}. Lower the copies or split the sources into two waves.
                </p>
              ) : null}
              {bidRefusalRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {bidRefusalRows.length} row{bidRefusalRows.length === 1 ? " has" : "s have"} a bid that doesn&apos;t fit its strategy — see the
                  note under the bid field.
                </p>
              ) : null}
              <p className="text-center text-[10.5px] leading-relaxed text-faint">
                {validRows.length === 0
                  ? "Add source campaigns below"
                  : previewed
                    ? "Fires ONE wave to LION · the tab is safe to close (server builds them)"
                    : "Preview first, then fire"}
              </p>
              {counts.active > 0 ? (
                <p className="text-center text-[10.5px] leading-relaxed text-faint">
                  {counts.active} Google build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.
                </p>
              ) : null}
            </div>
          </aside>

          {/* ---- Selected campaigns ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Selected campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{validRows.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">{modeLabel}</span>
              {blockedDatasetRows.length > 0 ? (
                <span className="rounded-md border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger">
                  {blockedDatasetRows.length} not in the dataset — excluded
                </span>
              ) : null}
              {lowBudgetCount > 0 ? (
                <span className="rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn">
                  {lowBudgetCount} below 1/day — won&apos;t fire (amber Budget field)
                </span>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <div className="animate-pop-in flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-surface p-6 text-[12px] leading-relaxed text-dim">
                <p className="text-[13px] font-semibold text-ink">Clone or JURO a Google Ads campaign</p>
                <ol className="flex flex-col gap-1.5 pl-4 text-faint [list-style:decimal]">
                  <li>Paste Google campaign ids below (one, or a comma list).</li>
                  <li>LION reads the source facts and pre-fetches its launch dataset.</li>
                  <li>Pick a target account and pixel (Cloner), or leave it on the source (JURO).</li>
                  <li>Preview, then Fire — LION builds the copies server-side; the tab is safe to close.</li>
                </ol>
              </div>
            ) : (
              <div className="clone-rows rounded-2xl border border-line bg-surface">
                <div className="clone-row clone-head border-b border-line bg-surface2/40 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                  <span className="cr-num text-center">#</span>
                  <span className="cr-name">Campaign</span>
                  <span className="cr-geo">Geo</span>
                  <span className="cr-dest">Destination</span>
                  <span className="cr-bid">Strategy · Bid</span>
                  <span className="cr-budget">Budget · Copies</span>
                  <span className="cr-del" />
                </div>
                {rows.map((r, i) => {
                  const info = r.info;
                  const lowBudget = idOk(r) && parseMoney(r.budget) < 1;
                  const badDataset = datasetBad(r);
                  const kind = rowBidKind(r);
                  const plan = rowBidPlan(r);
                  const refusal = "refusal" in plan ? plan.refusal : null;
                  const cur = rowCurrency(r);
                  const gap = mode === "clone" && info?.currency && cur && info.currency !== cur ? { src: info.currency, dest: cur } : null;
                  const head = info ? splitGoogleName(info.name).head : "";
                  // What LION appends around our bare suffix: " | DD.MM user tail | CLONE_FROM=<id>".
                  const suffixPreview = googleNamePreview({
                    mode,
                    head: "",
                    sourceId: r.campaignId.trim(),
                    suffix: googleNameSuffix({ mode, sourceId: r.campaignId.trim(), user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: r.suffix }),
                  }).trim();
                  const srcAccount = info ? customerById.get(info.accountId) ?? null : null;
                  const rowT = rowTarget(r);
                  return (
                    <div
                      key={r.id}
                      className={
                        "clone-row border-b border-line/60 transition-colors last:border-b-0 hover:bg-raise/25" +
                        (badDataset ? " opacity-70" : "")
                      }
                    >
                      <div className="cr-num">
                        <span className="flex h-8 items-center justify-center font-mono text-[12px] text-faint">{i + 1}</span>
                      </div>

                      {/* name + facts / dataset chips + editable tail */}
                      <div className="cr-name min-w-0">
                        {r.loading ? (
                          <span className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                            Loading from LION…
                          </span>
                        ) : !info && r.failed ? (
                          <span className="mb-1 block font-mono text-[10.5px] font-semibold text-danger">LION read failed</span>
                        ) : (
                          <span className="mb-1 flex items-center gap-1 truncate font-mono text-[10.5px] text-faint" title={head || undefined}>
                            <LockIcon className="h-2.5 w-2.5 shrink-0" />
                            {head || "—"}
                          </span>
                        )}
                        <AutoTextarea
                          value={r.suffix}
                          onChange={(v) => {
                            patchRow(r.id, { suffix: v });
                            setPreviewed(false);
                          }}
                          placeholder="note — appended to the team suffix"
                          ariaLabel="Name tail"
                          maxLength={80}
                          singleLine
                          className="block w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:bg-surface2/80 focus:ring-2 focus:ring-accent/15"
                        />
                        {info ? (
                          <p className="mt-1 truncate font-mono text-[10px] text-faint" title={suffixPreview}>
                            {suffixPreview}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint">
                            #{r.campaignId}
                          </span>
                          {!info && r.failed && !r.loading ? (
                            <button
                              type="button"
                              onClick={() => retrySource(r)}
                              className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            >
                              <RetryIcon className="h-3 w-3" />
                              Retry read
                            </button>
                          ) : null}
                          {info ? (
                            <>
                              {info.known ? (
                                <span
                                  className={
                                    "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide " +
                                    (info.status === "ENABLED"
                                      ? "border-launch/40 bg-launch/10 text-launch2"
                                      : "border-line bg-surface2 text-faint")
                                  }
                                >
                                  {info.status || "—"}
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center rounded border border-line bg-surface2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-faint"
                                  title="This id had no row in LION's Google metrics over the last 7 days — still launchable; the dataset fetch is the real gate"
                                >
                                  not in LION metrics (7 d)
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint" title="Source account · currency">
                                <span className="truncate max-w-[140px]">{info.accountName || info.accountId || "—"}</span>
                                {info.currency ? <span className="text-dim">· {info.currency}</span> : null}
                              </span>
                              <span
                                className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-faint"
                                title="Source campaign — daily budget · bid (the clone's own settings are on the right)"
                              >
                                {info.budget != null ? (
                                  <span>
                                    {curSymbol(info.currency)}
                                    {moneyLabel(info.budget)}
                                  </span>
                                ) : (
                                  <span>—</span>
                                )}
                                {info.bid != null ? (
                                  <>
                                    <span className="text-dim">·</span>
                                    <span>bid {moneyText(info.bid)}</span>
                                  </>
                                ) : null}
                              </span>
                              {/* dataset chip + re-fetch */}
                              <span
                                className={
                                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] " +
                                  (info.dataset.state === "ready"
                                    ? "border-launch/40 bg-launch/10 text-launch2"
                                    : info.dataset.state === "fetching"
                                      ? "border-accent/40 bg-accent/10 text-[#9db8ff]"
                                      : "border-danger/40 bg-danger/10 text-danger")
                                }
                                title={
                                  info.dataset.state === "ready"
                                    ? "In LION's launch dataset — ready to build"
                                    : info.dataset.state === "fetching"
                                      ? "LION is snapshotting this campaign into the launch dataset…"
                                      : info.dataset.state === "missing"
                                        ? "LION never saw this campaign — it can't be cloned"
                                        : info.dataset.error || "dataset error"
                                }
                              >
                                {info.dataset.state === "ready" ? (
                                  <>
                                    <CheckIcon className="h-2.5 w-2.5" /> dataset
                                  </>
                                ) : info.dataset.state === "fetching" ? (
                                  <>
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9db8ff]" /> fetching…
                                  </>
                                ) : info.dataset.state === "missing" ? (
                                  <>
                                    <XIcon className="h-2.5 w-2.5" /> not found
                                  </>
                                ) : (
                                  <>
                                    <XIcon className="h-2.5 w-2.5" /> error
                                  </>
                                )}
                              </span>
                              {info.dataset.state === "missing" ? (
                                <span className="text-[10px] font-medium text-danger">LION never saw this campaign</span>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void refetchSource(r)}
                                title="Re-fetch the dataset (the source changed since the snapshot)"
                                aria-label="Re-fetch dataset"
                                className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              >
                                <RetryIcon className="h-3 w-3" />
                                Re-fetch
                              </button>
                            </>
                          ) : null}
                        </div>
                        {r.state !== "idle" ? (
                          <p
                            className={
                              "mt-1.5 break-words font-mono text-[10.5px] leading-snug " +
                              (r.state === "error" ? "text-danger" : r.state === "ok" ? "text-launch2" : "text-[#9db8ff]")
                            }
                          >
                            {r.state === "sending" ? "Submitting…" : r.msg ?? "—"}
                          </p>
                        ) : null}
                      </div>

                      {/* geo — read-only from the source name */}
                      <div className="cr-geo min-w-0">
                        <span className="cr-label">Geo</span>
                        {info?.geo ? (
                          <span className="inline-flex max-w-full truncate rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                            {info.geo}
                          </span>
                        ) : (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                      </div>

                      {/* destination — CLONE: account + pixel; JURO: source account (locked) + its pixel */}
                      <div className="cr-dest min-w-0">
                        <span className="cr-label">Destination</span>
                        {mode === "clone" ? (
                          <>
                            <div className="mb-1.5 flex flex-wrap items-center gap-1">
                              {r.customer || r.pixel ? (
                                <>
                                  <span className="rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]" title="This row carries its own account / pixel">
                                    own
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const cur = customerById.get(customer)?.currency ?? "";
                                      patchRow(r.id, { customer: "", pixel: "", ...derivePrefill(r, cur, "clone") });
                                      setPreviewed(false);
                                    }}
                                    aria-label="Back to the wave defaults"
                                    title="Back to the wave defaults"
                                    className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-[10px] text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                                  >
                                    <RetryIcon className="h-3 w-3" />
                                    reset
                                  </button>
                                </>
                              ) : (
                                <span className="rounded border border-line bg-surface2 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-faint" title="Rides the wave defaults from Settings">
                                  defaults
                                </span>
                              )}
                            </div>
                            <div className="cr-dest-picks">
                              <SearchSelect
                                size="sm"
                                value={r.customer || customer}
                                onChange={(v) => {
                                  const cur = customerById.get(v)?.currency ?? "";
                                  patchRow(r.id, { customer: v, pixel: "", ...derivePrefill(r, cur, "clone") });
                                  setPreviewed(false);
                                }}
                                options={customerOptions}
                                placeholder="Account"
                                emptyHint={customersLoading ? "Loading…" : "No accounts"}
                                warn={!(r.customer || customer)}
                                accent={Boolean(r.customer)}
                                ariaLabel={`Target account for row ${i + 1}`}
                              />
                              <SearchSelect
                                size="sm"
                                value={rowEffPixel(r)}
                                onChange={(v) => {
                                  patchRow(r.id, { pixel: v });
                                  setPreviewed(false);
                                }}
                                options={pixelOptionsFor(rowT)}
                                placeholder="Pixel"
                                emptyHint={!rowT ? "Pick an account first" : "No pixels on this account"}
                                warn={rowPixelNeeded(r)}
                                accent={Boolean(r.pixel)}
                                ariaLabel={`Pixel for row ${i + 1}`}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="cr-dest-picks">
                            <span
                              className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint"
                              title="JURO lands on the source's own account"
                            >
                              <LockIcon className="h-3 w-3 shrink-0" />
                              <span className="truncate">{info?.accountName || info?.accountId || "source account"}</span>
                            </span>
                            {srcAccount ? (
                              <SearchSelect
                                size="sm"
                                value={rowEffPixel(r)}
                                onChange={(v) => {
                                  patchRow(r.id, { pixel: v });
                                  setPreviewed(false);
                                }}
                                options={pixelOptionsFor(srcAccount)}
                                placeholder="Pixel"
                                emptyHint="No pixels on this account"
                                warn={rowPixelNeeded(r)}
                                accent={Boolean(r.pixel)}
                                ariaLabel={`Pixel for row ${i + 1}`}
                              />
                            ) : (
                              <input
                                value={r.pixel}
                                onChange={(e) => {
                                  patchRow(r.id, { pixel: e.target.value.trim() });
                                  setPreviewed(false);
                                }}
                                placeholder="Pixel id (optional)"
                                aria-label={`Pixel id for row ${i + 1}`}
                                className={cellInput}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {/* strategy + bid */}
                      <div className="cr-bid min-w-0">
                        <span className="cr-label">Strategy · Bid</span>
                        <div className="cr-bid-inner">
                          <div className="relative">
                            {mode === "clone" ? (
                              <select
                                value={r.bidStrategy}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const prevKind = kind;
                                  const nextKind = val ? googleBidKind(val) : "unknown";
                                  patchRow(r.id, { bidStrategy: val, bid: nextKind === prevKind ? r.bid : "", autoBid: nextKind === prevKind ? r.autoBid : false });
                                  setPreviewed(false);
                                }}
                                disabled={badDataset}
                                aria-label="Clone bid strategy"
                                title="The clone's bidding strategy — Inherit keeps the source's (LION validates a typed bid against it)"
                                className={cellSelect + (r.bidStrategy ? " border-accent/50 text-[#9db8ff]" : "")}
                              >
                                <option value="" className="bg-surface text-ink">
                                  Inherit source
                                </option>
                                {GOOGLE_BID_STRATEGIES.map((o) => (
                                  <option key={o.value} value={o.value} className="bg-surface text-ink">
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <select disabled aria-label="JURO bid strategy" title="JURO keeps the source's bidding strategy" className={cellSelect}>
                                <option>Source&apos;s strategy</option>
                              </select>
                            )}
                          </div>
                          <div className="relative">
                            {kind === "roas" ? (
                              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-[#9db8ff]">%</span>
                            ) : kind === "cpa" ? (
                              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint">{curSymbol(cur)}</span>
                            ) : null}
                            <input
                              value={r.bid}
                              onChange={(e) => {
                                const raw = e.target.value;
                                let v: string;
                                if (kind === "cpa") v = limitMoneyCents(raw, GOOGLE_CPA_MAX);
                                else if (kind === "roas") {
                                  const digs = raw.replace(/\D/g, "").slice(0, 3);
                                  v = digs && Number(digs) > GOOGLE_ROAS_MAX ? String(GOOGLE_ROAS_MAX) : digs;
                                } else v = limitMoney(raw, GOOGLE_CPA_MAX);
                                patchRow(r.id, { bid: v, autoBid: false });
                                setPreviewed(false);
                              }}
                              disabled={badDataset || (mode === "clone" && kind === "none")}
                              inputMode={kind === "roas" ? "numeric" : "decimal"}
                              placeholder={
                                mode === "clone" && kind === "none"
                                  ? "auto"
                                  : kind === "cpa"
                                    ? gap
                                      ? `retype in ${gap.dest}`
                                      : "3,95"
                                    : kind === "roas"
                                      ? "90"
                                      : "inherit"
                              }
                              aria-label="Bid"
                              title={
                                gap
                                  ? `Source bids in ${gap.src}, this account is ${gap.dest} — type the bid in ${gap.dest}`
                                  : kind === "roas"
                                    ? "Target ROAS as a whole percent 1–200 (90 = 90%)"
                                    : kind === "cpa"
                                      ? `Target CPA in ${cur || "the account currency"} — digits fill cents (395 → 3,95)`
                                      : "Empty = inherit the source's bid; LION validates a typed value"
                              }
                              className={
                                cellInput +
                                (kind === "cpa" ? " pl-6" : kind === "roas" ? " pr-6" : "") +
                                (refusal ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")
                              }
                            />
                          </div>
                        </div>
                        {refusal ? <p className="mt-1 text-[10px] leading-snug text-warn">{refusal}</p> : null}
                        {gap && !refusal ? (
                          <p className="mt-1 text-[10px] leading-snug text-faint">target bills {gap.dest} — retype the bid</p>
                        ) : null}
                      </div>

                      {/* budget + copies */}
                      <div className="cr-budget min-w-0">
                        <span className="cr-label">Budget · Copies</span>
                        <div className="cr-budget-inner">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase text-faint">
                              {cur || "$"}
                            </span>
                            <input
                              value={r.budget}
                              onChange={(e) => {
                                patchRow(r.id, { budget: limitMoneyCents(e.target.value, GOOGLE_BUDGET_MAX), autoBudget: false });
                                setPreviewed(false);
                              }}
                              disabled={badDataset}
                              inputMode="decimal"
                              placeholder="30,00"
                              aria-label="Daily budget"
                              title={lowBudget ? "Min 1/day — this row won't fire until the budget is raised" : "Daily budget in the account currency — digits fill cents (1000 → 10,00)"}
                              className={cellInput + " pl-9" + (lowBudget ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")}
                            />
                          </div>
                          <div
                            className={
                              "flex h-8 items-stretch overflow-hidden rounded-md border bg-surface2 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 " +
                              (r.copies ? "border-accent/45" : "border-line hover:border-line2") +
                              (badDataset ? " opacity-50" : "")
                            }
                            title={`Copies of this row · empty = the wave default (${copiesN}) · max ${MAX_COPIES}`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                patchRow(r.id, { copies: String(Math.max(1, rowCopies(r) - 1)) });
                                setPreviewed(false);
                              }}
                              disabled={badDataset || rowCopies(r) <= 1}
                              aria-label="Fewer copies"
                              className="flex w-7 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <MinusIcon className="h-3 w-3" />
                            </button>
                            <span className="pointer-events-none self-center font-mono text-[10.5px] text-faint">×</span>
                            <input
                              value={r.copies}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                                patchRow(r.id, { copies: raw !== "" && Number(raw) > MAX_COPIES ? String(MAX_COPIES) : raw });
                                setPreviewed(false);
                              }}
                              onBlur={() => {
                                if (r.copies !== "" && Number(r.copies) < 1) patchRow(r.id, { copies: "" });
                              }}
                              inputMode="numeric"
                              placeholder={String(copiesN)}
                              aria-label="Copies for this row"
                              disabled={badDataset}
                              className={
                                "min-w-0 flex-1 bg-transparent px-1 text-center font-mono text-[12px] tabular-nums outline-none placeholder:text-faint disabled:cursor-not-allowed " +
                                (r.copies ? "text-[#9db8ff]" : "text-dim")
                              }
                            />
                            <button
                              type="button"
                              onClick={() => {
                                patchRow(r.id, { copies: String(Math.min(MAX_COPIES, rowCopies(r) + 1)) });
                                setPreviewed(false);
                              }}
                              disabled={badDataset || rowCopies(r) >= MAX_COPIES}
                              aria-label="More copies"
                              className="flex w-7 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <PlusIcon className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* remove */}
                      <div className="cr-del">
                        <button
                          type="button"
                          aria-label="Remove row"
                          title="Remove from the wave"
                          onClick={() => removeRow(r.id)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                        >
                          <TrashIcon className="h-[18px] w-[18px]" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 grow basis-[240px] items-center gap-1.5 sm:grow-0">
                <input
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addSources();
                  }}
                  placeholder="Campaign ID(s) — paste one or a comma list"
                  aria-label="Add source campaign ids"
                  className="h-8 w-full min-w-0 rounded-md border border-line bg-surface2 px-2 font-mono text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 sm:w-[280px]"
                />
                <button
                  type="button"
                  onClick={addSources}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[11.5px] font-medium text-faint transition-colors hover:border-accent/50 hover:text-[#9db8ff]"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add
                </button>
                {rows.length > 0 ? (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[11.5px] font-medium text-faint transition-colors hover:border-danger/50 hover:text-danger"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    Clear all
                  </button>
                ) : null}
                {rows.length >= MAX_SOURCES ? (
                  <span className="shrink-0 rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10.5px] text-warn">
                    {rows.length}/{MAX_SOURCES} max
                  </span>
                ) : null}
              </div>
              <p className="min-w-0 text-[10.5px] text-faint">
                {rows.length} row{rows.length === 1 ? "" : "s"} · Empty bid = inherit the source · CPA digits fill cents (395 → 3,95) · ROAS is a whole percent (90) · budget in the account currency
              </p>
            </div>

            {/* preview */}
            {previewed ? (
              <div className="animate-pop-in rounded-2xl border border-line bg-surface p-4">
                <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                <div className="flex flex-col gap-1.5">
                  {validRows.map((r) => {
                    const n = rowCopies(r);
                    const cur = rowCurrency(r);
                    const plan = rowBidPlan(r);
                    const bidText = "refusal" in plan ? "—" : plan.label;
                    const t = rowTarget(r);
                    // The suffix (date · buyer · CLONE_FROM/JURO_FROM=<id>) is the part worth reading
                    // whole — a long generated head is what gets trimmed.
                    const head = r.info ? splitGoogleName(r.info.name).head : `#${r.campaignId}`;
                    const namePreview = googleNamePreview({
                      mode,
                      head: head.length > 72 ? `${head.slice(0, 71)}…` : head,
                      sourceId: r.campaignId.trim(),
                      suffix: googleNameSuffix({ mode, sourceId: r.campaignId.trim(), user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: r.suffix }),
                    });
                    return (
                      <p key={r.id} className="text-[12px] text-dim">
                        <span className="text-ink">{namePreview}</span> → {n} cop{n === 1 ? "y" : "ies"} @ {curSymbol(cur)}
                        {moneyLabel(r.budget)}/day
                        <span className="text-[#9db8ff]"> · {bidText}</span>
                        <span className={r.customer ? "text-[#9db8ff]" : "text-faint"}> · → {t?.name || (mode === "juro" ? "source account" : "—")}</span>
                      </p>
                    );
                  })}
                  <div className="mt-1 border-t border-line pt-2 text-[12px] text-ink">
                    {totalCopies} {mode === "clone" ? "clone" : "JURO cop"}
                    {mode === "clone" ? (totalCopies === 1 ? "" : "s") : totalCopies === 1 ? "y" : "ies"} · fires ONE wave to LION · the tab is safe to close once accepted.
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
