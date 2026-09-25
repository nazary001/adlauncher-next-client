// Node's built-in runner (v24 strips types natively): `node --test tests/tool-sessions-model.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TOOL Sessions console — the pure decisions: wire-shape guards, the create / update validators
// (what the owner types → the exact body TOOL gets), cookie / proxy / account-id parsing, job and
// history sentences, the change-log helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountStatusLabel,
  accountStatusTone,
  cookieNames,
  cookiesProblem,
  describeActor,
  describeSessionEvent,
  hasScope,
  isTerminalJob,
  jobCanCancel,
  jobCanRetry,
  jobStatusTone,
  jobSummary,
  maskProxy,
  normalizeCookies,
  normalizeJobFilters,
  parseAccountIds,
  parseToolId,
  proxyProblem,
  pushLog,
  sanitizeLog,
  sessionStatusTone,
  summarizeAccounts,
  toJobView,
  toMe,
  toSession,
  toSessionEvent,
  toSessionRow,
  toTeamAccount,
  tokenProblem,
  validateSessionCreate,
  validateSessionUpdate,
} from "../lib/tool-sessions-model.ts";

const TOKEN = "EAAB" + "x1y2z3".repeat(8);
const COOKIES = "c_user=100089523099541; xs=12%3Aabc%3A2%3A1758796369%3A-1%3A7245; datr=abc; fr=def; sb=ghi";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// A SessionOut as TOOL answered it on 2026-09-25 (secrets masked by TOOL itself).
const LIVE_SESSION = {
  id: 1,
  team_id: 1,
  name: "glo-01",
  kind: "adsmanager_session",
  profile_slug: "glo-01-43",
  fb_user_id: "100089523099541",
  fb_user_name: "Анастасия Александрова",
  status: "active",
  token_masked: "EAABs…ZDZD",
  token_kind: "adsmanager",
  cookie_names: ["c_user", "xs", "datr", "sb", "fr"],
  cookies_captured_at: "2026-09-25T10:32:49.459Z",
  user_agent: UA,
  proxy_masked: "socks5h://***:***@193.193.217.60:2832",
  egress_ip_browser: null,
  egress_ip_proxy: "193.193.217.60",
  ip_match: null,
  accounts: [
    { name: "GC-HS-VD-C1-BR-254", status: 1, currency: "USD", account_id: "2131779034281811" },
    { name: "GC-HS-VD-C1-LA-58", status: 2, currency: "USD", account_id: "act_2000974017479516" },
    { name: "GC-HS-VD-C1-BR-397", status: 1, currency: "USD", account_id: "2465819307214249" },
  ],
  account_ids: [],
  graph_version: "v22.0",
  last_check_at: "2026-09-25T11:20:37.063Z",
  last_check_error: null,
  last_used_at: "2026-09-25T12:59:49.742Z",
  source: "import",
  created_at: "2026-09-25T10:32:49.459Z",
  updated_at: "2026-09-25T12:59:49.742Z",
};

test("toSession / toSessionRow: guard the live shape, strip act_, summarise the accounts", () => {
  const s = toSession(LIVE_SESSION);
  assert.equal(s.id, 1);
  assert.equal(s.accounts.length, 3);
  assert.equal(s.accounts[1].account_id, "2000974017479516", "act_ prefix stripped");
  assert.deepEqual(summarizeAccounts(s.accounts), { total: 3, active: 2, other: 1 });
  const row = toSessionRow(LIVE_SESSION);
  assert.equal("accounts" in row, false, "the list row carries no account list");
  assert.deepEqual(row.accountsSummary, { total: 3, active: 2, other: 1 });
  assert.equal(row.cookie_names.length, 5);
  // A foreign / partial answer never throws.
  const junk = toSession({ id: "7", name: 42, accounts: "nope", cookie_names: [1, null], ip_match: "yes" });
  assert.equal(junk.id, 7);
  assert.equal(junk.name, "42");
  assert.deepEqual(junk.accounts, []);
  assert.deepEqual(junk.cookie_names, ["1"]);
  assert.equal(junk.ip_match, null);
  assert.equal(junk.status, "unknown");
  assert.deepEqual(toSession(null).accounts, []);
});

test("session status tones: active ok · disabled dim · expired danger · anything else warn", () => {
  assert.equal(sessionStatusTone("active"), "ok");
  assert.equal(sessionStatusTone("disabled"), "dim");
  assert.equal(sessionStatusTone("expired"), "danger");
  assert.equal(sessionStatusTone("pending"), "warn");
  assert.equal(sessionStatusTone(""), "warn");
});

test("job vocabulary: terminal set, retry / cancel rules, tones", () => {
  for (const s of ["done", "partial", "error", "unknown", "canceled"]) assert.equal(isTerminalJob(s), true, s);
  for (const s of ["queued", "retry", "running", ""]) assert.equal(isTerminalJob(s), false, s);
  assert.equal(jobCanRetry("error"), true);
  assert.equal(jobCanRetry("unknown"), true);
  assert.equal(jobCanRetry("done"), false);
  assert.equal(jobCanCancel("queued"), true);
  assert.equal(jobCanCancel("retry"), true);
  assert.equal(jobCanCancel("running"), false);
  assert.equal(jobStatusTone("done"), "ok");
  assert.equal(jobStatusTone("partial"), "warn");
  assert.equal(jobStatusTone("error"), "danger");
  assert.equal(jobStatusTone("canceled"), "dim");
  assert.equal(jobStatusTone("running"), "accent");
});

test("jobSummary: one line per kind — check, validate checks, created campaign, media, error first", () => {
  assert.equal(jobSummary("session.check", "done", { status: "active", accounts: 302, ip_match: null, egress_ip: "193.193.217.60" }, null), "active · 302 accounts · egress 193.193.217.60");
  assert.equal(jobSummary("session.check", "done", { status: "active", accounts: 3, ip_match: false }, null), "active · 3 accounts · ip MISMATCH");
  assert.equal(jobSummary("session.check", "error", { status: "active" }, "Facebook error HTTP 400 code=190"), "Facebook error HTTP 400 code=190");
  assert.equal(
    jobSummary("campaign.create", "done", { checks: [{ ok: true, check: "account", detail: "x" }, { ok: false, check: "page:807", detail: "недоступна кабинету" }] }, null),
    "1/2 checks failed: page:807 — недоступна кабинету",
  );
  assert.equal(jobSummary("campaign.create", "done", { checks: [{ ok: true, check: "account" }] }, null), "1/1 checks ok");
  assert.equal(jobSummary("campaign.create", "done", { created: { campaign_id: "120253810228480635", adset_ids: ["a"], ad_ids: ["b", "c"] } }, null), "campaign 120253810228480635 · 1 adset · 2 ads");
  assert.equal(jobSummary("duplicate", "done", { campaign_id: "1" }, null), "campaign 1");
  assert.equal(jobSummary("media.upload", "done", { id: 1, type: "image", status: "ready", media_id: "med_1" }, null), "image med_1 ready");
  assert.equal(jobSummary("x", "done", {}, null), "done");
  assert.equal(jobSummary("x", "queued", null, null), "");
  assert.match(jobSummary("x", "done", { foo: "bar", nested: { a: 1 } }, null), /foo: bar · nested: \{"a":1\}/);
});

test("toJobView drops payload / normalized / plan and derives the summary", () => {
  const v = toJobView({ id: 6, job_id: 6, team_id: 1, session_id: 1, engine: "session", kind: "campaign.create", account_id: "1702978257719186", status: "done", stage: "SUCCEEDED", mode: "publish", priority: 5, payload: { huge: true }, normalized: { huge: true }, plan: { huge: true }, result: { created: { campaign_id: "120253810228480635", adset_ids: [], ad_ids: [] } }, error: null, attempts: 1, created_at: "2026-09-25T11:38:03Z", updated_at: "2026-09-25T11:38:14Z" });
  assert.equal("payload" in v, false);
  assert.equal("normalized" in v, false);
  assert.equal("plan" in v, false);
  assert.equal(v.summary, "campaign 120253810228480635");
  assert.equal(v.session_id, 1);
  assert.equal(toJobView({ id: 2, session_id: null }).session_id, null);
});

test("history sentences: created / updated / checked / check_failed / unknown kinds; actors", () => {
  const ev = (kind: string, details: Record<string, unknown> | null, actor = "user:hs:vanee4ka") => toSessionEvent({ id: 1, session_id: 1, ts: "2026-09-25T11:20:37Z", kind, actor, details });
  assert.equal(describeSessionEvent(ev("created", { kind: "adsmanager_session", proxy: "socks5h://***:***@h:1", source: "import", cookie_names: ["c_user", "xs"] })), "Created — adsmanager_session · source import · 2 cookies · proxy socks5h://***:***@h:1");
  assert.equal(describeSessionEvent(ev("updated", { changed: ["token", "cookies"] })), "Updated — token, cookies");
  assert.equal(describeSessionEvent(ev("checked", { fb_user: "Анастасия Александрова", accounts: 302, ip_match: null, egress_ip: "193.193.217.60" })), "Checked — Анастасия Александрова · 302 accounts · egress 193.193.217.60");
  assert.equal(describeSessionEvent(ev("check_failed", { auth: true, error: "Facebook error HTTP 400 code=190: Error loading application" })), "Check failed — Facebook error HTTP 400 code=190: Error loading application");
  assert.equal(describeSessionEvent(ev("disabled", null)), "Disabled");
  assert.equal(describeSessionEvent(ev("rotated", { by: "x" })), "rotated — by: x");
  assert.equal(describeSessionEvent(ev("weird", null)), "weird");
  assert.equal(describeActor("user:hs:vanee4ka"), "vanee4ka (user)");
  assert.equal(describeActor("key:hst_P1aFCVPi"), "key hst_P1aFCVPi");
  assert.equal(describeActor("import:hs-settings"), "import hs-settings");
  assert.equal(describeActor(""), "—");
});

test("cookies: header, multi-line, Cookie: prefix and JSON exports normalise; names + required check", () => {
  assert.equal(normalizeCookies(`Cookie: ${COOKIES}`), COOKIES);
  assert.equal(normalizeCookies("c_user=1;\nxs=2\n datr=3"), "c_user=1; xs=2; datr=3");
  assert.equal(normalizeCookies(JSON.stringify([{ name: "c_user", value: "1", domain: ".facebook.com" }, { name: "xs", value: "2" }])), "c_user=1; xs=2");
  assert.equal(normalizeCookies("[not json"), "[not json");
  assert.equal(normalizeCookies(""), "");
  assert.deepEqual(cookieNames(COOKIES), ["c_user", "xs", "datr", "fr", "sb"]);
  assert.equal(cookiesProblem(COOKIES), null);
  assert.match(cookiesProblem("") ?? "", /required/);
  assert.match(cookiesProblem("c_user=1; datr=2") ?? "", /missing xs/);
  assert.match(cookiesProblem("datr=2") ?? "", /missing c_user and xs/);
  assert.match(cookiesProblem("c_user=1; garbage") ?? "", /name=value/);
});

test("proxy: scheme / host / port rules and masking", () => {
  assert.equal(proxyProblem("socks5h://login:pass@193.193.217.60:2832"), null);
  assert.equal(proxyProblem("http://h:8080"), null);
  assert.equal(proxyProblem(""), null);
  assert.match(proxyProblem("193.193.217.60:2832") ?? "", /URL like/);
  assert.match(proxyProblem("ftp://h:21") ?? "", /scheme "ftp" is not supported/);
  assert.match(proxyProblem("socks5h://h") ?? "", /port/);
  assert.equal(maskProxy("socks5h://login:pass@193.193.217.60:2832"), "socks5h://***:***@193.193.217.60:2832");
  assert.equal(maskProxy("http://h:8080"), "http://h:8080");
  assert.equal(maskProxy("garbage"), "***");
});

test("tokens and account ids", () => {
  assert.equal(tokenProblem(TOKEN), null);
  assert.match(tokenProblem("short") ?? "", /too short/);
  assert.match(tokenProblem("EAAB abc" + "x".repeat(20)) ?? "", /whitespace/);
  assert.deepEqual(parseAccountIds("act_1702978257719186, 1712545759741850 1712545759741850;0011223344"), { ids: ["1702978257719186", "1712545759741850", "0011223344"], bad: [] });
  assert.deepEqual(parseAccountIds(["1", "abc", "1234567"]), { ids: ["1234567"], bad: ["1", "abc"] });
  assert.equal(parseToolId("12"), 12);
  assert.equal(parseToolId("0"), null);
  assert.equal(parseToolId("1e3"), null);
  assert.equal(parseToolId("abc"), null);
});

test("validateSessionCreate: an Ads Manager session needs cookies (c_user + xs) and a UA; a marketing token neither", () => {
  const ok = validateSessionCreate({ name: " glo-01-44 ", kind: "adsmanager_session", token: ` ${TOKEN} `, cookies: `Cookie: ${COOKIES}`, user_agent: UA, proxy: "socks5h://u:p@h:1080", profile_slug: "glo-01-44", account_ids: "act_1702978257719186, 1712545759741850", accept_language: "en-US,en;q=0.9", check_now: true });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.body, { name: "glo-01-44", kind: "adsmanager_session", token: TOKEN, check_now: true, source: "api", cookies: COOKIES, user_agent: UA, proxy: "socks5h://u:p@h:1080", profile_slug: "glo-01-44", account_ids: ["1702978257719186", "1712545759741850"], accept_language: "en-US,en;q=0.9" });
    assert.deepEqual(ok.warnings, []);
  }
  const noProxy = validateSessionCreate({ name: "a1", token: TOKEN, cookies: COOKIES, user_agent: UA, check_now: false });
  assert.ok(noProxy.ok && noProxy.body.check_now === false && noProxy.warnings.length === 1 && /no proxy/.test(noProxy.warnings[0]));
  const mt = validateSessionCreate({ name: "sys-user", kind: "marketing_token", token: TOKEN, cookies: "ignored", user_agent: "ignored", proxy: "" });
  assert.ok(mt.ok);
  if (mt.ok) {
    assert.equal(mt.body.cookies, undefined);
    assert.equal(mt.body.user_agent, undefined);
    assert.deepEqual(mt.warnings, [], "a marketing token without a proxy is fine");
  }
  const field = (r: ReturnType<typeof validateSessionCreate>) => (r.ok ? "OK" : r.field);
  assert.equal(field(validateSessionCreate({ name: "x", token: TOKEN, cookies: COOKIES, user_agent: UA })), "name");
  assert.equal(field(validateSessionCreate({ name: "ok", kind: "weird", token: TOKEN })), "kind");
  assert.equal(field(validateSessionCreate({ name: "ok", token: "short", cookies: COOKIES, user_agent: UA })), "token");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: "datr=1", user_agent: UA })), "cookies");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: COOKIES, user_agent: "" })), "user_agent");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: COOKIES, user_agent: UA, proxy: "h:1" })), "proxy");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: COOKIES, user_agent: UA, profile_slug: "a b" })), "profile_slug");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: COOKIES, user_agent: UA, account_ids: "abc" })), "account_ids");
  assert.equal(field(validateSessionCreate({ name: "ok", token: TOKEN, cookies: COOKIES, user_agent: UA, accept_language: "x".repeat(65) })), "accept_language");
});

test("validateSessionUpdate: only filled fields go out, blanks are not sent, clearing the restriction sends []", () => {
  const r = validateSessionUpdate({ token: "", cookies: COOKIES, user_agent: "", proxy: "", profile_slug: "", account_ids: "", accept_language: "", check_now: true });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.body, { check_now: true, cookies: COOKIES });
    assert.deepEqual(r.changed, ["cookies"]);
  }
  const st = validateSessionUpdate({ status: "disabled", check_now: false });
  assert.ok(st.ok && st.body.status === "disabled" && st.body.check_now === false && st.changed.join() === "status");
  const clear = validateSessionUpdate({ clear_account_ids: true, account_ids: "123456789" });
  assert.ok(clear.ok && Array.isArray(clear.body.account_ids) && clear.body.account_ids.length === 0);
  const ids = validateSessionUpdate({ account_ids: "act_123456789, 987654321" });
  assert.ok(ids.ok && ids.body.account_ids?.join() === "123456789,987654321");
  const none = validateSessionUpdate({});
  assert.ok(!none.ok && /nothing to update/.test(none.error));
  const bad = validateSessionUpdate({ status: "paused" });
  assert.ok(!bad.ok && bad.field === "status");
  const badTok = validateSessionUpdate({ token: "short" });
  assert.ok(!badTok.ok && badTok.field === "token");
  const badCookies = validateSessionUpdate({ cookies: "datr=1" });
  assert.ok(!badCookies.ok && badCookies.field === "cookies");
});

test("job filters: unknown values dropped, bounds kept", () => {
  assert.deepEqual(normalizeJobFilters({ session_id: "1", kind: "session.check", status: "ERROR", limit: "20", offset: "40" }), { session_id: 1, kind: "session.check", status: "error", limit: 20, offset: 40 });
  assert.deepEqual(normalizeJobFilters({ session_id: "x", kind: "nope", status: "nope", limit: "9999", offset: "-1" }), { limit: 50, offset: 0 });
});

test("accounts: FB status codes, the team account shape, key scopes", () => {
  assert.equal(accountStatusLabel(1), "active");
  assert.equal(accountStatusLabel(2), "disabled");
  assert.equal(accountStatusLabel(77), "status 77");
  assert.equal(accountStatusTone(1), "ok");
  assert.equal(accountStatusTone(2), "danger");
  assert.equal(accountStatusTone(3), "warn");
  const a = toTeamAccount({ account_id: "1702978257719186", name: "GC-HS-VD-C1-BR-387", currency: "USD", status: 1, sessions: [{ id: 1, name: "glo-01" }] });
  assert.deepEqual(a.sessions, [{ id: 1, name: "glo-01" }]);
  const me = toMe({ actor: "key:hst_P1aFCVPi", team_id: 1, teams: [1], is_hs_admin: false, scopes: ["sessions:read", "sessions:write"] });
  assert.equal(hasScope(me, "sessions:write"), true);
  assert.equal(hasScope(me, "jobs:write"), false);
  assert.equal(hasScope(null, "sessions:read"), false);
});

test("change log helpers: sanitise foreign rows, cap newest-first", () => {
  const list = sanitizeLog([{ at: 5, by: "Nazar", kind: "create", sessionId: 2, name: "x", text: "Added" }, { at: "nope", kind: "create" }, { at: 3, kind: "bogus" }, null]);
  assert.equal(list.length, 1);
  const grown = Array.from({ length: 70 }, (_, i) => ({ at: i + 1, by: "n", kind: "check" as const, sessionId: null, name: "", text: `t${i}` })).reduce((acc, e) => pushLog(acc, e), [] as ReturnType<typeof sanitizeLog>);
  assert.equal(grown.length, 60);
  assert.equal(grown[0].text, "t69", "newest first");
});
