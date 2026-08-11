import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { findTaskRow, pickTaskFields, storeConfigured, upsertTaskRow } from "@/lib/task-store";

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
  try {
    const cutoff = Date.now() - WINDOW_MS;
    const rows: Row[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${STRAPI}/api/launch-tasks?filters[partner][$eq]=${HS_PARTNER}&filters[owner][$notNull]=true` +
          `&filters[queued_at][$gte]=${cutoff}&sort[0]=queued_at:desc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        { headers: H(), cache: "no-store" },
      );
      if (!res.ok) {
        if (rows.length === 0) return NextResponse.json({ ok: false, tasks: [], status: res.status });
        break;
      }
      const body = await res.json().catch(() => ({}));
      const data = (body.data ?? []) as Row[];
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return NextResponse.json({ ok: true, now: Date.now(), tasks: rows.map(toClient) });
  } catch (e) {
    return NextResponse.json({ ok: false, tasks: [], error: String(e) });
  }
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
  for (let i = 0; i < items.length; i += 8) {
    const results = await Promise.all(
      items.slice(i, i + 8).map((item) =>
        // partner:"br" is forced here — the wire never sets it, so an MO row can't masquerade as HS.
        upsertTaskRow(user, String(item.task_id), { ...pickTaskFields(item), partner: HS_PARTNER }),
      ),
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
            await fetch(`${STRAPI}/api/launch-tasks/${found.documentId}`, { method: "DELETE", headers: H() });
          }
        }),
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
