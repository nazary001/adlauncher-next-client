"use client";

// Owner console: split FB ad accounts between the team. Rail tabs ride the header's partner
// switcher (MO / AIF / HS = the same mental model as the boards); the account universe comes
// from the SAME catalog endpoints the pickers use, so what the owner assigns here is exactly
// what a buyer's picker can show. Assignments are keyed by bare account digits (one flat map
// across rails — see lib/acct-assignments for the visibility contract).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { useAdAccounts } from "./use-adaccounts";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from "./icons";
import { PARTNERS, type PartnerId } from "@/lib/partners";

type TeamUser = { username: string; role: string | null; source: string };
type AssignMap = Record<string, string[]>;
type HsAccount = { id: string; name: string; status: number };

/** Assignment key: bare digits (LION ids carry an act_ prefix, Graph ids don't). */
const keyOf = (id: string): string => String(id ?? "").replace(/^act_/, "");
const eq = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const UNASSIGNED = "@unassigned"; // sidebar pseudo-filter

function Avatar({ name, className = "h-5 w-5 text-[10px]" }: { name: string; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full bg-accent/20 font-mono font-semibold text-[#9db8ff] ${className}`}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

/** Popover with the roster as a checkbox list + free-typed add. Renders right-aligned under its
 *  anchor (the row / bulk bar provides a `relative` parent). */
function AssignPopover({
  title,
  roster,
  initial,
  applyLabel,
  onApply,
  onClose,
  up = false,
}: {
  title: string;
  roster: TeamUser[];
  initial: string[];
  applyLabel: string;
  onApply: (users: string[]) => void;
  onClose: () => void;
  up?: boolean;
}) {
  const [checked, setChecked] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const [freeAdd, setFreeAdd] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Checked names missing from the roster (older assignment / free-typed) still get a row.
  const names = useMemo(() => {
    const out = roster.map((u) => u.username);
    for (const c of checked) if (!out.some((n) => eq(n, c))) out.push(c);
    return out;
  }, [roster, checked]);

  const q = query.trim().toLowerCase();
  const shown = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;

  const toggle = (name: string) =>
    setChecked((cur) => (cur.some((c) => eq(c, name)) ? cur.filter((c) => !eq(c, name)) : [...cur, name]));

  const addFree = () => {
    const name = freeAdd.trim();
    if (!name) return;
    if (!checked.some((c) => eq(c, name))) setChecked((cur) => [...cur, name]);
    setFreeAdd("");
  };

  return (
    <div
      ref={boxRef}
      className={
        "absolute right-0 z-50 w-[264px] animate-pop-in rounded-2xl border border-line bg-surface p-2 " +
        "shadow-[0_18px_50px_rgba(0,0,0,0.5)] " +
        (up ? "bottom-full mb-2" : "top-full mt-2")
      }
    >
      <p className="px-1.5 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
        {title}
      </p>
      <div className="relative mb-1.5">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search team"
          className="h-8 w-full rounded-lg border border-line bg-surface2 pl-8 pr-2 text-[12.5px] text-ink placeholder:text-faint outline-none focus:border-accent/60"
        />
      </div>
      <div className="flex max-h-[220px] flex-col overflow-y-auto overscroll-contain">
        {shown.length === 0 ? (
          <p className="px-1.5 py-3 text-center text-[11.5px] text-faint">No one matches.</p>
        ) : (
          shown.map((name) => {
            const user = roster.find((u) => eq(u.username, name));
            const on = checked.some((c) => eq(c, name));
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-raise"
              >
                <Avatar name={name} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{name}</span>
                {user?.role ? (
                  <span className="rounded-md bg-surface2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-faint">
                    {user.role}
                  </span>
                ) : null}
                <span
                  className={
                    "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors " +
                    (on ? "border-accent bg-accent text-white" : "border-line2 bg-surface2 text-transparent")
                  }
                >
                  <CheckIcon className="h-3 w-3" />
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 border-t border-line pt-1.5">
        <input
          value={freeAdd}
          onChange={(e) => setFreeAdd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFree();
            }
          }}
          placeholder="Add username…"
          className="h-7 min-w-0 flex-1 rounded-lg border border-line bg-surface2 px-2 text-[12px] text-ink placeholder:text-faint outline-none focus:border-accent/60"
        />
        <button
          type="button"
          onClick={addFree}
          disabled={!freeAdd.trim()}
          aria-label="Add username"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-surface2 text-dim transition-colors hover:border-line2 hover:text-ink disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-lg px-3 text-[12px] font-medium text-dim transition-colors hover:bg-raise hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onApply(checked)}
          className="h-8 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white transition-all hover:brightness-110 active:scale-[0.97]"
        >
          {applyLabel}
        </button>
      </div>
    </div>
  );
}

/** One account row: checkbox for bulk, name + id, assignee chips, per-row Assign popover. */
function AccountRow({
  id,
  name,
  assigned,
  roster,
  selected,
  onToggleSelect,
  onSave,
  readonly,
}: {
  id: string;
  name: string;
  assigned: string[];
  roster: TeamUser[];
  selected: boolean;
  onToggleSelect: () => void;
  onSave: (users: string[]) => void;
  /** Registry unreadable → chips render but nothing is editable (a save would be refused). */
  readonly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const key = keyOf(id);

  return (
    <div
      className={
        "group relative flex items-center gap-3 border-b border-line/60 px-3 py-2 transition-colors last:border-b-0 " +
        (selected ? "bg-accent/[0.06]" : "hover:bg-raise/40")
      }
    >
      <button
        type="button"
        onClick={onToggleSelect}
        aria-label={selected ? "Deselect account" : "Select account"}
        className={
          "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors " +
          (selected ? "border-accent bg-accent text-white" : "border-line2 bg-surface2 text-transparent hover:border-accent/50")
        }
      >
        <CheckIcon className="h-3 w-3" />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink" title={name}>
          {name || key}
        </p>
        <p className="font-mono text-[10.5px] text-faint">{key}</p>
      </div>

      <div className="flex max-w-[46%] flex-wrap items-center justify-end gap-1">
        {assigned.length === 0 ? (
          <span className="rounded-full border border-line bg-surface2/60 px-2 py-0.5 text-[10px] font-medium text-faint">
            everyone
          </span>
        ) : (
          assigned.map((u) => (
            <span
              key={u}
              className="flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 py-0.5 pl-1 pr-1.5 text-[11px] font-medium text-[#9db8ff]"
            >
              <Avatar name={u} className="h-3.5 w-3.5 text-[8px]" />
              {u}
              {readonly ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${u}`}
                  onClick={() => onSave(assigned.filter((x) => !eq(x, u)))}
                  className="text-[#9db8ff]/60 transition-colors hover:text-danger"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              )}
            </span>
          ))
        )}
      </div>

      <button
        type="button"
        disabled={readonly}
        onClick={() => setEditing((v) => !v)}
        className={
          "flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-all " +
          (editing
            ? "border-accent/50 bg-accent/15 text-[#9db8ff]"
            : "border-line bg-surface2 text-dim opacity-0 hover:border-accent/40 hover:text-[#9db8ff] focus-visible:opacity-100 group-hover:opacity-100")
        }
      >
        <UsersIcon className="h-3.5 w-3.5" />
        Assign
      </button>

      {editing ? (
        <AssignPopover
          title={name || key}
          roster={roster}
          initial={assigned}
          applyLabel="Apply"
          onApply={(users) => {
            onSave(users);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function SkeletonRows({ n = 5 }: { n?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 border-b border-line/60 px-3 py-3 last:border-b-0">
          <span className="h-4 w-4 rounded bg-surface2" />
          <span className="h-3.5 w-1/3 rounded bg-surface2" />
          <span className="ml-auto h-3.5 w-20 rounded bg-surface2" />
        </div>
      ))}
    </div>
  );
}

export function AccountAccessBoard({
  user,
  initialPartner = "in",
}: {
  user: SessionUser;
  initialPartner?: PartnerId;
}) {
  const [rail, setRail] = useState<PartnerId>(initialPartner);
  const [assignments, setAssignments] = useState<AssignMap | null>(null);
  const [regError, setRegError] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamUser[] | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Rail switch stays client-side (unlike the boards, nothing here is partner-bound in memory) —
  // just mirror it into the URL so a refresh restores the tab.
  const changeRail = (id: PartnerId) => {
    setRail(id);
    setSelected(new Set());
    setBulkOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.history.replaceState(null, "", url.toString());
  };

  // ---- data: assignments registry + team roster ------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/acct-assignments");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; accounts?: AssignMap; error?: string };
        if (!alive) return;
        if (r.ok && d.ok && d.accounts) {
          setAssignments(d.accounts);
          setRegError(null);
        } else {
          setRegError(d.error || `HTTP ${r.status}`);
        }
      } catch {
        if (alive) setRegError("network");
      }
    })();
    (async () => {
      try {
        const r = await fetch("/api/team");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; users?: TeamUser[] };
        if (alive && r.ok && d.ok && Array.isArray(d.users)) setTeam(d.users);
      } catch {
        /* roster degrades to names already in the registry */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Roster = server roster + any names only the registry knows (still removable from chips).
  const roster = useMemo<TeamUser[]>(() => {
    const out = [...(team ?? [])];
    for (const users of Object.values(assignments ?? {})) {
      for (const name of users) {
        if (!out.some((u) => eq(u.username, name))) out.push({ username: name, role: null, source: "assignments" });
      }
    }
    // The owner assigns to OTHERS; their own row stays (self-assignment is harmless) but sinks.
    return out.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
  }, [team, assignments]);

  // ---- data: per-rail account catalogs ---------------------------------------------------------
  // MO + AIF load eagerly (tab switches feel instant); both endpoints answer from server caches.
  const moAccounts = useAdAccounts(true, undefined, "/api/adaccounts");
  const aifAccounts = useAdAccounts(true, undefined, "/api/aif/adaccounts");

  // HS: profile slugs once, then each profile's accounts on expand (a full sweep of every LION
  // profile is heavy — hundreds of accounts per profile — so expansion is the load trigger).
  const [hsProfiles, setHsProfiles] = useState<string[] | null>(null);
  const [hsData, setHsData] = useState<Map<string, HsAccount[] | null>>(new Map());
  const [hsExpanded, setHsExpanded] = useState<ReadonlySet<string>>(new Set());
  const hsWanted = rail === "br";

  useEffect(() => {
    if (!hsWanted || hsProfiles !== null) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/hs/profiles");
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; profiles?: string[] };
        if (alive && r.ok && d.ok && Array.isArray(d.profiles)) setHsProfiles(d.profiles);
        else if (alive) setHsProfiles([]);
      } catch {
        if (alive) setHsProfiles([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hsWanted, hsProfiles]);

  const toggleProfile = (slug: string) => {
    setHsExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    if (!hsData.has(slug)) {
      setHsData((m) => new Map(m).set(slug, null));
      void (async () => {
        try {
          const r = await fetch(`/api/hs/profile-data?slug=${encodeURIComponent(slug)}`);
          const d = (await r.json().catch(() => ({}))) as { ok?: boolean; accounts?: HsAccount[] };
          const rows = r.ok && d.ok && Array.isArray(d.accounts) ? d.accounts.filter((a) => a.status === 1) : [];
          setHsData((m) => new Map(m).set(slug, rows));
        } catch {
          setHsData((m) => {
            const next = new Map(m);
            next.delete(slug); // retry on next expand
            return next;
          });
        }
      })();
    }
  };

  // ---- saving ----------------------------------------------------------------------------------
  const save = useCallback(
    async (set: Record<string, string[]>) => {
      setSaveError(null);
      const snapshot = assignments ?? {};
      const next: AssignMap = { ...snapshot };
      for (const [k, users] of Object.entries(set)) {
        if (users.length) next[k] = users;
        else delete next[k];
      }
      setAssignments(next); // optimistic
      try {
        const r = await fetch("/api/acct-assignments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ set }),
        });
        const d = (await r.json().catch(() => ({}))) as { ok?: boolean; accounts?: AssignMap; error?: string };
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (d.accounts) setAssignments(d.accounts);
        setSavedAt(Date.now());
      } catch (e) {
        setAssignments(snapshot); // revert
        setSaveError(String((e as Error).message ?? e));
      }
    },
    [assignments],
  );

  // Transient "Saved" tick.
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 2500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // ---- filtering -------------------------------------------------------------------------------
  const assignedOf = useCallback((id: string): string[] => assignments?.[keyOf(id)] ?? [], [assignments]);

  const q = query.trim().toLowerCase();
  const passes = useCallback(
    (id: string, name: string): boolean => {
      if (q && !name.toLowerCase().includes(q) && !keyOf(id).includes(q)) return false;
      const users = assignedOf(id);
      if (focus === UNASSIGNED) return users.length === 0;
      if (focus) return users.some((u) => eq(u, focus));
      return true;
    },
    [q, focus, assignedOf],
  );

  const countFor = useCallback(
    (name: string): number => Object.values(assignments ?? {}).filter((users) => users.some((u) => eq(u, name))).length,
    [assignments],
  );
  const unassignedIsFocus = focus === UNASSIGNED;

  // ---- selection / bulk ------------------------------------------------------------------------
  const toggleSelect = (id: string) => {
    const key = keyOf(id);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const bulkAssign = (users: string[]) => {
    if (users.length === 0) {
      setBulkOpen(false);
      return;
    }
    const set: Record<string, string[]> = {};
    for (const key of selected) {
      const cur = assignments?.[key] ?? [];
      const merged = [...cur];
      for (const u of users) if (!merged.some((x) => eq(x, u))) merged.push(u);
      set[key] = merged;
    }
    void save(set);
    setBulkOpen(false);
    setSelected(new Set());
  };

  const bulkClear = () => {
    const set: Record<string, string[]> = {};
    for (const key of selected) set[key] = [];
    void save(set);
    setSelected(new Set());
  };

  // ---- rail rows -------------------------------------------------------------------------------
  const graphRows = rail === "in" ? moAccounts : rail === "us" ? aifAccounts : null;
  const railLabel = PARTNERS.find((p) => p.id === rail)?.label ?? rail;

  const renderRows = (rows: { id: string; name: string }[]) => {
    const shown = rows.filter((r) => passes(r.id, r.name));
    if (shown.length === 0) {
      return (
        <p className="px-3 py-6 text-center text-[12px] text-faint">
          {rows.length === 0 ? "No accounts on this rail." : "Nothing matches the current filter."}
        </p>
      );
    }
    return shown.map((r) => (
      <AccountRow
        key={r.id}
        id={r.id}
        name={r.name}
        assigned={assignedOf(r.id)}
        roster={roster}
        selected={selected.has(keyOf(r.id))}
        onToggleSelect={() => toggleSelect(r.id)}
        onSave={(users) => void save({ [keyOf(r.id)]: users })}
        readonly={assignments === null}
      />
    ));
  };

  return (
    <>
      <Header partner={rail} onPartnerChange={changeRail} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-28 pt-6 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---- left: intro + team roster ---- */}
          <section className="flex flex-col gap-4 lg:sticky lg:top-[88px]">
            <div className="flex flex-col gap-1.5">
              <Link
                href="/"
                className="w-fit text-[11px] font-medium text-faint transition-colors hover:text-[#9db8ff]"
              >
                ← Back to launcher
              </Link>
              <h1 className="text-[19px] font-semibold tracking-tight text-ink">Account access</h1>
              <p className="text-[11.5px] leading-relaxed text-faint">
                Assign FB ad accounts to teammates — their pickers then show <em>only their</em>{" "}
                accounts. An unassigned account stays visible to the whole team; owners always see
                everything.
              </p>
            </div>

            <div className="overflow-hidden rounded-2xl border border-line bg-surface/60">
              <p className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                Team
              </p>
              <button
                type="button"
                onClick={() => setFocus(null)}
                className={
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors " +
                  (focus === null ? "bg-accent/10" : "hover:bg-raise/50")
                }
              >
                <span className="grid h-6 w-6 place-items-center rounded-full border border-line bg-surface2 text-faint">
                  <UsersIcon className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 text-[12.5px] font-medium text-ink">All accounts</span>
              </button>
              <button
                type="button"
                onClick={() => setFocus(unassignedIsFocus ? null : UNASSIGNED)}
                className={
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors " +
                  (unassignedIsFocus ? "bg-accent/10" : "hover:bg-raise/50")
                }
              >
                <span className="grid h-6 w-6 place-items-center rounded-full border border-dashed border-line2 bg-surface2 text-faint">
                  ?
                </span>
                <span className="flex-1 text-[12.5px] font-medium text-dim">Unassigned only</span>
              </button>
              <div className="h-px bg-line" />
              {team === null && roster.length === 0 ? (
                <div className="flex flex-col gap-2 p-3">
                  {Array.from({ length: 3 }, (_, i) => (
                    <div key={i} className="h-6 animate-pulse rounded bg-surface2" />
                  ))}
                </div>
              ) : roster.length === 0 ? (
                <p className="px-3 py-4 text-[11.5px] text-faint">
                  No teammates found yet — they appear after their first launch, or add one by name
                  inside any Assign dialog.
                </p>
              ) : (
                roster.map((u) => {
                  const active = focus !== null && focus !== UNASSIGNED && eq(focus, u.username);
                  const n = countFor(u.username);
                  return (
                    <button
                      key={u.username}
                      type="button"
                      onClick={() => setFocus(active ? null : u.username)}
                      className={
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors " +
                        (active ? "bg-accent/10" : "hover:bg-raise/50")
                      }
                    >
                      <Avatar name={u.username} className="h-6 w-6 text-[10px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ink">{u.username}</span>
                        {u.role ? (
                          <span className="block text-[9.5px] font-medium uppercase tracking-wide text-faint">
                            {u.role}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 font-mono text-[10.5px] " +
                          (n > 0 ? "bg-accent/15 text-[#9db8ff]" : "bg-surface2 text-faint")
                        }
                      >
                        {n}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* ---- right: accounts of the active rail ---- */}
          <section className="flex flex-col gap-3">
            {regError ? (
              <div className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[12px] text-danger">
                Assignment registry is unreachable ({regError}) — editing is disabled and pickers
                are temporarily unfiltered. Reload to retry.
              </div>
            ) : null}
            {saveError ? (
              <div className="rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[12px] text-warn">
                Saving failed ({saveError}) — the change was rolled back. Try again.
              </div>
            ) : null}

            <div className="flex items-center gap-2.5">
              <div className="relative min-w-0 flex-1">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${railLabel} accounts by name or id`}
                  className="h-9 w-full rounded-xl border border-line bg-surface2 pl-9 pr-3 text-[13px] text-ink placeholder:text-faint outline-none transition-colors focus:border-accent/60"
                />
              </div>
              {focus ? (
                <button
                  type="button"
                  onClick={() => setFocus(null)}
                  className="flex h-9 items-center gap-1.5 rounded-xl border border-accent/40 bg-accent/10 px-3 text-[12px] font-medium text-[#9db8ff] transition-colors hover:border-accent/60"
                >
                  {focus === UNASSIGNED ? "Unassigned" : focus}
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <span
                aria-live="polite"
                className={
                  "flex items-center gap-1 text-[11.5px] font-medium text-launch2 transition-opacity duration-300 " +
                  (showSaved ? "opacity-100" : "opacity-0")
                }
              >
                <CheckIcon className="h-3.5 w-3.5" />
                Saved
              </span>
            </div>

            {rail !== "br" ? (
              <div className="overflow-hidden rounded-2xl border border-line bg-surface/60">
                {graphRows === null ? (
                  <SkeletonRows n={6} />
                ) : (
                  renderRows(graphRows.map((a) => ({ id: a.value, name: a.label })))
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {hsProfiles === null ? (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface/60">
                    <SkeletonRows n={6} />
                  </div>
                ) : hsProfiles.length === 0 ? (
                  <p className="rounded-2xl border border-line bg-surface/60 px-3 py-6 text-center text-[12px] text-faint">
                    LION returned no profiles.
                  </p>
                ) : (
                  hsProfiles.map((slug) => {
                    const openP = hsExpanded.has(slug);
                    const rows = hsData.get(slug);
                    return (
                      <div key={slug} className="overflow-hidden rounded-2xl border border-line bg-surface/60">
                        <button
                          type="button"
                          onClick={() => toggleProfile(slug)}
                          aria-expanded={openP}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-raise/40"
                        >
                          <ChevronDownIcon
                            className={`h-4 w-4 text-faint transition-transform duration-150 ${openP ? "" : "-rotate-90"}`}
                          />
                          <span className="flex-1 truncate font-mono text-[12.5px] font-medium text-ink">{slug}</span>
                          <span className="font-mono text-[10.5px] text-faint">
                            {rows ? `${rows.length} accounts` : openP ? "loading…" : ""}
                          </span>
                        </button>
                        {openP ? (
                          rows === undefined || rows === null ? (
                            <SkeletonRows n={3} />
                          ) : (
                            <div className="border-t border-line">
                              {renderRows(rows.map((a) => ({ id: a.id, name: a.name })))}
                            </div>
                          )
                        ) : null}
                      </div>
                    );
                  })
                )}
                <p className="px-1 text-[10.5px] leading-relaxed text-faint">
                  LION profiles mirror one account pool — an assignment follows the account into
                  every profile (and into the FB Token rail) automatically.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* ---- bulk bar ---- */}
      {selected.size > 0 && assignments !== null ? (
        <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2">
          <div className="relative flex items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.55)]">
            <span className="pr-1 text-[12.5px] font-medium text-ink">
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => setBulkOpen((v) => !v)}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-white transition-all hover:brightness-110 active:scale-[0.97]"
            >
              <UsersIcon className="h-3.5 w-3.5" />
              Assign to…
            </button>
            <button
              type="button"
              onClick={bulkClear}
              data-tip="Clear assignments — back to visible for everyone"
              className="tip flex h-8 items-center rounded-lg border border-line bg-surface2 px-3 text-[12px] font-medium text-dim transition-colors hover:border-warn/50 hover:text-warn"
            >
              Reset to everyone
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(new Set());
                setBulkOpen(false);
              }}
              aria-label="Clear selection"
              className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink"
            >
              <XIcon className="h-4 w-4" />
            </button>
            {bulkOpen ? (
              <AssignPopover
                up
                title={`Add to ${selected.size} account${selected.size === 1 ? "" : "s"}`}
                roster={roster}
                initial={[]}
                applyLabel="Add users"
                onApply={bulkAssign}
                onClose={() => setBulkOpen(false)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
