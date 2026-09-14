"use client";

// Owner console: the Facebook token VAULT + the per-partner SIGNER SLOTS (owner ask 2026-09-14).
// Tokens are added / removed here and never leave the server (the page sees labels, identities,
// fingerprints and live health only). Each partner (MO · AIF · HS) has two slots — Launches and
// Clones — naming the token that signs that rail; the HS slots are ordered failover pools. An
// unassigned slot keeps today's env default, so nothing changes until an owner assigns.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, ChevronDownIcon, KeyIcon, LockIcon, PlusIcon, RetryIcon, TrashIcon, XIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import {
  PARTNER_LABEL,
  PARTNER_TITLE,
  SLOT_META,
  TOKEN_PARTNERS,
  describeSlot,
  type SlotId,
  type TokenPartner,
} from "@/lib/fb-token-registry";

// ---- wire shapes (mirror lib/fb-tokens views) -------------------------------------------------

type Identity = {
  ok: boolean;
  error?: string;
  userId: string;
  userName: string;
  appId: string;
  appName: string;
  expiresAt: number;
  dataAccessExpiresAt: number;
  scopes: string[];
  accounts: number | null;
  accountsCapped?: boolean;
  pages: number | null;
  pagesCapped?: boolean;
  checkedAt: number;
};
type Health = { ok: boolean; error?: string; checkedAt: number };
type VaultToken = {
  id: string;
  label: string;
  fp: string;
  partners: TokenPartner[];
  personal: boolean;
  note: string;
  addedBy: string;
  addedAt: number;
  identity: Identity | null;
  source: "registry" | "env";
  envVar?: string;
  readable: boolean;
  health: Health;
  usedIn: SlotId[];
};
type SlotView = {
  slot: SlotId;
  source: "assigned" | "env" | "none";
  assigned: string[];
  tokens: { id: string; label: string; source: "registry" | "env"; fp: string; personal: boolean }[];
  unreadable: string[];
  ok: boolean;
  error?: string;
};
type RegistryEvent = { at: number; by: string; kind: string; text: string };
type View = {
  vaultOpen: boolean;
  tokens: VaultToken[];
  slots: Record<SlotId, SlotView>;
  events: RegistryEvent[];
  updatedAt: number | null;
  updatedBy: string | null;
};

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (!r.ok || !d?.ok) return { ok: false, error: d?.error || `HTTP ${r.status}`, status: r.status };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), status: 0 };
  }
}

// ---- formatting ---------------------------------------------------------------------------------

const PARTNER_OF_RAIL: Record<PartnerId, TokenPartner> = { in: "mo", us: "aif", br: "hs" };
const RAIL_OF_PARTNER: Record<TokenPartner, PartnerId> = { mo: "in", aif: "us", hs: "br" };

function ago(ms: number): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function expiry(ms: number): { text: string; tone: "ok" | "warn" | "danger" } {
  if (!ms) return { text: "never expires", tone: "ok" };
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  const date = new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  if (days < 0) return { text: `expired ${date}`, tone: "danger" };
  if (days < 14) return { text: `expires in ${days} d (${date})`, tone: "warn" };
  return { text: `expires ${date}`, tone: "ok" };
}

const count = (n: number | null, capped?: boolean): string => (n === null ? "?" : `${n}${capped ? "+" : ""}`);

const chip = (tone: "ok" | "warn" | "danger" | "dim" | "accent"): string =>
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold " +
  (tone === "ok"
    ? "border-launch/30 bg-launch/10 text-launch2"
    : tone === "warn"
      ? "border-warn/40 bg-warn/10 text-warn"
      : tone === "danger"
        ? "border-danger/40 bg-danger/10 text-danger"
        : tone === "accent"
          ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
          : "border-line bg-surface2 text-dim");

const btn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ";
const btnGhost = btn + "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink";
const btnAccent = btn + "border-accent/40 bg-accent/10 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/20";
const btnDanger = btn + "border-danger/40 bg-danger/10 text-danger hover:border-danger/60 hover:bg-danger/20";
const inputCls =
  "h-8 w-full rounded-lg border border-line bg-surface2 px-2.5 text-[12.5px] text-ink placeholder:text-faint outline-none focus:border-accent/60";
const selectCls =
  "h-8 w-full rounded-lg border border-line bg-surface2 px-2 text-[12.5px] text-ink outline-none focus:border-accent/60 disabled:opacity-50";

function Dot({ ok, className = "" }: { ok: boolean; className?: string }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-launch2" : "bg-danger"} ${className}`} />;
}

function IdentityLine({ t }: { t: VaultToken }) {
  const id = t.identity;
  if (!id) return <p className="text-[11px] text-faint">identity not probed yet</p>;
  if (!id.ok) return <p className="text-[11px] text-danger">{id.error || "token rejected by Facebook"}</p>;
  const who = [id.userName, id.appName ? `(${id.appName})` : ""].filter(Boolean).join(" ");
  const exp = expiry(id.expiresAt);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
      <span className="text-ink" title={id.userId ? `user id ${id.userId}${id.appId ? ` · app id ${id.appId}` : ""}` : undefined}>
        {who || "unknown user"}
      </span>
      {/* Env seeds get a light probe (user + app only) — no expiry / scopes / counts to show. */}
      {t.source === "registry" ? (
        <>
          <span className={exp.tone === "ok" ? "text-faint" : exp.tone === "warn" ? "text-warn" : "text-danger"}>{exp.text}</span>
          <span title={id.scopes.join(", ") || "scopes unknown"}>{id.scopes.length ? `${id.scopes.length} scopes` : "scopes ?"}</span>
          <span>{count(id.accounts, id.accountsCapped)} ad accounts</span>
          <span>{count(id.pages, id.pagesCapped)} pages</span>
        </>
      ) : null}
      <span className="text-faint">checked {ago(id.checkedAt)}</span>
    </div>
  );
}

// ---- slot card ------------------------------------------------------------------------------------

function SlotCard({
  slot,
  view,
  tokensById,
  busy,
  onSetSlot,
}: {
  slot: SlotId;
  view: SlotView;
  tokensById: Map<string, VaultToken>;
  busy: boolean;
  onSetSlot: (slot: SlotId, ids: string[]) => void;
}) {
  const meta = SLOT_META[slot];
  const eligible = useMemo(
    () => [...tokensById.values()].filter((t) => t.partners.includes(meta.partner) && (t.source === "env" || t.readable)),
    [tokensById, meta.partner],
  );
  const vaultOpts = eligible.filter((t) => t.source === "registry");
  const envOpts = eligible.filter((t) => t.source === "env");
  const assigned = view.assigned;
  const srcChip =
    view.source === "assigned" ? (
      <span className={chip("accent")}>assigned</span>
    ) : view.source === "env" ? (
      <span className={chip("dim")}>env default</span>
    ) : (
      <span className={chip("danger")}>no token</span>
    );

  const optionLabel = (t: VaultToken): string =>
    `${t.label}${t.identity?.userName ? ` — ${t.identity.userName}` : ""}${t.identity?.appName ? ` (${t.identity.appName})` : ""}${t.health.ok ? "" : " · DEAD"}`;

  const options = (exclude: string[]) => (
    <>
      {vaultOpts.filter((t) => !exclude.includes(t.id)).length ? (
        <optgroup label="Vault">
          {vaultOpts
            .filter((t) => !exclude.includes(t.id))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {optionLabel(t)}
              </option>
            ))}
        </optgroup>
      ) : null}
      {envOpts.filter((t) => !exclude.includes(t.id)).length ? (
        <optgroup label="Vercel env (read-only)">
          {envOpts
            .filter((t) => !exclude.includes(t.id))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {optionLabel(t)}
              </option>
            ))}
        </optgroup>
      ) : null}
    </>
  );

  return (
    <div className={"flex flex-col gap-3 rounded-2xl border p-3.5 " + (view.ok ? "border-line bg-surface/60" : "border-danger/40 bg-danger/5")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">{meta.title}</p>
          <p className="text-[10.5px] leading-snug text-faint">{meta.hint}</p>
        </div>
        {srcChip}
      </div>

      {/* what signs right now */}
      <div className="flex flex-col gap-1.5">
        {view.tokens.length === 0 ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-red-300">
            {view.error || "No token — this rail is blocked."}
          </p>
        ) : (
          view.tokens.map((t, i) => {
            const full = tokensById.get(t.id);
            const ok = full?.health.ok ?? true;
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-2.5 py-1.5" title={full?.health.error || undefined}>
                <Dot ok={ok} />
                {meta.pool ? (
                  <span className={chip(i === 0 ? "accent" : "dim")}>{i === 0 ? "primary" : `fallback ${i}`}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                  {t.label}
                  {full?.identity?.userName ? <span className="text-faint"> · {full.identity.userName}</span> : null}
                  {full?.identity?.appName ? <span className="text-faint"> ({full.identity.appName})</span> : null}
                </span>
                {t.personal ? <span className={chip("warn")}>soc</span> : null}
                {t.source === "env" ? <LockIcon className="h-3 w-3 text-faint" /> : null}
              </div>
            );
          })
        )}
        {view.unreadable.length ? (
          <p className="text-[10.5px] leading-relaxed text-danger">
            Unreadable (sealed with another secret): {view.unreadable.join(", ")} — remove and re-add.
          </p>
        ) : null}
      </div>

      {/* assignment control */}
      {meta.pool ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Failover order</span>
          {assigned.length === 0 ? (
            <p className="text-[11px] text-faint">Riding the env default. Add a token to take over this pool.</p>
          ) : (
            assigned.map((id, i) => {
              const t = tokensById.get(id);
              return (
                <div key={id} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2 py-1">
                  <span className="w-5 font-mono text-[10px] text-faint">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{t ? optionLabel(t) : id}</span>
                  <button
                    type="button"
                    disabled={busy || i === 0}
                    onClick={() => {
                      const next = [...assigned];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      onSetSlot(slot, next);
                    }}
                    aria-label="Move up"
                    className="grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-raise hover:text-ink disabled:opacity-30"
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5 rotate-180" />
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === assigned.length - 1}
                    onClick={() => {
                      const next = [...assigned];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      onSetSlot(slot, next);
                    }}
                    aria-label="Move down"
                    className="grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-raise hover:text-ink disabled:opacity-30"
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSetSlot(slot, assigned.filter((x) => x !== id))}
                    aria-label="Remove from pool"
                    className="grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-raise hover:text-danger disabled:opacity-30"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
          <div className="flex items-center gap-1.5">
            <select
              className={selectCls}
              value=""
              disabled={busy || eligible.filter((t) => !assigned.includes(t.id)).length === 0}
              onChange={(e) => {
                if (e.target.value) onSetSlot(slot, [...assigned, e.target.value]);
              }}
            >
              <option value="">{assigned.length ? "Add a fallback token…" : "Pick the primary token…"}</option>
              {options(assigned)}
            </select>
            {assigned.length ? (
              <button type="button" disabled={busy} onClick={() => onSetSlot(slot, [])} className={btnGhost + " shrink-0"} title="Back to the env default">
                Reset
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Signer</span>
          <select
            className={selectCls}
            value={assigned[0] ?? ""}
            disabled={busy}
            onChange={(e) => onSetSlot(slot, e.target.value ? [e.target.value] : [])}
          >
            <option value="">Env default</option>
            {options([])}
          </select>
          {eligible.length === 0 ? (
            <p className="text-[10.5px] text-faint">No token is tagged for {PARTNER_LABEL[meta.partner]} yet — add one on the left.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---- add token ------------------------------------------------------------------------------------

type Probe = { identity: Identity; fp: string; duplicate: { where: "vault" | "env"; label: string } | null };

function AddTokenCard({ onAdded, disabled }: { onAdded: (view: View, label: string) => void; disabled: boolean }) {
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [partners, setPartners] = useState<TokenPartner[]>([]);
  const [personal, setPersonal] = useState(false);
  const [note, setNote] = useState("");
  const [assign, setAssign] = useState<SlotId[]>([]);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const reset = () => {
    setToken("");
    setProbe(null);
    setProbeErr(null);
    setLabel("");
    setPartners([]);
    setPersonal(false);
    setNote("");
    setAssign([]);
    setAddErr(null);
  };

  const check = async () => {
    if (!token.trim() || probing) return;
    setProbing(true);
    setProbeErr(null);
    setProbe(null);
    const r = await call<Probe>("/api/fb-tokens/probe", { method: "POST", body: JSON.stringify({ token }) });
    setProbing(false);
    if (!r.ok) return setProbeErr(r.error);
    setProbe(r.data);
    if (!label.trim() && r.data.identity.userName) setLabel(r.data.identity.userName.slice(0, 40));
  };

  const togglePartner = (p: TokenPartner) => {
    setPartners((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
    setAssign((cur) => cur.filter((s) => SLOT_META[s].partner !== p || partners.includes(p) === false));
  };
  const toggleAssign = (s: SlotId) => setAssign((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const add = async () => {
    if (adding || !probe?.identity.ok || probe.duplicate) return;
    setAdding(true);
    setAddErr(null);
    const r = await call<View>("/api/fb-tokens", {
      method: "POST",
      body: JSON.stringify({ token, label, partners, personal, note, assign: assign.filter((s) => partners.includes(SLOT_META[s].partner)) }),
    });
    setAdding(false);
    if (!r.ok) return setAddErr(r.error);
    onAdded(r.data, label);
    reset();
  };

  const canAdd = Boolean(probe?.identity.ok && !probe?.duplicate && label.trim() && partners.length > 0 && !adding && !disabled);
  const id = probe?.identity;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface/60 p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface2 text-[#9db8ff]">
          <PlusIcon className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[13px] font-semibold text-ink">Add a token</p>
          <p className="text-[10.5px] text-faint">Checked against Facebook before it is stored — sealed at rest.</p>
        </div>
      </div>

      <textarea
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setProbe(null);
          setProbeErr(null);
        }}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        placeholder="Paste the access token (EAA…)"
        className="w-full resize-none rounded-lg border border-line bg-surface2 px-2.5 py-2 font-mono text-[11px] text-ink placeholder:text-faint outline-none focus:border-accent/60"
      />
      <div className="flex items-center gap-2">
        <button type="button" onClick={check} disabled={!token.trim() || probing || disabled} className={btnAccent}>
          {probing ? "Checking…" : "Check token"}
        </button>
        {token ? (
          <button type="button" onClick={reset} className={btnGhost}>
            Clear
          </button>
        ) : null}
      </div>
      {probeErr ? <p className="text-[11px] leading-relaxed text-danger">{probeErr}</p> : null}

      {id ? (
        <div className={"flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 " + (id.ok ? "border-launch/30 bg-launch/5" : "border-danger/40 bg-danger/10")}>
          {id.ok ? (
            <>
              <p className="flex items-center gap-2 text-[12px] text-ink">
                <Dot ok />
                <span className="font-semibold">{id.userName || "unknown user"}</span>
                {id.appName ? <span className="text-faint">via app {id.appName}</span> : null}
              </p>
              <p className="text-[11px] text-dim">
                {expiry(id.expiresAt).text} · {id.scopes.length ? `${id.scopes.length} scopes` : "scopes ?"} · {count(id.accounts, id.accountsCapped)} ad accounts · {count(id.pages, id.pagesCapped)} advertisable pages
              </p>
              {id.scopes.length ? <p className="text-[10px] leading-relaxed text-faint">{id.scopes.join(" · ")}</p> : null}
              {!id.scopes.includes("ads_management") && id.scopes.length ? (
                <p className="text-[10.5px] text-warn">No ads_management scope — launches will fail on this token.</p>
              ) : null}
              {probe?.duplicate ? (
                <p className="text-[11px] text-warn">
                  Already {probe.duplicate.where === "vault" ? "in the vault" : "provided by the Vercel env"} as &quot;{probe.duplicate.label}&quot; — nothing to add.
                </p>
              ) : null}
            </>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-danger">
              <Dot ok={false} />
              Facebook refused this token: {id.error || "unknown error"}
            </p>
          )}
        </div>
      ) : null}

      {id?.ok && !probe?.duplicate ? (
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Harvmo · MO system user" className={inputCls} />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">May sign for</span>
            <div className="flex flex-wrap gap-1.5">
              {TOKEN_PARTNERS.map((p) => {
                const on = partners.includes(p);
                return (
                  <button key={p} type="button" onClick={() => togglePartner(p)} className={btn + (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim hover:text-ink")}>
                    {on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                    {PARTNER_LABEL[p]}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-dim">
            <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} className="mt-0.5 accent-[#3d7fff]" />
            <span>
              Personal soc profile (not a system user) — MO campaign names get the <span className="font-mono">SOC -</span> marker and the gcm note says <span className="font-mono">soc:</span>
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="who issued it, BM, purpose…" className={inputCls} />
          </label>
          {partners.length ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Use it right away for</span>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(SLOT_META) as SlotId[])
                  .filter((s) => partners.includes(SLOT_META[s].partner))
                  .map((s) => {
                    const on = assign.includes(s);
                    return (
                      <button key={s} type="button" onClick={() => toggleAssign(s)} className={btn + (on ? "border-launch/40 bg-launch/10 text-launch2" : "border-line bg-surface2 text-dim hover:text-ink")}>
                        {on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                        {describeSlot(s)}
                      </button>
                    );
                  })}
              </div>
              <p className="text-[10px] text-faint">HS slots are pools — the new token joins as the last fallback; MO/AIF slots switch to it.</p>
            </div>
          ) : null}
          {addErr ? <p className="text-[11px] leading-relaxed text-danger">{addErr}</p> : null}
          <button type="button" onClick={add} disabled={!canAdd} className={btnAccent + " h-9 justify-center"}>
            <KeyIcon className="h-4 w-4" />
            {adding ? "Adding…" : "Add to vault"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---- vault row ------------------------------------------------------------------------------------

function TokenRow({
  t,
  signsIn,
  busy,
  onRecheck,
  onRemove,
  onUpdate,
}: {
  t: VaultToken;
  /** Slots this bearer signs right now — explicitly assigned, or as the env default. */
  signsIn: { slot: SlotId; source: "assigned" | "env" }[];
  busy: boolean;
  onRecheck: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: { label?: string; partners?: TokenPartner[]; personal?: boolean; note?: string }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [label, setLabel] = useState(t.label);
  const [partners, setPartners] = useState<TokenPartner[]>(t.partners);
  const [personal, setPersonal] = useState(t.personal);
  const [note, setNote] = useState(t.note);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(timer);
  }, [confirm]);

  const startEdit = () => {
    setLabel(t.label);
    setPartners(t.partners);
    setPersonal(t.personal);
    setNote(t.note);
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    const ok = await onUpdate(t.id, { label, partners, personal, note });
    setSaving(false);
    if (ok) setEditing(false);
  };

  const dead = !t.health.ok;
  return (
    <div className={"flex flex-col gap-2 rounded-xl border px-3 py-2.5 " + (dead ? "border-danger/35 bg-danger/5" : "border-line bg-surface2")}>
      <div className="flex flex-wrap items-center gap-2">
        <Dot ok={t.health.ok} />
        <span className="text-[13px] font-semibold text-ink">{t.label}</span>
        {t.source === "env" ? (
          <span className={chip("dim")} title={`Provided by the Vercel env var ${t.envVar ?? ""} — remove it there`}>
            <LockIcon className="h-3 w-3" /> env
          </span>
        ) : null}
        {t.partners.map((p) => (
          <span key={p} className={chip("accent")}>
            {PARTNER_LABEL[p]}
          </span>
        ))}
        {t.personal ? <span className={chip("warn")}>personal soc</span> : null}
        {!t.readable ? <span className={chip("danger")}>unreadable</span> : null}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {signsIn.length ? (
            signsIn.map((s) => (
              <span
                key={s.slot}
                className={chip(s.source === "assigned" ? "ok" : "dim")}
                title={s.source === "assigned" ? "assigned on this page" : "signs while the slot is unassigned (env default)"}
              >
                {describeSlot(s.slot)}
                {s.source === "env" ? " · env default" : ""}
              </span>
            ))
          ) : (
            <span className="text-[10px] text-faint">not signing anywhere</span>
          )}
        </span>
      </div>
      <IdentityLine t={t} />
      {dead && t.identity?.ok !== false ? (
        <p className="text-[11px] text-danger">Health: {t.health.error || "token rejected"} (checked {ago(t.health.checkedAt)})</p>
      ) : null}
      {t.note ? <p className="text-[11px] italic text-faint">{t.note}</p> : null}
      {t.source === "registry" ? (
        <p className="text-[10px] text-faint">
          added by {t.addedBy || "?"} {ago(t.addedAt)} · fp <span className="font-mono">{t.fp}</span>
        </p>
      ) : (
        <p className="text-[10px] text-faint">
          from Vercel env <span className="font-mono">{t.envVar}</span> · fp <span className="font-mono">{t.fp}</span> · to retire it, remove the env var and redeploy
        </p>
      )}

      {t.source === "registry" ? (
        editing ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} className={inputCls} placeholder="Label" />
            <div className="flex flex-wrap gap-1.5">
              {TOKEN_PARTNERS.map((p) => {
                const on = partners.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPartners((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))}
                    className={btn + (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim hover:text-ink")}
                  >
                    {on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                    {PARTNER_LABEL[p]}
                  </button>
                );
              })}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-dim">
              <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} className="accent-[#3d7fff]" />
              Personal soc profile (SOC name marker on MO)
            </label>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={inputCls} placeholder="Note" />
            <p className="text-[10px] text-faint">Dropping a partner tag also unassigns the token from that partner&apos;s slots.</p>
            <div className="flex gap-1.5">
              <button type="button" onClick={save} disabled={saving || !label.trim() || partners.length === 0} className={btnAccent}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setEditing(false)} className={btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onRecheck(t.id)} disabled={busy || !t.readable} className={btnGhost} title="Probe Facebook again and refresh the identity">
              <RetryIcon className="h-3.5 w-3.5" /> Re-check
            </button>
            <button type="button" onClick={startEdit} disabled={busy} className={btnGhost}>
              Edit
            </button>
            {confirm ? (
              <button type="button" onClick={() => onRemove(t.id)} disabled={busy} className={btnDanger}>
                <TrashIcon className="h-3.5 w-3.5" />
                {t.usedIn.length ? `Remove & unassign from ${t.usedIn.length} slot${t.usedIn.length === 1 ? "" : "s"}?` : "Confirm remove?"}
              </button>
            ) : (
              <button type="button" onClick={() => setConfirm(true)} disabled={busy} className={btnGhost + " hover:text-danger"}>
                <TrashIcon className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

// ---- board --------------------------------------------------------------------------------------------

export function TokenVaultBoard({ user, initialPartner = "in" }: { user: SessionUser; initialPartner?: PartnerId }) {
  const [rail, setRail] = useState<PartnerId>(initialPartner);
  const [view, setView] = useState<View | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const sectionRefs = useRef<Partial<Record<TokenPartner, HTMLDivElement | null>>>({});
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const r = await call<View>("/api/fb-tokens");
    if (!r.ok) return setLoadErr(r.error);
    setLoadErr(null);
    setView(r.data);
  }, []);

  // Initial read + refresh on focus. All setState lives in the fetch continuations (async IIFE),
  // never synchronously in the effect body — same pattern as the account-access board.
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await call<View>("/api/fb-tokens");
      if (!alive) return;
      if (!r.ok) return setLoadErr(r.error);
      setLoadErr(null);
      setView(r.data);
    })();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(timer);
  }, [flash]);

  // Header partner switch = scroll to that partner's section (mirrored into the URL for refresh).
  const changeRail = (id: PartnerId) => {
    setRail(id);
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.history.replaceState(null, "", url.toString());
  };
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    sectionRefs.current[PARTNER_OF_RAIL[rail]]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [rail]);

  const tokensById = useMemo(() => new Map((view?.tokens ?? []).map((t) => [t.id, t])), [view]);

  const setSlot = async (slot: SlotId, ids: string[]) => {
    setBusy(slot);
    const r = await call<View>("/api/fb-tokens", { method: "PATCH", body: JSON.stringify({ op: "slot", slot, ids }) });
    setBusy(null);
    if (!r.ok) return setFlash({ tone: "danger", text: r.error });
    setView(r.data);
    setFlash({ tone: "ok", text: `${describeSlot(slot)} updated — live for every launch from now on.` });
  };
  const recheck = async (id: string) => {
    setBusy(id);
    const r = await call<View>("/api/fb-tokens", { method: "PATCH", body: JSON.stringify({ op: "recheck", id }) });
    setBusy(null);
    if (!r.ok) return setFlash({ tone: "danger", text: r.error });
    setView(r.data);
    setFlash({ tone: "ok", text: "Identity refreshed." });
  };
  const update = async (id: string, patch: { label?: string; partners?: TokenPartner[]; personal?: boolean; note?: string }): Promise<boolean> => {
    setBusy(id);
    const r = await call<View>("/api/fb-tokens", { method: "PATCH", body: JSON.stringify({ op: "update", id, patch }) });
    setBusy(null);
    if (!r.ok) {
      setFlash({ tone: "danger", text: r.error });
      return false;
    }
    setView(r.data);
    setFlash({ tone: "ok", text: "Token updated." });
    return true;
  };
  const remove = async (id: string) => {
    setBusy(id);
    const r = await call<View & { removedFrom?: SlotId[] }>(`/api/fb-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(null);
    if (!r.ok) return setFlash({ tone: "danger", text: r.error });
    setView(r.data);
    const from = r.data.removedFrom ?? [];
    setFlash({ tone: "ok", text: from.length ? `Removed — ${from.map(describeSlot).join(", ")} fell back to the env default.` : "Removed from the vault." });
  };

  const vault = view?.tokens.filter((t) => t.source === "registry") ?? [];
  const envTokens = view?.tokens.filter((t) => t.source === "env") ?? [];
  const assignedSlots = view ? (Object.keys(view.slots) as SlotId[]).filter((s) => view.slots[s].source === "assigned").length : 0;
  const blockedSlots = view ? (Object.keys(view.slots) as SlotId[]).filter((s) => !view.slots[s].ok) : [];

  return (
    <>
      <Header partner={rail} onPartnerChange={changeRail} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* ---- left: intro + add + changes ---- */}
          <section className="flex flex-col gap-4 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-112px)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex shrink-0 flex-col gap-1.5">
              <Link href="/" className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]">
                ← Back to launcher
              </Link>
              <h1 className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
                <KeyIcon className="h-5 w-5 text-[#9db8ff]" />
                FB tokens
              </h1>
              <p className="text-[11.5px] leading-relaxed text-faint">
                Add Facebook access tokens here and pick, per partner, which one signs <em>launches</em> and which
                one signs <em>clones</em>. Changes are live within seconds — no env edit, no redeploy. The LION API
                token is not managed here.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <span className={chip("dim")}>{vault.length} in vault</span>
                <span className={chip("dim")}>{envTokens.length} from env</span>
                <span className={chip(assignedSlots ? "accent" : "dim")}>{assignedSlots}/6 slots assigned</span>
                {blockedSlots.length ? <span className={chip("danger")}>{blockedSlots.length} blocked</span> : null}
              </div>
            </div>

            {view && !view.vaultOpen ? (
              <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] leading-relaxed text-red-300">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                The vault is closed: AUTH_SECRET is missing or shorter than 32 chars on this deployment. Tokens
                cannot be sealed or opened until it is fixed.
              </div>
            ) : null}

            <AddTokenCard
              disabled={Boolean(view && !view.vaultOpen)}
              onAdded={(v, label) => {
                setView(v);
                setFlash({ tone: "ok", text: `"${label}" added to the vault.` });
              }}
            />

            <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface/60">
              <p className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Recent changes</p>
              <div className="flex max-h-[40vh] flex-col overflow-y-auto overscroll-contain">
                {!view ? (
                  <p className="px-3 py-3 text-[11px] text-faint">Loading…</p>
                ) : view.events.length === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-faint">No changes yet.</p>
                ) : (
                  view.events.map((e, i) => (
                    <div key={`${e.at}-${i}`} className="border-b border-line/60 px-3 py-1.5 last:border-b-0">
                      <p className="text-[11px] leading-snug text-dim">{e.text}</p>
                      <p className="text-[10px] text-faint">
                        {e.by || "?"} · {ago(e.at)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          {/* ---- right: slots per partner + the vault ---- */}
          <section className="flex flex-col gap-5">
            {flash ? (
              <div
                className={
                  "animate-pop-in rounded-xl border px-3 py-2 text-[12px] leading-relaxed " +
                  (flash.tone === "ok" ? "border-launch/30 bg-launch/10 text-launch2" : "border-danger/40 bg-danger/10 text-red-300")
                }
              >
                {flash.text}
              </div>
            ) : null}
            {loadErr ? (
              <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-red-300">
                <AlertIcon className="h-4 w-4 shrink-0" />
                Could not load the registry: {loadErr}
                <button type="button" onClick={() => void load()} className={btnGhost + " ml-auto"}>
                  <RetryIcon className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            ) : null}

            {!view ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">
                {loadErr ? "Registry unavailable." : "Loading the token registry…"}
              </div>
            ) : (
              TOKEN_PARTNERS.map((p) => {
                const active = PARTNER_OF_RAIL[rail] === p;
                const slots = (Object.keys(SLOT_META) as SlotId[]).filter((s) => SLOT_META[s].partner === p);
                return (
                  <div
                    key={p}
                    ref={(el) => {
                      sectionRefs.current[p] = el;
                    }}
                    className={"scroll-mt-24 rounded-2xl border p-4 transition-colors " + (active ? "border-accent/35 bg-accent/[0.04]" : "border-line bg-surface/40")}
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <p className="text-[14px] font-semibold text-ink">{PARTNER_TITLE[p]}</p>
                        <p className="text-[10.5px] text-faint">
                          {p === "hs"
                            ? "Both slots are failover pools: the first token is primary, the rest take over on an app-level limit or a dead token."
                            : "One token per rail. Unassigned = the env default (what runs today)."}
                        </p>
                      </div>
                      {!active ? (
                        <button type="button" onClick={() => changeRail(RAIL_OF_PARTNER[p])} className={btnGhost + " shrink-0"}>
                          Focus
                        </button>
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {slots.map((s) => (
                        <SlotCard key={s} slot={s} view={view.slots[s]} tokensById={tokensById} busy={busy === s} onSetSlot={(slot, ids) => void setSlot(slot, ids)} />
                      ))}
                    </div>
                  </div>
                );
              })
            )}

            {view ? (
              <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[14px] font-semibold text-ink">Vault</p>
                    <p className="text-[10.5px] text-faint">
                      Every bearer the launcher can sign with — {vault.length} stored here, {envTokens.length} still from the Vercel env. Health is a live <span className="font-mono">/me</span> probe (cached a minute).
                    </p>
                  </div>
                  <button type="button" onClick={() => void load()} disabled={busy !== null} className={btnGhost + " shrink-0"}>
                    <RetryIcon className="h-3.5 w-3.5" /> Refresh
                  </button>
                </div>
                {view.tokens.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line2 px-3 py-6 text-center text-[12px] text-faint">
                    No tokens at all — neither in the vault nor in the env. Add one on the left.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {[...vault, ...envTokens].map((t) => (
                      <TokenRow
                        key={t.id}
                        t={t}
                        signsIn={(Object.keys(view.slots) as SlotId[])
                          .filter((s) => view.slots[s].tokens.some((x) => x.id === t.id))
                          .map((s) => ({ slot: s, source: view.slots[s].source === "assigned" ? ("assigned" as const) : ("env" as const) }))}
                        busy={busy === t.id}
                        onRecheck={(id) => void recheck(id)}
                        onRemove={(id) => void remove(id)}
                        onUpdate={update}
                      />
                    ))}
                  </div>
                )}
                {view.updatedAt ? (
                  <p className="text-[10px] text-faint">
                    Registry last changed by {view.updatedBy || "?"} {ago(view.updatedAt)}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
