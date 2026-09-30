// Which Meta platforms a launch runs on — the AV launch card's Platforms pick (owner ask 30.09:
// "при заливе на AV выбирать соц, на который будет залив"). Pure and dependency-free (node --test).
//
// On TOOL it is targeting.publisher_platforms (+ positions) — CONFIRMED on its /capabilities (live
// read 30.09: "adset.targeting.publisher_platforms/positions" status CONFIRMED), so it never needs
// allow_inferred; the direct-Graph path puts the same words on the Marketing API targeting.
// "auto" = no platforms at all = Advantage+ placements (every platform Meta picks), exactly what a
// card sent before the pick existed. TOOL's schema also knows threads / messenger /
// audience_network, but Meta runs those only alongside Instagram (Threads) or Facebook (Messenger,
// Audience Network), so the card offers just the choices that run on their own.

/** The card's choices (value = the word stored on Campaign.platforms). */
export const PLATFORM_CHOICES: { value: string; label: string }[] = [
  { value: "auto", label: "All (auto)" },
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook+instagram", label: "Facebook + Instagram" },
];

const PLATFORMS_OF: Readonly<Record<string, readonly string[]>> = {
  auto: [],
  facebook: ["facebook"],
  instagram: ["instagram"],
  "facebook+instagram": ["facebook", "instagram"],
};

/**
 * The Meta publisher_platforms a card's pick stands for: [] = automatic (auto, blank, or a draft
 * saved before the pick existed); null = a word we do not know — the launch route refuses it rather
 * than widen or narrow a launch on a guess.
 */
export function publisherPlatformsOf(choice: unknown): string[] | null {
  if (choice == null) return [];
  if (typeof choice !== "string") return null;
  const word = choice.trim().toLowerCase();
  if (word === "") return [];
  return Object.hasOwn(PLATFORMS_OF, word) ? [...PLATFORMS_OF[word]] : null;
}

/**
 * publisher_platforms + positions for a placement set and a platforms pick — the one rule both AV
 * channels follow (lib/tool-launch keeps a literal twin for its purity; tests/av-platforms pins the
 * two together). No pick: FULL sets nothing (Advantage+), COMPLIANCE keeps its FB + IG feeds. A pick:
 * FULL runs every position of the picked platforms, COMPLIANCE only their feeds.
 */
export function placementPlatformFields(
  compliance: boolean,
  platforms: readonly string[],
): { publisher_platforms?: string[]; facebook_positions?: string[]; instagram_positions?: string[] } {
  if (!compliance) return platforms.length ? { publisher_platforms: [...platforms] } : {};
  const set = platforms.length ? [...platforms] : ["facebook", "instagram"];
  return {
    publisher_platforms: set,
    ...(set.includes("facebook") ? { facebook_positions: ["feed"] } : {}),
    ...(set.includes("instagram") ? { instagram_positions: ["stream"] } : {}),
  };
}
