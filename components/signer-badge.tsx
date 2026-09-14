"use client";

import Link from "next/link";
import type { SlotSigner } from "./use-signers";

/**
 * Read-only "Signs as …" badge for the MO / AIF boards (the per-buyer signer switch is gone —
 * owner ask 2026-09-14: the token that signs is picked centrally on /tokens). Shows the label,
 * the identity behind it, whether it is the owner's assignment or the env default, and the
 * live health verdict; with no token at all the board's launch gate closes and this says why.
 */
export function SignerBadge({
  signer,
  loaded,
  rail,
  owner = false,
  compact = false,
}: {
  signer: SlotSigner | null | undefined;
  /** false while the first /signers answer is pending. */
  loaded: boolean;
  rail: "launch" | "clone";
  /** Owners get a link to /tokens in the empty/dead states. */
  owner?: boolean;
  compact?: boolean;
}) {
  const primary = signer?.primary ?? null;
  const fix = owner ? (
    <Link href="/tokens" className="font-semibold text-[#9db8ff] underline-offset-2 hover:underline">
      FB tokens
    </Link>
  ) : (
    <span className="font-semibold">FB tokens</span>
  );

  if (!loaded && !signer) {
    return (
      <div className="rounded-xl border border-line bg-surface2 px-3 py-2 text-[11px] text-faint">Resolving the signer…</div>
    );
  }
  if (!primary) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-red-300">
        No {rail === "launch" ? "launch" : "clone"} token is assigned for this partner — {rail === "launch" ? "launches" : "clones"} are
        blocked until an owner assigns one under {fix} (menu).
      </div>
    );
  }
  const who = [primary.user, primary.app ? `(${primary.app})` : ""].filter(Boolean).join(" ");
  const kind = primary.personal ? "personal soc · names carry SOC" : "system user";
  const source = signer?.source === "assigned" ? "assigned on /tokens" : "env default";
  const pool = signer?.pool && signer.extra > 0 ? ` · +${signer.extra} failover` : "";
  return (
    <div
      className={
        "flex flex-col gap-0.5 rounded-xl border px-3 py-2 " +
        (primary.ok ? "border-line bg-surface2" : "border-danger/40 bg-danger/10")
      }
      title={primary.error || who || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${primary.ok ? "bg-launch2" : "bg-danger"}`} />
        <span className="truncate text-[12px] text-dim">
          Signs as <span className="font-semibold text-ink">{primary.label}</span>
          {who ? <span className="text-faint"> · {who}</span> : null}
        </span>
      </div>
      {!compact ? (
        <p className="truncate pl-4 text-[10px] text-faint">
          {kind} · {source}
          {pool}
        </p>
      ) : null}
      {!primary.ok ? (
        <p className="pl-4 text-[10px] leading-relaxed text-red-300">
          Token dead — pickers stay empty and {rail === "launch" ? "launches" : "clones"} will fail: {primary.error || "re-issue it"}.
          {owner ? <> Fix it under {fix}.</> : null}
        </p>
      ) : null}
    </div>
  );
}
