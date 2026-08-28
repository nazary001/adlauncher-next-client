"use client";

import { useEffect, useState } from "react";

/** One provisioned MO soc channel with its live token verdict from the server's `/me` probe.
 *  ok:false carries FB's own error text — the board shows it under the switch so a dead token
 *  reads as "re-issue this soc" instead of a silently empty account picker. system:true marks
 *  an alternate SYSTEM user (no SOC name marker on its launches — previews must match). */
export type MoSocStatus = { name: string; ok: boolean; error?: string; system?: boolean };

/**
 * Provisioned MO soc launch channels (FB_MO_SOC_TOKENS on the server) — powers the board's
 * System-token ↔ soc switch. null = still loading, [] = none provisioned (switch hidden).
 * Names + health only; tokens never reach the browser. A soc pick is honored only while its
 * name is in this list (mirrors the HS rail's `hs.tokenLaunch` honor rule).
 */
export function useMoSocs(enabled: boolean): MoSocStatus[] | null {
  const [socs, setSocs] = useState<MoSocStatus[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/mo-socs")
      .then((r) => r.json())
      .then((d: { ok?: boolean; socs?: unknown[]; statuses?: { name?: unknown; ok?: unknown; error?: unknown; system?: unknown }[] }) => {
        if (!alive) return;
        if (!d?.ok) return setSocs([]);
        // Prefer the health-carrying shape; a mid-deploy old server sends names only — treat
        // those as healthy (the pickers/launch still error honestly if a token is dead).
        if (Array.isArray(d.statuses)) {
          setSocs(
            d.statuses.map((s) => ({
              name: String(s?.name ?? ""),
              ok: Boolean(s?.ok),
              ...(s?.error ? { error: String(s.error) } : {}),
              ...(s?.system === true ? { system: true } : {}),
            })),
          );
        } else {
          setSocs(Array.isArray(d.socs) ? d.socs.map((n) => ({ name: String(n), ok: true })) : []);
        }
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
