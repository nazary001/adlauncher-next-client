// Server-only persistence for launch-task rows (MongoDB collection `launch_tasks`, the former Strapi
// `launch-task`). Shared by /api/launch-tasks (client upserts) AND the launch/clone runners, which
// write status/stage progress server-side so the row stays truthful for the whole team even when the
// launching browser dies mid-run. Rows belong to their owner: creates are stamped from the session,
// foreign updates are refused — visibility is shared, authority is not.

import type { Document, Filter } from "mongodb";
import { coll } from "./mongo.ts";
import { LAUNCH_TASKS, STORE_TIMEOUT_MS, bounded, dupKeyOn, insertFresh, storeConfigured, strapiRow, toBigint } from "./store.ts";

export { storeConfigured, STORE_TIMEOUT_MS };

// Short shared cache for the team-wide task list. The list is IDENTICAL for every user in a scope,
// so the whole team's polling (dozens of buyers, every few seconds) collapses to ~one store read per
// scope per TTL on each warm instance. Per-instance (serverless has no shared memory), which is
// plenty: N warm instances read the store at most N×(1/TTL). Owners still see their OWN tasks live —
// the client overlays local state (mergeShared); only other buyers' rows can lag by up to the TTL.
const TEAM_CACHE_TTL_MS = 4_000;
const teamCache = new Map<string, { at: number; tasks: unknown[] }>();

/** Every partner that runs its OWN task manager over this one collection: HS ("br", /api/hs-tasks),
 *  AIF ("us"), Google ("gg"), Snapchat ("sn"), TikTok ("tt") and AV ("av", /api/launch-tasks?scope=av). */
export const DRAWER_PARTNERS = ["br", "us", "gg", "sn", "tt", "av"] as const;

/**
 * The shared-view filter of one drawer: rows with an owner, queued inside the window, and the scope's
 * partner. The MO drawer (scope "mo") takes every row that is NOT another drawer's — INCLUDING rows
 * whose partner is null/missing (historic server-writer/beacon creates; null = MO by definition,
 * lib/task-view.ts). Under Strapi this needed `$or[partner $null][$and partner $ne …]` because SQL's
 * `<>` drops NULLs; Mongo's `$nin` keeps null AND missing values while excluding the listed partners,
 * which is exactly the SQL `IS NULL OR (<> … AND <> …)` set (CONVENTIONS §3.2 — re-derived, not
 * transliterated; tests/mongo-semantics.test.ts proves it on a live collection). `owner: {$ne: null}`
 * is `IS NOT NULL` (a missing owner is excluded too).
 */
export function taskScopeFilter(scope: "mo" | { partner: string }, cutoff: number): Filter<Document> {
  return {
    owner: { $ne: null },
    partner: scope === "mo" ? { $nin: [...DRAWER_PARTNERS] } : scope.partner,
    queued_at: { $gte: cutoff },
  };
}

/**
 * Read the team task list for one scope: served from the short cache when warm, otherwise loaded by
 * `load` (bounded). On a store failure it serves the last good list if there is one (a store blip must
 * not blank the whole team's drawer). Returns `ok:false` only when there is nothing cached AND the
 * load failed. The loader is injected so the cache contract is testable without a database.
 */
export async function readTeamTasksWith<T>(
  scopeKey: string,
  load: () => Promise<Record<string, unknown>[]>,
  mapRow: (row: Record<string, unknown>) => T,
): Promise<{ ok: boolean; tasks: T[] }> {
  const now = Date.now();
  const hit = teamCache.get(scopeKey);
  if (hit && now - hit.at < TEAM_CACHE_TTL_MS) return { ok: true, tasks: hit.tasks as T[] };
  try {
    const rows = await load();
    const tasks = rows.map(mapRow);
    teamCache.set(scopeKey, { at: now, tasks });
    return { ok: true, tasks };
  } catch {
    if (hit) return { ok: true, tasks: hit.tasks as T[] }; // timeout/network → last good list
    return { ok: false, tasks: [] };
  }
}

/**
 * The team list of one drawer scope from the store: newest queued first (the old `sort[0]=queued_at:desc`,
 * no tiebreak — `{partner, queued_at}` serves filter AND sort straight from the index; a compound sort would
 * pull the whole 7-day set into an in-memory sort), at most `limit` rows — the old 3 pages × 100 window. One
 * bounded query; a complete answer or none.
 */
export async function readTeamTasks<T>(
  scopeKey: string,
  filter: Filter<Document>,
  mapRow: (row: Record<string, unknown>) => T,
  opts: { limit: number },
): Promise<{ ok: boolean; tasks: T[] }> {
  return readTeamTasksWith(
    scopeKey,
    async () => {
      const c = await coll(LAUNCH_TASKS);
      const docs = await bounded(
        c.find(filter, { maxTimeMS: STORE_TIMEOUT_MS }).sort({ queued_at: -1 }).limit(opts.limit).toArray(),
        "launch-tasks list",
      );
      return docs.map(strapiRow);
    },
    mapRow,
  );
}

// Fields persisted per task (schema attribute names). Wire format matches this 1:1.
// `owner` is intentionally NOT here — it is always stamped server-side from the session,
// never taken from a request body.
export const TASK_FIELDS = [
  "task_id",
  "name",
  "partner",
  "gcm",
  "geo",
  "budget",
  "status",
  "stage",
  "campaign_id",
  "adset_id",
  "ad_id",
  "link",
  "error",
  "queued_at",
  "started_at",
  "finished_at",
  // Display-only "what it bids on" tag (bidTag: "ROAS 0,3" / "bid $0,5" / "auto") shown on the
  // monitor cards — the `bid` string column (maxLength 40) exists on the shared collection since
  // 2026-09-11. Unknown keys are dropped here (Strapi used to 400 the whole write on them).
  "bid",
  // Server-launch-queue flags (2026-10-08): `srv`=1 marks a row the queue OWNS (the client then
  // never judges it stale, never settles it, and its own writes to it are ignored — see
  // upsertTaskRow's `client` option), `retry`=1 marks a job the owner may re-queue with one click.
  // Both are stamped ONLY by the server (lib/launch-queue-types row patches); a client write that
  // carries them has them stripped in upsertTaskRow.
  "srv",
  "retry",
] as const;

/** biginteger columns — stored as Numbers (CONVENTIONS §2 typing) so the window `$gte` and the sort
 *  compare numbers with numbers; a numeric string from an older client is coerced, never kept. */
const TASK_BIGINT = ["queued_at", "started_at", "finished_at"] as const;

/** Every schema attribute a fresh row carries (nulls for the unset ones, the enum default for status)
 *  — other readers of this collection index the keys directly, so a new row has the same shape as a
 *  migrated one. */
const TASK_ROW_DEFAULTS: Record<string, unknown> = {
  task_id: null,
  owner: null,
  name: null,
  partner: null,
  gcm: null,
  geo: null,
  budget: null,
  status: "queued",
  stage: null,
  campaign_id: null,
  adset_id: null,
  ad_id: null,
  bid: null,
  srv: null,
  retry: null,
  link: null,
  error: null,
  queued_at: null,
  started_at: null,
  finished_at: null,
};

export type TaskRowData = Record<string, unknown>;

export function pickTaskFields(body: Record<string, unknown>): TaskRowData {
  const out: TaskRowData = {};
  for (const k of TASK_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  // `bid` is a display tag bounded by the column (maxLength 40): clamp it here so a stale/buggy
  // client can never break the whole upsert; empty/non-string → omitted (the stored value stays).
  if ("bid" in out) {
    const b = typeof out.bid === "string" ? out.bid.trim().slice(0, 40) : "";
    if (b) out.bid = b;
    else delete out.bid;
  }
  return out;
}

/** Column typing on the way in (biginteger → Number). */
function typeTaskFields(data: TaskRowData): TaskRowData {
  const out: TaskRowData = { ...data };
  for (const k of TASK_BIGINT) if (k in out) out[k] = toBigint(out[k]);
  return out;
}

type FoundTaskRow = { documentId: string; owner: string | null; status: string | null; stage: string | null; srv: boolean };

/**
 * Find one row by task_id. `strict` distinguishes "confirmed absent" (null) from "store failed"
 * (throws) — for guards where a store blip must not read as absence (the hs-tasks zombie-guard
 * would otherwise swallow a terminal write while answering ok:true). Non-strict callers get null
 * on a failure, as they did on a non-2xx read.
 *
 * ⚠️ ONE function with the full nullable body ON PURPOSE — no thin async wrapper. The 08-24
 * `findTaskRow → findTaskRowImpl` wrapper made Turbopack's const-eval mark the awaited result
 * "compile-time truthy": `existing ? PUT : POST` in upsertTaskRow compiled to ALWAYS-PUT with
 * `existing.documentId` on null — every task-row CREATE (team drawers, all partners) crashed
 * on prod for ~16h while updates kept working. Verified in the compiled chunk; keep this shape.
 *
 * `srv` rides the projection too: upsertTaskRow's client-write guard needs it (a client write to a
 * row the server owns is ignored), and the launch-queue runner reads it when settling ambiguous rows.
 */
export async function findTaskRow(taskId: string, strict = false): Promise<FoundTaskRow | null> {
  let row: Document | null = null;
  try {
    const c = await coll(LAUNCH_TASKS);
    row = await bounded(
      c.findOne({ task_id: taskId }, { projection: { documentId: 1, owner: 1, status: 1, stage: 1, srv: 1 }, maxTimeMS: STORE_TIMEOUT_MS }),
      "launch-task read",
    );
  } catch (e) {
    if (strict) throw new Error(`launch-task read failed: ${(e as Error).message ?? String(e)}`);
    return null;
  }
  return row?.documentId
    ? {
        documentId: String(row.documentId),
        owner: row.owner ? String(row.owner) : null,
        status: row.status ? String(row.status) : null,
        stage: row.stage ? String(row.stage) : null,
        srv: row.srv === 1 || row.srv === true,
      }
    : null;
}

export type UpsertResult = { ok: true } | { ok: false; reason: "forbidden" | "store" | "not_configured"; detail?: string };

/**
 * Upsert one task row by task_id on behalf of `user`.
 * Fail CLOSED: an existing row is writable only when its owner is readable AND it is the caller's.
 * A create that loses the unique-task_id race (two writers creating at once — the unique index makes
 * the loser's insert fail with E11000, the former Strapi 400) re-finds and updates. The index is
 * atomic, so no post-create twin check is needed any more.
 *
 * `opts.client` (the POST routes pass it) marks a CLIENT write — a buyer's tab. Two things change:
 * the server-owned flags (srv / retry) are stripped from the incoming fields (a client can never set
 * them), and a write to an EXISTING row that the server OWNS (`srv` set) is silently ignored
 * (`{ok:true}`) — an old tab's heartbeat / stale-settle / pagehide beacon must never bury a job the
 * server is running (spec §4.2 #6). Server writers (the launch queue) omit opts and behave as before.
 */
export async function upsertTaskRow(
  user: string,
  taskId: string,
  fields: TaskRowData,
  opts?: { client?: boolean },
): Promise<UpsertResult> {
  if (!storeConfigured()) return { ok: false, reason: "not_configured" };
  const client = opts?.client === true;
  const incoming: TaskRowData = { ...fields };
  // The server-owned flags are never the client's to set, whatever the wire carries.
  if (client) {
    delete incoming.srv;
    delete incoming.retry;
  }
  const data: TaskRowData = { ...typeTaskFields(pickTaskFields(incoming)), task_id: taskId, owner: user };
  try {
    const c = await coll(LAUNCH_TASKS);
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await findTaskRow(taskId);
      if (existing && existing.owner !== user) return { ok: false, reason: "forbidden" };
      // A client write to a row the SERVER owns is accepted-and-dropped: the queue is the single
      // writer of a job's row, and a stale tab must not demote a live server run.
      if (existing && client && existing.srv) return { ok: true };
      if (existing) {
        const r = await bounded(c.updateOne({ documentId: existing.documentId }, { $set: { ...data, updatedAt: new Date() } }), "launch-task update");
        if (r.matchedCount === 0) return { ok: false, reason: "store", detail: "row vanished before the update" };
        return { ok: true };
      }
      try {
        // Creates default queued_at (the runners' server-side writes don't carry it, and the
        // shared GET windows on it — a row without it would be invisible to the team until the
        // client's own save backfills it). Updates never touch it.
        await insertFresh(LAUNCH_TASKS, { ...TASK_ROW_DEFAULTS, queued_at: Date.now(), ...data });
        return { ok: true };
      } catch (e) {
        // Lost the create race (unique task_id → E11000): the row now exists — retry as an update.
        if (dupKeyOn(e, "task_id") && attempt === 0) continue;
        throw e;
      }
    }
    return { ok: false, reason: "store", detail: "create raced twice" };
  } catch (e) {
    return { ok: false, reason: "store", detail: String(e) };
  }
}

/**
 * Write `fields` ONLY over a row that is still open (queued / running) — ONE atomic conditional
 * update. The launch queue uses it for verdicts it is not sure of ("interrupted", an unknown
 * outcome): such a write must never bury a terminal state the handler itself wrote a moment ago,
 * and it must not depend on a prior read (a store blip on that read used to leave the row
 * "running" for good — review find 08.10). True = written; false = the row is already terminal,
 * or absent. Throws on a store failure, so the caller can try again.
 */
export async function patchOpenTaskRow(taskId: string, fields: TaskRowData): Promise<boolean> {
  const data: TaskRowData = typeTaskFields(pickTaskFields({ ...fields }));
  const c = await coll(LAUNCH_TASKS);
  const r = await bounded(
    c.updateOne({ task_id: taskId, status: { $in: ["queued", "running"] } }, { $set: { ...data, updatedAt: new Date() } }),
    "launch-task open patch",
  );
  return r.matchedCount > 0;
}

/** Delete one row by its documentId (the routes' owner-checked DELETE). True when a row went away;
 *  throws on a store failure (the route answers 502). */
export async function deleteTaskRow(documentId: string): Promise<boolean> {
  const c = await coll(LAUNCH_TASKS);
  const r = await bounded(c.deleteOne({ documentId }), "launch-task delete");
  return r.deletedCount > 0;
}

/**
 * Server-side stamp of a freshly-submitted HS task into the shared store (partner="br"). Called
 * right after LION accepts a create/duplicate so the team sees the row even if the submitting
 * browser dies immediately. For LAUNCHES acceptance IS the terminal outcome (owner call 08-14:
 * nobody waits on LION's answer — results are checked in LION itself), so the row lands "done";
 * duplicates stay "running" — their wave pump / the pollers advance them from the durable LION
 * id in `link`. LION fields ride in reused columns: `link` = LION task id, `gcm` = kind
 * (launch|duplicate), `ad_id` = ad count. Best-effort; the client saver is the fallback.
 */
export async function stampHsTaskRow(
  user: string,
  row: {
    taskId: string;
    name: string;
    geo: string;
    budget: string;
    lionTaskId: string;
    kind: "launch" | "duplicate";
    /** Override stamp: "geo-gate" marks a geo-override clone whose Graph patch has not landed —
     *  /api/hs/activate and the client poller refuse to flip such a row ACTIVE. */
    stage?: string;
    /** Display-only "what it bids on" tag (bidTag) for the monitor card — the caller computes it
     *  from the shot's effective strategy + bid; omitted when there is nothing to show. */
    bid?: string;
  },
): Promise<void> {
  if (!storeConfigured()) return;
  const now = Date.now();
  await upsertTaskRow(user, row.taskId, {
    partner: "br",
    name: row.name,
    geo: row.geo,
    budget: row.budget,
    status: row.kind === "launch" ? "done" : "running",
    stage: row.stage ?? "queue",
    link: row.lionTaskId,
    gcm: row.kind,
    ...(row.bid ? { bid: row.bid } : {}),
    queued_at: now,
    started_at: now,
    ...(row.kind === "launch" ? { finished_at: now } : {}),
  }).catch(() => {});
}

/**
 * Non-blocking, ordered task-row writer for the launch/clone runners: each write() chains after
 * the previous so status transitions land in order without ever delaying the FB pipeline; flush()
 * awaits the tail — call it before closing the stream so Vercel can't freeze the function with a
 * write still in flight. Failures are swallowed (the client-side saver is the fallback writer).
 */
export function taskWriter(user: string, taskId: string | null, statics: TaskRowData = {}) {
  let chain: Promise<unknown> = Promise.resolve();
  const active = Boolean(taskId) && storeConfigured();
  return {
    write(fields: TaskRowData): void {
      if (!active) return;
      // `statics` ride on EVERY write (e.g. partner="us" for the AIF rail) so even a row this
      // writer CREATES (client died before its first save) lands in the right drawer's scope.
      chain = chain.then(() => upsertTaskRow(user, taskId as string, { ...statics, ...fields })).catch(() => {});
    },
    flush(): Promise<unknown> {
      return chain.catch(() => {});
    },
  };
}
