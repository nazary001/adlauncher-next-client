"use client";

import { useEffect, useState } from "react";

/**
 * Names of the provisioned MO soc launch channels (FB_MO_SOC_TOKENS on the server) — powers the
 * board's System-token ↔ soc switch. null = still loading, [] = none provisioned (switch hidden).
 * Names only; tokens never reach the browser. A soc pick is honored only while its name is in
 * this list (mirrors the HS rail's `hs.tokenLaunch` honor rule).
 */
export function useMoSocs(enabled: boolean): string[] | null {
  const [socs, setSocs] = useState<string[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/mo-socs")
      .then((r) => r.json())
      .then((d: { ok?: boolean; socs?: unknown[] }) => {
        if (!alive) return;
        setSocs(d?.ok && Array.isArray(d.socs) ? d.socs.map(String) : []);
      })
      .catch(() => {
        // Transient blip = no soc option this session — the system channel still works.
        if (alive) setSocs([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return enabled ? socs : null;
}
