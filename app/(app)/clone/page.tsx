import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { AifCloneStub } from "@/components/aif-clone-stub";
import { CloneBoard } from "@/components/clone-board";
import { HsCloneBoard } from "@/components/hs-clone-board";
import { type PartnerId, partnerConfig, sanitizePartnerId } from "@/lib/partners";

export const metadata: Metadata = {
  title: "Clone campaigns — Ad Launcher",
};

/** Dedupe + trim the comma-separated campaign ids handed over in the link. */
function parseIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  return [...new Set(joined.split(",").map((x) => x.trim()).filter(Boolean))];
}

export default async function ClonePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string | string[]; partner?: string | string[] }>;
}) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");

  const sp = await searchParams;
  const ids = parseIds(sp.ids);
  // Shared sanitizer: unknown AND in-development partners fall back to MO (a stale prod URL
  // must not open the board on a partner the switcher itself refuses).
  const partner: PartnerId = sanitizePartnerId(sp.partner);

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

      {partnerConfig(partner).lionLaunch ? (
        // HS clones go through LION's duplicate weapon — a different rail entirely (no Graph
        // token, no gcm), so it gets its own board.
        <HsCloneBoard
          user={{ username: session.username, role: session.role ?? null }}
          partner={partner}
          initialIds={ids}
        />
      ) : partnerConfig(partner).aifLaunch ? (
        // AIF has no duplicator yet — never open the MO clone board on this partner (wrong
        // token, wrong registry).
        <AifCloneStub user={{ username: session.username, role: session.role ?? null }} />
      ) : (
        <CloneBoard
          user={{ username: session.username, role: session.role ?? null }}
          initialIds={ids}
          partner={partner}
        />
      )}
    </>
  );
}
