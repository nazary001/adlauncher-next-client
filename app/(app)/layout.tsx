import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { AifTaskManagerProvider, TaskManagerProvider } from "@/components/task-manager";
import { HsTaskManagerProvider } from "@/components/hs-task-manager";
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
          <AcctLimitProvider>{children}</AcctLimitProvider>
        </HsTaskManagerProvider>
      </AifTaskManagerProvider>
    </TaskManagerProvider>
  );
}
