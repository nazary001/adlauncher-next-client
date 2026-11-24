// Server-only: VC's cabinets as TOOL sees them (owner ask 23.10 — VC through TOOL without a VC token).
// TOOL's live accounts narrowed to VC's by the one rule every partner shares (lib/tool-run
// toolPartnerCatalog → lib/tool-partner, owner ask 24.11): the cabinets a live session filed under
// TOOL's "VC" project sees, and — of the cabinets no partner's session sees — the ones named
// GC-for-VC-*. A cabinet a session of ANOTHER partner's project holds is that partner's, whatever its
// name says (the nine GC-for-VC-T4Y-UTC-… cabinets moved to AV, 24.11).
// Shared by /api/tool/ready?partner=vc (the board's picker), /api/vc/launch and lib/vc-clone-run (the
// fire-time checks).

import { toolPartnerCatalog } from "./tool-run";
import type { ToolTeamAccount } from "./tool-sessions-model";
import { VC_TOOL_PROJECT } from "./vc-link";

export type VcToolCatalog =
  | { ok: true; live: ToolTeamAccount[]; vc: ToolTeamAccount[] }
  | { ok: false; reason: string; message: string };

/** TOOL's live accounts (`live`, for the "TOOL sees N" line) and VC's among them (`vc`). `force`
 *  re-reads TOOL (fire time — the 60 s cache may predate a session an owner just added). */
export async function vcToolCatalog(force = false): Promise<VcToolCatalog> {
  const cat = await toolPartnerCatalog("vc", force);
  if (!cat.ok) return { ok: false, reason: cat.reason, message: cat.message };
  return { ok: true, live: cat.live, vc: cat.own };
}

/** The actionable sentence when TOOL is up but no session sees a VC cabinet. */
export const VC_TOOL_NO_SESSION =
  `no TOOL session sees VC's cabinets — an owner adds the session of the profile that holds them on Ads Manager sessions and files it under the "${VC_TOOL_PROJECT}" project`;
