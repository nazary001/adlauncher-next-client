// Which partner a cabinet TOOL sees belongs to — PURE (no imports), so the picker (/api/tool/ready),
// the fire-time checks (/api/av/launch, /api/clone/run, /api/vc/launch, lib/vc-clone-run) and
// `node --test tests/tool-partner.test.ts` share ONE rule.
//
// Owner 24.11: «А можно не привязываться к неймингу а сделать чтобы с tool по сесии определяло какой
// это партнер и туда и были добавлены аки?» — nine cabinets moved to AV still carried their old name
// (GC-for-VC-T4Y-UTC-19…27): the sessions that hold them were filed under TOOL's "AV" project, yet the
// launcher read the NAME, offered them to VC and hid them from AV.
//
// The rule: a cabinet belongs to the partner whose TOOL project one of its live sessions is filed
// under — the session's word wins over the name. Only a cabinet that no partner's session sees is read
// by its name, as before (GC-AV-… / GC-for-VC-…): its sessions are filed under no partner's project,
// or TOOL could not give the session list at all. Two cabinets are never a partner's by its sessions
// alone, they keep the name's verdict: the profile's own personal cabinet (TOOL lists it next to the
// business ones; its name is the profile's — «Елена Тимофеева» under av-04), and a cabinet that carries
// another rail's name (HS: one session filed under the wrong project would pour hundreds of GC-HS-…
// cabinets into the picker).

export type ToolPartnerId = "av" | "vc";

/** The TOOL project a partner's sessions are filed under (TOOL → Sessions / Inbox → project). */
export const TOOL_PARTNER_PROJECT: Readonly<Record<ToolPartnerId, string>> = { av: "AV", vc: "VC" };
/** A partner's cabinets by NAME — the fallback for a cabinet no partner's session sees. */
export const TOOL_PARTNER_NAME: Readonly<Record<ToolPartnerId, RegExp>> = { av: /^GC-AV-/i, vc: /^GC-for-VC-/i };

const PARTNERS: readonly ToolPartnerId[] = ["av", "vc"];

/** A TOOL account row, as far as the rule reads it (lib/tool-sessions-model ToolTeamAccount). */
export type ToolPartnerAccount = { name?: string | null; sessions?: readonly { id: number }[] | null };
/** A TOOL session, as far as the rule reads it (lib/tool-run ToolSessionInfo). */
export type ToolPartnerSession = { project?: string | null; profile?: string | null; status?: string | null };
/** The team's sessions by id; null / undefined = TOOL could not give the list. */
export type ToolPartnerDirectory = ReadonlyMap<number, ToolPartnerSession> | null | undefined;
export type ToolPartnerOpts = {
  /** Is this cabinet NAME another rail's (lib/team teamHsToolAccount)? Such a cabinet is never a
   *  partner's by its sessions alone. */
  otherRail?: (name: string) => boolean;
};

const projectKey = (v: unknown): string => String(v ?? "").trim().toUpperCase();
const person = (v: unknown): string => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The partners a cabinet NAME names (GC-AV-… → av, GC-for-VC-… → vc), [] for any other name. */
export function toolPartnersByName(name: string | null | undefined): ToolPartnerId[] {
  const n = String(name ?? "").trim();
  return PARTNERS.filter((p) => TOOL_PARTNER_NAME[p].test(n));
}

/**
 * The partners a TOOL-visible cabinet belongs to. A session speaks only while TOOL knows it as
 * `active` (an expired one holds nothing live); a cabinet seen by sessions of two partners' projects
 * is both partners'.
 */
export function toolAccountPartners(account: ToolPartnerAccount, directory: ToolPartnerDirectory, opts: ToolPartnerOpts = {}): ToolPartnerId[] {
  const name = String(account?.name ?? "").trim();
  const byName = toolPartnersByName(name);
  if (!directory) return byName;
  const live: ToolPartnerSession[] = [];
  for (const s of account?.sessions ?? []) {
    const known = directory.get(s.id);
    if (known && known.status === "active") live.push(known);
  }
  const filed = PARTNERS.filter((p) => live.some((s) => projectKey(s.project) === TOOL_PARTNER_PROJECT[p]));
  if (filed.length === 0) return byName;
  if (opts.otherRail?.(name)) return byName;
  const own = person(name);
  if (own && live.some((s) => person(s.profile) === own)) return byName;
  return filed;
}

/** The partner's cabinets among TOOL's accounts, in TOOL's order. */
export function toolPartnerAccounts<T extends ToolPartnerAccount>(
  partner: ToolPartnerId,
  accounts: readonly T[],
  directory: ToolPartnerDirectory,
  opts: ToolPartnerOpts = {},
): T[] {
  return accounts.filter((a) => toolAccountPartners(a, directory, opts).includes(partner));
}

/** How a refusal names what a partner's cabinet is — one wording for the picker and the fire-time checks. */
export const toolPartnerCabinetHint = (partner: ToolPartnerId): string =>
  `seen by a session of TOOL's "${TOOL_PARTNER_PROJECT[partner]}" project, or named ${partner === "av" ? "GC-AV-…" : "GC-for-VC-…"}`;
