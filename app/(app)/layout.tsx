import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { AifTaskManagerProvider, TaskManagerProvider } from "@/components/task-manager";
import { HsTaskManagerProvider } from "@/components/hs-task-manager";
import { GoogleTaskManagerProvider } from "@/components/google-task-manager";
import { SnapTaskManagerProvider } from "@/components/snap-task-manager";
import { TiktokTaskManagerProvider } from "@/components/tiktok-task-manager";
import { AcctLimitProvider } from "@/components/use-acct-limit";

/**
 * Shared shell for the authenticated app (launcher + clone board). The Task Manager provider is
 * mounted HERE — once, above both boards — so the queue, its single-flight worker and the drawer
 * survive navigating between `/` and `/clone`. (Previously each board mounted its own provider:
 * navigation killed the in-memory queue mid-wave and could run two workers in parallel.)
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");

  return (
    <TaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
      <AifTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
        <HsTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
          <AcctLimitProvider>
            {/* Google rail queue — innermost so it survives navigating between every board. */}
            <GoogleTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
              {/* Snapchat rail queue — innermost, same reason. */}
              <SnapTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
                {/* TikTok rail queue — innermost, same reason. */}
                <TiktokTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>{children}</TiktokTaskManagerProvider>
              </SnapTaskManagerProvider>
            </GoogleTaskManagerProvider>
          </AcctLimitProvider>
        </HsTaskManagerProvider>
      </AifTaskManagerProvider>
    </TaskManagerProvider>
  );
}
