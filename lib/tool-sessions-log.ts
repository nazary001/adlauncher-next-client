// Server-only. Our OWN change log for the TOOL Sessions console. TOOL records every action made
// through the API as the key's actor ("key:hst_P1aFCVPi") — it cannot tell WHICH owner clicked;
// this row keeps that: who, when, what, on which session. Best-effort by design: a Strapi blip
// never blocks the action itself (the write is fire-and-forget after TOOL has answered), and a
// lost entry under a concurrent write is acceptable for a human-readable trail.
//
// Storage: ONE `app-cache` row (ckey TOOL_LOG_KEY), newest first, capped at MAX_LOG_ENTRIES.

import { readAppCacheDetailed, writeAppCache } from "@/lib/app-cache";
import { type ToolLogEntry, pushLog, sanitizeLog } from "@/lib/tool-sessions-model";

export const TOOL_LOG_KEY = "tool-sessions:log:v1";
export { MAX_LOG_ENTRIES, pushLog, sanitizeLog } from "@/lib/tool-sessions-model";
export type { ToolLogEntry, ToolLogKind } from "@/lib/tool-sessions-model";

export async function readToolLog(): Promise<ToolLogEntry[]> {
  const r = await readAppCacheDetailed<unknown>(TOOL_LOG_KEY);
  return r.ok && r.row ? sanitizeLog(r.row.value) : [];
}

// Appends are SERIALISED per instance (a promise chain): two actions milliseconds apart would
// otherwise both read the same row and the second write would drop the first entry (seen in the
// route smoke). Cross-instance overlap remains possible and is accepted for a best-effort trail.
let chain: Promise<unknown> = Promise.resolve();

async function appendNow(entry: ToolLogEntry): Promise<boolean> {
  try {
    const r = await readAppCacheDetailed<unknown>(TOOL_LOG_KEY);
    if (!r.ok) return false; // store unreachable → the action already happened; nothing to record
    const current = r.row ? sanitizeLog(r.row.value) : [];
    const id = await writeAppCache(TOOL_LOG_KEY, pushLog(current, entry), r.row?.documentId ?? null);
    return Boolean(id);
  } catch {
    return false;
  }
}

/** Append (queued behind any append in flight). Never throws; resolves with whether the row was
 *  written. Routes schedule it with next/server `after()` so the answer is not delayed and the
 *  write still completes on a serverless instance. */
export function appendToolLog(entry: Omit<ToolLogEntry, "at"> & { at?: number }): Promise<boolean> {
  const full: ToolLogEntry = { ...entry, at: entry.at ?? Date.now() };
  const p = chain.then(() => appendNow(full));
  chain = p.catch(() => false);
  return p;
}
