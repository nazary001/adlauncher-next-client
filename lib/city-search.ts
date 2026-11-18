// Server-only: the REAL deps of the Meta city search (lib/city-search-core) — owner ask 18.11, city
// launches through TOOL. TOOL has no geo search (openapi v1.0, re-read 18.11), so city keys come from
// Graph `search?type=adgeolocation`, a GLOBAL endpoint any live token can sign (no account access).
//
// Signer chain: the AIF → HS → MO → VC → AV launch slots, first live one wins (18.11: the MO env token
// answers "API access blocked" #200/5258005; AIF and HS T1 search fine). The core benches refused
// signers and caches answers 24 h, so a buyer retyping a city costs nothing.

import { resolveSlot } from "./fb-tokens";
import type { SlotId } from "./fb-token-registry";
import { graphBase } from "./fb-graph";
import type { CitySearchDeps, CitySigner } from "./city-search-core";

const SIGNER_CHAIN: readonly SlotId[] = ["aif.launch", "hs.launch", "mo.launch", "vc.launch", "av.launch"];
const TIMEOUT_MS = 8_000;

async function chainSigners(): Promise<CitySigner[]> {
  const out: CitySigner[] = [];
  const seen = new Set<string>();
  for (const slot of SIGNER_CHAIN) {
    try {
      const r = await resolveSlot(slot);
      for (const t of r.tokens) {
        if (!t.token || seen.has(t.fp)) continue;
        seen.add(t.fp);
        out.push({ fp: t.fp, token: t.token });
      }
    } catch {
      /* a store blip on one slot never blocks the others */
    }
  }
  return out;
}

async function fetchJson(url: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The real deps — the route calls city-search-core searchCities(q, cc, cityDeps) directly (no thin
 *  async wrapper here: the Turbopack const-fold gotcha). */
export const cityDeps: CitySearchDeps = { signers: chainSigners, fetchJson, base: graphBase, now: () => Date.now() };
