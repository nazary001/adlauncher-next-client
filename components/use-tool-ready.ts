"use client";

import { useCallback, useEffect, useState } from "react";

/** One TOOL-live account the ready endpoint reported (owner ask 28.09): bare-digit `id`, its display
 *  `name` and `currency`. `rows` is ADDED for every partner (additive) with the SAME ids/order as
 *  `accounts` — the AV TOOL card builds its account picker straight from these (AV has no FB token,
 *  so there is no catalog to intersect with; the rows ARE the catalog). */
export type ToolAccountRow = {
  id: string;
  name: string;
  currency: string;
  /** AV (owner ask 30.09): the live TOOL sessions (FB profiles) that see this cabinet — the card's
   *  Profile pick. Empty when the answer carried none (other partners, an older server). */
  sessions: ToolSessionOption[];
};

/** One pickable TOOL session: its id (the card stores it as digits), name (av-01) and FB profile. */
export type ToolSessionOption = { id: string; name: string; profile: string };

/** The TOOL launch channel's readiness for one partner × rail, as /api/tool/ready resolved it
 *  (owner ask 28.09). `accounts` are the bare-digit account ids the TOOL rail may launch into (the
 *  card's account picker intersects its own catalog with this set); `rows` carries the same ids with
 *  their names/currency for pickers that have no local catalog (AV); `ready` gates the TOOL segment
 *  on the launch/clone rail. Never throws — a transient failure keeps the last known picture. */
export type ToolReadyState = {
  /** false until the first answer for THIS partner/rail lands (the segment shows "checking"). */
  loaded: boolean;
  ready: boolean;
  reason?: string;
  /** Human, specific — shown as the disabled TOOL segment's tooltip. */
  message?: string;
  accounts: Set<string>;
  /** Same ids/order as `accounts`, with each account's name + currency (empty when the answer
   *  omitted rows). The AV TOOL account picker reads names from here. */
  rows: ToolAccountRow[];
  refresh: () => void;
};

// Same cadence as the "Signs as …" badge (use-signers): a launch-readiness verdict does not need a
// tight poll, and this hits a server that reads TOOL /me + /accounts. 5 min + a debounced focus.
const POLL_MS = 5 * 60_000;
const FOCUS_MIN_MS = 2 * 60_000;

/** State is stamped with the partner|rail `key` it belongs to; a render whose key differs (partner
 *  or rail just changed, or the hook is disabled) reads as "checking" WITHOUT a synchronous setState
 *  in the effect — the reset is derived, not written. */
type Loaded = { key: string; ready: boolean; reason?: string; message?: string; accounts: Set<string>; rows: ToolAccountRow[] };

/** Coerce the endpoint's `rows` (foreign / partial answers must never throw) — each entry becomes
 *  {id, name, currency} with String()'d fields, dropping anything without a usable id. */
function parseRows(raw: unknown): ToolAccountRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolAccountRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = String(o.id ?? "");
    if (!id) continue;
    out.push({ id, name: String(o.name ?? ""), currency: String(o.currency ?? ""), sessions: parseSessions(o.sessions) });
  }
  return out;
}

/** Coerce a row's `sessions` — digit ids only, never throws. */
function parseSessions(raw: unknown): ToolSessionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolSessionOption[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const id = String(o.id ?? "");
    if (!/^\d{1,9}$/.test(id)) continue;
    out.push({ id, name: String(o.name ?? ""), profile: String(o.profile ?? "") });
  }
  return out;
}

/**
 * Poll /api/tool/ready for one partner × rail. Refreshes every 5 minutes and on focus (debounced);
 * a partner/rail change is a fresh key, so the previous partner's answer never leaks through.
 * `enabled=false` parks it (the board's non-active partners). Never throws.
 */
export function useToolReady(
  partner: string,
  rail: "launch" | "clone" = "launch",
  enabled = true,
): ToolReadyState {
  const key = `${partner}|${rail}`;
  const [state, setState] = useState<Loaded>({ key: "", ready: false, accounts: new Set(), rows: [] });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastLoad = 0;

    async function load() {
      lastLoad = Date.now();
      try {
        const r = await fetch(`/api/tool/ready?partner=${encodeURIComponent(partner)}&rail=${rail}`, { cache: "no-store" });
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          ready?: boolean;
          reason?: string;
          message?: string;
          accounts?: string[];
          rows?: unknown;
        };
        if (!alive) return;
        if (r.ok && d?.ok) {
          setState({
            key,
            ready: d.ready === true,
            reason: d.reason,
            message: d.message,
            accounts: new Set(Array.isArray(d.accounts) ? d.accounts.map(String) : []),
            rows: parseRows(d.rows),
          });
        } else {
          // Auth blip / bad answer: mark this key loaded-empty only if we have nothing for it yet;
          // otherwise keep the last known picture (don't flap ready→false on a transient blip).
          setState((s) => (s.key === key ? s : { key, ready: false, accounts: new Set(), rows: [] }));
        }
      } catch {
        if (!alive) return;
        setState((s) => (s.key === key ? s : { key, ready: false, accounts: new Set(), rows: [] }));
      }
    }

    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastLoad >= FOCUS_MIN_MS) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, partner, rail, key, nonce]);

  // Fresh only when the loaded state belongs to the current partner/rail AND the hook is enabled —
  // a stale MO verdict can never render as an AIF verdict, and disabling parks it, all derived.
  const fresh = enabled && state.key === key;
  return {
    loaded: fresh,
    ready: fresh ? state.ready : false,
    reason: fresh ? state.reason : undefined,
    message: fresh ? state.message : undefined,
    accounts: fresh ? state.accounts : new Set<string>(),
    rows: fresh ? state.rows : [],
    refresh,
  };
}
