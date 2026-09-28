// Server-only glue for the TOOL launch channel (owner ask 28.09). Three jobs, each a FULL body (no
// thin `return impl(...)` async wrappers — the Turbopack const-fold gotcha, spec §3):
//   • toolDeps       — the real transport + real sleep/now, an OBJECT the pure orchestration in
//                      lib/tool-launch (runToolMedia / runToolPublish / runToolDuplicate) is driven
//                      through, so routes never re-wire the transport.
//   • toolLaunchReady — is TOOL launchable at all right now (key configured, key scopes ⊇
//                      jobs:write + media:write + accounts:read, ≥1 live status-1 account), cached
//                      60s per instance with in-flight dedupe.
//   • toolInputFromCampaign — our Campaign → the normalized ToolBuildInput, so every route (and the
//                      card preview) maps the same way and no route hand-rolls parseMoney / ROAS.
// The TOOL key never leaves this process (lib/tool-sessions holds it).

import {
  createCampaign,
  createDuplicates,
  getJob,
  getMedia,
  jobEvents,
  mediaFromUrl,
  teamAccounts,
  toolConfigured,
  toolMe,
} from "./tool-sessions";
import { type ToolAccount, hasScope, toAccount } from "./tool-sessions-model";
import { type Campaign, bidKind, normalizeRoasGoal, parseMoney } from "./types";
import type { ToolBid, ToolBuildInput, ToolCreativeInput, ToolDeps } from "./tool-launch";

// ---- the injected dependency object (real transport + real clock) ------------------------------
// Direct bindings, not wrapper closures: the transport fns already carry the timeouts, the
// Idempotency-Key header and the never-throws contract; wrapping them would risk the const-fold
// gotcha and buy nothing.
export const toolDeps: ToolDeps = {
  createCampaign,
  createDuplicates,
  mediaFromUrl,
  getMedia,
  getJob,
  jobEvents,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
};

// ---- readiness (spec §2.3) ---------------------------------------------------------------------

export type ToolReadyReason = "not_configured" | "key_rejected" | "scope_missing" | "unreachable" | "no_live_session";
export type ToolReadyResult = { ok: true; accounts: ToolAccount[] } | { ok: false; reason: ToolReadyReason; message: string };

/** Scopes a launch through TOOL needs (jobs to write the create/duplicate job, media to register
 *  creatives, accounts to read the live roster). media:write is not in SCOPE_OF, so it is literal. */
const REQUIRED_SCOPES = ["jobs:write", "media:write", "accounts:read"] as const;

const READY_TTL_MS = 60_000;
let readyCache: { at: number; val: ToolReadyResult } | null = null;
let readyInflight: Promise<ToolReadyResult> | null = null;

/** Test/hot-reload seam — drop the readiness cache (mirrors _resetToolCaches in lib/tool-sessions). */
export function _resetToolRunCaches(): void {
  readyCache = null;
  readyInflight = null;
}

/** Compute readiness from scratch (key → scopes → GET /accounts, status-1 rows only). FULL body. */
async function computeReady(): Promise<ToolReadyResult> {
  if (!toolConfigured()) {
    return { ok: false, reason: "not_configured", message: "TOOL is not configured on this deployment — an owner sets TOOL_SESSIONS_API_KEY" };
  }
  const me = await toolMe();
  if (!me.ok) {
    if (me.status === 401 || me.error === "key_rejected") return { ok: false, reason: "key_rejected", message: me.message };
    return { ok: false, reason: "unreachable", message: me.message };
  }
  const missing = REQUIRED_SCOPES.filter((s) => !hasScope(me.data, s));
  if (missing.length) {
    return {
      ok: false,
      reason: "scope_missing",
      message: `TOOL key is missing scope${missing.length > 1 ? "s" : ""} ${missing.join(", ")} — an owner re-issues it with every scope on tool.gctracking.xyz/keys`,
    };
  }
  const acc = await teamAccounts();
  if (!acc.ok) {
    if (acc.status === 401 || acc.error === "key_rejected") return { ok: false, reason: "key_rejected", message: acc.message };
    if (acc.status === 403 || acc.error === "scope_missing") return { ok: false, reason: "scope_missing", message: acc.message };
    return { ok: false, reason: "unreachable", message: acc.message };
  }
  const rows = Array.isArray(acc.data?.accounts)
    ? acc.data.accounts.map(toAccount).filter((a) => a.status === 1)
    : [];
  if (rows.length === 0) {
    // GET /accounts is empty exactly when the only session is expired (live 26.09) — the actionable
    // read for a buyer is "an owner refreshes a session", not "TOOL is broken".
    return { ok: false, reason: "no_live_session", message: "No live TOOL session — an owner refreshes one on Ads Manager sessions" };
  }
  return { ok: true, accounts: rows };
}

/** Is TOOL launchable right now? Cached 60s per instance; in-flight calls dedupe. `force` skips the
 *  cache (fire-time re-check). */
export async function toolLaunchReady(force = false): Promise<ToolReadyResult> {
  if (!force && readyCache && Date.now() - readyCache.at < READY_TTL_MS) return readyCache.val;
  if (readyInflight) return readyInflight;
  readyInflight = (async () => {
    try {
      const val = await computeReady();
      readyCache = { at: Date.now(), val };
      return val;
    } finally {
      readyInflight = null;
    }
  })();
  return readyInflight;
}

/** Fire-time check: is this account among the live TOOL-visible ones? Forces ONE refresh on a miss
 *  (the 60s cache may predate an owner refreshing the session). */
export async function toolAccountVisible(accountId: string): Promise<boolean> {
  const id = String(accountId).replace(/^act_/, "");
  const hit = (r: ToolReadyResult): boolean => r.ok && r.accounts.some((a) => a.account_id === id);
  const cached = await toolLaunchReady();
  if (hit(cached)) return true;
  return hit(await toolLaunchReady(true));
}

// ---- Campaign → ToolBuildInput normalizer (spec §2.3) ------------------------------------------

/** Everything a launch needs that is NOT on the Campaign card itself: the final (marked) name, the
 *  resolved binds, the built creatives and the desired status/currency. */
export type ToolInputExtras = {
  /** Full campaign name AFTER withPartnerMark → toolEnsureMark (the client name is never trusted). */
  name: string;
  pageId: string;
  pixelId: string;
  /** Resolved FB locale ids (the card stores locale strings; the route resolves them). */
  localeIds: number[];
  /** Creatives with their TOOL MediaRefs already registered (runToolMedia output) + link + copy. */
  creatives: ToolCreativeInput[];
  status: "ACTIVE" | "PAUSED";
  adsetStartTime?: string;
  accountCurrency: string;
};

/**
 * Normalize a Campaign (+ resolved binds) into a ToolBuildInput. This is the ONE place bidKind /
 * normalizeRoasGoal / parseMoney run for TOOL, so routes hand buildToolCampaign a clean, human-unit
 * input (USD budget, ROAS coefficient). An ambiguous/invalid ROAS goal normalizes to coefficient 0
 * so buildToolCampaign refuses it cleanly ("roas_goal_invalid") — the launch routes' own guards
 * (isReady / hsCampaignError) already block such a card upstream, so this is only a backstop.
 */
export function toolInputFromCampaign(c: Campaign, extras: ToolInputExtras): ToolBuildInput {
  const kind = bidKind(c.bidStrategy);
  const raw = parseMoney(c.bidCap);
  let bid: ToolBid;
  if (kind === "roas") {
    const coefficient = normalizeRoasGoal(raw);
    bid = { kind: "roas", coefficient: coefficient ?? 0 };
  } else if (kind === "cap") {
    bid = { kind: "cap", usd: raw };
  } else {
    bid = { kind: "none" };
  }
  return {
    name: extras.name,
    objective: c.objective,
    budgetUsd: parseMoney(c.budget),
    bidStrategy: c.bidStrategy,
    bid,
    optimization: c.optimization,
    conversionEvent: c.conversionEvent,
    pixelId: extras.pixelId,
    pageId: extras.pageId,
    countries: c.countries,
    localeIds: extras.localeIds,
    category: c.category,
    placement: c.placement,
    ageMin: c.ageMin,
    userOs: c.userOs,
    adsetStartTime: extras.adsetStartTime,
    creatives: extras.creatives,
    status: extras.status,
    accountCurrency: extras.accountCurrency,
  };
}
