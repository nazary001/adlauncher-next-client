"use client";

import { useCallback, useEffect, useState } from "react";
import type { SlotId } from "@/lib/fb-token-registry";

/** The primary signer of one partner×rail slot as the server resolved it (labels only). */
export type SignerInfo = {
  id: string;
  label: string;
  source: "registry" | "env";
  /** Personal soc profile → MO campaign names carry the SOC marker (previews must match). */
  personal: boolean;
  user: string;
  app: string;
  ok: boolean;
  error?: string;
};

export type SlotSigner = {
  slot: SlotId;
  /** Owner-assigned on /tokens, the env default, or nothing at all. */
  source: "assigned" | "env" | "none";
  pool: boolean;
  primary: SignerInfo | null;
  /** Failover bearers behind the primary (HS pools). */
  extra: number;
  error?: string;
};

// Was 60s — this poll drives a `/me` token-health probe server-side and runs on EVERY open board,
// so a tight interval hammered the MO app's dev-tier rate limit. 5 min is plenty for a "Signs as …"
// badge (the verdict is server-cached in the shared app-cache and re-checkable on demand).
const POLL_MS = 5 * 60_000;
// A tab-focus refresh is nice, but a focus/blur storm must not re-probe every time — only refresh
// on focus when the last poll is already older than this.
const FOCUS_MIN_MS = 2 * 60_000;

/**
 * Effective signer per slot (GET /api/fb-tokens/signers) — powers the boards' read-only
 * "Signs as …" badges and their launch gates. The owner's pick lands here within the server's
 * 15s registry cache; the hook re-polls every 5 minutes and on focus (debounced). `slots` is null until the
 * first answer (badges show "resolving"); a transient failure keeps the last known picture.
 */
export function useSigners(enabled = true): { slots: Record<SlotId, SlotSigner> | null; loaded: boolean; refresh: () => void } {
  const [slots, setSlots] = useState<Record<SlotId, SlotSigner> | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastLoad = 0;
    async function load() {
      lastLoad = Date.now();
      try {
        const r = await fetch("/api/fb-tokens/signers", { cache: "no-store" });
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; slots?: Record<SlotId, SlotSigner> };
        if (!alive) return;
        if (r.ok && d?.ok && d.slots) setSlots(d.slots);
      } catch {
        /* transient — keep the last known state */
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
  }, [enabled, nonce]);

  return { slots: enabled ? slots : null, loaded: slots !== null, refresh };
}
