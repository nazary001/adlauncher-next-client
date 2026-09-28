"use client";

import { useCallback, useEffect, useState } from "react";

/** The TOOL launch channel's readiness for one partner × rail, as /api/tool/ready resolved it
 *  (owner ask 28.09). `accounts` are the bare-digit account ids the TOOL rail may launch into (the
 *  card's account picker intersects its own catalog with this set); `ready` gates the TOOL segment
 *  on the launch/clone rail. Never throws — a transient failure keeps the last known picture. */
export type ToolReadyState = {
  /** false until the first answer for THIS partner/rail lands (the segment shows "checking"). */
  loaded: boolean;
  ready: boolean;
  reason?: string;
  /** Human, specific — shown as the disabled TOOL segment's tooltip. */
  message?: string;
  accounts: Set<string>;
  refresh: () => void;
};

// Same cadence as the "Signs as …" badge (use-signers): a launch-readiness verdict does not need a
// tight poll, and this hits a server that reads TOOL /me + /accounts. 5 min + a debounced focus.
const POLL_MS = 5 * 60_000;
const FOCUS_MIN_MS = 2 * 60_000;

/** State is stamped with the partner|rail `key` it belongs to; a render whose key differs (partner
 *  or rail just changed, or the hook is disabled) reads as "checking" WITHOUT a synchronous setState
 *  in the effect — the reset is derived, not written. */
type Loaded = { key: string; ready: boolean; reason?: string; message?: string; accounts: Set<string> };

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
  const [state, setState] = useState<Loaded>({ key: "", ready: false, accounts: new Set() });
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
        };
        if (!alive) return;
        if (r.ok && d?.ok) {
          setState({
            key,
            ready: d.ready === true,
            reason: d.reason,
            message: d.message,
            accounts: new Set(Array.isArray(d.accounts) ? d.accounts.map(String) : []),
          });
        } else {
          // Auth blip / bad answer: mark this key loaded-empty only if we have nothing for it yet;
          // otherwise keep the last known picture (don't flap ready→false on a transient blip).
          setState((s) => (s.key === key ? s : { key, ready: false, accounts: new Set() }));
        }
      } catch {
        if (!alive) return;
        setState((s) => (s.key === key ? s : { key, ready: false, accounts: new Set() }));
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
    refresh,
  };
}
