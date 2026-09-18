import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { TIKTOK_ENABLED } from "@/lib/partners";
import { TiktokLaunchBoard } from "@/components/tiktok-launch-board";

export const metadata: Metadata = {
  title: "TikTok — launch — Ad Launcher",
};

export default async function TiktokLaunchPage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // The TikTok rail ships dormant on prod (NEXT_PUBLIC_TIKTOK_ENABLED unset there): a stale link
  // to /tiktok must not open a half-wired board — bounce to the launcher home.
  if (!TIKTOK_ENABLED) redirect("/");

  return (
    <>
      {/* ambient backdrop: aurora glows + fading grid horizon (same as the launcher / clone board) */}
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

      <TiktokLaunchBoard user={{ username: session.username, role: session.role ?? null, owner: isOwnerSession(session) }} />
    </>
  );
}
