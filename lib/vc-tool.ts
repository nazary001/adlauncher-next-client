// Server-only: VC's cabinets as TOOL sees them (owner ask 23.10 — VC through TOOL without a VC token).
// TOOL's live accounts (lib/tool-run toolLaunchReady) narrowed to VC's (lib/vc-link vcToolAccounts):
// named GC-VD-C1-DE-* or seen by a session filed under TOOL's "VC" project (the session directory).
// Shared by /api/tool/ready?partner=vc (the board's picker) and /api/vc/launch (the fire-time check).

import { toolLaunchReady, toolSessionDirectory } from "./tool-run";
import type { ToolTeamAccount } from "./tool-sessions-model";
import { VC_TOOL_PROJECT, vcToolAccounts } from "./vc-link";

export type VcToolCatalog =
  | { ok: true; live: ToolTeamAccount[]; vc: ToolTeamAccount[] }
  | { ok: false; reason: string; message: string };

/** TOOL's live accounts (`live`, for the "TOOL sees N" line) and VC's among them (`vc`). `force`
 *  re-reads TOOL (fire time — the 60 s cache may predate a session an owner just added). */
export async function vcToolCatalog(force = false): Promise<VcToolCatalog> {
  const ready = await toolLaunchReady(force);
  if (!ready.ok) return { ok: false, reason: ready.reason, message: ready.message };
  const dir = await toolSessionDirectory(force);
  const vc = vcToolAccounts(ready.accounts, (id) => dir?.get(id)?.project ?? null);
  return { ok: true, live: ready.accounts, vc };
}

/** The actionable sentence when TOOL is up but no session sees a VC cabinet. */
export const VC_TOOL_NO_SESSION =
  `no TOOL session sees VC's cabinets — an owner adds the session of the profile that holds them (GC-VD-C1-DE-…) on Ads Manager sessions and files it under the "${VC_TOOL_PROJECT}" project`;
