import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { readAssignments } from "@/lib/acct-assignments";
import { listDirectoryUsers } from "@/lib/auth-users";
import { coll } from "@/lib/mongo";
import { LAUNCH_TASKS, STORE_TIMEOUT_MS, bounded, storeConfigured } from "@/lib/store";

export const runtime = "nodejs";

// The same user directory the login authenticates against (`up_users`): the roster comes straight
// from it (username + app_role, non-PII fields only); when the store is unreachable the route falls
// back to usernames observed in team activity, so the page still works.

export type TeamUser = {
  username: string;
  role: string | null;
  /** Where the name came from: the user directory, observed launch activity, or an existing
   *  assignment (a name assigned once stays offered even after its tasks age out). */
  source: "directory" | "activity" | "assignments";
};

async function directoryUsers(): Promise<TeamUser[] | null> {
  if (!storeConfigured()) return null;
  try {
    const rows = await listDirectoryUsers(300);
    return rows
      .filter((u) => !u.blocked)
      .map((u) => ({ username: u.username.trim(), role: u.app_role, source: "directory" as const }))
      .filter((u) => u.username);
  } catch {
    return null;
  }
}

/** Usernames seen on recent launch-task rows (newest-first, up to 300 — the old 3 × 100 pages).
 *  This is the roster's mainstay when the directory is unreachable, so it reaches deeper than one
 *  page: one busy wave day can fill 100 rows with 2-3 owners. */
async function activityUsers(): Promise<string[]> {
  if (!storeConfigured()) return [];
  const out: string[] = [];
  try {
    const c = await coll(LAUNCH_TASKS);
    const rows = await bounded(
      c.find({}, { projection: { _id: 0, owner: 1 }, maxTimeMS: STORE_TIMEOUT_MS }).sort({ updatedAt: -1 }).limit(300).toArray(),
      "launch-tasks list",
    );
    out.push(...rows.map((r) => String(r.owner ?? "").trim()).filter(Boolean));
  } catch {
    /* partial list is fine — merged with directory + registry names */
  }
  return out;
}

/**
 * GET /api/team — owner-only roster for the /accounts assignment page.
 * { ok, users: TeamUser[], directory: boolean } — `directory` tells the UI whether the list is
 * authoritative (the user directory) or best-effort (activity + registry), so it can offer manual add.
 */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const [dir, activity, reg] = await Promise.all([directoryUsers(), activityUsers(), readAssignments()]);

  const byKey = new Map<string, TeamUser>();
  const add = (u: TeamUser) => {
    const key = u.username.toLowerCase();
    if (!key) return;
    const existing = byKey.get(key);
    // Directory entries win (they carry the role and canonical casing); otherwise first-seen.
    if (!existing || (u.source === "directory" && existing.source !== "directory")) byKey.set(key, u);
  };

  for (const u of dir ?? []) add(u);
  for (const name of activity) add({ username: name, role: null, source: "activity" });
  for (const users of Object.values(reg?.data.accounts ?? {})) {
    for (const name of users) add({ username: name, role: null, source: "assignments" });
  }
  add({ username: session.username, role: session.role ?? null, source: "activity" });

  const users = [...byKey.values()].sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
  return NextResponse.json({ ok: true, users, directory: dir !== null });
}
