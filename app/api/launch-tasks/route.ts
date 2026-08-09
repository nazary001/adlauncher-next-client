import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { findTaskRow, pickTaskFields, storeConfigured, upsertTaskRow } from "@/lib/task-store";

// A pagehide-beacon batch (25 rows) or a bulk clear is ~2 Strapi round-trips per row — the
// platform default duration (~15s) could cut the tail off mid-write, leaving half a wave unmarked.
export const maxDuration = 60;

// Server-only: the Strapi token never reaches the browser.
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

// Shared-view window: the drawer shows the team's last 7 days. Strapi clamps pageSize to 100
// (probe-verified), so restore pages through up to 3 pages instead of silently truncating.
const WINDOW_MS = 7 * 24 * 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

type Row = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Strapi row → client-facing task (biginteger timestamps come back as strings → numbers).
 *  `updated_ms` (Strapi updatedAt) is the liveness signal behind the client's stale detection. */
function toClient(r: Row): Row {
  const updated = typeof r.updatedAt === "string" ? Date.parse(r.updatedAt) : NaN;
  return {
    id: r.task_id,
    owner: r.owner ?? null,
    name: r.name ?? "",
    partner: r.partner ?? null,
    gcm: r.gcm ?? "",
    geo: r.geo ?? "",
    budget: r.budget ?? "",
    status: r.status ?? "queued",
    stage: r.stage ?? null,
    campaign_id: r.campaign_id ?? null,
    adset_id: r.adset_id ?? null,
    ad_id: r.ad_id ?? null,
    link: r.link ?? null,
    error: r.error ?? null,
    queued_at: num(r.queued_at) ?? null,
    started_at: num(r.started_at) ?? null,
    finished_at: num(r.finished_at) ?? null,
    updated_ms: Number.isFinite(updated) ? updated : null,
  };
}

/** The caller's identity. Reads are team-wide but still authenticated; writes are owner-scoped. */
function callerOf(req: Request): string | null {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  return session?.username ? String(session.username) : null;
}

/**
 * GET → the whole team's tasks from the last 7 days (newest first) for restore + live refresh.
 * Every logged-in user sees everyone's launches and clones (visibility is shared); mutations
 * (POST/DELETE) stay owner-scoped, so you can still only change your own rows. `now` (server
 * clock) + per-row `updated_ms` let the client judge owner liveness without trusting local clocks.
 */
export async function GET(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, tasks: [] });
  try {
    const cutoff = Date.now() - WINDOW_MS;
    const rows: Row[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `${STRAPI}/api/launch-tasks?filters[owner][$notNull]=true&filters[queued_at][$gte]=${cutoff}` +
          `&sort[0]=queued_at:desc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        { headers: H(), cache: "no-store" },
      );
      if (!res.ok) {
        if (rows.length === 0) return NextResponse.json({ ok: false, tasks: [], status: res.status });
        break; // keep what we have — a partial list beats none for a later page's hiccup
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

/**
 * POST → upsert by task_id (create if new, update if the row already exists).
 * Body: a single task object, or { tasks: [...] } — the batch form serves the pagehide beacon
 * that marks this session's in-flight rows interrupted in one shot.
 * Rows belong to the session user: creates are stamped, foreign updates are refused.
 */
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
  // Distinct task_ids have no ordering dependency between them — write in parallel chunks so a
  // full beacon batch completes well inside the function budget.
  for (let i = 0; i < items.length; i += 8) {
    const results = await Promise.all(
      items.slice(i, i + 8).map((item) => upsertTaskRow(user, String(item.task_id), pickTaskFields(item))),
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

/** DELETE ?taskId=X (or ?taskIds=a,b,c) → remove the caller's row(s); foreign rows are skipped. */
export async function DELETE(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const url = new URL(req.url);
  const ids = (url.searchParams.get("taskIds") ?? url.searchParams.get("taskId") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ ok: false, reason: "no_task_id" }, { status: 400 });

  try {
    // Parallel chunks — a bulk "clear failed" can carry dozens of ids.
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
