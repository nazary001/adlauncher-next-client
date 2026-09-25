// TOOL Sessions console — MODEL + pure helpers (owner ask 2026-09-25: run the Ads Manager
// SESSIONS of https://tool.gctracking.xyz from inside Ad Launcher — list, add, check, refresh
// credentials, disable/enable, delete, read the history / accounts / jobs of every session).
// The I/O (the bearer key, HTTP) lives in lib/tool-sessions; this file carries the wire shapes,
// the vocabularies and every validation decision, and is deliberately dependency-free (no "@/"
// imports) so `node --test tests/tool-sessions-model.test.ts` runs it straight off Node's type
// stripping.
//
// Contract read on 2026-09-25 from /api/openapi.json (TOOL Sessions API 1.0) and the owner's
// API_GUIDE.md: SessionOut / SessionCreate / SessionUpdate / JobOut / JobEventOut; error bodies
// are always {error, message, field?, problems?}.

// ---- wire shapes (what TOOL answers) -----------------------------------------------------------

/** One ad account as a session's last check saw it (FB account_status code in `status`). */
export type ToolAccount = { account_id: string; name: string; currency: string; status: number };

export type ToolSession = {
  id: number;
  team_id: number;
  name: string;
  kind: string;
  profile_slug: string | null;
  fb_user_id: string | null;
  fb_user_name: string | null;
  status: string;
  token_masked: string;
  token_kind: string | null;
  cookie_names: string[];
  cookies_captured_at: string | null;
  user_agent: string | null;
  proxy_masked: string | null;
  egress_ip_browser: string | null;
  egress_ip_proxy: string | null;
  ip_match: boolean | null;
  accounts: ToolAccount[];
  /** Owner-set restriction (empty = every account the session sees). */
  account_ids: string[];
  graph_version: string;
  last_check_at: string | null;
  last_check_error: string | null;
  last_used_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

/** The list row the board renders: a session WITHOUT its (300+) accounts, plus their summary. */
export type ToolSessionRow = Omit<ToolSession, "accounts"> & { accountsSummary: AccountsSummary };

export type ToolSessionEvent = {
  id: number;
  session_id: number;
  ts: string;
  kind: string;
  actor: string;
  details: Record<string, unknown> | null;
};

export type ToolJob = {
  id: number;
  job_id: number | null;
  scheduled_at: string | null;
  team_id: number;
  session_id: number | null;
  engine: string;
  kind: string;
  account_id: string | null;
  client_request_id: string | null;
  status: string;
  stage: string;
  mode: string;
  priority: number;
  payload?: Record<string, unknown>;
  normalized?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  draft_id: string | null;
  fragment_ids: string[];
  async_request_set_ids: string[];
  result: Record<string, unknown> | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  events_url: string | null;
};

/** What the board gets per job: the heavy payload / normalized / plan blobs are dropped and a
 *  one-line `summary` is derived from the result or the error. */
export type ToolJobView = Omit<ToolJob, "payload" | "normalized" | "plan"> & { summary: string };

export type ToolJobEvent = { id: number; ts: string; step: string; level: string; message: string; meta: Record<string, unknown> | null };

export type ToolMe = { actor: string; team_id: number; teams: number[]; is_hs_admin: boolean; scopes: string[] };

/** A team-wide account (GET /accounts) with the sessions that see it. */
export type ToolTeamAccount = ToolAccount & { sessions: { id: number; name: string }[] };

// ---- vocabularies ------------------------------------------------------------------------------

export const SESSION_KINDS = ["adsmanager_session", "marketing_token"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const isSessionKind = (v: unknown): v is SessionKind => typeof v === "string" && (SESSION_KINDS as readonly string[]).includes(v);
export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  adsmanager_session: "Ads Manager session",
  marketing_token: "Marketing API token",
};
export const SESSION_KIND_HINT: Record<SessionKind, string> = {
  adsmanager_session: "Token + cookies + User-Agent (+ proxy) captured from ONE logged-in Ads Manager profile.",
  marketing_token: "A system-user / long-lived Graph token — no cookies; reads sources another session cannot see.",
};

/** Statuses TOOL sets: active (checked OK), expired (FB 190/102 on a check), disabled (owner). */
export const SESSION_STATUSES = ["active", "expired", "disabled"] as const;
export type SessionTone = "ok" | "warn" | "danger" | "dim";
export function sessionStatusTone(status: string): SessionTone {
  const s = String(status ?? "").toLowerCase();
  if (s === "active") return "ok";
  if (s === "disabled") return "dim";
  if (s === "expired" || s === "error" || s === "invalid") return "danger";
  return "warn";
}

export const JOB_KINDS = ["session.check", "campaign.create", "duplicate", "media.upload"] as const;
export const JOB_STATUSES = ["queued", "retry", "running", "done", "partial", "error", "unknown", "canceled"] as const;
const TERMINAL_JOB = new Set(["done", "partial", "error", "unknown", "canceled"]);
/** A job that will not move again on its own (the poll can stop). */
export const isTerminalJob = (status: string): boolean => TERMINAL_JOB.has(String(status ?? "").toLowerCase());
/** TOOL's own rule: retry re-runs error/unknown jobs; cancel takes queued/retry ones. */
export const jobCanRetry = (status: string): boolean => ["error", "unknown"].includes(String(status ?? "").toLowerCase());
export const jobCanCancel = (status: string): boolean => ["queued", "retry"].includes(String(status ?? "").toLowerCase());
export function jobStatusTone(status: string): SessionTone | "accent" {
  const s = String(status ?? "").toLowerCase();
  if (s === "done") return "ok";
  if (s === "partial") return "warn";
  if (s === "error" || s === "unknown") return "danger";
  if (s === "canceled") return "dim";
  return "accent"; // queued / retry / running
}

/** Facebook `account_status` codes (Marketing API AdAccount reference). */
export const ACCOUNT_STATUS_LABEL: Record<number, string> = {
  1: "active",
  2: "disabled",
  3: "unsettled",
  7: "pending risk review",
  8: "pending settlement",
  9: "in grace period",
  100: "pending closure",
  101: "closed",
  201: "any active",
  202: "any closed",
};
export const accountStatusLabel = (code: number): string => ACCOUNT_STATUS_LABEL[code] ?? `status ${code}`;
export const accountStatusTone = (code: number): SessionTone => (code === 1 ? "ok" : code === 2 || code === 101 || code === 100 ? "danger" : "warn");

export type AccountsSummary = { total: number; active: number; other: number };
export function summarizeAccounts(accounts: unknown): AccountsSummary {
  const list = Array.isArray(accounts) ? accounts : [];
  let active = 0;
  for (const a of list) if (Number((a as { status?: unknown })?.status) === 1) active++;
  return { total: list.length, active, other: list.length - active };
}

// ---- shape guards (a foreign / partial answer must never crash the board) --------------------

const str = (v: unknown): string => (v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) ? Number(v) : d);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export function toAccount(v: unknown): ToolAccount {
  const r = rec(v);
  return { account_id: str(r.account_id).replace(/^act_/, ""), name: str(r.name), currency: str(r.currency), status: num(r.status, 0) };
}

export function toSession(v: unknown): ToolSession {
  const r = rec(v);
  return {
    id: num(r.id),
    team_id: num(r.team_id),
    name: str(r.name),
    kind: str(r.kind) || "adsmanager_session",
    profile_slug: strOrNull(r.profile_slug),
    fb_user_id: strOrNull(r.fb_user_id),
    fb_user_name: strOrNull(r.fb_user_name),
    status: str(r.status) || "unknown",
    token_masked: str(r.token_masked),
    token_kind: strOrNull(r.token_kind),
    cookie_names: strList(r.cookie_names),
    cookies_captured_at: strOrNull(r.cookies_captured_at),
    user_agent: strOrNull(r.user_agent),
    proxy_masked: strOrNull(r.proxy_masked),
    egress_ip_browser: strOrNull(r.egress_ip_browser),
    egress_ip_proxy: strOrNull(r.egress_ip_proxy),
    ip_match: typeof r.ip_match === "boolean" ? r.ip_match : null,
    accounts: Array.isArray(r.accounts) ? r.accounts.map(toAccount) : [],
    account_ids: strList(r.account_ids),
    graph_version: str(r.graph_version),
    last_check_at: strOrNull(r.last_check_at),
    last_check_error: strOrNull(r.last_check_error),
    last_used_at: strOrNull(r.last_used_at),
    source: str(r.source),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

export function toSessionRow(v: unknown): ToolSessionRow {
  const s = toSession(v);
  const { accounts, ...rest } = s;
  return { ...rest, accountsSummary: summarizeAccounts(accounts) };
}

export function toSessionEvent(v: unknown): ToolSessionEvent {
  const r = rec(v);
  return { id: num(r.id), session_id: num(r.session_id), ts: str(r.ts), kind: str(r.kind), actor: str(r.actor), details: r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null };
}

export function toJobEvent(v: unknown): ToolJobEvent {
  const r = rec(v);
  return { id: num(r.id), ts: str(r.ts), step: str(r.step), level: str(r.level), message: str(r.message), meta: r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : null };
}

/** One line for a job's outcome, by kind — the tool's own Jobs page shows the raw result dict. */
export function jobSummary(kind: string, status: string, result: Record<string, unknown> | null, error: string | null): string {
  if (error) return error;
  const r = rec(result);
  const k = String(kind ?? "");
  if (k === "session.check") {
    const parts: string[] = [];
    if (r.status) parts.push(str(r.status));
    if (r.accounts != null) parts.push(`${num(r.accounts)} accounts`);
    if (r.egress_ip) parts.push(`egress ${str(r.egress_ip)}`);
    if (r.ip_match === true) parts.push("ip matches");
    if (r.ip_match === false) parts.push("ip MISMATCH");
    return parts.join(" · ");
  }
  if (Array.isArray(r.checks)) {
    const checks = r.checks as Array<{ ok?: unknown; check?: unknown; detail?: unknown }>;
    const bad = checks.filter((c) => c?.ok !== true);
    return bad.length ? `${bad.length}/${checks.length} checks failed: ${bad.map((c) => `${str(c.check)} — ${str(c.detail)}`).join("; ")}` : `${checks.length}/${checks.length} checks ok`;
  }
  const created = rec(r.created);
  if (created.campaign_id) {
    const adsets = strList(created.adset_ids).length;
    const ads = strList(created.ad_ids).length;
    return `campaign ${str(created.campaign_id)}${adsets ? ` · ${adsets} adset${adsets === 1 ? "" : "s"}` : ""}${ads ? ` · ${ads} ad${ads === 1 ? "" : "s"}` : ""}`;
  }
  if (r.campaign_id) return `campaign ${str(r.campaign_id)}`;
  if (r.media_id || r.type) return [str(r.type), str(r.media_id) || str(r.id), str(r.status)].filter(Boolean).join(" ");
  const keys = Object.keys(r);
  if (!keys.length) return status === "done" ? "done" : "";
  return keys
    .slice(0, 4)
    .map((key) => `${key}: ${typeof r[key] === "object" ? JSON.stringify(r[key]).slice(0, 60) : str(r[key]).slice(0, 60)}`)
    .join(" · ");
}

export function toJobView(v: unknown): ToolJobView {
  const r = rec(v);
  const result = r.result && typeof r.result === "object" ? (r.result as Record<string, unknown>) : null;
  const error = strOrNull(r.error);
  const status = str(r.status);
  const kind = str(r.kind);
  return {
    id: num(r.id),
    job_id: r.job_id == null ? null : num(r.job_id),
    scheduled_at: strOrNull(r.scheduled_at),
    team_id: num(r.team_id),
    session_id: r.session_id == null ? null : num(r.session_id),
    engine: str(r.engine),
    kind,
    account_id: strOrNull(r.account_id),
    client_request_id: strOrNull(r.client_request_id),
    status,
    stage: str(r.stage),
    mode: str(r.mode),
    priority: num(r.priority),
    draft_id: strOrNull(r.draft_id),
    fragment_ids: strList(r.fragment_ids),
    async_request_set_ids: strList(r.async_request_set_ids),
    result,
    error,
    error_code: strOrNull(r.error_code),
    attempts: num(r.attempts),
    created_at: str(r.created_at),
    started_at: strOrNull(r.started_at),
    finished_at: strOrNull(r.finished_at),
    updated_at: str(r.updated_at),
    events_url: strOrNull(r.events_url),
    summary: jobSummary(kind, status, result, error),
  };
}

export function toMe(v: unknown): ToolMe {
  const r = rec(v);
  return { actor: str(r.actor), team_id: num(r.team_id), teams: Array.isArray(r.teams) ? r.teams.map((t) => num(t)) : [], is_hs_admin: r.is_hs_admin === true, scopes: strList(r.scopes) };
}

export function toTeamAccount(v: unknown): ToolTeamAccount {
  const r = rec(v);
  const sessions = Array.isArray(r.sessions) ? r.sessions.map((s) => ({ id: num(rec(s).id), name: str(rec(s).name) })) : [];
  return { ...toAccount(r), sessions };
}

/** Scopes a key needs per action — the board greys out what the key cannot do. */
export const SCOPE_OF = {
  read: "sessions:read",
  write: "sessions:write",
  jobsRead: "jobs:read",
  jobsWrite: "jobs:write",
  accounts: "accounts:read",
} as const;
export const hasScope = (me: ToolMe | null | undefined, scope: string): boolean => Boolean(me?.scopes.includes(scope));

// ---- session history → one sentence -------------------------------------------------------------

/** The tool's history rows carry {kind, actor, details}; this turns them into a sentence the
 *  owner can read at a glance ("Checked — Анастасия · 302 accounts · egress 193.193.217.60"). */
export function describeSessionEvent(ev: ToolSessionEvent): string {
  const d = rec(ev.details);
  switch (ev.kind) {
    case "created": {
      const bits = [str(d.kind), str(d.source) ? `source ${str(d.source)}` : "", Array.isArray(d.cookie_names) ? `${d.cookie_names.length} cookies` : "", str(d.proxy) ? `proxy ${str(d.proxy)}` : ""].filter(Boolean);
      return `Created${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
    }
    case "updated": {
      const changed = strList(d.changed);
      return `Updated${changed.length ? ` — ${changed.join(", ")}` : ""}`;
    }
    case "checked": {
      const bits = [str(d.fb_user), d.accounts != null ? `${num(d.accounts)} accounts` : "", str(d.egress_ip) ? `egress ${str(d.egress_ip)}` : "", d.ip_match === true ? "ip matches" : d.ip_match === false ? "ip MISMATCH" : ""].filter(Boolean);
      return `Checked${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
    }
    case "check_failed":
      return `Check failed — ${str(d.error) || "unknown error"}`;
    case "disabled":
      return "Disabled";
    case "enabled":
      return "Enabled";
    case "deleted":
      return "Deleted";
    case "expired":
      return `Marked expired${str(d.error) ? ` — ${str(d.error)}` : ""}`;
    default: {
      const keys = Object.keys(d);
      return keys.length ? `${ev.kind} — ${keys.slice(0, 4).map((k) => `${k}: ${typeof d[k] === "object" ? JSON.stringify(d[k]).slice(0, 50) : str(d[k]).slice(0, 50)}`).join(" · ")}` : ev.kind || "event";
    }
  }
}

/** "user:hs:vanee4ka" → "vanee4ka (user)", "key:hst_P1aFCVPi" → "key hst_P1aFCVPi", "import:hs-settings" → "import hs-settings". */
export function describeActor(actor: string): string {
  const a = String(actor ?? "");
  const m = /^(user|key|import|system|worker):(.*)$/.exec(a);
  if (!m) return a || "—";
  if (m[1] === "user") return `${m[2].split(":").pop()} (user)`;
  return `${m[1]} ${m[2]}`;
}

// ---- input validation (what the owner types → what goes to TOOL) --------------------------------

export type Problem = { ok: false; error: string; field: string };
export type CreateBody = {
  name: string;
  kind: SessionKind;
  token: string;
  cookies?: string;
  user_agent?: string;
  proxy?: string;
  profile_slug?: string;
  account_ids?: string[];
  accept_language?: string;
  check_now: boolean;
  source: "api";
};
export type UpdateBody = {
  token?: string;
  cookies?: string;
  user_agent?: string;
  proxy?: string;
  profile_slug?: string;
  account_ids?: string[];
  accept_language?: string;
  status?: "active" | "disabled";
  check_now: boolean;
};

const NAME_RE = /^[\p{L}\p{N} ._()#/+-]{2,80}$/u;
const SLUG_RE = /^[\p{L}\p{N}._-]{1,80}$/u;
const TOKEN_MIN = 20;
/** The two cookies an Ads Manager session cannot work without (the logged-in user + its secret). */
export const REQUIRED_AM_COOKIES = ["c_user", "xs"] as const;
export const PROXY_SCHEMES = ["socks5h", "socks5", "socks4", "http", "https"] as const;

export const normalizeName = (v: unknown): string => str(v).trim().replace(/\s+/g, " ");
export const validName = (name: string): boolean => NAME_RE.test(name);

/** A pasted token: whitespace trimmed; refused when it still carries whitespace or is too short. */
export function normalizeToken(v: unknown): string {
  return str(v).trim();
}
export const tokenProblem = (token: string): string | null =>
  token.length < TOKEN_MIN ? `token is too short (${token.length} chars, ${TOKEN_MIN}+ expected) — paste the full access token` : /\s/.test(token) ? "token contains whitespace — paste ONE token, nothing else" : null;

/** Turn whatever the owner pasted into a Cookie header: a `name=value; …` string (a leading
 *  `Cookie:` label is dropped), OR a JSON array export ([{name, value, …}], the EditThisCookie /
 *  Cookie-Editor shape). Empty → "". */
export function normalizeCookies(v: unknown): string {
  let s = str(v).trim();
  if (!s) return "";
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        const pairs = arr
          .map((c) => rec(c))
          .filter((c) => str(c.name))
          .map((c) => `${str(c.name)}=${str(c.value)}`);
        if (pairs.length) return pairs.join("; ");
      }
    } catch {
      /* not JSON — fall through to the header shape */
    }
  }
  s = s.replace(/^cookie\s*:\s*/i, "");
  // Collapse line breaks (a header copied over several lines) into the `; ` separator.
  return s
    .split(/;|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("; ");
}
export function cookieNames(header: string): string[] {
  return normalizeCookies(header)
    .split(";")
    .map((p) => p.trim().split("=")[0].trim())
    .filter(Boolean);
}
/** null = fine; otherwise why this cookie string cannot drive an Ads Manager session. */
export function cookiesProblem(header: string): string | null {
  const s = normalizeCookies(header);
  if (!s) return "cookies are required for an Ads Manager session — paste the Cookie string of the logged-in profile";
  const pairs = s.split(";").map((p) => p.trim());
  if (pairs.some((p) => !p.includes("="))) return "cookies must look like name=value; name2=value2";
  const names = new Set(cookieNames(s));
  const missing = REQUIRED_AM_COOKIES.filter((n) => !names.has(n));
  return missing.length ? `cookies are missing ${missing.join(" and ")} — copy them from the same logged-in profile` : null;
}

/** null = fine; otherwise why this is not a proxy URL TOOL can use. */
export function proxyProblem(raw: string): string | null {
  const s = str(raw).trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "proxy must be a URL like socks5h://user:pass@host:port";
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!(PROXY_SCHEMES as readonly string[]).includes(scheme)) return `proxy scheme "${scheme}" is not supported — use ${PROXY_SCHEMES.join(" / ")}`;
  if (!u.hostname) return "proxy needs a host";
  if (!u.port) return "proxy needs a port (host:port)";
  return null;
}
/** socks5h://login:pass@host:port → socks5h://***:***@host:port (for our own change log only —
 *  TOOL never returns the secret either). */
export function maskProxy(raw: string): string {
  const s = str(raw).trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const auth = u.username || u.password ? "***:***@" : "";
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return "***";
  }
}

/** "act_123, 456 789;0011" → ["123","456","789","0011"]; a token that is not a plain id is reported. */
export function parseAccountIds(v: unknown): { ids: string[]; bad: string[] } {
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(/[\s,;|]+/);
  const ids: string[] = [];
  const bad: string[] = [];
  for (const t of raw) {
    const s = t.trim().replace(/^act_/, "");
    if (!s) continue;
    if (!/^\d{6,20}$/.test(s)) {
      bad.push(t.trim());
      continue;
    }
    if (!ids.includes(s)) ids.push(s);
  }
  return { ids, bad };
}

export type CreateInput = {
  name?: unknown;
  kind?: unknown;
  token?: unknown;
  cookies?: unknown;
  user_agent?: unknown;
  proxy?: unknown;
  profile_slug?: unknown;
  account_ids?: unknown;
  accept_language?: unknown;
  check_now?: unknown;
};

/** The whole create form → the exact SessionCreate body, or the first problem (with its field).
 *  An Ads Manager session must bring cookies (with c_user + xs) and a User-Agent; a marketing
 *  token brings neither (those fields are dropped, not refused). */
export function validateSessionCreate(input: CreateInput): { ok: true; body: CreateBody; warnings: string[] } | Problem {
  const name = normalizeName(input.name);
  if (!validName(name)) return { ok: false, field: "name", error: "name: 2–80 chars — letters, digits, space . _ ( ) # / + -" };
  const kind: SessionKind = input.kind == null || input.kind === "" ? "adsmanager_session" : isSessionKind(input.kind) ? input.kind : ("" as never);
  if (!kind) return { ok: false, field: "kind", error: `kind must be one of ${SESSION_KINDS.join(" / ")}` };
  const token = normalizeToken(input.token);
  const tp = tokenProblem(token);
  if (tp) return { ok: false, field: "token", error: tp };
  const warnings: string[] = [];
  const body: CreateBody = { name, kind, token, check_now: input.check_now !== false, source: "api" };

  if (kind === "adsmanager_session") {
    const cookies = normalizeCookies(input.cookies);
    const cp = cookiesProblem(cookies);
    if (cp) return { ok: false, field: "cookies", error: cp };
    body.cookies = cookies;
    const ua = str(input.user_agent).trim();
    if (ua.length < 10) return { ok: false, field: "user_agent", error: "user_agent is required for an Ads Manager session — the browser's User-Agent of the same profile" };
    body.user_agent = ua.slice(0, 512);
  }
  const proxy = str(input.proxy).trim();
  if (proxy) {
    const pp = proxyProblem(proxy);
    if (pp) return { ok: false, field: "proxy", error: pp };
    body.proxy = proxy;
  } else if (kind === "adsmanager_session") {
    warnings.push("no proxy — TOOL will reach Facebook from its own IP, which may not match the profile's egress IP");
  }
  const slug = str(input.profile_slug).trim();
  if (slug) {
    if (!SLUG_RE.test(slug)) return { ok: false, field: "profile_slug", error: "profile_slug: 1–80 chars — letters, digits . _ -" };
    body.profile_slug = slug;
  }
  if (input.account_ids != null && str(input.account_ids).trim() !== "") {
    const { ids, bad } = parseAccountIds(input.account_ids);
    if (bad.length) return { ok: false, field: "account_ids", error: `account ids must be plain digits (act_ is fine): ${bad.slice(0, 3).join(", ")}` };
    if (ids.length) body.account_ids = ids;
  }
  const lang = str(input.accept_language).trim();
  if (lang) {
    if (lang.length > 64) return { ok: false, field: "accept_language", error: "accept_language is too long" };
    body.accept_language = lang;
  }
  return { ok: true, body, warnings };
}

export type UpdateInput = CreateInput & { status?: unknown; clear_account_ids?: unknown };

/** The update form → a SessionUpdate body carrying ONLY what changes (TOOL patches a subset).
 *  Blank fields are left out, never sent as empty strings; `clear_account_ids` sends [] (= every
 *  account the session sees). At least one change is required. */
export function validateSessionUpdate(input: UpdateInput): { ok: true; body: UpdateBody; changed: string[] } | Problem {
  const body: UpdateBody = { check_now: input.check_now !== false };
  const changed: string[] = [];
  const token = normalizeToken(input.token);
  if (token) {
    const tp = tokenProblem(token);
    if (tp) return { ok: false, field: "token", error: tp };
    body.token = token;
    changed.push("token");
  }
  const cookies = normalizeCookies(input.cookies);
  if (cookies) {
    const cp = cookiesProblem(cookies);
    if (cp) return { ok: false, field: "cookies", error: cp };
    body.cookies = cookies;
    changed.push("cookies");
  }
  const ua = str(input.user_agent).trim();
  if (ua) {
    if (ua.length < 10) return { ok: false, field: "user_agent", error: "user_agent looks too short" };
    body.user_agent = ua.slice(0, 512);
    changed.push("user_agent");
  }
  const proxy = str(input.proxy).trim();
  if (proxy) {
    const pp = proxyProblem(proxy);
    if (pp) return { ok: false, field: "proxy", error: pp };
    body.proxy = proxy;
    changed.push("proxy");
  }
  const slug = str(input.profile_slug).trim();
  if (slug) {
    if (!SLUG_RE.test(slug)) return { ok: false, field: "profile_slug", error: "profile_slug: 1–80 chars — letters, digits . _ -" };
    body.profile_slug = slug;
    changed.push("profile_slug");
  }
  if (input.clear_account_ids === true) {
    body.account_ids = [];
    changed.push("account_ids");
  } else if (input.account_ids != null && str(input.account_ids).trim() !== "") {
    const { ids, bad } = parseAccountIds(input.account_ids);
    if (bad.length) return { ok: false, field: "account_ids", error: `account ids must be plain digits (act_ is fine): ${bad.slice(0, 3).join(", ")}` };
    body.account_ids = ids;
    changed.push("account_ids");
  }
  const lang = str(input.accept_language).trim();
  if (lang) {
    if (lang.length > 64) return { ok: false, field: "accept_language", error: "accept_language is too long" };
    body.accept_language = lang;
    changed.push("accept_language");
  }
  if (input.status != null && input.status !== "") {
    const s = str(input.status).toLowerCase();
    if (s !== "active" && s !== "disabled") return { ok: false, field: "status", error: "status must be active or disabled" };
    body.status = s;
    changed.push("status");
  }
  if (!changed.length) return { ok: false, field: "", error: "nothing to update — fill at least one field" };
  return { ok: true, body, changed };
}

/** Jobs list filters as the board sends them → the query TOOL accepts (unknown values dropped). */
export function normalizeJobFilters(q: Record<string, unknown>): { session_id?: number; kind?: string; status?: string; limit: number; offset: number } {
  const out: { session_id?: number; kind?: string; status?: string; limit: number; offset: number } = { limit: 50, offset: 0 };
  const sid = Number(q.session_id);
  if (Number.isInteger(sid) && sid > 0) out.session_id = sid;
  const kind = str(q.kind).trim();
  if (kind && (JOB_KINDS as readonly string[]).includes(kind)) out.kind = kind;
  const status = str(q.status).trim().toLowerCase();
  if (status && (JOB_STATUSES as readonly string[]).includes(status)) out.status = status;
  const limit = Number(q.limit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 200) out.limit = limit;
  const offset = Number(q.offset);
  if (Number.isInteger(offset) && offset >= 0) out.offset = offset;
  return out;
}

/** Path ids come in as strings: only a positive integer is a TOOL id. */
export function parseToolId(raw: unknown): number | null {
  const s = str(raw).trim();
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// ---- our own change log (lib/tool-sessions-log stores it; the pure parts live here for tests) -----

export const MAX_LOG_ENTRIES = 60;
export type ToolLogKind = "create" | "update" | "status" | "delete" | "check" | "job";
export type ToolLogEntry = { at: number; by: string; kind: ToolLogKind; sessionId: number | null; name: string; text: string };
const LOG_KINDS: readonly ToolLogKind[] = ["create", "update", "status", "delete", "check", "job"];

/** Shape-guard a stored list (a foreign/corrupt row must not crash the board). */
export function sanitizeLog(value: unknown): ToolLogEntry[] {
  const list = Array.isArray(value) ? value : [];
  const out: ToolLogEntry[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Partial<ToolLogEntry>;
    const at = Number(r.at);
    const kind = LOG_KINDS.includes(r.kind as ToolLogKind) ? (r.kind as ToolLogKind) : null;
    if (!Number.isFinite(at) || at <= 0 || !kind) continue;
    const sid = Number(r.sessionId);
    out.push({ at, by: str(r.by).slice(0, 80), kind, sessionId: Number.isInteger(sid) && sid > 0 ? sid : null, name: str(r.name).slice(0, 80), text: str(r.text).slice(0, 300) });
    if (out.length >= MAX_LOG_ENTRIES) break;
  }
  return out;
}

/** Pure: prepend one entry, keep the cap (newest first). */
export function pushLog(list: ToolLogEntry[], entry: ToolLogEntry, max = MAX_LOG_ENTRIES): ToolLogEntry[] {
  return [entry, ...list].slice(0, max);
}
