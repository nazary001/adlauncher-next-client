// What an open tab does when a deploy lands under it. Pure — the client (components/use-acct-limit)
// and the server (app/api/acct-limit) both read this file, so the two sides of one build agree.
//
// Until 10.11.2026 ANY newer build hard-blocked launching in every open tab until it reloaded — and
// a reload costs a designer the board they had filled in. Owner ask 10.11: «чтобы дизайнерам не
// приходилось перезапускать странички … должна быть возможность работать и на старой версии …
// а уже после перезагрузки вступала в силу новая версия». So now:
//   · a deploy that leaves the wire alone (almost every one) is only OFFERED: a small notice, the
//     tab keeps launching against the new server, the new bundle arrives with the next reload;
//   · a deploy that changes what the browser and the server say to each other raises WIRE_LEVEL,
//     and only then do the tabs of a lower level stop launching until they reload.
// What made the block safe to drop: the server is the authority on every launch gate (the
// per-account slot claim, the queue's accept) — a tab's own gates only spare it doomed waves.

/**
 * The level of the browser ↔ server contract this bundle speaks.
 *
 * Raise it by one IN THE SAME COMMIT as a change after which an older tab would launch something
 * the new build must not allow:
 *   · the server would misread what the tab sends — a renamed or re-meant field of a launch / clone /
 *     queue request (units of a budget or a bid), a new field the server relies on the tab to fill;
 *   · a rule that ONLY the tab enforces and that must hold from the moment of the deploy ("this
 *     partner launches only through TOOL": the server still serves the old rail to a tab that never
 *     heard of the rule).
 * Additive changes, new routes, copy, layout and fixes do NOT raise it — the server re-judges every
 * launch with its own current gates, so an old tab's outdated pre-checks cost it error rows at most.
 * Raising it brings the old behaviour back for that one deploy: every open tab must reload before
 * it launches again.
 */
export const WIRE_LEVEL = 1;

/** The level of the bundles from before levels existed (opened before 10.11.2026). They know one
 *  rule only: an answer whose `build` differs from their own stamp locks their launch buttons. */
export const LEGACY_WIRE_LEVEL = 1;

/** A build as its tabs and its server name it: the ISO build time and the wire level it speaks. */
export type Release = { build: string; level: number };

/** current = this tab is the live build · available = another build is live, the tab keeps working ·
 *  required = another build is live and this tab's wire is too old for it — reload before launching. */
export type UpdateState = "current" | "available" | "required";

/** This build's own release. `stamp` is process.env.NEXT_PUBLIC_BUILD_STAMP read LITERALLY by the
 *  caller (next.config `env` values exist only as build-time replacements). */
export function releaseOf(stamp: string | undefined, level: number = WIRE_LEVEL): Release {
  return { build: stamp ?? "", level };
}

/**
 * What goes into the answer's old `build` field — the one the bundles from before levels compare
 * with their own stamp. Blank while the wire is still theirs (they keep working, like every other
 * tab); the real stamp once it moved past them (their own red block is exactly what is needed then).
 */
export function legacyBuildField(live: Release): string {
  return live.level > LEGACY_WIRE_LEVEL ? live.build : "";
}

function asLevel(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : LEGACY_WIRE_LEVEL;
}

function asBuild(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The live release as GET /api/acct-limit names it: `release: { build, level }`; a server from
 * before levels (a rollback) answers with `build` alone. null = the answer names none.
 */
export function liveRelease(answer: unknown): Release | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as { build?: unknown; release?: unknown };
  if (a.release && typeof a.release === "object" && !Array.isArray(a.release)) {
    const r = a.release as { build?: unknown; level?: unknown };
    const build = asBuild(r.build);
    if (build) return { build, level: asLevel(r.level) };
  }
  const legacy = asBuild(a.build);
  return legacy ? { build: legacy, level: LEGACY_WIRE_LEVEL } : null;
}

/** This tab's release against the live one. */
export function updateState(own: Release, live: Release | null): UpdateState {
  if (!own.build || !live || !live.build || live.build === own.build) return "current";
  return live.level > own.level ? "required" : "available";
}

const RANK: Record<UpdateState, number> = { current: 0, available: 1, required: 2 };

/** A tab's state only gets worse until it reloads: one poll that saw less (an instance of the
 *  previous deployment answering during the switch) must not take the notice — or the block — back. */
export function worseUpdate(a: UpdateState, b: UpdateState): UpdateState {
  return RANK[b] > RANK[a] ? b : a;
}
