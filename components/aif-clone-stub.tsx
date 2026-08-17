"use client";

import Link from "next/link";
import type { PartnerId } from "@/lib/partners";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { RocketIcon } from "./icons";

/**
 * The AIF partner has no duplicator yet — v1 ships the launcher only. This stub keeps /clone
 * navigable on partner=us (header + switcher work; switching partners is a full navigation,
 * same as the other clone boards) instead of silently opening the MO clone board on the wrong
 * token/registry.
 */
export function AifCloneStub({ user }: { user?: SessionUser }) {
  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.location.assign(url.toString());
  };

  return (
    <>
      <Header partner={"us" as PartnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[640px] px-6 pt-28 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface">
            <RocketIcon className="h-5 w-5 text-dim" />
          </div>
          <h1 className="mt-4 text-[15px] font-semibold text-ink">AIF duplicator isn&apos;t built yet</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-dim">
            Launch AIF campaigns from the launcher board — cloning for this partner comes later.
          </p>
          <Link
            href="/?partner=us"
            className={
              "mt-6 inline-flex h-10 items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-4 " +
              "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
              "hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            }
          >
            <RocketIcon className="h-4 w-4" />
            Open the AIF launcher
          </Link>
        </div>
      </main>
    </>
  );
}
