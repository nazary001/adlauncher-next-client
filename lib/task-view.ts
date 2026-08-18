// Pure view logic for the shared Task Manager: remote-row mapping, list merging and the
// owner-liveness model. No React/DOM — unit-testable and shared by components/task-manager.tsx.

export type TaskKind = "launch" | "clone";
export type TaskStatus = "queued" | "running" | "done" | "error";

/** Display status: raw, or "stale" — a non-terminal row whose owner session stopped reporting.
 *  Derived (never stored): it resolves the moment the owner's session writes again. */
export type EffStatus = TaskStatus | "stale";

export type LaunchTask = {
  id: string;
  kind: TaskKind;
  /** Username that launched/cloned this. Shared view shows everyone's; mutations stay owner-scoped. */
  owner?: string | null;
  name: string;
  /** Partner id ("in" MO / "us" AIF / "br" HS) — labels the marker column ("gcm" vs "brand") and
   *  scopes pool bookkeeping on the board. Older rows may miss it (treated as MO). */
  partner?: string;
  gcm: string;
  geo: string;
  budget: string;
  status: TaskStatus;
  stage: string | null;
  result?: { campaignId?: string; adsetId?: string; adId?: string; gcm?: string; link?: string };
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Server-side updatedAt (ms) of the Strapi row — the liveness signal behind `stale`. */
  updatedMs?: number;
  /** Created this session (has its input → can be retried). Restored rows are false. */
  local?: boolean;
  /** Target ad account id (client-only, set at enqueue — NOT persisted to Strapi): feeds the
   *  launch-limit's optimistic demand, so a board can't over-queue its own wave into one
   *  account. Restored/foreign rows have none — their claims live in the server registry. */
  account?: string;
};

/** A task with its display status resolved against owner liveness. */
export type ViewTask = LaunchTask & { eff: EffStatus };

/** An owner counts as live while ANY of their rows was written within this window. The running
 *  task heartbeats every ~25s (60s in throttled hidden tabs) and the server writes every stage,
 *  so 180s of silence across a whole session reliably means the session is gone. */
export const STALE_MS = 180_000;

const terminal = (s: TaskStatus) => s === "done" || s === "error";

/** A Strapi/localStorage row → in-memory task. */
export function fromRemote(r: Record<string, unknown>): LaunchTask {
  const n = (v: unknown) => {
    if (v == null || v === "") return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const s = (v: unknown) => (v == null ? undefined : String(v));
  const name = s(r.name) ?? "";
  const rawStatus = s(r.status) ?? "queued";
  // Legacy rows may carry the Strapi enum's "interrupted"; the client models that as an error.
  const status: TaskStatus =
    rawStatus === "queued" || rawStatus === "running" || rawStatus === "done" || rawStatus === "error"
      ? rawStatus
      : "error";
  return {
    id: String(r.id ?? r.task_id ?? ""),
    // Strapi doesn't store the kind; the clone name prefix "[DD.MM] (CLONE) - …" is baked in at
    // enqueue, so inferring from the name is reliable for restore rendering.
    kind: /\(clone\)/i.test(name) ? "clone" : "launch",
    owner: s(r.owner) ?? null,
    name,
    partner: s(r.partner),
    gcm: s(r.gcm) ?? "",
    geo: s(r.geo) ?? "",
    budget: s(r.budget) ?? "",
    status,
    stage: s(r.stage) ?? null,
    result:
      r.campaign_id || r.ad_id || r.link
        ? { campaignId: s(r.campaign_id), adsetId: s(r.adset_id), adId: s(r.ad_id), gcm: s(r.gcm), link: s(r.link) }
        : undefined,
    error: s(r.error) ?? (rawStatus === "interrupted" ? "Interrupted — session went offline" : undefined),
    queuedAt: n(r.queued_at) ?? Date.now(),
    startedAt: n(r.started_at),
    finishedAt: n(r.finished_at),
    updatedMs: n(r.updated_ms),
  };
}

/**
 * Merge a freshly-fetched shared list into the current in-memory list.
 * - This session's own tasks (`local`) are authoritative — never clobbered by a lagging row.
 * - Every other row mirrors the fetch exactly: present → shown, absent → it was deleted (or aged
 *   out of the server window) and disappears here too, no reload needed.
 * - `tombstones` are ids just deleted in THIS session — an in-flight fetch snapshotted before the
 *   delete landed must not resurrect them.
 * Newest first (queued_at desc, id as the deterministic tiebreak). Rows keep their object identity
 * when unchanged (`updated_ms` is bumped by every Strapi write, so it doubles as a cheap version) —
 * and the whole array keeps ITS identity when nothing changed, so a quiet 4s poll re-renders nothing.
 */
export function mergeShared(
  cur: LaunchTask[],
  fetched: LaunchTask[],
  tombstones?: ReadonlySet<string>,
): LaunchTask[] {
  const curById = new Map<string, LaunchTask>();
  for (const c of cur) curById.set(c.id, c);
  const byId = new Map<string, LaunchTask>();
  for (const f of fetched) {
    if (!f.id || tombstones?.has(f.id)) continue;
    const prev = curById.get(f.id);
    byId.set(f.id, prev && !prev.local && prev.updatedMs && prev.updatedMs === f.updatedMs ? prev : f);
  }
  for (const c of cur) if (c.local) byId.set(c.id, c);
  const next = [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
  return next.length === cur.length && next.every((t, i) => t === cur[i]) ? cur : next;
}

/** Freshest server write per owner (max updated_ms across ALL their rows — any activity counts). */
export function ownerLastWrite(tasks: readonly LaunchTask[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner || !t.updatedMs) continue;
    if ((last.get(t.owner) ?? 0) < t.updatedMs) last.set(t.owner, t.updatedMs);
  }
  return last;
}

/**
 * Resolve a task's display status. `estServerNow` is the client's estimate of the server clock
 * (Date.now() + skew measured at the last fetch) so owner age is judged clock-skew-free.
 * Local tasks are alive by definition (this session runs them); terminal rows are final; a
 * non-terminal row of a silent owner renders as "stale" until the owner's session writes again.
 */
export function effStatusOf(
  t: LaunchTask,
  lastWriteByOwner: ReadonlyMap<string, number>,
  estServerNow: number,
): EffStatus {
  if (t.local || terminal(t.status)) return t.status;
  const last = t.owner ? lastWriteByOwner.get(t.owner) : undefined;
  if (!last) return "stale"; // no liveness signal at all (e.g. offline localStorage fallback)
  return estServerNow - last > STALE_MS ? "stale" : t.status;
}

/** Deterministic hue for an owner chip (stable across sessions/users). */
export function ownerHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}
