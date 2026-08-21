import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { readAssignments } from "@/lib/acct-assignments";

export const runtime = "nodejs";

// Same tools Strapi the login authenticates against. The token is OPTIONAL: with it the roster
// comes straight from the user directory (username + app_role, non-PII fields only); without it
// the route falls back to usernames observed in team activity, so the feature needs no new
// secret to function.
const TOOLS = (process.env.STRAPI_TOOLS_URL ?? "").replace(/\/+$/, "");
const TOOLS_TOKEN = process.env.STRAPI_TOOLS_TOKEN ?? "";

// The shared vivid-triumph Strapi where launch-task rows live (their `owner` = usernames of
// everyone who ever launched — MO/AIF and the HS rail all write into `launch-tasks`).
const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

export type TeamUser = {
  username: string;
  role: string | null;
  /** Where the name came from: the user directory, observed launch activity, or an existing
   *  assignment (a name assigned once stays offered even after its tasks age out). */
  source: "directory" | "activity" | "assignments";
};

async function directoryUsers(): Promise<TeamUser[] | null> {
  if (!TOOLS || !TOOLS_TOKEN) return null;
  try {
    const res = await fetch(
      `${TOOLS}/api/users?fields[0]=username&fields[1]=app_role&fields[2]=blocked&pagination[pageSize]=100`,
      { headers: { Authorization: `Bearer ${TOOLS_TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as unknown;
    const rows = Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? null);
    if (!Array.isArray(rows)) return null;
    return rows
      .filter((u) => !(u as { blocked?: boolean }).blocked)
      .map((u) => ({
        username: String((u as { username?: unknown }).username ?? "").trim(),
        role: ((u as { app_role?: unknown }).app_role ?? null) as string | null,
        source: "directory" as const,
      }))
      .filter((u) => u.username);
  } catch {
    return null;
  }
}

/** Usernames seen on recent launch-task rows (newest-first, up to 3×100 — Strapi clamps
 *  pageSize to 100). This is the roster's mainstay when the directory token isn't configured,
 *  so it reaches deeper than one page: one busy wave day can fill 100 rows with 2-3 owners. */
async function activityUsers(): Promise<string[]> {
  if (!STRAPI || !TOKEN) return [];
  const out: string[] = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(
        `${STRAPI}/api/launch-tasks?fields[0]=owner&sort[0]=updatedAt:desc&pagination[page]=${page}&pagination[pageSize]=100`,
        { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store", signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) break;
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ owner?: unknown }> };
      const rows = body.data ?? [];
      out.push(...rows.map((r) => String(r.owner ?? "").trim()).filter(Boolean));
      if (rows.length < 100) break;
    }
  } catch {
    /* partial list is fine — merged with directory + registry names */
  }
  return out;
}

/**
 * GET /api/team — owner-only roster for the /accounts assignment page.
 * { ok, users: TeamUser[], directory: boolean } — `directory` tells the UI whether the list is
 * authoritative (tools Strapi) or best-effort (activity + registry), so it can offer manual add.
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
