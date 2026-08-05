// Client-side ad-copy variator. When a campaign is duplicated, each clone's primary text is nudged
// so Meta never sees two identical ads (which hurts delivery / trips duplicate detection). It is NOT
// a translator: it swaps interchangeable words (EN/ES/PT), lightly reorders, and varies emoji /
// punctuation — clones still read naturally but differ. Runs in the browser, so Math.random is fine.

/** Interchangeable word groups — any member may swap for another (case of the first letter kept). */
const SYNONYMS: string[][] = [
  // ---- EN ----
  ["get", "grab", "unlock"],
  ["now", "today", "right away"],
  ["best", "top", "smartest"],
  ["easy", "simple", "effortless"],
  ["fast", "quick", "instant"],
  ["free", "no-cost"],
  ["learn", "discover", "find out"],
  ["great", "amazing", "excellent"],
  ["deal", "offer", "chance"],
  ["new", "fresh", "latest"],
  ["help", "guide", "support"],
  ["money", "cash", "funds"],
  ["loan", "credit"],
  ["financing", "funding"],
  ["save", "keep more"],
  ["start", "begin"],
  ["check", "see", "explore"],
  ["your", "your own"],
  ["boost", "grow", "improve"],
  ["today", "right now", "this week"],
  ["approved", "accepted", "eligible"],
  // ---- ES ----
  ["descubre", "conoce", "explora"],
  ["ahora", "hoy", "ya"],
  ["gratis", "sin costo"],
  ["dinero", "efectivo"],
  ["préstamo", "financiamiento", "crédito"],
  ["fácil", "sencillo", "simple"],
  ["rápido", "al instante"],
  ["mejor", "ideal"],
  ["obtén", "consigue", "logra"],
  ["ahorra", "guarda"],
  // ---- PT ----
  ["descubra", "conheça", "veja"],
  ["agora", "hoje", "já"],
  ["grátis", "sem custo"],
  ["dinheiro", "grana"],
  ["empréstimo", "financiamento", "crédito"],
  ["simples", "descomplicado"],
  ["melhor", "ideal"],
  ["rápido", "na hora"],
  ["economize", "guarde"],
];

const SYN_MAP = new Map<string, string[]>();
for (const group of SYNONYMS) for (const w of group) SYN_MAP.set(w.toLowerCase(), group);

const EMOJI_POOL = ["✨", "🔥", "🚀", "💡", "✅", "💸", "📈", "⭐", "💰", "👉"];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const isUpper = (ch: string) => ch === ch.toUpperCase() && ch !== ch.toLowerCase();
const matchCase = (sample: string, word: string) =>
  isUpper(sample[0] ?? "") ? word.charAt(0).toUpperCase() + word.slice(1) : word;

function swapSynonyms(text: string): { out: string; changed: boolean } {
  let changed = false;
  const out = text.replace(/[\p{L}\p{M}'’-]+/gu, (word) => {
    const group = SYN_MAP.get(word.toLowerCase());
    if (!group || Math.random() < 0.45) return word; // swap ~55% of matches
    let alt = pick(group);
    for (let i = 0; i < 4 && alt.toLowerCase() === word.toLowerCase(); i++) alt = pick(group);
    if (alt.toLowerCase() === word.toLowerCase()) return word;
    changed = true;
    return matchCase(word, alt);
  });
  return { out, changed };
}

/** Mildly reorder: swap the last two sentences occasionally (keeps grammar intact). */
function reorderSentences(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length < 2 || Math.random() < 0.55) return text;
  const i = parts.length - 1;
  [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]];
  return parts.join(" ");
}

/** Swap existing emojis for pool ones; if the copy has none, sometimes add a single trailing one. */
function varyEmoji(text: string): { out: string; changed: boolean } {
  if (/\p{Extended_Pictographic}/u.test(text)) {
    let changed = false;
    const out = text.replace(/\p{Extended_Pictographic}/gu, (e) => {
      if (Math.random() < 0.5) return e;
      changed = true;
      return pick(EMOJI_POOL);
    });
    return { out, changed };
  }
  if (Math.random() < 0.3) return { out: `${text.replace(/\s+$/, "")} ${pick(EMOJI_POOL)}`, changed: true };
  return { out: text, changed: false };
}

/** Collapse an accidental adjacent repeat (e.g. two words from one synonym group both swapping to
 *  the same alternative → "credit credit" → "credit"). */
function dedupeAdjacent(text: string): string {
  return text.replace(/([\p{L}\p{M}'’-]+)(\s+)\1\b/giu, "$1");
}

/** Vary trailing punctuation occasionally. */
function varyPunctuation(text: string): { out: string; changed: boolean } {
  if (/[.!…]\s*$/u.test(text) && Math.random() < 0.4) {
    return { out: text.replace(/[.!…]\s*$/u, pick(["!", ".", " …"])), changed: true };
  }
  return { out: text, changed: false };
}

/** Produce a near-variant of ad copy so duplicated campaigns aren't identical. Falls back to a
 *  trailing emoji if nothing else changed, so the result is always distinct from the input. */
export function spinCopy(text: string): string {
  const original = (text ?? "").trim();
  if (!original) return text;

  const s = swapSynonyms(original);
  let out = dedupeAdjacent(reorderSentences(s.out));
  const e = varyEmoji(out);
  out = e.out;
  const p = varyPunctuation(out);
  out = p.out;

  const changed = s.changed || e.changed || p.changed || out !== original;
  if (!changed) out = `${original.replace(/\s+$/, "")} ${pick(EMOJI_POOL)}`;
  return out;
}
