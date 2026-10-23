"use client";

import Link from "next/link";
import type { PartnerId } from "@/lib/partners";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";

/** /clone on the VC partner: VC has no clone rail yet (owner ask 23.10 was launches) — say so, keep
 *  the header so the buyer can switch partners, and point at the launcher. The server refuses VC clones too. */
export function VcCloneNotice({ user }: { user: SessionUser }) {
  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.location.assign(url.toString());
  };
  return (
    <>
      <Header partner="vc" onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[720px] px-4 pb-24 pt-16">
          <div className="rounded-2xl border border-line bg-surface/60 p-6 text-center">
            <p className="text-[15px] font-semibold text-ink">VC clones are not available yet</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-dim">
              ValueClick campaigns launch from the launcher board — paste the VC landingpage link on a card.
            </p>
            <Link
              href="/?partner=vc"
              className="mt-4 inline-flex h-9 items-center rounded-lg border border-line2 bg-raise px-4 text-[12.5px] font-semibold text-ink hover:border-accent/50"
            >
              Open the VC launcher
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
