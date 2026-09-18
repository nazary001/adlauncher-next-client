"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./header";
import { TiktokNav, TT_ON } from "./tiktok-nav";
import { AutoTextarea, Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useTiktokAdvertisers, useTiktokConfigs, type TiktokSourceInfo, type TwAdvertiser, type TwConfig } from "./use-tiktok";
import { useTiktokTaskManager } from "./tiktok-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { limitMoneyCents, moneyCentsLabel, moneyLabel, parseMoney } from "@/lib/types";
import {
  TIKTOK_BID_MAX,
  TIKTOK_BUDGET_MAX,
  TIKTOK_BUDGET_MIN,
  TIKTOK_CAMPAIGN_ID_RE,
  TIKTOK_CLONE_MODES,
  TIKTOK_DEFAULT_BUDGET,
  TIKTOK_ROAS_MAX,
  moneyText,
  tiktokCloneWire,
  tiktokJuroWire,
  tiktokModeKind,
  tiktokNamePreview,
  tiktokNameSuffix,
  tiktokResolvePixel,
  todaySaoPauloDotDDMM,
  type TiktokBidKind,
  type TiktokCloneShotIn,
  type TiktokKind,
  type TiktokPixelLike,
} from "@/lib/tiktok-launch";
import { parseTiktokName } from "@/lib/tiktok-source";
import { CopyIcon, EyeIcon, LockIcon, MinusIcon, PlusIcon, RetryIcon, TrashIcon, XIcon } from "./icons";
import type { RichOption } from "@/lib/catalog";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

const MAX_COPIES = 20;
const MAX_SOURCES = 30;

/** The board's two modes — the partner's clone and JURO kinds (a fresh launch lives on /tiktok). */
type BoardMode = Exclude<TiktokKind, "launch">;

/** One source-campaign row: the LION-read facts + the editable clone overrides. */
type Row = {
  id: string;
  campaignId: string;
  /** LION facts + what the dataset-fetch trigger answered — null while the /sources read is in flight. */
  info: TiktokSourceInfo | null;
  loading: boolean;
  /** The /sources read failed (network/HTTP) — a manual "Retry read" re-arms it. */
  failed?: boolean;
  /** The row's "Re-fetch" call is in flight (the partner has no status read to poll instead). */
  refetching?: boolean;
  /** Picked bidding mode ("" = same as the source; CLONE only — JURO always keeps the source's). */
  bidMode: string;
  /** Editable value, HUMAN ("" = none sent). A USD bid — cash-register money — under "Same as
   *  source" / Bid cap and in JURO; a ROAS MULTIPLIER (1,20 = 120 %) under Min ROAS. */
  bid: string;
  /** Editable daily budget — cash-register "20,00" (limitMoneyCents), USD on every TikTok account. */
  budget: string;
  /** The budget / bid still hold a MACHINE value (the seed, or the source's own once LION answers).
   *  The first manual keystroke pins the field (false) — a buyer's number is never overwritten. */
  autoBudget: boolean;
  autoBid: boolean;
  /** Buyer's free tail — the team-pattern suffix is built around it (server + preview). */
  suffix: string;
  /** Row's OWN target advertiser ("" = the wave default in Settings; CLONE only). */
  advertiser: string;
  /** Row's OWN pixel code ("" = the wave/auto pixel; CLONE only — JURO keeps the source's). */
  pixel: string;
  /** Row's OWN number of copies ("" = the wave default). */
  copies: string;
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

/** What the row's value field holds for a picked mode: dollars under "Same as source" (the partner
 *  never inherits a bid, so a typed one rides as the bid) and Bid cap, a multiplier under Min ROAS,
 *  nothing under the value-less modes. */
const valueKindOf = (bidMode: string): TiktokBidKind => {
  const k = bidMode ? tiktokModeKind(bidMode) : "bid";
  return k === "unknown" ? "bid" : k;
};

/**
 * Machine prefill of a row's budget/bid from its LION facts. Every TikTok account bills in USD and
 * LION reports USD, so the source's own numbers carry over as they are: budget = the source's when
 * TikTok would accept it (≥ $20), else the console default; bid = the source's when it has one AND
 * the row's value field means dollars (a ROAS goal is never seeded from a bid). Only auto* fields move.
 */
function derivePrefill(r: Row): Partial<Row> {
  const s = r.info;
  if (!s) return {};
  const patch: Partial<Row> = {};
  if (r.autoBudget) {
    patch.budget = s.budget != null && s.budget >= TIKTOK_BUDGET_MIN && s.budget <= TIKTOK_BUDGET_MAX ? moneyCentsLabel(s.budget) : TIKTOK_DEFAULT_BUDGET;
  }
  if (r.autoBid) {
    patch.bid = valueKindOf(r.bidMode) === "bid" && s.bid != null && s.bid > 0 && s.bid <= TIKTOK_BID_MAX ? moneyCentsLabel(s.bid) : "";
  }
  return patch;
}

/** Server-side wave cap (lib/tiktok-wave TIKTOK_MAX_SHOTS) mirrored here so an oversized wave is
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

/** A locked, read-only cell (JURO's pinned advertiser / mode, a value-less mode's empty value). */
const cellLocked = "flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 text-[11px] text-faint";

const idOk = (r: Row): boolean => TIKTOK_CAMPAIGN_ID_RE.test(r.campaignId.trim());

const freshRow = (campaignId: string, n: number): Row => ({
  id: `tr${Date.now()}-${n}`,
  campaignId,
  info: null,
  loading: false,
  failed: false,
  bidMode: "",
  bid: "",
  // Cash-register seed ("20,00" — TikTok's floor and 97 % of the team's book); a source's own
  // budget replaces it once LION answers. A bare "20" would re-read as 0,20 on the first keystroke.
  budget: TIKTOK_DEFAULT_BUDGET,
  autoBudget: true,
  autoBid: true,
  suffix: "",
  advertiser: "",
  pixel: "",
  copies: "",
  state: "idle",
});

/** Where a CLONE row lands, resolved the way the server resolves it: no target yet, the target's
 *  config still loading / failed, or the config in hand with the pixel (or the reason there is none). */
type Dest =
  | { state: "none" }
  | { state: "loading"; target: TwAdvertiser }
  | { state: "failed"; target: TwAdvertiser; error: string }
  | { state: "ok"; target: TwAdvertiser; cfg: TwConfig; pixel: TiktokPixelLike | { refusal: string } };

/** A row's readiness. `at` names the cell that owns the fix (the sentence is shown there);
 *  `pending` = nothing to fix, a read is still in flight. */
type RowPlan =
  | { ready: true; label: string }
  | { ready: false; why: string; at: "target" | "config" | "pixel" | "source" | "wire"; pending?: boolean };

/**
 * TikTok clone / JURO board — the Google clone board's twin (a sticky Settings column with the wave
 * defaults + Preview→Fire, and a table of source rows with their real facts next to the editable
 * overrides), bent only where the partner contract differs: one currency (every advertiser is USD,
 * so no cross-currency prefill guard), a pixel that lives in the target advertiser's CONFIG (read
 * per picked advertiser), bidding MODES with a dollar bid or a ROAS multiplier, Smart+ sources, and
 * NO dataset status read — the fetch is triggered on add and the launch itself retries until the
 * source is in. Readiness is the server's own pure builders (tiktokCloneWire / tiktokJuroWire), so
 * the board can't disagree with the route. The launch rides LION's tiktok-weapon API through one
 * server pump (fire-and-forget — the tab is safe to close once the wave is accepted, the drawer
 * mirrors the server's progress).
 */
export function TiktokCloneBoard({
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
  const { advertisers, acr, liveLaunch, error: advError, retry: retryAdvertisers } = useTiktokAdvertisers();
  const { setOpen, counts, refresh } = useTiktokTaskManager();

  const [mode, setMode] = useState<BoardMode>(initialMode ?? "clone");
  const [advertiser, setAdvertiser] = useState(""); // wave target advertiser (CLONE)
  const [pixel, setPixel] = useState(""); // wave pixel code
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
  // Source ids whose /sources read is claimed (in flight, answered or failed) — see the effect below.
  const fetchedRef = useRef(new Set<string>());

  const [rows, setRows] = useState<Row[]>(() =>
    initialIds
      .filter((id) => TIKTOK_CAMPAIGN_ID_RE.test(id))
      .slice(0, MAX_SOURCES)
      .map((cid, i) => freshRow(cid, i + 1)),
  );

  const advertiserById = useMemo(() => new Map((advertisers ?? []).map((a) => [a.advertiserId, a])), [advertisers]);

  // Configs (pixels + the modes each can run) of every advertiser a CLONE row may land on. JURO
  // never needs one — it keeps the source's own advertiser AND pixel.
  const { configs, retry: retryConfig } = useTiktokConfigs(mode === "clone" ? [advertiser, ...rows.map((r) => r.advertiser)] : []);

  // ---- mode (localStorage; ?mode= wins) ------------------------------------------------------
  useEffect(() => {
    try {
      const m = localStorage.getItem("adlauncher.tiktok.mode");
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR); a
      // link-forced mode wins, so the remembered pick must not override it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!initialMode && (m === "clone" || m === "juro")) setMode(m);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, [initialMode]);

  const changeMode = (m: BoardMode) => {
    setMode(m);
    setPreviewed(false);
    setFireNote(null);
    // The value field means DOLLARS in JURO and under "Same as source" / Bid cap, but a MULTIPLIER
    // under Min ROAS: a row that carried a ROAS or value-less mode drops back to "Same as source"
    // with the machine bid, so 1,20 (= 120 %) can never ride as $1.20 in the other mode. A typed
    // dollar bid means the same in both modes and stays.
    setRows((rs) =>
      rs.map((r) => {
        if (valueKindOf(r.bidMode) === "bid") return r;
        const next: Row = { ...r, bidMode: "", bid: "", autoBid: true };
        return { ...next, ...derivePrefill(next) };
      }),
    );
    try {
      localStorage.setItem("adlauncher.tiktok.mode", m);
    } catch {
      /* storage disabled */
    }
  };

  const patchRow = (id: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const addSources = () => {
    const ids = [...new Set(draftId.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => TIKTOK_CAMPAIGN_ID_RE.test(x)))];
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
      // Free the read claim when no other row carries this id — a re-added id must be read (and its
      // dataset fetch re-triggered) again.
      const cid = gone?.campaignId.trim();
      if (cid && !next.some((r) => r.campaignId.trim() === cid)) fetchedRef.current.delete(cid);
      return next;
    });
    setPreviewed(false);
  };

  const clearAll = () => {
    fetchedRef.current.clear();
    setRows([]);
    setPreviewed(false);
    setFireNote(null);
  };

  const retrySource = (r: Row) => {
    fetchedRef.current.delete(r.campaignId.trim());
    patchRow(r.id, { failed: false });
  };

  // ---- source facts from LION (POST /api/tiktok/sources), batched + debounced ----------------
  // The same call TRIGGERS the partner's dataset fetch per id (pre-warm): by the time the buyer
  // fires, the source is usually in. There is nothing to poll afterwards — tiktok-weapon has no
  // dataset status read, and the pump's launch-first retry is the real gate.
  useEffect(() => {
    const want = rows.filter((r) => idOk(r) && !r.info && !r.loading);
    const ids = [...new Set(want.map((r) => r.campaignId.trim()))].filter((id) => !fetchedRef.current.has(id));
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      ids.forEach((id) => fetchedRef.current.add(id));
      setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: true } : r)));
      void (async () => {
        try {
          const res = await fetch("/api/tiktok/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const d = (await res.json().catch(() => ({}))) as { ok?: boolean; sources?: TiktokSourceInfo[] };
          if (!res.ok || !d?.ok) throw new Error(`HTTP ${res.status}`);
          const byId = new Map((d.sources ?? []).map((s) => [s.campaignId, s]));
          setRows((rs) =>
            rs.map((r) => {
              const s = byId.get(r.campaignId.trim());
              // Answered without this id → the same manual-Retry path as a failed call (no auto-loop).
              if (!s) return ids.includes(r.campaignId.trim()) ? { ...r, loading: false, failed: true } : r;
              const next = { ...r, loading: false, failed: false, info: s };
              return { ...next, ...derivePrefill(next) };
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
  }, [rows]);

  /** Per-row "Re-fetch" — the source changed since LION's snapshot (new creatives, a new landing),
   *  or the first trigger failed: ask the partner again. With no status read to follow up on, the
   *  chip simply shows what the trigger itself answered. */
  const refetchSource = async (r: Row) => {
    const id = r.campaignId.trim();
    if (!r.info || r.refetching) return;
    setRows((rs) => rs.map((x) => (x.campaignId.trim() === id ? { ...x, refetching: true } : x)));
    let ds: TiktokSourceInfo["dataset"] = { state: "error", error: "re-fetch failed — try again" };
    try {
      const res = await fetch("/api/tiktok/dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; datasets?: Record<string, TiktokSourceInfo["dataset"]> };
      const u = d?.datasets?.[id];
      if (res.ok && d?.ok && u) ds = { state: u.state, ...(u.error ? { error: u.error } : {}) };
      else if (d?.error) ds = { state: "error", error: d.error };
    } catch {
      /* network — the "re-fetch failed" default stands */
    }
    setRows((rs) => rs.map((x) => (x.campaignId.trim() === id ? { ...x, refetching: false, info: x.info ? { ...x.info, dataset: ds } : x.info } : x)));
  };

  // ---- derived: copies, destinations, pixels -------------------------------------------------
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  const rowCopies = (r: Row): number => {
    const n = Number(r.copies);
    return r.copies !== "" && Number.isFinite(n) && n >= 1 ? Math.min(MAX_COPIES, Math.round(n)) : copiesN;
  };

  // The wave pixel as it rides the wire: the buyer's pick, or the wave target's lone pixel.
  const waveCfg = mode === "clone" && advertiser ? configs[advertiser] : undefined;
  const wavePixelAuto = waveCfg && !("error" in waveCfg) && waveCfg.pixels.length === 1 ? waveCfg.pixels[0].pixelCode : "";
  const effWavePixel = pixel || wavePixelAuto;

  const destOf = (targetId: string, ownPixel: string): Dest => {
    const target = targetId ? advertiserById.get(targetId) : undefined;
    if (!target) return { state: "none" };
    const cfg = configs[target.advertiserId];
    if (!cfg) return { state: "loading", target };
    if ("error" in cfg) return { state: "failed", target, error: cfg.error };
    // The wave pixel rides only onto targets that actually carry it (the server's rule): a row sent
    // to another advertiser resolves ITS pixel, never inherits the wave's foreign one.
    const picked = ownPixel || (effWavePixel && cfg.pixels.some((p) => p.pixelCode === effWavePixel) ? effWavePixel : "");
    return { state: "ok", target, cfg, pixel: tiktokResolvePixel(cfg.pixels, picked, target.name) };
  };
  const waveDest = mode === "clone" ? destOf(advertiser, "") : ({ state: "none" } as Dest);
  const waveTarget = waveDest.state === "none" ? null : waveDest.target;
  const wavePixels = waveDest.state === "ok" ? waveDest.cfg.pixels : null;
  const wavePixelNeeded = Boolean(wavePixels && wavePixels.length > 1 && !effWavePixel);
  /** A CLONE row's destination: its own advertiser / pixel over the wave defaults. */
  const rowDest = (r: Row): Dest => destOf(r.advertiser || advertiser, r.pixel);

  /** The advertiser a row ships to: CLONE = its own pick over the wave default; JURO = the source's own. */
  const rowTarget = (r: Row): TwAdvertiser | null => {
    const id = mode === "clone" ? r.advertiser || advertiser : r.info?.accountId ?? "";
    return id ? advertiserById.get(id) ?? null : null;
  };

  // ---- naming (LION's grammar around our suffix — the same head the server stamps on the row) --
  const rowSuffix = (r: Row): string => tiktokNameSuffix({ user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: r.suffix });
  const rowName = (r: Row, headMax = 0): { locked: string; suffix: string; full: string } => {
    const cid = r.campaignId.trim();
    const parts = parseTiktokName(r.info?.name ?? "");
    // `{HS-____}` becomes LION's hash and `cl` the target advertiser's cluster number at launch —
    // neither is ours to know; JURO stays on its advertiser, so it keeps the source's cluster.
    const built = parts.geo.length
      ? `{HS-____} (${acr.toUpperCase() || "GLO-01"}) [${mode === "juro" ? parts.cl || "cl" : "cl"}|${parts.geo.join(",")}|${parts.language || "ALL"}] (${parts.landingPath || "<landing>"})`
      : r.info?.name || `campaign ${cid}`;
    const head = headMax > 0 && built.length > headMax ? `${built.slice(0, headMax - 1)}…` : built;
    const suffix = rowSuffix(r);
    const full = tiktokNamePreview({ head, suffix, kind: mode, sourceId: cid, smartPlus: mode === "clone" ? parts.smartPlus : "" });
    // `full` ends with " | <suffix>" — everything before it is LION's locked part (head + the
    // CLONE_FROM/JURO_FROM marker + the Smart+ tag).
    return { locked: full.slice(0, full.length - suffix.length - 3), suffix, full };
  };

  // ---- readiness: the SAME pure builders the server runs -------------------------------------
  const rowShot = (r: Row): TiktokCloneShotIn => {
    const cur = rowTarget(r)?.currency || (mode === "juro" ? r.info?.currency ?? "" : "");
    return {
      campaignId: r.campaignId.trim(),
      budget: r.budget,
      bid: r.bid.trim(),
      mode: mode === "clone" ? r.bidMode : "",
      suffix: r.suffix.trim(),
      ...(mode === "clone" && r.advertiser ? { advertiser: r.advertiser } : {}),
      ...(mode === "clone" && r.pixel ? { pixel: r.pixel } : {}),
      ...(r.info?.name ? { sourceName: r.info.name } : {}),
      ...(r.info?.accountId ? { sourceAccount: r.info.accountId } : {}),
      ...(r.info?.geo ? { geo: r.info.geo } : {}),
      ...(cur ? { currency: cur } : {}),
    };
  };

  /** Ready (with the monitor's bid tag) or the sentence that names the fix — in the server's own
   *  order: target → config → pixel → wire for a clone; the two JURO rules → wire for a JURO. */
  const rowPlan = (r: Row): RowPlan => {
    const shot = rowShot(r);
    const nameSuffix = rowSuffix(r);
    if (mode === "juro") {
      const s = r.info;
      if (s?.smartPlus) return { ready: false, at: "source", why: "JURO doesn't support Smart+ sources — switch to Clone" };
      if (s?.accountId && advertisers && !advertiserById.has(s.accountId)) {
        return {
          ready: false,
          at: "source",
          why: `JURO lands on the source's own advertiser (${s.accountName || s.accountId}), which is not launch-eligible — clone it onto another advertiser`,
        };
      }
      const built = tiktokJuroWire(shot, { nameSuffix });
      return "refusal" in built ? { ready: false, at: "wire", why: built.refusal } : { ready: true, label: built.label };
    }
    const dest = rowDest(r);
    if (dest.state === "none") {
      const built = tiktokCloneWire(shot, { advertiserId: "", pixelCode: "", nameSuffix });
      return { ready: false, at: "target", why: "refusal" in built ? built.refusal : "Pick a target advertiser" };
    }
    if (dest.state === "loading") return { ready: false, at: "config", pending: true, why: `Reading ${dest.target.name}'s pixels…` };
    if (dest.state === "failed") return { ready: false, at: "config", why: `Couldn't read ${dest.target.name}'s config — ${dest.error}` };
    if ("refusal" in dest.pixel) return { ready: false, at: "pixel", why: dest.pixel.refusal };
    const built = tiktokCloneWire(shot, {
      advertiserId: dest.target.advertiserId,
      pixelCode: dest.pixel.pixelCode,
      supportedModes: dest.pixel.supportedModes,
      nameSuffix,
    });
    return "refusal" in built ? { ready: false, at: "wire", why: built.refusal } : { ready: true, label: built.label };
  };

  // ---- fireable set + gates ------------------------------------------------------------------
  const advertisersLoading = advertisers === null && !advError;
  const advertisersFailed = Boolean(advError);
  // Only "missing" blocks: LION never saw the campaign, so no launch can ever find it. A triggered
  // fetch is never waited on, and a failed trigger isn't proof of anything — the pump re-asks.
  const datasetBad = (r: Row): boolean => r.info?.dataset.state === "missing";
  const lowBudget = (r: Row): boolean => idOk(r) && parseMoney(r.budget) < TIKTOK_BUDGET_MIN;
  const candidateRows = rows.filter((r) => idOk(r) && !lowBudget(r));
  const validRows = candidateRows.filter((r) => !datasetBad(r));
  const blockedDatasetRows = candidateRows.filter(datasetBad);
  const lowBudgetCount = rows.filter(lowBudget).length;

  const planById = new Map(rows.map((r) => [r.id, rowPlan(r)]));
  const notReadyAt = (at: Exclude<RowPlan, { ready: true }>["at"], pending = false): Row[] =>
    validRows.filter((r) => {
      const p = planById.get(r.id);
      return Boolean(p && !p.ready && p.at === at && Boolean(p.pending) === pending);
    });
  const needTarget = notReadyAt("target").length > 0;
  const configPending = notReadyAt("config", true).length > 0;
  const configFailedRows = notReadyAt("config");
  const pixelNeededRows = notReadyAt("pixel");
  const sourceRefusalRows = notReadyAt("source");
  const bidRefusalRows = notReadyAt("wire");
  const notReadyCount = validRows.filter((r) => !planById.get(r.id)?.ready).length;
  const totalCopies = validRows.reduce((sum, r) => sum + rowCopies(r), 0);
  // Every TikTok account bills in USD — one total, no per-currency split.
  const totalDay = validRows.reduce((sum, r) => sum + parseMoney(r.budget) * rowCopies(r), 0);

  const overShotCap = totalCopies > MAX_SHOTS;
  const fireBlocked =
    firing ||
    !liveLaunch ||
    validRows.length === 0 ||
    advertisersLoading ||
    advertisersFailed ||
    notReadyCount > 0 ||
    blockedDatasetRows.length > 0 ||
    overShotCap;

  // ---- Settings picker options ---------------------------------------------------------------
  // ~170 launchable advertisers — the pickers are searchable by name, id and timezone.
  const advertiserOptions: RichOption[] = (advertisers ?? []).map((a) => ({
    value: a.advertiserId,
    label: a.name,
    subLabel: a.advertiserId,
    meta: a.timezone,
  }));
  const pixelOptionsFor = (d: Dest): RichOption[] => (d.state === "ok" ? d.cfg.pixels : []).map((p) => ({ value: p.pixelCode, label: p.pixelCode }));
  const pixelEmptyHint = (d: Dest): string =>
    d.state === "none" ? "Pick an advertiser first" : d.state === "loading" ? "Reading pixels…" : d.state === "failed" ? "Couldn't read the pixels" : "No pixels on this advertiser";
  /** The pixel shown in a picker: what actually resolves, else the (refused) pick itself. */
  const destPixel = (d: Dest, own: string): string => (d.state === "ok" && !("refusal" in d.pixel) ? d.pixel.pixelCode : own);

  // ---- fire ----------------------------------------------------------------------------------
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    // One shot per copy; shotRow remembers the row each shot came from, so the server's
    // "shot N: …" lands on ITS row even with the copies expanded.
    const shots: TiktokCloneShotIn[] = [];
    const shotRow: string[] = [];
    for (const r of validRows) {
      const shot = rowShot(r);
      for (let k = 0; k < rowCopies(r); k++) {
        shots.push({ ...shot });
        shotRow.push(r.id);
      }
    }
    const waveAdvertiser = mode === "clone" ? advertiser : "";
    const wavePixel = mode === "clone" ? effWavePixel : "";
    const sig = JSON.stringify({ mode, advertiser: waveAdvertiser, pixel: wavePixel, shots });
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    validRows.forEach((r) => patchRow(r.id, { state: "sending", msg: "queuing on server…" }));
    try {
      const endpoint = mode === "clone" ? "/api/tiktok/clone" : "/api/tiktok/juro";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waveId: waveRef.current.id,
          ...(waveAdvertiser ? { advertiser: waveAdvertiser } : {}),
          ...(wavePixel ? { pixel: wavePixel } : {}),
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
      } else if (res.status === 403 && String(d?.error ?? "").startsWith("tiktok_live_launch_blocked")) {
        // Not a row's fault and nothing was sent: this instance may read the live partner but not
        // fire at it (the advertisers read said otherwise only if it is stale).
        setFireNote("This instance isn't allowed to fire at the live partner (not production) — nothing was sent.");
        validRows.forEach((r) => patchRow(r.id, { state: "idle", msg: undefined }));
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        // "shot N: …" pins the failure to one row; otherwise every row of the wave carries it.
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotRow[Number(m[1]) - 1] : null;
        validRows.forEach((r) =>
          patchRow(r.id, culprit && r.id !== culprit ? { state: "error", msg: "wave refused — fix the flagged row" } : { state: "error", msg }),
        );
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  // Leaving the TikTok platform entirely → a full navigation back to the Facebook board on the
  // picked partner (a different server component tree, not a client route within TikTok).
  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const modeLabel = mode === "clone" ? "Cloner" : "JURO";

  return (
    <>
      <Header partner="br" onPartnerChange={changePartner} user={user} platform="tiktok" />
      <TiktokNav active="clone" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (wave defaults + Preview→Fire) — sticky AND internally scrollable ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Settings</span>
                <span className="text-[10.5px] leading-snug text-faint">
                  Wave defaults — every row rides these unless it sets its own advertiser / pixel in the table.
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
                  ? "Clones the source campaign onto the target advertiser — a Smart+ source stays Smart+"
                  : "JURO copy on the source's OWN advertiser — same pixel, identity and mode, kept on its rail"}
              </p>

              {/* target advertiser */}
              {mode === "clone" ? (
                <Field
                  label="Target advertiser"
                  hint={
                    waveTarget
                      ? `${waveTarget.currency || "USD"} · ${waveTarget.timezone || "—"}${wavePixels ? ` · ${wavePixels.length} pixel${wavePixels.length === 1 ? "" : "s"}` : ""}`
                      : "Where every clone lands — a row can override it"
                  }
                >
                  <SearchSelect
                    value={advertiser}
                    onChange={(v) => {
                      setAdvertiser(v);
                      setPixel("");
                      setPreviewed(false);
                      // A pixel belongs to ONE advertiser: rows riding the wave default drop a pick
                      // made for the previous target (rows with their own advertiser keep theirs).
                      setRows((rs) => rs.map((r) => (r.advertiser || !r.pixel ? r : { ...r, pixel: "" })));
                    }}
                    options={advertiserOptions}
                    placeholder="Search advertiser"
                    metaWhenClosed
                    emptyHint={advertisersLoading ? "Loading advertisers…" : advertisersFailed ? "Couldn't load advertisers" : "No advertisers"}
                  />
                </Field>
              ) : (
                <Field label="Target advertiser">
                  <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
                    <LockIcon className="h-3 w-3 shrink-0" />
                    Source&apos;s own advertiser — JURO never moves advertisers
                  </div>
                </Field>
              )}

              {/* pixel (wave) — CLONE only (a JURO keeps the source's pixel; the partner takes none) */}
              {mode === "clone" ? (
                <Field
                  label="Pixel"
                  hint={
                    waveDest.state === "none"
                      ? "Pick a target advertiser first"
                      : waveDest.state === "loading"
                        ? "reading the advertiser's pixels…"
                        : waveDest.state === "failed"
                          ? undefined
                          : waveDest.cfg.pixels.length === 1
                            ? "one pixel — auto-picked"
                            : effWavePixel
                              ? undefined
                              : "several pixels — pick one"
                  }
                  error={
                    waveDest.state === "failed"
                      ? `Couldn't read this advertiser's config — ${waveDest.error}`
                      : waveDest.state === "ok" && waveDest.cfg.pixels.length === 0
                        ? "No usable pixel on this advertiser — LION can't launch on it. Pick another one."
                        : wavePixelNeeded
                          ? "This advertiser has several pixels — pick one."
                          : undefined
                  }
                >
                  <SearchSelect
                    value={effWavePixel}
                    onChange={(v) => {
                      setPixel(v);
                      setPreviewed(false);
                    }}
                    options={pixelOptionsFor(waveDest)}
                    placeholder="Search pixel"
                    warn={wavePixelNeeded}
                    emptyHint={pixelEmptyHint(waveDest)}
                  />
                </Field>
              ) : null}
              {mode === "clone" && waveDest.state === "failed" ? (
                <button
                  type="button"
                  onClick={() => retryConfig(waveDest.target.advertiserId)}
                  className="-mt-1 self-start rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Retry the config read
                </button>
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
                <div className="flex items-center justify-between">
                  <span className="text-faint">Total/day</span>
                  <span className="font-mono tabular-nums">${moneyLabel(totalDay)}</span>
                </div>
              </div>

              {!liveLaunch ? (
                <div className="rounded-lg border border-line bg-surface2/40 px-3 py-2 text-center text-[11px] leading-relaxed text-dim">
                  This instance reads the live partner but won&apos;t fire at it (not production) — launching is off here.
                </div>
              ) : null}

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
              {advertisersFailed ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the TikTok advertisers — {advError}.</span>
                  <button
                    type="button"
                    onClick={retryAdvertisers}
                    className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {needTarget ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  Pick a target advertiser (or set one per row) — every clone needs somewhere to land.
                </p>
              ) : null}
              {configPending ? (
                <p className="text-center text-[10.5px] leading-relaxed text-faint">Reading the target advertiser&apos;s pixels…</p>
              ) : null}
              {configFailedRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {configFailedRows.length} row{configFailedRows.length === 1 ? "'s" : "s'"} advertiser config couldn&apos;t be read — Retry it
                  on the row (or pick another advertiser).
                </p>
              ) : null}
              {pixelNeededRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {pixelNeededRows.length} row{pixelNeededRows.length === 1 ? " needs" : "s need"} a pixel — see the note under its
                  destination (pick one in Settings or on the row).
                </p>
              ) : null}
              {sourceRefusalRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {sourceRefusalRows.length} source{sourceRefusalRows.length === 1 ? "" : "s"} can&apos;t be JURO&apos;d — see the note on the
                  row; the Cloner takes {sourceRefusalRows.length === 1 ? "it" : "them"}.
                </p>
              ) : null}
              {blockedDatasetRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  LION never saw {blockedDatasetRows.length} source{blockedDatasetRows.length === 1 ? "" : "s"} —{" "}
                  {blockedDatasetRows.length === 1 ? "it" : "they"} can&apos;t be cloned through LION. Remove{" "}
                  {blockedDatasetRows.length === 1 ? "that row" : "those rows"} (or Re-fetch a campaign that is brand new).
                </p>
              ) : null}
              {overShotCap ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {totalCopies} shots — one wave carries at most {MAX_SHOTS}. Lower the copies or split the sources into two waves.
                </p>
              ) : null}
              {bidRefusalRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {bidRefusalRows.length} row{bidRefusalRows.length === 1 ? " has" : "s have"} a mode or bid that doesn&apos;t fit — see the
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
                  {counts.active} TikTok build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.
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
                  {blockedDatasetRows.length} LION never saw — excluded
                </span>
              ) : null}
              {lowBudgetCount > 0 ? (
                <span className="rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn">
                  {lowBudgetCount} below ${TIKTOK_BUDGET_MIN}/day — won&apos;t fire (amber Budget field)
                </span>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <div className="animate-pop-in flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-surface p-6 text-[12px] leading-relaxed text-dim">
                <p className="text-[13px] font-semibold text-ink">Clone or JURO a TikTok campaign</p>
                <ol className="flex flex-col gap-1.5 pl-4 text-faint [list-style:decimal]">
                  <li>Paste TikTok campaign ids below (one, or a comma list).</li>
                  <li>LION reads the source facts and starts fetching the source — no need to wait for it.</li>
                  <li>Pick a target advertiser and pixel (Cloner), or leave it on the source (JURO).</li>
                  <li>Preview, then Fire — LION builds the copies server-side; the tab is safe to close.</li>
                </ol>
              </div>
            ) : (
              <div className="clone-rows rounded-2xl border border-line bg-surface">
                <div className="clone-row clone-head border-b border-line bg-surface2/40 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                  <span className="cr-num text-center">#</span>
                  <span className="cr-name">Campaign</span>
                  <span className="cr-geo">Geo · Lang</span>
                  <span className="cr-dest">Destination</span>
                  <span className="cr-bid">Mode · Bid</span>
                  <span className="cr-budget">Budget · Copies</span>
                  <span className="cr-del" />
                </div>
                {rows.map((r, i) => {
                  const info = r.info;
                  const low = lowBudget(r);
                  const badDataset = datasetBad(r);
                  const valueKind: TiktokBidKind = mode === "clone" ? valueKindOf(r.bidMode) : "bid";
                  const modeDef = TIKTOK_CLONE_MODES.find((o) => o.value === r.bidMode);
                  const plan = planById.get(r.id);
                  const why = idOk(r) && !badDataset && plan && !plan.ready ? plan : null;
                  // The builders refuse the budget first — a low budget owns the wire sentence,
                  // anything else on the wire is the mode / bid.
                  const destWhy = why && why.at !== "wire" ? why : null;
                  const bidWhy = why && why.at === "wire" && !low ? why.why : null;
                  const budgetWhy = why && why.at === "wire" && low ? why.why : null;
                  const dest = rowDest(r);
                  const name = rowName(r);
                  const srcTail = info?.name ? parseTiktokName(info.name).suffix || info.name : "";
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
                          <span
                            className="mb-1 flex items-center gap-1 truncate font-mono text-[10.5px] text-faint"
                            title={info ? `LION builds this part of the ${mode === "clone" ? "clone" : "JURO"}'s name: ${name.locked}` : undefined}
                          >
                            <LockIcon className="h-2.5 w-2.5 shrink-0" />
                            {info ? name.locked : "—"}
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
                          <p className="mt-1 truncate font-mono text-[10px] text-faint" title={`| ${name.suffix}`}>
                            | {name.suffix}
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint">
                            #{r.campaignId}
                          </span>
                          {/* The source's OWN suffix is how a buyer recognises the campaign — the
                              copy doesn't inherit it (LION builds a new head, we a new suffix). */}
                          {srcTail ? (
                            <span
                              className="inline-flex min-w-0 items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-dim"
                              title={`Source: ${info?.name ?? ""}`}
                            >
                              <span className="max-w-[260px] truncate">{srcTail}</span>
                            </span>
                          ) : null}
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
                                    (info.status === "ENABLE"
                                      ? "border-launch/40 bg-launch/10 text-launch2"
                                      : info.status === "DELETE"
                                        ? "border-danger/40 bg-danger/10 text-danger"
                                        : "border-line bg-surface2 text-faint")
                                  }
                                  title={info.delivery ? `TikTok delivery: ${info.delivery}` : undefined}
                                >
                                  {info.status || "—"}
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center rounded border border-line bg-surface2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-faint"
                                  title="This id had no row in LION's TikTok metrics over the last 7 days — still launchable; LION's own fetch of the source is the real gate"
                                >
                                  not in LION metrics (7 d)
                                </span>
                              )}
                              {info.smartPlus ? (
                                <span
                                  className={"inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide " + TT_ON}
                                  title={
                                    mode === "clone"
                                      ? "A clone of a Smart+ source stays Smart+ — LION keeps the campaign kind and its budget level"
                                      : "JURO doesn't support Smart+ sources — switch to Clone"
                                  }
                                >
                                  {info.smartPlus === "campaign" ? "Smart+ CBO" : "Smart+"}
                                </span>
                              ) : null}
                              {info.accountName || info.accountId ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint"
                                  title={`Source advertiser${info.accountId ? ` · ${info.accountId}` : ""}`}
                                >
                                  <span className="max-w-[140px] truncate">{info.accountName || info.accountId}</span>
                                </span>
                              ) : null}
                              {info.landingPath ? (
                                <span
                                  className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint"
                                  title={`Landing path · ${info.landingPath}`}
                                >
                                  <span className="max-w-[200px] truncate">{info.landingPath}</span>
                                </span>
                              ) : null}
                              {info.known ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-faint"
                                  title="Source campaign — daily budget · bid, USD (the clone's own settings are on the right)"
                                >
                                  {info.budget != null ? <span>${moneyLabel(info.budget)}</span> : <span>—</span>}
                                  {info.bid != null && info.bid > 0 ? (
                                    <>
                                      <span className="text-dim">·</span>
                                      <span>bid {moneyText(info.bid)}</span>
                                    </>
                                  ) : null}
                                </span>
                              ) : null}
                              {/* dataset chip + re-fetch. No pulse on "fetch triggered": nothing is
                                  polled (the partner has no status read), so the chip never changes
                                  by itself — a live dot would promise an update that can't come. */}
                              <span
                                className={
                                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] " +
                                  (info.dataset.state === "fetching"
                                    ? "border-accent/40 bg-accent/10 text-[#9db8ff]"
                                    : info.dataset.state === "missing"
                                      ? "border-danger/40 bg-danger/10 text-danger"
                                      : info.dataset.state === "error"
                                        ? "border-warn/40 bg-warn/10 text-warn"
                                        : "border-line bg-surface text-faint")
                                }
                                title={
                                  info.dataset.state === "fetching"
                                    ? "LION is fetching the source — usually in within 30–120 s. You don't have to wait: the launch retries by itself until the source is in."
                                    : info.dataset.state === "missing"
                                      ? "LION never saw this campaign — it can't be cloned through LION"
                                      : info.dataset.state === "error"
                                        ? `${info.dataset.error || "The fetch trigger failed"} — not blocking: the launch asks LION for the source again by itself`
                                        : "The source fetch wasn't triggered yet — Re-fetch asks LION for it; the launch also does it by itself"
                                }
                              >
                                {info.dataset.state === "fetching" ? (
                                  "fetch triggered"
                                ) : info.dataset.state === "missing" ? (
                                  <>
                                    <XIcon className="h-2.5 w-2.5" /> not found
                                  </>
                                ) : info.dataset.state === "error" ? (
                                  <>
                                    <XIcon className="h-2.5 w-2.5" /> fetch failed
                                  </>
                                ) : (
                                  "fetch not asked"
                                )}
                              </span>
                              {info.dataset.state === "missing" ? (
                                <span className="text-[10px] font-medium text-danger">LION never saw this campaign — it can&apos;t be cloned through LION</span>
                              ) : info.dataset.state === "error" ? (
                                <span className="min-w-0 break-words text-[10px] font-medium text-warn">{info.dataset.error || "the fetch trigger failed"}</span>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void refetchSource(r)}
                                disabled={r.refetching}
                                title="Ask LION to fetch the source again (it changed since the snapshot, or the first trigger failed)"
                                aria-label="Re-fetch the source"
                                className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              >
                                <RetryIcon className={"h-3 w-3" + (r.refetching ? " animate-spin" : "")} />
                                {r.refetching ? "Asking…" : "Re-fetch"}
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

                      {/* geo + language — read-only from the source name */}
                      <div className="cr-geo min-w-0">
                        <span className="cr-label">Geo · Lang</span>
                        {info?.geo || info?.language ? (
                          <div className="flex flex-wrap items-center gap-1">
                            {info.geo ? (
                              <span className="inline-flex max-w-full truncate rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim" title={`Geo · ${info.geo}`}>
                                {info.geo}
                              </span>
                            ) : null}
                            {info.language ? (
                              <span className="inline-flex rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-faint" title="Language">
                                {info.language}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                      </div>

                      {/* destination — CLONE: advertiser + pixel; JURO: the source's advertiser (locked) */}
                      <div className="cr-dest min-w-0">
                        <span className="cr-label">Destination</span>
                        {mode === "clone" ? (
                          <>
                            <div className="mb-1.5 flex flex-wrap items-center gap-1">
                              {r.advertiser || r.pixel ? (
                                <>
                                  <span className="rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]" title="This row carries its own advertiser / pixel">
                                    own
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      patchRow(r.id, { advertiser: "", pixel: "" });
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
                                value={r.advertiser || advertiser}
                                onChange={(v) => {
                                  patchRow(r.id, { advertiser: v, pixel: "" });
                                  setPreviewed(false);
                                }}
                                options={advertiserOptions}
                                placeholder="Advertiser"
                                emptyHint={advertisersLoading ? "Loading…" : "No advertisers"}
                                warn={!(r.advertiser || advertiser)}
                                accent={Boolean(r.advertiser)}
                                ariaLabel={`Target advertiser for row ${i + 1}`}
                              />
                              <SearchSelect
                                size="sm"
                                value={destPixel(dest, r.pixel)}
                                onChange={(v) => {
                                  patchRow(r.id, { pixel: v });
                                  setPreviewed(false);
                                }}
                                options={pixelOptionsFor(dest)}
                                placeholder="Pixel"
                                emptyHint={pixelEmptyHint(dest)}
                                warn={destWhy?.at === "pixel"}
                                accent={Boolean(r.pixel)}
                                ariaLabel={`Pixel for row ${i + 1}`}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="cr-dest-picks">
                            <span className={cellLocked + " font-mono"} title="JURO lands on the source's own advertiser — with its pixel and identity">
                              <LockIcon className="h-3 w-3 shrink-0" />
                              <span className="truncate">{info?.accountName || info?.accountId || "source advertiser"}</span>
                            </span>
                          </div>
                        )}
                        {destWhy ? (
                          <p className={"mt-1 break-words text-[10px] leading-snug " + (destWhy.pending ? "text-faint" : "text-warn")}>
                            {destWhy.why}
                            {destWhy.at === "config" && !destWhy.pending && dest.state === "failed" ? (
                              <button
                                type="button"
                                onClick={() => retryConfig(dest.target.advertiserId)}
                                className="ml-1.5 inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-px text-[10px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              >
                                <RetryIcon className="h-3 w-3" />
                                Retry
                              </button>
                            ) : null}
                          </p>
                        ) : null}
                      </div>

                      {/* mode + bid */}
                      <div className="cr-bid min-w-0">
                        <span className="cr-label">Mode · Bid</span>
                        <div className="cr-bid-inner">
                          <div className="relative">
                            {mode === "clone" ? (
                              <select
                                value={r.bidMode}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  // Dollars and a multiplier never trade places: a change of KIND
                                  // drops the value and re-seeds it (the source's bid when the new
                                  // kind means dollars, empty otherwise — a value-less mode must
                                  // ride without one).
                                  const next: Row = valueKindOf(val) === valueKind ? { ...r, bidMode: val } : { ...r, bidMode: val, bid: "", autoBid: true };
                                  patchRow(r.id, { bidMode: next.bidMode, bid: next.bid, autoBid: next.autoBid, ...derivePrefill(next) });
                                  setPreviewed(false);
                                }}
                                disabled={badDataset}
                                aria-label="Clone mode"
                                title={
                                  modeDef
                                    ? modeDef.hint
                                    : "Same as source keeps the source's mode. The partner never inherits a BID — a Bid-cap source needs its bid typed here (prefilled from the source)"
                                }
                                className={cellSelect + (r.bidMode ? " border-accent/50 text-[#9db8ff]" : "")}
                              >
                                <option value="" className="bg-surface text-ink">
                                  Same as source
                                </option>
                                {TIKTOK_CLONE_MODES.map((o) => (
                                  <option key={o.value} value={o.value} className="bg-surface text-ink">
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className={cellLocked} title="JURO keeps the source's mode — only the budget and the bid are yours">
                                <LockIcon className="h-3 w-3 shrink-0" />
                                <span className="truncate">Source&apos;s mode</span>
                              </span>
                            )}
                          </div>
                          <div className="relative">
                            {valueKind === "none" ? (
                              <span className={cellLocked} title={`${modeDef?.label ?? "This mode"} takes no bid and no ROAS goal`}>
                                <span className="truncate">no value for this mode</span>
                              </span>
                            ) : (
                              <>
                                {valueKind === "roas" ? (
                                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-[#9db8ff]">×</span>
                                ) : (
                                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint">$</span>
                                )}
                                <input
                                  value={r.bid}
                                  onChange={(e) => {
                                    patchRow(r.id, { bid: limitMoneyCents(e.target.value, valueKind === "roas" ? TIKTOK_ROAS_MAX : TIKTOK_BID_MAX), autoBid: false });
                                    setPreviewed(false);
                                  }}
                                  disabled={badDataset}
                                  inputMode="decimal"
                                  placeholder={valueKind === "roas" ? "1,20" : mode === "juro" || !r.bidMode ? "no bid" : "0,46"}
                                  aria-label={valueKind === "roas" ? "ROAS goal" : "Bid"}
                                  title={
                                    valueKind === "roas"
                                      ? "ROAS goal as a MULTIPLIER — 1,20 = 120 % · digits fill hundredths (120 → 1,20)"
                                      : mode === "juro"
                                        ? "Optional, USD — prefilled from the source. LION refuses a bid-less JURO of a bid source, so keep it unless the source runs without a bid"
                                        : r.bidMode
                                          ? "Bid per conversion, USD — digits fill cents (46 → 0,46)"
                                          : "USD — prefilled from the source; the partner never inherits a bid. Leave empty only for a source that runs without one"
                                  }
                                  className={
                                    cellInput +
                                    (valueKind === "roas" ? " pr-6" : " pl-6") +
                                    (bidWhy ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")
                                  }
                                />
                              </>
                            )}
                          </div>
                        </div>
                        {bidWhy ? <p className="mt-1 text-[10px] leading-snug text-warn">{bidWhy}</p> : null}
                      </div>

                      {/* budget + copies */}
                      <div className="cr-budget min-w-0">
                        <span className="cr-label">Budget · Copies</span>
                        <div className="cr-budget-inner">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase text-faint">USD</span>
                            <input
                              value={r.budget}
                              onChange={(e) => {
                                patchRow(r.id, { budget: limitMoneyCents(e.target.value, TIKTOK_BUDGET_MAX), autoBudget: false });
                                setPreviewed(false);
                              }}
                              disabled={badDataset}
                              inputMode="decimal"
                              placeholder={TIKTOK_DEFAULT_BUDGET}
                              aria-label="Daily budget"
                              title={
                                low
                                  ? `TikTok refuses less than $${TIKTOK_BUDGET_MIN}/day — this row won't fire until the budget is raised`
                                  : "Daily budget, USD — digits fill cents (2000 → 20,00)"
                              }
                              className={cellInput + " pl-9" + (low ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")}
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
                        {budgetWhy ? <p className="mt-1 text-[10px] leading-snug text-warn">{budgetWhy}</p> : null}
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
              {/* sm:basis-auto — a fixed 240px basis with grow-0 squeezes the id field to a stub once
                  "Clear all" joins the row; from sm up the group is as wide as its content. */}
              <div className="flex min-w-0 grow basis-[240px] items-center gap-1.5 sm:grow-0 sm:basis-auto">
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
                {rows.length} row{rows.length === 1 ? "" : "s"} · Empty bid = no bid sent (the partner never inherits one) · bid digits fill cents (46 → 0,46) · ROAS is
                a multiplier (1,20 = 120 %) · everything in USD, budget from ${TIKTOK_BUDGET_MIN}/day
              </p>
            </div>

            {/* preview */}
            {previewed ? (
              <div className="animate-pop-in rounded-2xl border border-line bg-surface p-4">
                <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                <div className="flex flex-col gap-1.5">
                  {validRows.map((r) => {
                    const n = rowCopies(r);
                    const plan = planById.get(r.id);
                    const bidText = plan?.ready ? plan.label : "—";
                    const t = rowTarget(r);
                    // The suffix (date · buyer · GC-Launcher · tail) is the part worth reading whole —
                    // a long generated head is what gets trimmed.
                    const namePreview = rowName(r, 72).full;
                    return (
                      <p key={r.id} className="text-[12px] text-dim">
                        <span className="text-ink">{namePreview}</span> → {n} cop{n === 1 ? "y" : "ies"} @ ${moneyLabel(r.budget)}/day
                        <span className="text-[#9db8ff]"> · {bidText}</span>
                        <span className={r.advertiser && mode === "clone" ? "text-[#9db8ff]" : "text-faint"}>
                          {" "}
                          · → {t?.name || (mode === "juro" ? r.info?.accountName || "source advertiser" : "—")}
                        </span>
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
