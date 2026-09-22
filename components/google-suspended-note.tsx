"use client";

// The Google boards list only launch accounts Google has NOT suspended (owner ask 21.09). This
// line says what the picker left out, so a missing account reads as "suspended", not as a bug.

import type { GwSuspendedCustomer } from "./use-google";

/** "GLO-HS-012, 013, 014" — the shared "GLO-HS-" head printed once. */
function shortNames(names: string[]): string {
  const head = "GLO-HS-";
  if (names.length < 2 || !names.every((n) => n.startsWith(head))) return names.join(", ");
  return head + names.map((n) => n.slice(head.length)).join(", ");
}

export function GoogleSuspendedNote({ suspended }: { suspended: GwSuspendedCustomer[] }) {
  if (suspended.length === 0) return null;
  const names = suspended.map((c) => c.name);
  return (
    <p className="text-center text-[10.5px] leading-relaxed text-faint" title={suspended.map((c) => `${c.name} — ${c.reason}`).join("\n")}>
      {suspended.length} suspended account{suspended.length === 1 ? "" : "s"} hidden from the pickers — {shortNames(names)}.
    </p>
  );
}
