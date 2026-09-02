"use client";

// Published AUTO landings for the MO landing picker (owner-generated MK Learn pages). Loaded
// once per board mount + refreshed on window focus, so a landing published while the tab sat in
// the background appears on return. Degrades to [] — the static catalog always works.

import { useEffect, useState } from "react";
import type { Landing } from "@/lib/partners";

export function useAutoLandings(enabled: boolean): Landing[] {
  const [rows, setRows] = useState<Landing[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/landings");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; landings?: Landing[] };
        if (alive && r.ok && d.ok && Array.isArray(d.landings)) setRows(d.landings);
      } catch {
        /* keep whatever we had */
      }
    };
    void load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return enabled ? rows : [];
}
