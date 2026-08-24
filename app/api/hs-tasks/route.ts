import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { findTaskRow, pickTaskFields, readTeamTasks, storeConfigured, strapiFetch, upsertTaskRow } from "@/lib/task-store";

// HS tasks share the `launch-task` collection (no separate deploy), tagged partner="br" so they
// live alongside MO rows without colliding — the MO reader excludes "br", this reader takes only
// "br". Same shared-visibility + owner-authority model as /api/launch-tasks.
export const maxDuration = 60;

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
const HS_PARTNER = "br";

const WINDOW_MS = 7 * 24 * 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

type Row = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Strapi row → HS client task. LION-specific fields ride in reused columns: the durable LION
 *  task id in `link`, the kind (launch|duplicate) in `gcm`, the ad count in `ad_id`. */
function toClient(r: Row): Row {
  const updated = typeof r.updatedAt === "string" ? Date.parse(r.updatedAt) : NaN;
  return {
    id: r.task_id,
    owner: r.owner ?? null,
    name: r.name ?? "",
    geo: r.geo ?? "",
    budget: r.budget ?? "",
    status: r.status ?? "queued",
    stage: r.stage ?? null,
    lionTaskId: r.link ?? null,
    kind: r.gcm ?? null,
    campaignId: r.campaign_id ?? null,
    adsetId: r.adset_id ?? null,
    adCount: num(r.ad_id) ?? null,
    error: r.error ?? null,
    queued_at: num(r.queued_at) ?? null,
    started_at: num(r.started_at) ?? null,
    finished_at: num(r.finished_at) ?? null,
    updated_ms: Number.isFinite(updated) ? updated : null,
  };
}

function callerOf(req: Request): string | null {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  return session?.username ? String(session.username) : null;
}

/** GET → the team's HS tasks from the last 7 days (shared view). */
export async function GET(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, tasks: [] });
  // Bounded + short-cached read (task-store) — see /api/launch-tasks; keeps the team's HS polling
  // from hammering the shared Strapi and serves the last good list through a Strapi blip.
  const cutoff = Date.now() - WINDOW_MS;
  const pageUrl = (page: number) =>
    `${STRAPI}/api/launch-tasks?filters[partner][$eq]=${HS_PARTNER}&filters[owner][$notNull]=true` +
    `&filters[queued_at][$gte]=${cutoff}&sort[0]=queued_at:desc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`;
  const { ok, tasks, status } = await readTeamTasks("hs", pageUrl, toClient, {
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  });
  if (!ok) return NextResponse.json({ ok: false, tasks: [], ...(status ? { status } : {}) });
  return NextResponse.json({ ok: true, now: Date.now(), tasks });
}

/** POST → upsert one HS task by task_id (partner forced to "br", owner from the session). */
export async function POST(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const items = (Array.isArray(body.tasks) ? body.tasks : [body]).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object",
  );
  if (items.length === 0 || items.length > 25) {
    return NextResponse.json({ ok: false, reason: "bad_batch" }, { status: 400 });
  }
  if (items.some((item) => !String(item.task_id ?? ""))) {
    return NextResponse.json({ ok: false, reason: "no_task_id" }, { status: 400 });
  }
  let forbidden = false;
  let failed: string | null = null;
  // Failure states never get another write after them, so a failure-write for a row that no
  // longer exists can only be a stale client resurrecting an admin-deleted zombie (live 08-12:
  // a sleeping tab's 60-min cap re-created rows deleted minutes earlier). Skip the create; a
  // legit first-write is always queued/running/submitted (client) or the server-side stamp.
  // "done" stays writable as a first write — losing a real completion would be worse.
  const failureStates = new Set(["error", "interrupted"]);
  for (let i = 0; i < items.length; i += 8) {
    const results = await Promise.all(
      items.slice(i, i + 8).map(async (item) => {
        const fields = pickTaskFields(item);
        const incoming = String(fields.status ?? "");
        if (incoming !== "done") {
          const existing = await findTaskRow(String(item.task_id));
          if (!existing && failureStates.has(incoming)) return { ok: true as const };
          // done is TERMINAL: a stale tab's heartbeat, 60-min cap or late error must never
          // demote a row that already recorded the real completion (live 08-13: tasks the
          // buyer saw finish were re-written to "Still not finished after 60 min").
          if (existing?.status === "done") return { ok: true as const };
        }
        // partner:"br" is forced here — the wire never sets it, so an MO row can't masquerade as HS.
        return upsertTaskRow(user, String(item.task_id), { ...fields, partner: HS_PARTNER });
      }),
    );
    for (const r of results) {
      if (!r.ok) {
        if (r.reason === "forbidden") forbidden = true;
        else failed = r.detail ?? r.reason;
      }
    }
  }
  if (forbidden && items.length === 1) return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  if (failed) return NextResponse.json({ ok: false, error: failed }, { status: 502 });
  return NextResponse.json({ ok: true });
}

/** DELETE ?taskIds=… → remove the caller's HS rows (foreign rows skipped). Kept for parity/admin;
 *  the drawer itself never deletes (errors are a permanent team-visible record). */
export async function DELETE(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const ids = (new URL(req.url).searchParams.get("taskIds") ?? new URL(req.url).searchParams.get("taskId") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ ok: false, reason: "no_task_id" }, { status: 400 });
  try {
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(
        ids.slice(i, i + 8).map(async (id) => {
          const found = await findTaskRow(id);
          if (found && found.owner === user) {
            await strapiFetch(`${STRAPI}/api/launch-tasks/${found.documentId}`, { method: "DELETE", headers: H() });
          }
        }),
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
