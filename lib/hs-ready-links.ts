// The partner's READY landings for an HS launch — what LION's Campaign URL Builder
// (lion.highstakes.tech/campaign-url-builder) hands a buyer who clicks niche → market → type — kept
// here so a card can PICK one instead of building it there and pasting it (owner ask 13.10: "чтобы
// можно было из списка просто выбрать готовые статьи … карс, мкд и капчу на 4 языка"). A pick only
// fills the card's link field: the link stays free text and launches exactly as a pasted one does.
//
// Read off the builder on 13.10 under the GLO-02 login. It has one tab per redirect type, and a
// landing belongs to its tab's type (the tracking tails differ — lib/hs-launch hsLinkSegments):
//   #ADX [HIGH] — https://fast-flow.org/htd/<niche>/<lang>/             the direct article
//                 https://fast-flow.org/ht/<template>/<niche>/<lang>/    a quiz template before it
//                 (all 168 template × niche × language URLs the builder printed for the two niches
//                 follow this shape; fast-flow.org is its default out of a pool of 36 domains)
//   #ADX [META] — routerix.tech, every path spelled out in the builder's own map (CAMPAIGN_URL_MAP)
// Each link below answered 200 in its own language that day.
//
// Clothes joined on 25.11 (owner: "добавь так же им в лаунчер еще нишу clothes по тому же принципу"),
// read off the same two tabs: the same four markets and the same templates as the first two niches.
// All 48 HIGH links answered 200 in their own language. META's four captchas did too; its direct
// articles are a rotation on the partner's side (each request lands on another article site), and
// that day about one request in six to the EN / ES / PT ones ended on a site that answered 404 —
// the builder's link is right, the dead pages sit in the partner's pool (Digital Marketing EN hit
// one in twelve the same hour).
//
// Not listed, one line each when asked for: the builder's other HIGH templates (prize, cube,
// v2-prize, gift, slot, age-gate, ai-comp-1…4), META's Quiz type (/worldcars/, /videomkt/,
// /clothes/) and the other niches (Benefits, Loans, …).
//
// Import-free and pure: loaded by the card and by `node --test`.

export type HsReadyRedirect = "HIGH ADX" | "META ADX";
export type HsReadyLang = "EN" | "ES" | "FR" | "PT";

export type HsReadyLink = {
  /** The bare landing, exactly as the builder prints it — what the card's link field takes. */
  url: string;
  /** The redirect type (lib/catalog REDIRECT_TYPES) of the builder tab the landing comes from. */
  redirectType: HsReadyRedirect;
  /** The builder's niche — the picker's section. */
  niche: string;
  /** The niche as the team says it — heads the row: "Cars · Captcha 3", "MKD · Direct article",
   *  "Clothes · Captcha 1". */
  short: string;
  lang: HsReadyLang;
  /** "Direct article" · "Captcha 1" … "Captcha 10" · "Captcha (legacy)" (HIGH) · "Captcha" (META). */
  kind: string;
};

const LANGS: readonly HsReadyLang[] = ["EN", "ES", "FR", "PT"];
const DIRECT = "Direct article";

const HIGH_BASE = "https://fast-flow.org";
const HIGH_NICHES = [
  { slug: "cars", niche: "Cars", short: "Cars" },
  { slug: "digital-marketing", niche: "Digital Marketing", short: "MKD" },
  { slug: "clothes", niche: "Clothes", short: "Clothes" },
] as const;
/** The builder's captcha templates in its own order: the ten numbered ones, then the original. */
const HIGH_CAPTCHAS: ReadonlyArray<readonly [slug: string, kind: string]> = [
  ...Array.from({ length: 10 }, (_, i) => [`captcha-${i + 1}`, `Captcha ${i + 1}`] as const),
  ["captcha", "Captcha (legacy)"],
];

const META_BASE = "https://routerix.tech";
/** META's direct articles are named per market, each niche its own way: the Brazilian one is "-br"
 *  for Cars and Digital Marketing and "-pt" for Clothes ("roupas-…" in every language). */
const META_NICHES = [
  {
    niche: "Cars",
    short: "Cars",
    captcha: "cars",
    direct: { EN: "carros-en", ES: "carros-es", FR: "carros-fr", PT: "carros-br" },
  },
  {
    niche: "Digital Marketing",
    short: "MKD",
    captcha: "mkt",
    direct: { EN: "marketing-digital-en", ES: "marketing-digital-es", FR: "marketing-digital-fr", PT: "marketing-digital-br" },
  },
  {
    niche: "Clothes",
    short: "Clothes",
    captcha: "clothes",
    direct: { EN: "roupas-en", ES: "roupas-es", FR: "roupas-fr", PT: "roupas-pt" },
  },
] as const;

function build(): HsReadyLink[] {
  const out: HsReadyLink[] = [];
  for (const n of HIGH_NICHES) {
    for (const lang of LANGS) {
      const row = { redirectType: "HIGH ADX" as const, niche: n.niche, short: n.short, lang };
      const tail = `${n.slug}/${lang.toLowerCase()}/`;
      out.push({ ...row, kind: DIRECT, url: `${HIGH_BASE}/htd/${tail}` });
      for (const [slug, kind] of HIGH_CAPTCHAS) out.push({ ...row, kind, url: `${HIGH_BASE}/ht/${slug}/${tail}` });
    }
  }
  for (const n of META_NICHES) {
    for (const lang of LANGS) {
      const row = { redirectType: "META ADX" as const, niche: n.niche, short: n.short, lang };
      out.push({ ...row, kind: DIRECT, url: `${META_BASE}/direct/${n.direct[lang]}/` });
      out.push({ ...row, kind: "Captcha", url: `${META_BASE}/captcha/${n.captcha}/${lang.toLowerCase()}/` });
    }
  }
  return out;
}

/** Every ready landing, in picker order: a niche is one unbroken run (the picker prints a section
 *  header whenever it changes), languages EN → ES → FR → PT inside it, the article before its captchas. */
export const HS_READY_LINKS: readonly HsReadyLink[] = build();

const BY_TYPE = new Map<string, readonly HsReadyLink[]>(
  (["HIGH ADX", "META ADX"] as const).map((type) => [type, HS_READY_LINKS.filter((l) => l.redirectType === type)]),
);
const NONE: readonly HsReadyLink[] = [];

/** The ready landings of a redirect type, in picker order — the same array on every call. Plain
 *  #ADX has none: the builder has no tab for it (its links come from the weapon's own table). */
export function hsReadyLinksFor(redirectType: string): readonly HsReadyLink[] {
  return BY_TYPE.get(redirectType) ?? NONE;
}

const BY_URL = new Map(HS_READY_LINKS.map((l) => [l.url, l]));

/** The ready landing a card's link IS (spaces around it ignored), or null for a pasted link. */
export function hsReadyLinkOf(link: string): HsReadyLink | null {
  return BY_URL.get(String(link ?? "").trim()) ?? null;
}
