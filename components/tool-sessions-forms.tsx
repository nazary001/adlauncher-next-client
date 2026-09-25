"use client";

// The two forms of the TOOL Sessions console: ADD a session (name, kind, token, cookies, UA,
// proxy, …) and UPDATE one (any subset — new cookies/token after a re-login, a proxy change, a
// status flip, an account restriction). Both validate with the same pure rules the server
// applies (lib/tool-sessions-model), so a mistake is named before anything leaves the browser;
// secrets go straight to /api/tool-sessions/* and on to TOOL — never stored, never echoed.

import { useMemo, useState, type ReactNode } from "react";
import { CheckIcon, KeyIcon } from "./icons";
import { Modal, btnAccent, btnGhost, inputCls, labelCls, selectCls, textareaCls } from "./tool-sessions-ui";
import { toolCall } from "./use-tool-sessions";
import {
  type SessionKind,
  type ToolSessionRow,
  SESSION_KINDS,
  SESSION_KIND_HINT,
  SESSION_KIND_LABEL,
  REQUIRED_AM_COOKIES,
  cookieNames,
  normalizeCookies,
  parseAccountIds,
  validateSessionCreate,
  validateSessionUpdate,
} from "@/lib/tool-sessions-model";

function Field({ label, hint, error, children, className = "" }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className={labelCls}>{label}</span>
      {children}
      {error ? <span className="text-[11px] leading-snug text-danger">{error}</span> : hint ? <span className="text-[10.5px] leading-snug text-faint">{hint}</span> : null}
    </label>
  );
}

/** Live read of a pasted cookie string: how many, which of the required ones are missing. */
function CookieHint({ value }: { value: string }) {
  const names = useMemo(() => cookieNames(value), [value]);
  if (!value.trim()) return <>Paste the Cookie header of the logged-in profile (c_user=…; xs=…; datr=…; fr=…; sb=…) or a JSON cookie export.</>;
  const missing = REQUIRED_AM_COOKIES.filter((n) => !names.includes(n));
  return (
    <>
      {names.length} cookie{names.length === 1 ? "" : "s"} recognised{names.length ? `: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}` : ""}
      {missing.length ? <span className="text-warn"> · missing {missing.join(" and ")}</span> : <span className="text-launch2"> · c_user + xs present</span>}
    </>
  );
}

const err = (field: string, problem: { field: string; error: string } | null) => (problem && problem.field === field ? problem.error : null);

// ---- add -----------------------------------------------------------------------------------------------

export function AddSessionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (row: ToolSessionRow, warnings: string[], checkQueued: boolean) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SessionKind>("adsmanager_session");
  const [token, setToken] = useState("");
  const [cookies, setCookies] = useState("");
  const [ua, setUa] = useState("");
  const [proxy, setProxy] = useState("");
  const [slug, setSlug] = useState("");
  const [accountIds, setAccountIds] = useState("");
  const [lang, setLang] = useState("");
  const [checkNow, setCheckNow] = useState(true);
  const [problem, setProblem] = useState<{ field: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isAm = kind === "adsmanager_session";
  const input = { name, kind, token, cookies, user_agent: ua, proxy, profile_slug: slug, account_ids: accountIds, accept_language: lang, check_now: checkNow };
  const badIds = useMemo(() => parseAccountIds(accountIds).bad, [accountIds]);

  const submit = async () => {
    if (busy) return;
    const v = validateSessionCreate(input);
    if (!v.ok) return setProblem({ field: v.field, error: v.error });
    setProblem(null);
    setBusy(true);
    const r = await toolCall<{ session: ToolSessionRow; warnings: string[] }>("/api/tool-sessions", { method: "POST", body: JSON.stringify(input) });
    setBusy(false);
    if (!r.ok) return setProblem({ field: r.field ?? "", error: r.message });
    onCreated(r.data.session, r.data.warnings ?? [], checkNow);
  };

  return (
    <Modal title="Add a session" subtitle="Token, cookies, User-Agent and proxy must come from ONE logged-in Ads Manager profile. TOOL checks it right away." onClose={onClose} width="max-w-[720px]" testId="add-session-modal">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_240px]">
          <Field label="Name" error={err("name", problem)} hint="Unique in the team — the profile's slug is the usual choice (glo-01-43).">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="glo-01-44" autoFocus maxLength={80} data-testid="add-name" />
          </Field>
          <Field label="Kind" error={err("kind", problem)} hint={SESSION_KIND_HINT[kind]}>
            <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)} className={selectCls} data-testid="add-kind">
              {SESSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SESSION_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Access token" error={err("token", problem)} hint={isAm ? "The EAAB… token Ads Manager uses (from the profile's network requests / the extension)." : "A system-user or long-lived user token with ads_management."}>
          <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={2} spellCheck={false} autoComplete="off" className={textareaCls} placeholder="EAAB…" data-testid="add-token" />
        </Field>

        {isAm ? (
          <>
            <Field label="Cookies" error={err("cookies", problem)} hint={<CookieHint value={cookies} />}>
              <textarea value={cookies} onChange={(e) => setCookies(e.target.value)} rows={3} spellCheck={false} autoComplete="off" className={textareaCls} placeholder="c_user=…; xs=…; datr=…; fr=…; sb=…" data-testid="add-cookies" />
            </Field>
            <Field label="User-Agent" error={err("user_agent", problem)} hint="The exact User-Agent of the profile's browser (navigator.userAgent there).">
              <input value={ua} onChange={(e) => setUa(e.target.value)} className={inputCls + " font-mono text-[11px]"} placeholder="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 …" spellCheck={false} autoComplete="off" data-testid="add-ua" />
            </Field>
          </>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Proxy" error={err("proxy", problem)} hint={isAm ? "The same profile's proxy — socks5h://user:pass@host:port. Without it TOOL exits from its own IP." : "Optional — socks5h://user:pass@host:port or http://…"}>
            <input value={proxy} onChange={(e) => setProxy(e.target.value)} className={inputCls + " font-mono text-[11px]"} placeholder="socks5h://login:pass@host:port" spellCheck={false} autoComplete="off" data-testid="add-proxy" />
          </Field>
          <Field label="Profile slug" error={err("profile_slug", problem)} hint="Optional — the anti-detect profile this session was captured from.">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} placeholder="glo-01-44" maxLength={80} data-testid="add-slug" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Restrict to accounts" error={err("account_ids", problem)} hint={badIds.length ? <span className="text-warn">not ids: {badIds.slice(0, 3).join(", ")}</span> : "Optional — ids (comma / space separated). Empty = every account the session sees."}>
            <textarea value={accountIds} onChange={(e) => setAccountIds(e.target.value)} rows={2} spellCheck={false} className={textareaCls} placeholder="1702978257719186, 1712545759741850" data-testid="add-accounts" />
          </Field>
          <div className="flex flex-col gap-3">
            <Field label="Accept-Language" error={err("accept_language", problem)} hint="Optional — the profile's browser language header.">
              <input value={lang} onChange={(e) => setLang(e.target.value)} className={inputCls} placeholder="en-US,en;q=0.9" maxLength={64} />
            </Field>
            <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-dim">
              <input type="checkbox" checked={checkNow} onChange={(e) => setCheckNow(e.target.checked)} className="mt-0.5 accent-[#3d7fff]" data-testid="add-check-now" />
              <span>Check right away — TOOL reads /me, the ad accounts and the egress IP through the proxy.</span>
            </label>
          </div>
        </div>

        {problem && !problem.field ? <p className="text-[11.5px] leading-relaxed text-danger">{problem.error}</p> : null}
        {problem?.field && !["name", "kind", "token", "cookies", "user_agent", "proxy", "profile_slug", "account_ids", "accept_language"].includes(problem.field) ? <p className="text-[11.5px] leading-relaxed text-danger">{problem.error}</p> : null}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || !token.trim() || (isAm && (!normalizeCookies(cookies) || !ua.trim()))} className={btnAccent + " h-9"} data-testid="add-submit">
            <KeyIcon className="h-4 w-4" />
            {busy ? "Adding…" : "Add session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- update ------------------------------------------------------------------------------------------

export function UpdateSessionModal({ session, onClose, onUpdated }: { session: ToolSessionRow; onClose: () => void; onUpdated: (row: ToolSessionRow, changed: string[], checkQueued: boolean) => void }) {
  const [token, setToken] = useState("");
  const [cookies, setCookies] = useState("");
  const [ua, setUa] = useState("");
  const [proxy, setProxy] = useState("");
  const [slug, setSlug] = useState("");
  const [accountIds, setAccountIds] = useState("");
  const [clearIds, setClearIds] = useState(false);
  const [lang, setLang] = useState("");
  const [checkNow, setCheckNow] = useState(true);
  const [problem, setProblem] = useState<{ field: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isAm = session.kind === "adsmanager_session";
  const input = { token, cookies, user_agent: ua, proxy, profile_slug: slug, account_ids: clearIds ? "" : accountIds, clear_account_ids: clearIds, accept_language: lang, check_now: checkNow };
  const preview = validateSessionUpdate(input);
  const changed = preview.ok ? preview.changed : [];
  const badIds = useMemo(() => parseAccountIds(accountIds).bad, [accountIds]);

  const submit = async () => {
    if (busy) return;
    const v = validateSessionUpdate(input);
    if (!v.ok) return setProblem({ field: v.field, error: v.error });
    setProblem(null);
    setBusy(true);
    const r = await toolCall<{ session: ToolSessionRow; changed: string[] }>(`/api/tool-sessions/${session.id}`, { method: "PATCH", body: JSON.stringify(input) });
    setBusy(false);
    if (!r.ok) return setProblem({ field: r.field ?? "", error: r.message });
    onUpdated(r.data.session, r.data.changed, checkNow);
  };

  return (
    <Modal title={`Update «${session.name}»`} subtitle="Fill only what changes — blank fields stay as they are. New cookies / token after a re-login, a new proxy, a restriction." onClose={onClose} width="max-w-[720px]" testId="update-session-modal">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="New access token" error={err("token", problem)} hint={`Current: ${session.token_masked || "—"}${session.token_kind ? ` (${session.token_kind})` : ""}. Leave blank to keep it.`}>
          <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={2} spellCheck={false} autoComplete="off" className={textareaCls} placeholder="EAAB…" data-testid="upd-token" />
        </Field>
        {isAm ? (
          <>
            <Field label="New cookies" error={err("cookies", problem)} hint={cookies.trim() ? <CookieHint value={cookies} /> : `Current: ${session.cookie_names.length} cookies (${session.cookie_names.slice(0, 6).join(", ")}${session.cookie_names.length > 6 ? "…" : ""}). Leave blank to keep them.`}>
              <textarea value={cookies} onChange={(e) => setCookies(e.target.value)} rows={3} spellCheck={false} autoComplete="off" className={textareaCls} placeholder="c_user=…; xs=…; datr=…; fr=…; sb=…" data-testid="upd-cookies" />
            </Field>
            <Field label="User-Agent" error={err("user_agent", problem)} hint={session.user_agent ? <span className="font-mono">{session.user_agent}</span> : "Not set."}>
              <input value={ua} onChange={(e) => setUa(e.target.value)} className={inputCls + " font-mono text-[11px]"} placeholder="Leave blank to keep" spellCheck={false} autoComplete="off" />
            </Field>
          </>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Proxy" error={err("proxy", problem)} hint={session.proxy_masked ? <span className="font-mono">{session.proxy_masked}</span> : "No proxy."}>
            <input value={proxy} onChange={(e) => setProxy(e.target.value)} className={inputCls + " font-mono text-[11px]"} placeholder="socks5h://login:pass@host:port" spellCheck={false} autoComplete="off" data-testid="upd-proxy" />
          </Field>
          <Field label="Profile slug" error={err("profile_slug", problem)} hint={session.profile_slug ? `Current: ${session.profile_slug}` : "Not set."}>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} placeholder="Leave blank to keep" maxLength={80} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Restrict to accounts"
            error={err("account_ids", problem)}
            hint={
              badIds.length && !clearIds ? (
                <span className="text-warn">not ids: {badIds.slice(0, 3).join(", ")}</span>
              ) : session.account_ids.length ? (
                `Current: ${session.account_ids.length} account${session.account_ids.length === 1 ? "" : "s"} (${session.account_ids.slice(0, 3).join(", ")}${session.account_ids.length > 3 ? "…" : ""}). A new list REPLACES it.`
              ) : (
                "Currently unrestricted — every account the session sees."
              )
            }
          >
            <textarea value={accountIds} onChange={(e) => setAccountIds(e.target.value)} rows={2} spellCheck={false} disabled={clearIds} className={textareaCls} placeholder="1702978257719186, 1712545759741850" data-testid="upd-accounts" />
          </Field>
          <div className="flex flex-col gap-3">
            {session.account_ids.length ? (
              <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-dim">
                <input type="checkbox" checked={clearIds} onChange={(e) => setClearIds(e.target.checked)} className="mt-0.5 accent-[#3d7fff]" data-testid="upd-clear-ids" />
                <span>Lift the restriction — back to every account the session sees.</span>
              </label>
            ) : null}
            <Field label="Accept-Language" error={err("accept_language", problem)} hint="Optional.">
              <input value={lang} onChange={(e) => setLang(e.target.value)} className={inputCls} placeholder="en-US,en;q=0.9" maxLength={64} />
            </Field>
            <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-dim">
              <input type="checkbox" checked={checkNow} onChange={(e) => setCheckNow(e.target.checked)} className="mt-0.5 accent-[#3d7fff]" data-testid="upd-check-now" />
              <span>Check after the update.</span>
            </label>
          </div>
        </div>

        {problem && (!problem.field || !["token", "cookies", "user_agent", "proxy", "profile_slug", "account_ids", "accept_language"].includes(problem.field)) ? <p className="text-[11.5px] leading-relaxed text-danger">{problem.error}</p> : null}

        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-[11px] text-faint" data-testid="upd-changed">
            {changed.length ? (
              <>
                <CheckIcon className="mr-1 inline h-3 w-3 text-launch2" />
                Will change: {changed.join(", ")}
              </>
            ) : (
              "Nothing filled yet."
            )}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !changed.length} className={btnAccent + " h-9"} data-testid="upd-submit">
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
