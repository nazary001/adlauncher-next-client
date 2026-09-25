import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { parseToolId } from "@/lib/tool-sessions-model";
import { type BoardTab, ToolSessionsBoard } from "@/components/tool-sessions-board";

export const metadata: Metadata = {
  title: "Ads Manager sessions — Ad Launcher",
};

/** Owner-only: the HS team's Ads Manager sessions on TOOL (tool.gctracking.xyz) — list, add,
 *  check, refresh credentials, disable / enable, delete; per session its accounts, jobs, history.
 *  `?tab=jobs|accounts` and `?id=<session>` deep-link into the board. */
export default async function SessionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // Non-owners have no business here — and the APIs behind the page 403 them anyway.
  if (!isOwnerSession(session)) redirect("/");

  const q = await searchParams;
  const tabRaw = Array.isArray(q.tab) ? q.tab[0] : q.tab;
  const tab: BoardTab = tabRaw === "jobs" || tabRaw === "accounts" ? tabRaw : "sessions";
  const id = parseToolId(Array.isArray(q.id) ? q.id[0] : q.id);

  return (
    <>
      {/* ambient backdrop: aurora glows + fading grid horizon (same as the launcher) */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-44 left-1/2 h-[480px] w-[920px] -translate-x-1/2 rounded-full bg-accent/[0.07] blur-[120px]" />
        <div className="absolute -top-24 right-[8%] h-[320px] w-[440px] rounded-full bg-accent2/[0.06] blur-[110px]" />
        <div
          className={
            "absolute inset-x-0 top-0 h-[540px] " +
            "bg-[linear-gradient(rgba(255,255,255,0.028)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.028)_1px,transparent_1px)] " +
            "bg-[size:44px_44px] " +
            "[mask-image:radial-gradient(ellipse_60%_60%_at_50%_0%,black,transparent)]"
          }
        />
      </div>

      <ToolSessionsBoard user={{ username: session.username, role: session.role ?? null, owner: true }} initialTab={tab} initialId={id} />
    </>
  );
}
