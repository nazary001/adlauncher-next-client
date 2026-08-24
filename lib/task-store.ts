// Server-only persistence for launch-task rows (Strapi collection `launch-task`).
// Shared by /api/launch-tasks (client upserts) AND the launch/clone runners, which write
// status/stage progress server-side so the row stays truthful for the whole team even when the
// launching browser dies mid-run. Rows belong to their owner: creates are stamped from the
// session, foreign updates are refused — visibility is shared, authority is not.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

export const storeConfigured = () => Boolean(STRAPI && TOKEN);

// Every Strapi call is bounded: the shared Strapi Cloud instance flakes under the team's polling
// load (repeated 503/timeout incidents), and an unbounded fetch would hang the function to the
// 60s runtime limit → "Vercel Runtime Timeout Error" (504) and 50× the GB-hours. A bounded call
// fails fast so the route can serve stale/empty instead of piling up hung invocations.
export const STRAPI_TIMEOUT_MS = 8_000;
export async function strapiFetch(url: string, init: RequestInit = {}, timeoutMs = STRAPI_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Short shared cache for the team-wide task list. The list is IDENTICAL for every user in a scope,
// so the whole team's polling (dozens of buyers, every few seconds) collapses to ~one Strapi read
// per scope per TTL on each warm instance — the difference between Strapi coasting and Strapi
// falling over. Per-instance (serverless has no shared memory), which is plenty: N warm instances
// read Strapi at most N×(1/TTL). Owners still see their OWN tasks live — the client overlays local
// state (mergeShared); only other buyers' rows can lag by up to the TTL.
const TEAM_CACHE_TTL_MS = 4_000;
const teamCache = new Map<string, { at: number; tasks: unknown[] }>();

/**
 * Read the team task list for one scope: served from the short cache when warm, otherwise fetched
 * from Strapi page-by-page (each page bounded by strapiFetch). On an upstream failure it serves the
 * last good list if there is one (a Strapi blip must not blank the whole team's drawer). Returns
 * `ok:false` only when there is nothing cached AND the fetch failed.
 */
export async function readTeamTasks<T>(
  scopeKey: string,
  pageUrl: (page: number) => string,
  mapRow: (row: Record<string, unknown>) => T,
  opts: { pageSize: number; maxPages: number },
): Promise<{ ok: boolean; tasks: T[]; status?: number }> {
  const now = Date.now();
  const hit = teamCache.get(scopeKey);
  if (hit && now - hit.at < TEAM_CACHE_TTL_MS) return { ok: true, tasks: hit.tasks as T[] };
  try {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= opts.maxPages; page++) {
      const res = await strapiFetch(pageUrl(page), { headers: H(), cache: "no-store" });
      if (!res.ok) {
        if (rows.length > 0) break; // keep the pages we got
        if (hit) return { ok: true, tasks: hit.tasks as T[] }; // serve stale rather than blank
        return { ok: false, tasks: [], status: res.status };
      }
      const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
      const data = body.data ?? [];
      rows.push(...data);
      if (data.length < opts.pageSize) break;
    }
    const tasks = rows.map(mapRow);
    teamCache.set(scopeKey, { at: now, tasks });
    return { ok: true, tasks };
  } catch {
    if (hit) return { ok: true, tasks: hit.tasks as T[] }; // timeout/network → last good list
    return { ok: false, tasks: [] };
  }
}

// Fields persisted per task (Strapi attribute names). Wire format matches this 1:1.
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
] as const;

export type TaskRowData = Record<string, unknown>;

export function pickTaskFields(body: Record<string, unknown>): TaskRowData {
  const out: TaskRowData = {};
  for (const k of TASK_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

type FoundTaskRow = { documentId: string; owner: string | null; status: string | null };

async function findTaskRowImpl(taskId: string, strict: boolean): Promise<FoundTaskRow | null> {
  const res = await strapiFetch(
    `${STRAPI}/api/launch-tasks?filters[task_id][$eq]=${encodeURIComponent(taskId)}&fields[0]=task_id&fields[1]=owner&fields[2]=status&pagination[pageSize]=1`,
    { headers: H(), cache: "no-store" },
  );
  if (!res.ok) {
    if (strict) throw new Error(`launch-task read ${res.status}`);
    return null;
  }
  const body = await res.json().catch(() => ({}));
  const row = body?.data?.[0];
  return row?.documentId
    ? {
        documentId: row.documentId,
        owner: row.owner ? String(row.owner) : null,
        status: row.status ? String(row.status) : null,
      }
    : null;
}

export async function findTaskRow(taskId: string): Promise<FoundTaskRow | null> {
  return findTaskRowImpl(taskId, false);
}

/** findTaskRow that DISTINGUISHES "confirmed absent" (null) from "store failed" (throws) — for
 *  guards where a Strapi blip must not read as absence: the hs-tasks zombie-guard would
 *  otherwise swallow a terminal write while answering ok:true, and the client never retries a
 *  claimed success. (A network/timeout rejection from strapiFetch propagates in both modes.) */
export async function findTaskRowStrict(taskId: string): Promise<FoundTaskRow | null> {
  return findTaskRowImpl(taskId, true);
}

export type UpsertResult = { ok: true } | { ok: false; reason: "forbidden" | "store" | "not_configured"; detail?: string };

/**
 * Post-create verify: Strapi's app-level unique constraint has a TOCTOU window (proven live for
 * gcm-map on 08-09, observed for launch-task on 08-10 — task c1b148e8… committed TWICE from a
 * concurrent client save + server beat), so two simultaneous creates of one task_id can BOTH
 * succeed. After winning a create, re-read the code's rows; if a twin exists, the OLDEST row
 * (createdAt, then documentId — same total order every writer computes) is canonical: delete the
 * caller-owned extras and fold this write's fields into the survivor. Best-effort — a failure
 * here leaves at worst the pre-existing duplicate, never lost data.
 */
async function dedupeTaskRows(user: string, taskId: string, data: TaskRowData): Promise<void> {
  try {
    const res = await strapiFetch(
      `${STRAPI}/api/launch-tasks?filters[task_id][$eq]=${encodeURIComponent(taskId)}` +
        `&fields[0]=task_id&fields[1]=owner&fields[2]=createdAt&sort[0]=createdAt:asc&sort[1]=documentId:asc&pagination[pageSize]=5`,
      { headers: H(), cache: "no-store" },
    );
    if (!res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> };
    const rows = body.data ?? [];
    if (rows.length <= 1) return;
    const [keep, ...extras] = rows;
    for (const r of extras) {
      const owner = r.owner ? String(r.owner) : null;
      if (owner === user && r.documentId) {
        await strapiFetch(`${STRAPI}/api/launch-tasks/${r.documentId}`, { method: "DELETE", headers: H() });
      }
    }
    const keepOwner = keep.owner ? String(keep.owner) : null;
    if (keepOwner === user && keep.documentId) {
      await strapiFetch(`${STRAPI}/api/launch-tasks/${keep.documentId}`, {
        method: "PUT",
        headers: H(),
        body: JSON.stringify({ data }),
      });
    }
  } catch {
    /* best-effort — the duplicate stays visible until the next write's verify */
  }
}

/**
 * Upsert one task row by task_id on behalf of `user`.
 * Fail CLOSED: an existing row is writable only when its owner is readable AND it is the caller's.
 * A create that loses the unique-task_id race (two writers creating at once) re-finds and updates;
 * a create that "wins" is verified for a committed twin (see dedupeTaskRows).
 */
export async function upsertTaskRow(user: string, taskId: string, fields: TaskRowData): Promise<UpsertResult> {
  if (!storeConfigured()) return { ok: false, reason: "not_configured" };
  const data: TaskRowData = { ...pickTaskFields(fields), task_id: taskId, owner: user };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await findTaskRow(taskId);
      if (existing && existing.owner !== user) return { ok: false, reason: "forbidden" };
      const res = existing
        ? await strapiFetch(`${STRAPI}/api/launch-tasks/${existing.documentId}`, {
            method: "PUT",
            headers: H(),
            body: JSON.stringify({ data }),
          })
        : await strapiFetch(`${STRAPI}/api/launch-tasks`, {
            method: "POST",
            headers: H(),
            // Creates default queued_at (the runners' server-side writes don't carry it, and the
            // shared GET windows on it — a row without it would be invisible to the team until the
            // client's own save backfills it). Updates never touch it.
            body: JSON.stringify({ data: { queued_at: Date.now(), ...data } }),
          });
      if (res.ok) {
        // Unique-constraint TOCTOU: a concurrent create may have committed a twin row — verify.
        if (!existing) await dedupeTaskRows(user, taskId, data);
        return { ok: true };
      }
      // Lost the create race (unique task_id → 400): the row now exists — retry as an update.
      if (!existing && res.status === 400 && attempt === 0) continue;
      const err = await res.text().catch(() => "");
      return { ok: false, reason: "store", detail: `${res.status} ${err.slice(0, 300)}` };
    }
    return { ok: false, reason: "store", detail: "create raced twice" };
  } catch (e) {
    return { ok: false, reason: "store", detail: String(e) };
  }
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
  row: { taskId: string; name: string; geo: string; budget: string; lionTaskId: string; kind: "launch" | "duplicate" },
): Promise<void> {
  if (!storeConfigured()) return;
  const now = Date.now();
  await upsertTaskRow(user, row.taskId, {
    partner: "br",
    name: row.name,
    geo: row.geo,
    budget: row.budget,
    status: row.kind === "launch" ? "done" : "running",
    stage: "queue",
    link: row.lionTaskId,
    gcm: row.kind,
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
