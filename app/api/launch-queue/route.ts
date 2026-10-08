import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { QUEUE_SCOPES, type QueueActionResponse, type QueueEnqueueResponse, type QueueScope, parseEnqueue } from "@/lib/launch-queue-types";
import { acceptEnqueue, cancelJobs, pumpLane, retryJobs, selfOrigin } from "@/lib/launch-queue-run";
import { teamAllowsJob } from "@/lib/team";

export const runtime = "nodejs";
// The hand-off answers at once (after(pumpLane) runs the wave in the background), but the SAME
// invocation hosts that pump's first budget window — maxDuration is the pump's, not the hand-off's.
export const maxDuration = 800;

const TASK_ID_RE = /^[\w-]{6,64}$/;
const noStore = { "Cache-Control": "no-store" };

/** Validate a retry/cancel id list: each a well-formed task id, at most 100. `undefined` → empty
 *  (cancel-by-scope); a non-array or a bad id → null (the route answers 400). */
function validateIds(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const ids: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !TASK_ID_RE.test(x)) return null;
    ids.push(x);
  }
  return ids;
}

/**
 * POST /api/launch-queue — the browser hands a wave over here (components/launch-queue-client.ts):
 *   • "enqueue" (default): parse → accept (rows stamped, jobs inserted) → after(pumpLane) → answer.
 *   • "retry": re-queue the caller's retryable jobs → after(pumpLane) per touched lane → answer.
 *   • "cancel": cancel the caller's queued jobs (listed, or a whole scope) → answer (no pump).
 * Session-gated inline (defense in depth, like the other data routes). JSON only, never cached.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // FIRST, before any await: the pump's budget is anchored at the invocation start, not at the
  // moment the after() callback happens to run — runLane's "does the next job still fit?" check needs
  // the real deadline (lib/launch-queue runLane).
  const startedAt = Date.now();
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400, headers: noStore });
  }

  const action = typeof body.action === "string" ? body.action : "enqueue";
  const origin = selfOrigin(req);

  if (action === "retry" || action === "cancel") {
    const ids = validateIds(body.taskIds);
    if (ids === null) return NextResponse.json({ ok: false, error: "bad_task_ids" } as QueueActionResponse, { status: 400, headers: noStore });
    const scope = QUEUE_SCOPES.includes(body.scope as QueueScope) ? (body.scope as QueueScope) : undefined;
    try {
      if (action === "retry") {
        if (ids.length === 0) return NextResponse.json({ ok: false, error: "no_task_ids" } as QueueActionResponse, { status: 400, headers: noStore });
        const { taskIds, lanes } = await retryJobs(session, ids);
        for (const lane of lanes) after(() => pumpLane(lane, { origin, startedAt }));
        return NextResponse.json({ ok: true, taskIds } as QueueActionResponse, { headers: noStore });
      }
      // cancel — either the listed ids or every queued job of a scope; a cancel starts no work.
      if (ids.length === 0 && !scope) return NextResponse.json({ ok: false, error: "no_selection" } as QueueActionResponse, { status: 400, headers: noStore });
      const { taskIds } = await cancelJobs(session, { jobIds: ids.length ? ids : undefined, scope });
      return NextResponse.json({ ok: true, taskIds } as QueueActionResponse, { headers: noStore });
    } catch (e) {
      return NextResponse.json({ ok: false, error: `queue_store_error: ${(e as Error).message ?? String(e)}` } as QueueActionResponse, { status: 502, headers: noStore });
    }
  }

  // enqueue (default)
  const parsed = parseEnqueue(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error } as QueueEnqueueResponse, { status: 400, headers: noStore });
  // The team gate of the queue (lib/team): a queued launch never passes proxy.ts — the pump calls its
  // handler in-process — so a rail or channel this team's launcher does not have is refused HERE,
  // before anything is stored. The client sends the kind; this is where it is judged.
  const foreign = parsed.value.jobs.find((j) => !teamAllowsJob(parsed.value.scope, j.kind));
  if (foreign) {
    return NextResponse.json({ ok: false, error: `not_available: ${foreign.kind}` } as QueueEnqueueResponse, { status: 403, headers: noStore });
  }
  const res = await acceptEnqueue(session, parsed.value, origin);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error } as QueueEnqueueResponse, { status: res.status, headers: noStore });
  for (const lane of res.lanes) after(() => pumpLane(lane, { origin, startedAt }));
  return NextResponse.json({ ok: true, accepted: res.accepted, failed: res.failed } as QueueEnqueueResponse, { headers: noStore });
}
