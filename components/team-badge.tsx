import { TEAM, type TeamId } from "@/lib/team";

// The mark of the team this launcher belongs to (owner ask 08.10: the first launcher says GLO-01,
// the second GLO-02). One colour per team, deliberately OFF the blue→violet brand gradient, so the
// two launchers cannot be mistaken for each other at a glance: cyan for the first, amber for the second.
const TONE: Record<TeamId, { line: string; ink: string; wash: string }> = {
  "glo-01": { line: "border-[#22d3ee]/50", ink: "text-[#7fe7f0]", wash: "bg-[#22d3ee]/10" },
  "glo-02": { line: "border-[#fbbf24]/55", ink: "text-[#f6cf6b]", wash: "bg-[#fbbf24]/10" },
};

/**
 * `corner` = the tiny chip pinned to the bottom edge of the logo mark (its parent must be
 * `relative`): it costs the header no width, so it is what shows wherever the wordmark is hidden.
 * Default = the inline pill next to a title.
 */
export function TeamBadge({ corner = false, className = "" }: { corner?: boolean; className?: string }) {
  const t = TONE[TEAM.id];
  if (corner) {
    return (
      <span
        title={`Team ${TEAM.label}`}
        className={
          "pointer-events-none absolute -bottom-1.5 left-1/2 -translate-x-1/2 select-none whitespace-nowrap " +
          `rounded-[5px] border bg-bg px-1 py-[2px] font-mono text-[8px] font-bold leading-none tracking-[0.04em] ${t.line} ${t.ink} ${className}`
        }
      >
        {TEAM.label}
      </span>
    );
  }
  return (
    <span
      title={`Team ${TEAM.label}`}
      className={
        "shrink-0 select-none whitespace-nowrap rounded-md border px-1.5 py-[3px] font-mono text-[10px] font-bold " +
        `leading-none tracking-[0.06em] ${t.line} ${t.ink} ${t.wash} ${className}`
      }
    >
      {TEAM.label}
    </span>
  );
}
