export type Option = { value: string; label: string };
export type RichOption = {
  value: string;
  label: string;
  meta?: string;
  /** Right-aligned status tag on the option row (e.g. fanka fill "12/250"); not searched. */
  tag?: string;
  tagTone?: "dim" | "warn" | "danger";
};
export type Country = { code: string; name: string };
export type CountryPreset = { label: string; codes: string[] };

export const PROFILES: string[] = [
  "globecoders-120",
  "globecoders-121",
  "globecoders-124",
  "globecoders-128",
  "globecoders-129",
  "globecoders-130",
  "globecoders-133",
  "globecoders-134",
  "globecoders-135",
  "globecoders-137",
  "globecoders-138",
  "globecoders-139",
  "globecoders-140",
  "globecoders-141",
  "globecoders-142",
  "globecoders-143",
  "globecoders-FARM-34",
  "globecoders-FARM-35",
  "globecoders-FARM-36",
  "globecoders-FARM-37",
  "globecoders-FARM-38",
  "globecoders-FARM-40",
  "globecoders-FARM-41",
  "globecoders-FARM-42",
  "globecoders-FARM-43",
  "globecoders-FARM-44",
  "globecoders-FARM-46",
  "globecoders-FARM-47",
];

export const OBJECTIVES: Option[] = [
  { value: "OUTCOME_SALES", label: "Sales" },
  { value: "OUTCOME_LEADS", label: "Leads" },
];

export const OPTIMIZATIONS: Option[] = [
  { value: "conversions", label: "Conversions" },
  { value: "clicks", label: "Clicks" },
];

export const BID_STRATEGIES: Option[] = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Lowest cost" },
  { value: "LOWEST_COST_WITH_BID_CAP", label: "Lowest cost + bid cap" },
  { value: "COST_CAP", label: "Cost cap" },
];

export const CONVERSION_EVENTS: Option[] = [
  { value: "PURCHASE", label: "Purchase" },
  { value: "CONTENT_VIEW", label: "ViewContent" },
  { value: "LEAD", label: "Lead" },
  { value: "SEARCH", label: "Search" },
  { value: "SUBMIT_APPLICATION", label: "SubmitApplication" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "COMPLETE_REGISTRATION", label: "CompleteRegistration" },
  { value: "ADD_TO_CART", label: "AddToCart" },
  { value: "ADD_PAYMENT_INFO", label: "AddPaymentInfo" },
  { value: "INITIATED_CHECKOUT", label: "InitiateCheckout" },
  { value: "SCHEDULE", label: "Schedule" },
  { value: "START_TRIAL", label: "StartTrial" },
  { value: "ADD_TO_WISHLIST", label: "AddToWishlist" },
  { value: "CONTACT", label: "Contact" },
  { value: "CUSTOMIZE_PRODUCT", label: "CustomizeProduct" },
  { value: "DONATE", label: "Donate" },
  { value: "FIND_LOCATION", label: "FindLocation" },
];

/** Pixel events Meta actually allows per objective (empirically mapped against the Graph API
 *  2026-08-05). Filtering the dropdown by objective prevents "Conversion event unavailable"
 *  ad-set rejections; events valid for neither (e.g. CustomizeProduct) never surface. */
export const EVENTS_BY_OBJECTIVE: Record<string, string[]> = {
  OUTCOME_SALES: ["PURCHASE", "CONTENT_VIEW", "ADD_TO_CART", "INITIATED_CHECKOUT", "ADD_PAYMENT_INFO", "ADD_TO_WISHLIST", "COMPLETE_REGISTRATION", "SUBSCRIBE", "START_TRIAL", "SEARCH", "DONATE"],
  OUTCOME_LEADS: ["LEAD", "SUBMIT_APPLICATION", "SCHEDULE", "CONTACT", "FIND_LOCATION", "COMPLETE_REGISTRATION", "SUBSCRIBE", "START_TRIAL", "CONTENT_VIEW", "SEARCH"],
};

export function conversionEventsFor(objective: string): Option[] {
  const allowed = new Set(EVENTS_BY_OBJECTIVE[objective] ?? EVENTS_BY_OBJECTIVE.OUTCOME_SALES);
  return CONVERSION_EVENTS.filter((e) => allowed.has(e.value));
}

export const CTAS: Option[] = [
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "APPLY_NOW", label: "Apply Now" },
  { value: "BOOK_NOW", label: "Book Now" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "DONATE_NOW", label: "Donate Now" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "GET_OFFER", label: "Get Offer" },
  { value: "GET_QUOTE", label: "Get Quote" },
  { value: "GET_SHOWTIMES", label: "Get Showtimes" },
  { value: "LISTEN_NOW", label: "Listen Now" },
  { value: "MESSAGE_US", label: "Message Us" },
  { value: "PLAY_GAME", label: "Play Game" },
  { value: "REQUEST_TIME", label: "Request Time" },
  { value: "SEE_MENU", label: "See Menu" },
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "USE_APP", label: "Use App" },
  { value: "WATCH_MORE", label: "Watch More" },
  { value: "SEND_MESSAGE", label: "Send Message" },
  { value: "", label: "No CTA" },
];

export const REDIRECT_TYPES: Option[] = [
  { value: "META ADX", label: "META ADX" },
  { value: "HIGH ADX", label: "HIGH ADX" },
  { value: "#ADX", label: "ADX" },
];

export const PARAM_MODES: Option[] = [
  { value: "url_tags", label: "URL Tags" },
  { value: "link", label: "On Link" },
];

export const CATEGORIES: Option[] = [
  { value: "", label: "No category" },
  { value: "FINANCIAL_PRODUCTS_SERVICES", label: "Financial products" },
  { value: "HOUSING", label: "Housing" },
  { value: "EMPLOYMENT", label: "Employment" },
  // ISSUES_ELECTIONS_POLITICS omitted: it always fails on this account (Meta requires separate
  // "social issues, elections or politics" advertiser authorization we don't hold).
];

export const PLACEMENTS: Option[] = [
  { value: "FULL", label: "Full" },
  { value: "FULL_HOMEM", label: "Full · male" },
  { value: "FULL_MULHER", label: "Full · female" },
  { value: "COMPLIANCE", label: "Compliance" },
  { value: "COMPLIANCE_HOMEM", label: "Compliance · male" },
  { value: "COMPLIANCE_MULHER", label: "Compliance · female" },
];

export const AGES: Option[] = [
  { value: "18", label: "18+" },
  { value: "25", label: "25+" },
  { value: "35", label: "35+" },
  { value: "45", label: "45+" },
];

export const OS_OPTIONS: Option[] = [
  { value: "all", label: "All devices" },
  { value: "android", label: "Android only" },
];

export const LOCALES: string[] = [
  "English (all)",
  "English (US)",
  "English (UK)",
  "Portuguese (all)",
  "Portuguese (Brazil)",
  "Portuguese (Portugal)",
  "Spanish (all)",
  "Spanish (Spain)",
  "French (all)",
  "German",
  "Italian",
  "Dutch",
  "Polish",
  "Romanian",
  "Greek",
  "Czech",
  "Hungarian",
  "Slovak",
  "Bulgarian",
  "Croatian",
  "Serbian",
  "Swedish",
  "Danish",
  "Norwegian",
  "Finnish",
  "Turkish",
  "Arabic",
  "Hebrew",
  "Russian",
  "Ukrainian",
  "Hindi",
  "Bengali",
  "Urdu",
  "Indonesian",
  "Malay",
  "Thai",
  "Vietnamese",
  "Filipino",
  "Japanese",
  "Korean",
  "Chinese (simplified)",
  "Chinese (traditional)",
  "Swahili",
  "Amharic",
  "Zulu",
  "Afrikaans",
];

export const COUNTRY_PRESETS: CountryPreset[] = [
  { label: "World", codes: ["WW"] },
  {
    label: "LATAM",
    codes: ["AR", "BO", "CL", "CO", "CR", "SV", "EC", "GT", "HN", "MX", "NI", "PA", "PY", "PE", "PR", "DO", "UY"],
  },
  {
    label: "EU",
    codes: [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
      "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    ],
  },
  {
    label: "Africa",
    codes: ["ZA", "NG", "ET", "KE", "GH", "TZ", "UG", "CM", "CI", "SN", "ZM", "ZW", "MZ", "AO", "BW", "NA", "RW", "MW"],
  },
  { label: "T1", codes: ["US", "CA", "GB", "AU", "NZ", "DE", "FR", "NL", "SE", "NO", "DK", "CH"] },
];

export const COUNTRIES: Country[] = [
  { code: "WW", name: "Worldwide" },
  { code: "AF", name: "Afghanistan" },
  { code: "AL", name: "Albania" },
  { code: "DZ", name: "Algeria" },
  { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" },
  { code: "AR", name: "Argentina" },
  { code: "AM", name: "Armenia" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" },
  { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" },
  { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" },
  { code: "BO", name: "Bolivia" },
  { code: "BA", name: "Bosnia & Herzegovina" },
  { code: "BW", name: "Botswana" },
  { code: "BR", name: "Brazil" },
  { code: "BG", name: "Bulgaria" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" },
  { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" },
  { code: "CV", name: "Cape Verde" },
  { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" },
  { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" },
  { code: "CG", name: "Congo" },
  { code: "CD", name: "Congo (DRC)" },
  { code: "CR", name: "Costa Rica" },
  { code: "CI", name: "Cote d'Ivoire" },
  { code: "HR", name: "Croatia" },
  { code: "CU", name: "Cuba" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czech Republic" },
  { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" },
  { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" },
  { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" },
  { code: "EE", name: "Estonia" },
  { code: "ET", name: "Ethiopia" },
  { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" },
  { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" },
  { code: "GR", name: "Greece" },
  { code: "GT", name: "Guatemala" },
  { code: "GN", name: "Guinea" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong" },
  { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" },
  { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" },
  { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" },
  { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" },
  { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" },
  { code: "KR", name: "South Korea" },
  { code: "KW", name: "Kuwait" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" },
  { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" },
  { code: "LY", name: "Libya" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MO", name: "Macao" },
  { code: "MK", name: "North Macedonia" },
  { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" },
  { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MR", name: "Mauritania" },
  { code: "MU", name: "Mauritius" },
  { code: "MX", name: "Mexico" },
  { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" },
  { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar" },
  { code: "NA", name: "Namibia" },
  { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" },
  { code: "NZ", name: "New Zealand" },
  { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NO", name: "Norway" },
  { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" },
  { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "PR", name: "Puerto Rico" },
  { code: "QA", name: "Qatar" },
  { code: "RO", name: "Romania" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" },
  { code: "RS", name: "Serbia" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" },
  { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" },
  { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" },
  { code: "SZ", name: "Eswatini" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" },
  { code: "TG", name: "Togo" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "TN", name: "Tunisia" },
  { code: "TR", name: "Turkey" },
  { code: "TM", name: "Turkmenistan" },
  { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VE", name: "Venezuela" },
  { code: "VN", name: "Vietnam" },
  { code: "YE", name: "Yemen" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));
export function countryName(code: string): string {
  return COUNTRY_BY_CODE.get(code) ?? code;
}

/* Placeholder data below stands in for LION lookups until the logic phase. */

function seed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1_000_000_007;
  return h;
}

function digits(s: string, len: number): string {
  let out = "";
  let h = seed(s);
  for (let i = 0; i < len; i++) {
    out += String(h % 10);
    h = (h * 7 + 13) % 1_000_000_007;
  }
  return out;
}

export function accountsFor(profile: string): RichOption[] {
  if (!profile) return [];
  const short = profile.replace("globecoders-", "");
  return [1, 2, 3].map((n) => ({
    value: `${short}-A${n}`,
    label: `${short}-A${n}`,
    meta: `act_${digits(profile + n, 12)}`,
  }));
}

export function pagesFor(profile: string): RichOption[] {
  if (!profile) return [];
  return ["Magic Offers", "MK Learn", "Nice Advice", "Prime Autos"].map((name, i) => ({
    value: name,
    label: name,
    meta: digits(profile + name + i, 10),
  }));
}

export function pixelsFor(account: string): RichOption[] {
  if (!account) return [];
  return ["mklearn", "finance", "autos"].map((tag, i) => ({
    value: `PX ${tag}`,
    label: `PX ${tag}`,
    meta: digits(account + tag + i, 15),
  }));
}
