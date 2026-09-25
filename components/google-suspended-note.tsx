"use client";

// The Google boards list only launch accounts that are ACTIVE on Google (owner ask 21.09; since
// 25.09 the status rides on the partner's customers list, read live). This line says what the
// picker left out, so a missing account reads as "suspended", not as a bug.

import type { GwSuspendedCustomer } from "./use-google";

/** Names printed in the line; the rest is "+N more" (the tooltip carries every name with its reason). */
const NAMES_SHOWN = 10;

/** "GLO-HS-012, 013, 014 +20 more" — the shared "GLO-HS-" head printed once, the tail capped. */
function shortNames(names: string[]): string {
  const head = "GLO-HS-";
  const shared = names.length >= 2 && names.every((n) => n.startsWith(head));
  const shown = names.slice(0, NAMES_SHOWN).map((n) => (shared ? n.slice(head.length) : n));
  const more = names.length - shown.length;
  return (shared ? head : "") + shown.join(", ") + (more > 0 ? ` +${more} more` : "");
}

export function GoogleSuspendedNote({ suspended }: { suspended: GwSuspendedCustomer[] }) {
  if (suspended.length === 0) return null;
  const n = suspended.length;
  // "suspended" while that is the only word Google used; "inactive" once a CANCELED / CLOSED joins.
  const word = suspended.every((c) => c.status === "SUSPENDED") ? "suspended" : "inactive";
  return (
    <p className="text-center text-[10.5px] leading-relaxed text-faint" title={suspended.map((c) => `${c.name} — ${c.reason}`).join("\n")}>
      {n} {word} account{n === 1 ? "" : "s"} hidden from the pickers — {shortNames(suspended.map((c) => c.name))}.
    </p>
  );
}
