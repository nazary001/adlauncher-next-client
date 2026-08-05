import { NextResponse } from "next/server";

// Server-only: the Strapi token never reaches the browser.
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

// Fields persisted per task (Strapi attribute names). Wire format matches this 1:1.
const FIELDS = [
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

type Row = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Strapi row → client-facing task (biginteger timestamps come back as strings → numbers). */
function toClient(r: Row): Row {
  return {
    id: r.task_id,
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
  };
}

function pickFields(body: Record<string, unknown>): Row {
  const out: Row = {};
  for (const k of FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

async function findByTaskId(taskId: string): Promise<{ documentId: string } | null> {
  const res = await fetch(
    `${STRAPI}/api/launch-tasks?filters[task_id][$eq]=${encodeURIComponent(taskId)}&fields[0]=task_id&pagination[pageSize]=1`,
    { headers: H(), cache: "no-store" },
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  const row = body?.data?.[0];
  return row?.documentId ? { documentId: row.documentId } : null;
}

/** GET → recent tasks (newest first) for restore on page load. */
export async function GET() {
  if (!STRAPI || !TOKEN) return NextResponse.json({ ok: false, tasks: [] });
  try {
    const res = await fetch(
      `${STRAPI}/api/launch-tasks?sort[0]=queued_at:desc&pagination[pageSize]=100`,
      { headers: H(), cache: "no-store" },
    );
    if (!res.ok) return NextResponse.json({ ok: false, tasks: [], status: res.status });
    const body = await res.json();
    const tasks = ((body.data ?? []) as Row[]).map(toClient);
    return NextResponse.json({ ok: true, tasks });
  } catch (e) {
    return NextResponse.json({ ok: false, tasks: [], error: String(e) });
  }
}

/** POST → upsert by task_id (create if new, update if the row already exists). */
export async function POST(req: Request) {
  if (!STRAPI || !TOKEN) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskId = String(body.task_id ?? "");
  if (!taskId) return NextResponse.json({ ok: false, reason: "no_task_id" }, { status: 400 });

  const data = pickFields(body);
  try {
    const existing = await findByTaskId(taskId);
    const res = existing
      ? await fetch(`${STRAPI}/api/launch-tasks/${existing.documentId}`, {
          method: "PUT",
          headers: H(),
          body: JSON.stringify({ data }),
        })
      : await fetch(`${STRAPI}/api/launch-tasks`, {
          method: "POST",
          headers: H(),
          body: JSON.stringify({ data }),
        });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, status: res.status, error: err.slice(0, 300) }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}

/** DELETE ?taskId=X (or ?taskIds=a,b,c) → remove the row(s). */
export async function DELETE(req: Request) {
  if (!STRAPI || !TOKEN) return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 500 });
  const url = new URL(req.url);
  const ids = (url.searchParams.get("taskIds") ?? url.searchParams.get("taskId") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ ok: false, reason: "no_task_id" }, { status: 400 });

  try {
    for (const id of ids) {
      const found = await findByTaskId(id);
      if (found) {
        await fetch(`${STRAPI}/api/launch-tasks/${found.documentId}`, { method: "DELETE", headers: H() });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
