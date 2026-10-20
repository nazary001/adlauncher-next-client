"use client";

// Owner console: the team's logins (owner ask 20.10: "роль овнер могла управлять акаунтами, например
// добавлять новый акаунт дизайнера или овнера или же удалять или редактировать … в менюшках
// соответствующих сделай такой функционал"). Add an owner or a designer, rename, change the role,
// reset the password, block / unblock, sign out everywhere, delete. The server decides everything
// (/api/users — lib/user-admin: an owner never locks themselves out, the team keeps one active owner);
// this board only mirrors those rules so a button that cannot work says why up front. A password is
// shown once — right after it is set — with a copy-ready sign-in note to hand to the person.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PlusIcon,
  RetryIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
  UserCogIcon,
  XIcon,
} from "./icons";
import { TextInput } from "./ui";
import { TEAM } from "@/lib/team";
import type { ManagedUser, MovedCounts } from "@/lib/user-admin";
import { USERNAME_MAX, checkEmail, checkPassword, checkUsername, generatePassword, type UserRole } from "@/lib/user-fields";

type Listing = { users: ManagedUser[]; me: number; team: { label: string; sharedDirectory: boolean } };
type Modal = { kind: "create" } | { kind: "edit"; user: ManagedUser } | { kind: "delete"; user: ManagedUser } | null;
/** A password that was just set — shown once, with the note to hand over. */
type Handover = { username: string; password: string; what: "created" | "reset" };
type Filter = "all" | "owner" | "designer" | "blocked";

type ApiFail = { ok: false; error: string; busy?: number; message?: string };
type ApiResult<T> = ({ ok: true } & T) | ApiFail;

async function api<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const r = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok && d.ok) return d as { ok: true } & T;
    return { ok: false, error: typeof d.error === "string" ? d.error : `http_${r.status}`, busy: typeof d.busy === "number" ? d.busy : undefined, message: typeof d.message === "string" ? d.message : undefined };
  } catch {
    return { ok: false, error: "network" };
  }
}

/** What a refusal means, in the words the owner reads. */
function errorText(e: ApiFail | { error: string; busy?: number; message?: string }, name = "This login"): string {
  switch (e.error) {
    case "unauthorized":
    case "session_revoked":
      return "Your session has ended — sign in again.";
    case "forbidden":
      return "Only an active owner can manage logins.";
    case "username_required":
      return "Type a login name.";
    case "username_too_long":
      return `A login name is at most ${USERNAME_MAX} characters.`;
    case "username_invalid":
      return "A login name cannot contain “@” or tabs / line breaks.";
    case "username_taken":
      return "This name is taken — somebody has it now or had it before (letter case does not matter).";
    case "password_required":
      return "Set a password.";
    case "password_too_short":
      return "The password needs at least 6 characters.";
    case "password_too_long":
      return "The password is too long (72 bytes at most).";
    case "email_invalid":
      return "This does not look like an e-mail address.";
    case "email_taken":
      return "Another login already uses this e-mail.";
    case "role_invalid":
      return "Pick owner or designer.";
    case "user_busy":
      return `${name} has ${e.busy ?? "some"} launch${e.busy === 1 ? "" : "es"} in the queue right now — wait until ${e.busy === 1 ? "it finishes" : "they finish"}, or block the login meanwhile.`;
    case "self_delete":
      return "You cannot delete your own login — another owner can.";
    case "self_block":
      return "You cannot block your own login — another owner can.";
    case "self_demote":
      return "You cannot take the owner role from yourself — another owner can.";
    case "self_sign_out":
      return "To end your own sessions use Sign out.";
    case "last_owner":
      return "The team must keep at least one active owner — make somebody else an owner first.";
    case "not_found":
      return "This login was deleted in the meantime.";
    case "nothing_to_change":
      return "Nothing changed.";
    case "store_unavailable":
    case "network":
      return `The user directory did not answer${e.message ? ` (${e.message})` : ""} — try again.`;
    default:
      return `Could not save — ${e.error}${e.message ? ` (${e.message})` : ""}.`;
  }
}

const byName = (a: ManagedUser, b: ManagedUser): number => a.username.localeCompare(b.username, undefined, { sensitivity: "base" });

const dayLabel = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function Avatar({ name, dim = false }: { name: string; dim?: boolean }) {
  return (
    <span
      className={
        "grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-[12px] font-semibold " +
        (dim ? "bg-surface2 text-faint" : "bg-accent/20 text-[#9db8ff]")
      }
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

function RoleBadge({ user }: { user: Pick<ManagedUser, "role" | "owner"> }) {
  return user.owner ? (
    <span className="inline-flex items-center gap-1 rounded-md border border-accent/35 bg-accent/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9db8ff]">
      <ShieldIcon className="h-3 w-3" />
      {user.role && user.role !== "owner" ? `${user.role} · owner` : "owner"}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-dim">
      {user.role || "no role"}
    </span>
  );
}

// ---- the sign-in note handed to the person -------------------------------------------------------------

function HandoverCard({ handover, onClose }: { handover: Handover; onClose: () => void }) {
  const [copied, setCopied] = useState<"note" | "password" | null>(null);
  const site = typeof window === "undefined" ? "" : window.location.origin;
  const note = `${TEAM.label} Ad Launcher\nSite: ${site}\nLogin: ${handover.username}\nPassword: ${handover.password}`;
  const copy = async (what: "note" | "password") => {
    if (await copyText(what === "note" ? note : handover.password)) {
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    }
  };
  return (
    <div role="status" className="animate-pop-in flex flex-col gap-3 rounded-2xl border border-launch/40 bg-launch/10 px-4 py-3.5 sm:flex-row sm:items-center">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-launch/20 text-launch2">
        <CheckIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">
          {handover.what === "created" ? `Login ${handover.username} is ready` : `New password for ${handover.username}`}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-dim">
          Hand these over now — the password is shown only this once.{" "}
          <span className="font-mono text-ink">
            {handover.username} · {handover.password}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy("note")}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-launch px-3 text-[12px] font-semibold text-white transition-all hover:brightness-110 active:scale-[0.97]"
        >
          {copied === "note" ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          {copied === "note" ? "Copied" : "Copy sign-in note"}
        </button>
        <button
          type="button"
          onClick={() => void copy("password")}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3 text-[12px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink"
        >
          {copied === "password" ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          Password
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---- modal shell -------------------------------------------------------------------------------------

function ModalShell({
  title,
  subtitle,
  icon,
  tone = "accent",
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle: React.ReactNode;
  icon: React.ReactNode;
  tone?: "accent" | "danger";
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-pop-in relative flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl " +
                (tone === "danger" ? "bg-danger/15 text-danger" : "bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]")
              }
            >
              {icon}
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
              <p className="mt-1 text-[12px] leading-snug text-dim">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="border-t border-line px-5 py-3.5">{footer}</div>
      </div>
    </div>
  );
}

const labelCls = "text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none";

function RolePicker({ value, onChange, disabled, hint }: { value: UserRole; onChange: (r: UserRole) => void; disabled?: boolean; hint?: string }) {
  const choices: { role: UserRole; title: string; text: string }[] = [
    { role: "designer", title: "Designer", text: "Launches and clones campaigns on the accounts given to them." },
    { role: "owner", title: "Owner", text: "Everything a designer does, plus Owner tools — this page included." },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className={labelCls}>Role</span>
      <div role="radiogroup" aria-label="Role" className="grid grid-cols-2 gap-2">
        {choices.map((c) => {
          const on = value === c.role;
          return (
            <button
              key={c.role}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange(c.role)}
              className={
                "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
                (on ? "border-accent/60 bg-accent/12" : "border-line bg-surface2 hover:border-line2")
              }
            >
              <span className={"flex items-center gap-1.5 text-[13px] font-semibold " + (on ? "text-[#c3d4ff]" : "text-ink")}>
                {c.role === "owner" ? <ShieldIcon className="h-3.5 w-3.5" /> : null}
                {c.title}
              </span>
              <span className="text-[11px] leading-snug text-faint">{c.text}</span>
            </button>
          );
        })}
      </div>
      {hint ? <p className="text-[11px] leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}

function PasswordField({
  value,
  onChange,
  label,
  placeholder,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  error?: string | null;
}) {
  const [shown, setShown] = useState(true);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="ul-password" className={labelCls}>
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <TextInput
            id="ul-password"
            type={shown ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoComplete="new-password"
            className="pr-9 font-mono"
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide password" : "Show password"}
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-faint transition-colors hover:text-ink"
          >
            {shown ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => onChange(generatePassword())}
          data-tip="Generate a strong password"
          className="tip flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 text-[12px] font-medium text-dim transition-colors hover:border-accent/40 hover:text-[#9db8ff]"
        >
          <RetryIcon className="h-3.5 w-3.5" />
          Generate
        </button>
        <button
          type="button"
          disabled={!value}
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          aria-label="Copy password"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface2 text-dim transition-colors hover:border-line2 hover:text-ink disabled:opacity-40"
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-launch2" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
      {error ? <p className="text-[11px] leading-snug text-warn">{error}</p> : null}
    </div>
  );
}

function Toggle({ on, onChange, disabled, label, text }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; text: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-full items-start gap-3 rounded-xl border border-line bg-surface2 px-3 py-2.5 text-left transition-colors hover:border-line2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className={"mt-0.5 flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition-colors " + (on ? "bg-danger/80" : "bg-line2")}>
        <span className={"h-3.5 w-3.5 rounded-full bg-white transition-transform " + (on ? "translate-x-3.5" : "")} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        <span className="block text-[11px] leading-snug text-faint">{text}</span>
      </span>
    </button>
  );
}

// ---- add / edit a login --------------------------------------------------------------------------------

function LoginModal({
  mode,
  me,
  shared,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; user: ManagedUser };
  me: number;
  shared: boolean;
  onClose: () => void;
  onSaved: (user: ManagedUser, handover: Handover | null, moved: MovedCounts | null) => void;
}) {
  const editing = mode.kind === "edit" ? mode.user : null;
  const self = editing?.id === me;
  const [username, setUsername] = useState(editing?.username ?? "");
  const [role, setRole] = useState<UserRole>(editing ? (editing.owner ? "owner" : "designer") : "designer");
  const [password, setPassword] = useState(() => (editing ? "" : generatePassword()));
  const [email, setEmail] = useState(editing?.email ?? "");
  const [blocked, setBlocked] = useState(editing?.blocked ?? false);
  const [signOut, setSignOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameCheck = checkUsername(username);
  const passCheck = password.trim() === "" && editing ? null : checkPassword(password);
  const mailCheck = checkEmail(email);
  const nameError = username !== "" && !nameCheck.ok ? errorText(nameCheck) : null;
  const passError = passCheck && !passCheck.ok && password !== "" ? errorText(passCheck) : null;
  const mailError = !mailCheck.ok ? errorText(mailCheck) : null;
  const renaming = Boolean(editing && nameCheck.ok && nameCheck.value !== editing.username);
  // A role the launcher does not hand out (e.g. "admin") stays as it is unless the owner picks one.
  const roleChanged = editing ? role !== (editing.owner ? "owner" : "designer") : true;

  /** The PATCH body: only what differs from the login as it is. */
  const patch = (): Record<string, unknown> => {
    if (!editing) return {};
    const out: Record<string, unknown> = {};
    if (nameCheck.ok && nameCheck.value !== editing.username) out.username = nameCheck.value;
    if (roleChanged) out.role = role;
    if (password.trim()) out.password = password;
    if (mailCheck.ok && (mailCheck.value ?? null) !== (editing.email ?? null)) out.email = mailCheck.value ?? "";
    if (blocked !== editing.blocked) out.blocked = blocked;
    if (signOut) out.signOutEverywhere = true;
    return out;
  };
  const changes = editing ? Object.keys(patch()).length : 1;
  const canSave = !busy && nameCheck.ok && (!passCheck || passCheck.ok) && mailCheck.ok && changes > 0;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    if (!editing) {
      const r = await api<{ user: ManagedUser }>("POST", "/api/users", { username, password, role, email });
      setBusy(false);
      if (!r.ok) return setError(errorText(r));
      onSaved(r.user, { username: r.user.username, password: password.trim(), what: "created" }, null);
      return;
    }
    const body = patch();
    const r = await api<{ user: ManagedUser; moved?: MovedCounts }>("PATCH", `/api/users/${editing.id}`, body);
    setBusy(false);
    if (!r.ok) return setError(errorText(r, editing.username));
    onSaved(r.user, body.password ? { username: r.user.username, password: String(body.password).trim(), what: "reset" } : null, r.moved ?? null);
  }

  return (
    <ModalShell
      title={editing ? `Edit ${editing.username}` : "New login"}
      subtitle={
        editing ? (
          <>
            {editing.createdAt ? `Added ${dayLabel(editing.createdAt)}${editing.createdBy ? ` by ${editing.createdBy}` : ""} · ` : ""}
            only what you change is saved.
          </>
        ) : (
          <>Someone who can sign in to the {TEAM.label} launcher.</>
        )
      }
      icon={editing ? <PencilIcon className="h-4 w-4" /> : <PlusIcon className="h-4.5 w-4.5" />}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-warn" aria-live="polite">
            {error ?? ""}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-4 py-2 text-[13px] font-semibold text-[#9db8ff] transition-all hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editing ? <CheckIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
              {busy ? "Saving…" : editing ? "Save changes" : "Add login"}
            </button>
          </div>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ul-name" className={labelCls}>
            Login name
          </label>
          <TextInput
            id="ul-name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={USERNAME_MAX + 10}
            placeholder="e.g. Korsun"
            autoFocus={!editing}
          />
          {nameError ? (
            <p className="text-[11px] leading-snug text-warn">{nameError}</p>
          ) : renaming ? (
            <p className="text-[11px] leading-snug text-faint">
              Their ad accounts, templates and launch history move to the new name; the old name stops signing in. Campaign names already launched keep the old one.
            </p>
          ) : (
            <p className="text-[11px] leading-snug text-faint">What they type to sign in — and the name the launcher writes into their campaigns.</p>
          )}
        </div>

        <RolePicker
          value={role}
          onChange={setRole}
          disabled={self}
          hint={self ? "You cannot change your own role — another owner can." : editing?.role && !["owner", "designer"].includes(editing.role) ? `Stored role: “${editing.role}”.` : undefined}
        />

        <PasswordField
          label={editing ? "New password" : "Password"}
          value={password}
          onChange={setPassword}
          placeholder={editing ? "Leave empty to keep the current one" : "At least 6 characters"}
          error={passError}
        />
        {editing && password.trim() ? (
          <p className="-mt-2.5 text-[11px] leading-snug text-faint">
            {self ? "Your other sessions end; this one stays signed in." : `${editing.username} is signed out everywhere and signs in with the new password.`}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ul-email" className={labelCls}>
            E-mail (optional)
          </label>
          <TextInput id="ul-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          {mailError ? (
            <p className="text-[11px] leading-snug text-warn">{mailError}</p>
          ) : (
            <p className="text-[11px] leading-snug text-faint">They can sign in with it instead of the name{shared ? " — here and in Amazon Tools" : ""}.</p>
          )}
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <Toggle
              on={blocked}
              onChange={setBlocked}
              disabled={self}
              label={blocked ? "Blocked" : "Block this login"}
              text={self ? "You cannot block your own login." : "A blocked login cannot sign in, and its open sessions end within seconds. Unblock any time."}
            />
            {!self ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface2 px-3 py-2.5 transition-colors hover:border-line2">
                <input type="checkbox" checked={signOut} onChange={(e) => setSignOut(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">Sign out everywhere</span>
                  <span className="block text-[11px] leading-snug text-faint">End every open session of {editing.username} — they sign in again with their password.</span>
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </ModalShell>
  );
}

// ---- delete ------------------------------------------------------------------------------------------

function DeleteModal({
  user,
  shared,
  onClose,
  onDeleted,
  onBlocked,
}: {
  user: ManagedUser;
  shared: boolean;
  onClose: () => void;
  onDeleted: (r: { username: string; accounts: number; freed: number }) => void;
  onBlocked: (u: ManagedUser) => void;
}) {
  const [busy, setBusy] = useState<"delete" | "block" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim() === user.username;

  async function del() {
    if (!confirmed || busy) return;
    setBusy("delete");
    setError(null);
    const r = await api<{ username: string; accounts: number; freed: number }>("DELETE", `/api/users/${user.id}`);
    setBusy(null);
    if (!r.ok) return setError(errorText(r, user.username));
    onDeleted(r);
  }
  async function block() {
    if (busy) return;
    setBusy("block");
    setError(null);
    const r = await api<{ user: ManagedUser }>("PATCH", `/api/users/${user.id}`, { blocked: true });
    setBusy(null);
    if (!r.ok) return setError(errorText(r, user.username));
    onBlocked(r.user);
  }

  return (
    <ModalShell
      title={`Delete ${user.username}?`}
      subtitle="This cannot be undone."
      icon={<TrashIcon className="h-4 w-4" />}
      tone="danger"
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-warn" aria-live="polite">
            {error ?? ""}
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {!user.blocked ? (
              <button
                type="button"
                onClick={() => void block()}
                disabled={Boolean(busy)}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-dim transition-colors hover:border-warn/50 hover:text-warn disabled:opacity-50"
              >
                <BanIcon className="h-4 w-4" />
                {busy === "block" ? "Blocking…" : "Block instead"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void del()}
              disabled={!confirmed || Boolean(busy)}
              className="flex items-center gap-1.5 rounded-lg border border-danger/50 bg-danger/15 px-4 py-2 text-[13px] font-semibold text-danger transition-all hover:bg-danger/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <TrashIcon className="h-4 w-4" />
              {busy === "delete" ? "Deleting…" : "Delete login"}
            </button>
          </div>
        </div>
      }
    >
      <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-snug text-dim marker:text-faint">
        <li>
          <span className="text-ink">{user.username}</span> cannot sign in any more, and every open session ends within seconds.
        </li>
        <li>Ad accounts assigned only to them become visible to the whole team again (re-assign them in Account access).</li>
        <li>Their launch history and campaign templates stay.</li>
        {shared ? (
          <li className="text-warn">
            {TEAM.label} logins are the shared Amazon Tools accounts — this also deletes their Amazon Tools login.
          </li>
        ) : null}
      </ul>
      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor="ul-confirm" className={labelCls}>
          Type <span className="font-mono normal-case tracking-normal text-ink">{user.username}</span> to confirm
        </label>
        <TextInput
          id="ul-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={user.username}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void del();
            }
          }}
        />
      </div>
    </ModalShell>
  );
}

// ---- the board ---------------------------------------------------------------------------------------------

export function UsersBoard({ user }: { user: SessionUser }) {
  const [data, setData] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [modal, setModal] = useState<Modal>(null);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  /** The owner renamed their OWN login while a new password is on screen: the page starts over under
   *  the new name only once that password has been dismissed (it is shown this once). */
  const [reloadAfterHandover, setReloadAfterHandover] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Listing>("GET", "/api/users");
    if (!r.ok) {
      if (r.error === "unauthorized" || r.error === "session_revoked") {
        window.location.href = "/login";
        return;
      }
      setLoadError(errorText(r));
      return;
    }
    setLoadError(null);
    setData({ users: r.users, me: r.me, team: r.team });
  }, []);

  useEffect(() => {
    // The first read of the directory (setState lands after the fetch, never synchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const closeModal = useCallback(() => setModal(null), []);

  const users = useMemo(() => data?.users ?? [], [data]);
  const me = data?.me ?? -1;
  const shared = data?.team.sharedDirectory ?? TEAM.toolsDirectory;
  const counts = useMemo(
    () => ({
      all: users.length,
      owner: users.filter((u) => u.owner && !u.blocked).length,
      designer: users.filter((u) => !u.owner && !u.blocked).length,
      blocked: users.filter((u) => u.blocked).length,
    }),
    [users],
  );
  const q = query.trim().toLowerCase();
  const shown = users.filter((u) => {
    if (q && !u.username.toLowerCase().includes(q) && !(u.email ?? "").toLowerCase().includes(q)) return false;
    if (filter === "owner") return u.owner && !u.blocked;
    if (filter === "designer") return !u.owner && !u.blocked;
    if (filter === "blocked") return u.blocked;
    return true;
  });

  /** After a change of the owner's OWN login the server re-issued their cookie — the page starts over
   *  under the new name (the header still shows the old one otherwise); with a new password on screen,
   *  only once it is dismissed. */
  const replaceUser = (next: ManagedUser, handoverShown = false) => {
    setData((d) => (d ? { ...d, users: d.users.map((u) => (u.id === next.id ? next : u)).sort(byName) } : d));
    if (next.id === me && next.username !== user.username) {
      if (handoverShown) setReloadAfterHandover(true);
      else window.location.reload();
    }
  };

  async function toggleBlock(u: ManagedUser) {
    setRowBusy(u.id);
    const r = await api<{ user: ManagedUser }>("PATCH", `/api/users/${u.id}`, { blocked: !u.blocked });
    setRowBusy(null);
    if (!r.ok) return setToast({ text: errorText(r, u.username), tone: "warn" });
    replaceUser(r.user);
    setToast({ text: r.user.blocked ? `${u.username} is blocked — signed out within seconds.` : `${u.username} can sign in again.`, tone: "ok" });
  }

  const filterBtn = (id: Filter, label: string, n: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setFilter(id)}
      aria-pressed={filter === id}
      className={
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors " +
        (filter === id ? "bg-accent/15 text-[#c3d4ff]" : "text-dim hover:bg-raise hover:text-ink")
      }
    >
      {label}
      <span className={"rounded-full px-1.5 font-mono text-[10.5px] " + (filter === id ? "bg-accent/25" : "bg-surface2 text-faint")}>{n}</span>
    </button>
  );

  return (
    <>
      <Header
        partner={TEAM.defaultPartner}
        onPartnerChange={() => undefined}
        user={user}
        platform="console"
        consoleLabel={
          <>
            <UserCogIcon className="h-3.5 w-3.5" /> Team logins · {TEAM.label}
          </>
        }
      />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 pb-28 pt-6 sm:px-6">
          {/* ---- title ---- */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Link href="/" className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]">
                ← Back to launcher
              </Link>
              <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
                <UserCogIcon className="h-5 w-5 text-[#9db8ff]" />
                Team logins
              </h1>
              <p className="max-w-[640px] text-[11.5px] leading-relaxed text-faint">
                Who can sign in to the {TEAM.label} launcher. Designers launch; owners also get Owner tools. A change reaches
                the person within seconds — no new sign-in needed, except after a password change or a block.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModal({ kind: "create" })}
              disabled={!data}
              className="flex h-9 items-center gap-2 rounded-xl bg-accent px-4 text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(61,127,255,0.25)] transition-all hover:brightness-110 active:scale-[0.97] disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" />
              New login
            </button>
          </div>

          {shared ? (
            <div className="rounded-xl border border-warn/30 bg-warn/[0.07] px-3.5 py-2.5 text-[12px] leading-snug text-dim">
              <span className="font-semibold text-warn">Shared with Amazon Tools.</span> {TEAM.label} logins are the Amazon Tools
              accounts — a login added, renamed, blocked or deleted here is the same login there.
            </div>
          ) : null}

          {handover ? (
            <HandoverCard
              handover={handover}
              onClose={() => {
                setHandover(null);
                if (reloadAfterHandover) window.location.reload();
              }}
            />
          ) : null}

          {/* ---- search + filters ---- */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or e-mail"
                className="h-9 w-full rounded-xl border border-line bg-surface2 pl-9 pr-3 text-[13px] text-ink placeholder:text-faint outline-none transition-colors focus:border-accent/60"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/60 p-0.5">
              {filterBtn("all", "All", counts.all)}
              {filterBtn("owner", "Owners", counts.owner)}
              {filterBtn("designer", "Designers", counts.designer)}
              {filterBtn("blocked", "Blocked", counts.blocked)}
            </div>
          </div>

          {/* ---- the list ---- */}
          <div className="rounded-2xl border border-line bg-surface/60">
            <div className="hidden grid-cols-[minmax(0,1.5fr)_120px_minmax(0,1.2fr)_auto] gap-3 border-b border-line px-4 py-2 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint md:grid">
              <span>Login</span>
              <span>Role</span>
              <span>E-mail</span>
              <span className="w-[120px] text-right">Actions</span>
            </div>
            {loadError ? (
              <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
                <p className="text-[12.5px] text-warn">{loadError}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="h-8 rounded-lg border border-line bg-surface2 px-3 text-[12px] font-medium text-dim transition-colors hover:border-accent/40 hover:text-[#9db8ff]"
                >
                  Retry
                </button>
              </div>
            ) : !data ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="h-11 animate-pulse rounded-lg bg-surface2" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-[12.5px] text-faint">{users.length === 0 ? "No logins yet." : "Nobody matches."}</p>
            ) : (
              shown.map((u) => {
                const self = u.id === me;
                const added = dayLabel(u.createdAt);
                return (
                  <div
                    key={u.id}
                    className={
                      "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:rounded-b-2xl last:border-b-0 md:grid-cols-[minmax(0,1.5fr)_120px_minmax(0,1.2fr)_auto] " +
                      (u.blocked ? "bg-surface2/30" : "")
                    }
                  >
                    {/* login */}
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={u.username} dim={u.blocked} />
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5">
                          <span className={"truncate text-[13.5px] font-semibold " + (u.blocked ? "text-faint line-through decoration-faint/60" : "text-ink")}>
                            {u.username}
                          </span>
                          {self ? <span className="rounded-full bg-accent/20 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-[#9db8ff]">you</span> : null}
                          {u.blocked ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-danger">
                              <BanIcon className="h-2.5 w-2.5" />
                              blocked
                            </span>
                          ) : null}
                          {!u.hasPassword ? (
                            <span
                              className="tip rounded-full bg-warn/15 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-warn"
                              data-tip="Migrated login that has not signed in since the move — set a password to let them in"
                            >
                              no password
                            </span>
                          ) : null}
                          <span className="md:hidden">
                            <RoleBadge user={u} />
                          </span>
                        </p>
                        <p className="truncate text-[11px] text-faint">
                          {added ? `added ${added}` : "migrated login"}
                          {u.createdBy ? ` by ${u.createdBy}` : ""}
                          <span className="md:hidden">{u.email ? ` · ${u.email}` : ""}</span>
                        </p>
                      </div>
                    </div>
                    {/* role */}
                    <div className="hidden md:block">
                      <RoleBadge user={u} />
                    </div>
                    {/* e-mail */}
                    <div className="hidden min-w-0 md:block">
                      <span className={"block truncate text-[12px] " + (u.email ? "text-dim" : "text-faint/60")} title={u.email ?? undefined}>
                        {u.email ?? "—"}
                      </span>
                    </div>
                    {/* actions */}
                    <div className="flex w-[120px] items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setModal({ kind: "edit", user: u })}
                        data-tip="Edit"
                        title="Name, role, password, e-mail"
                        aria-label={`Edit ${u.username}`}
                        className="tip grid h-8 w-8 place-items-center rounded-lg text-dim transition-colors hover:bg-raise hover:text-[#9db8ff]"
                      >
                        <PencilIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleBlock(u)}
                        disabled={self || rowBusy === u.id}
                        data-tip={self ? "Not yourself" : u.blocked ? "Unblock" : "Block"}
                        title={self ? "You cannot block your own login" : u.blocked ? "They can sign in again" : "Signs them out and keeps the login"}
                        aria-label={u.blocked ? `Unblock ${u.username}` : `Block ${u.username}`}
                        className={
                          "tip grid h-8 w-8 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-35 " +
                          (u.blocked ? "text-danger hover:bg-raise hover:text-launch2" : "text-dim hover:bg-raise hover:text-warn")
                        }
                      >
                        {u.blocked ? <CheckIcon className="h-4 w-4" /> : <BanIcon className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setModal({ kind: "delete", user: u })}
                        disabled={self}
                        data-tip={self ? "Not yourself" : "Delete"}
                        title={self ? "You cannot delete your own login" : undefined}
                        aria-label={`Delete ${u.username}`}
                        className="tip grid h-8 w-8 place-items-center rounded-lg text-dim transition-colors hover:bg-raise hover:text-danger disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <p className="px-1 text-[10.5px] leading-relaxed text-faint">
            Who sees which ad accounts is set in{" "}
            <Link href="/accounts" className="text-dim underline decoration-faint/50 underline-offset-2 hover:text-[#9db8ff]">
              Account access
            </Link>
            . A new login sees only unassigned accounts until it is given some.
          </p>
        </div>
      </main>

      {modal?.kind === "create" || modal?.kind === "edit" ? (
        <LoginModal
          key={modal.kind === "edit" ? `edit-${modal.user.id}` : "create"}
          mode={modal}
          me={me}
          shared={shared}
          onClose={closeModal}
          onSaved={(saved, ho, moved) => {
            setModal(null);
            if (ho) setHandover(ho);
            if (modal.kind === "create") {
              setData((d) => (d ? { ...d, users: [...d.users, saved].sort(byName) } : d));
              setToast({ text: `${saved.username} added as ${saved.owner ? "owner" : "designer"}.`, tone: "ok" });
            } else {
              replaceUser(saved, Boolean(ho));
              const m = moved ? ` Moved: ${moved.accounts} ad account${moved.accounts === 1 ? "" : "s"}, ${moved.tasks} task row${moved.tasks === 1 ? "" : "s"}, ${moved.templates} template${moved.templates === 1 ? "" : "s"}.` : "";
              setToast({ text: `${saved.username} saved.${m}`, tone: "ok" });
            }
          }}
        />
      ) : null}
      {modal?.kind === "delete" ? (
        <DeleteModal
          user={modal.user}
          shared={shared}
          onClose={closeModal}
          onBlocked={(u) => {
            setModal(null);
            replaceUser(u);
            setToast({ text: `${u.username} is blocked — signed out within seconds.`, tone: "ok" });
          }}
          onDeleted={(r) => {
            setModal(null);
            setData((d) => (d ? { ...d, users: d.users.filter((x) => x.id !== modal.user.id) } : d));
            setToast({
              text: `${r.username} deleted.${r.accounts ? ` Removed from ${r.accounts} ad account${r.accounts === 1 ? "" : "s"}${r.freed ? ` (${r.freed} now visible to everyone)` : ""}.` : ""}`,
              tone: "ok",
            });
          }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-5 left-1/2 z-[95] w-[min(92vw,560px)] -translate-x-1/2" aria-live="polite">
          <div
            className={
              "animate-pop-in flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-snug shadow-[0_18px_50px_rgba(0,0,0,0.55)] " +
              (toast.tone === "ok" ? "border-launch/40 bg-surface text-ink" : "border-warn/50 bg-surface text-warn")
            }
          >
            {toast.tone === "ok" ? <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-launch2" /> : <BanIcon className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0 flex-1">{toast.text}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="shrink-0 text-faint hover:text-ink">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
