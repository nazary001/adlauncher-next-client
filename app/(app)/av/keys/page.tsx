import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { partnerConfig } from "@/lib/partners";
import { AvKeysBoard } from "@/components/av-keys-board";

export const metadata: Metadata = {
  title: "AV keys — Ad Launcher",
};

/** Owner-only: the AV (ActiveView) key registry (av001…, one key per campaign — the AIF-brand twin)
 *  and the "UTM Campaign Values" upload files. Dormant on prod (NEXT_PUBLIC_AV_ENABLED unset there):
 *  a stale link must not open a half-wired board, so it bounces to the launcher home. Non-owners
 *  have no business here and the /api/av/keys mutations 403 them anyway. */
export default async function AvKeysPage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // The build flag gates the whole AV rail (partnerConfig("av").inDevelopment === AV flag off).
  if (partnerConfig("av").inDevelopment) redirect("/");
  if (!isOwnerSession(session)) redirect("/");

  return (
    <>
      {/* ambient backdrop: aurora glows + fading grid horizon (same as /tokens and /sessions) */}
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

      <AvKeysBoard user={{ username: session.username, role: session.role ?? null, owner: true }} />
    </>
  );
}
