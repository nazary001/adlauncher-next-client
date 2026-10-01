import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { SNAP_ENABLED } from "@/lib/partners";
import { snapCloneRefs } from "@/lib/snap-launch";
import { SnapCloneBoard } from "@/components/snap-clone-board";

export const metadata: Metadata = {
  title: "Snapchat — clone — Ad Launcher",
};

/**
 * The Snapchat cloner. Deep link (docs/snap-clone-link-contract.md):
 *   /snap/clone?ids=<campaign id>,<campaign id>&keys=glo-snp_012,glo-snp_045
 * `ids` = Snapchat campaign ids (UUIDs), `keys` = the partner keys of OUR campaigns (resolved through
 * the key registry to the campaign that holds them now); either param takes either kind, may repeat,
 * any separator; garbage and duplicates are dropped; at most 30 sources. `mode` is accepted and
 * ignored (Snapchat has one mode — the other cloners' JURO is a per-row destination / geo here).
 */
export default async function SnapClonePage({ searchParams }: { searchParams: Promise<{ ids?: string | string[]; keys?: string | string[] }> }) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // Dormant on a build without the flag: a stale link must not open a half-wired board.
  if (!SNAP_ENABLED) redirect("/");

  const sp = await searchParams;
  const refs = snapCloneRefs(sp.ids, sp.keys);

  return (
    <>
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-44 left-1/2 h-[480px] w-[920px] -translate-x-1/2 rounded-full bg-[#FFFC00]/[0.05] blur-[120px]" />
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
      <SnapCloneBoard user={{ username: session.username, role: session.role ?? null, owner: isOwnerSession(session) }} initialRefs={refs} />
    </>
  );
}
