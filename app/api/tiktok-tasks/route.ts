import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { findTaskRow, readTeamTasks, storeConfigured, strapiFetch } from "@/lib/task-store";
import { tiktokRailEnabled } from "@/lib/tiktok-weapon";

// TikTok (LION tiktok-weapon) rows share the `launch-task` collection (no separate deploy), tagged
// partner="tt" so they live alongside MO/HS/AIF/Google/Snapchat rows without colliding — the MO
// reader excludes "tt", this reader takes only "tt". Same shared-visibility + owner-authority model
// as /api/google-tasks. Rows are written SERVER-side only (the wave route stamps them, the pump and
// /api/tiktok/status advance them), so there is no client upsert here.
export const maxDuration = 60;

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
const TIKTOK_PARTNER = "tt";

const WINDOW_MS = 7 * 24 * 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

type Row = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Strapi row → TikTok client task. TikTok-specific fields ride in reused columns: the durable
 *  tiktok-weapon task id in `link`, the kind (t-launch|t-clone|t-juro) in `gcm`, the target
 *  advertiser id in `adset_id`, the account currency code in `ad_id`. */
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
    advertiser: r.adset_id ?? null,
    currency: r.ad_id ?? null,
    bid: r.bid ?? null,
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

/** GET → the team's TikTok tasks from the last 7 days (shared view). */
export async function GET(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!tiktokRailEnabled()) return NextResponse.json({ ok: false, error: "tiktok_rail_disabled" }, { status: 404 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, tasks: [] });
  // Bounded + short-cached read (task-store) — see /api/launch-tasks; keeps the team's polling
  // from hammering the shared Strapi and serves the last good list through a Strapi blip.
  const cutoff = Date.now() - WINDOW_MS;
  const pageUrl = (page: number) =>
    `${STRAPI}/api/launch-tasks?filters[partner][$eq]=${TIKTOK_PARTNER}&filters[owner][$notNull]=true` +
    `&filters[queued_at][$gte]=${cutoff}&sort[0]=queued_at:desc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`;
  const { ok, tasks, status } = await readTeamTasks("tiktok", pageUrl, toClient, { pageSize: PAGE_SIZE, maxPages: MAX_PAGES });
  if (!ok) return NextResponse.json({ ok: false, tasks: [], ...(status ? { status } : {}) });
  return NextResponse.json({ ok: true, now: Date.now(), tasks });
}

/** DELETE ?taskIds=… → remove the caller's TikTok rows (foreign rows skipped). Kept for the smoke
 *  and admin clean-up; the drawer itself never deletes (errors are a permanent team-visible record). */
export async function DELETE(req: Request) {
  const user = callerOf(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!tiktokRailEnabled()) return NextResponse.json({ ok: false, error: "tiktok_rail_disabled" }, { status: 404 });
  if (!storeConfigured()) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const ids = (new URL(req.url).searchParams.get("taskIds") ?? new URL(req.url).searchParams.get("taskId") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^tt[lcj]-/.test(x));
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
