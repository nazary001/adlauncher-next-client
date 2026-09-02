// Server-only I/O for the Auto landings rail (MO / MK Learn): the mo-landing-job queue the
// owner console manages and the published mo-landing catalog the pickers + launch guard read.
// All Strapi access rides the bounded strapiFetch (8s abort) — a hung CMS must degrade, never
// pin a route to its maxDuration.

import type { Landing } from "@/lib/partners";
import { strapiFetch } from "@/lib/task-store";

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
/** Where the generated pages live (same base the MO partner config uses). */
export const AUTO_LANDING_BASE = "https://finance.magicoffers.shop/guides";

const auth = { Authorization: `Bearer ${TOKEN}` };
const authJson = { ...auth, "Content-Type": "application/json" };

export type AutoLandingJob = {
  documentId: string;
  title: string;
  lang: "en" | "es";
  niche: string;
  notes: string;
  status: "scheduled" | "generating" | "published" | "failed" | "canceled";
  scheduledAt: number;
  createdBy: string;
  batchId: string;
  attempts: number;
  error: string;
  slug: string;
  landingUrl: string;
  startedAt: number;
  finishedAt: number;
  createdAt: string;
};

type StrapiJobRow = {
  documentId?: string;
  title?: string;
  lang?: string;
  niche?: string;
  notes?: string;
  status?: string;
  scheduled_at?: unknown;
  created_by?: string;
  batch_id?: string;
  attempts?: unknown;
  error?: string;
  slug?: string;
  landing_url?: string;
  started_at?: unknown;
  finished_at?: unknown;
  createdAt?: string;
};

const num = (v: unknown): number => Number(v) || 0;

function formatJob(r: StrapiJobRow): AutoLandingJob | null {
  if (!r?.documentId || !r?.title) return null;
  const status = ["scheduled", "generating", "published", "failed", "canceled"].includes(String(r.status))
    ? (r.status as AutoLandingJob["status"])
    : "scheduled";
  return {
    documentId: String(r.documentId),
    title: String(r.title),
    lang: r.lang === "es" ? "es" : "en",
    niche: String(r.niche ?? "") || "Auto",
    notes: String(r.notes ?? ""),
    status,
    scheduledAt: num(r.scheduled_at),
    createdBy: String(r.created_by ?? ""),
    batchId: String(r.batch_id ?? ""),
    attempts: num(r.attempts),
    error: String(r.error ?? ""),
    slug: String(r.slug ?? ""),
    landingUrl: String(r.landing_url ?? ""),
    startedAt: num(r.started_at),
    finishedAt: num(r.finished_at),
    createdAt: String(r.createdAt ?? ""),
  };
}

/** Newest jobs first (whole queue — the batch cap keeps it small; paged past 100 anyway). */
export async function listJobs(): Promise<AutoLandingJob[] | null> {
  if (!STRAPI || !TOKEN) return null;
  const out: AutoLandingJob[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await strapiFetch(
        `${STRAPI}/api/mo-landing-jobs?sort[0]=createdAt:desc&pagination[page]=${page}&pagination[pageSize]=100`,
        { headers: auth, cache: "no-store" },
      );
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { data?: StrapiJobRow[] };
      const rows = body.data ?? [];
      for (const r of rows) {
        const j = formatJob(r);
        if (j) out.push(j);
      }
      if (rows.length < 100) break;
    }
    return out;
  } catch {
    return null;
  }
}

export async function readJob(documentId: string): Promise<AutoLandingJob | null> {
  if (!STRAPI || !TOKEN) return null;
  try {
    const res = await strapiFetch(`${STRAPI}/api/mo-landing-jobs/${encodeURIComponent(documentId)}`, {
      headers: auth,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { data?: StrapiJobRow };
    return body.data ? formatJob(body.data) : null;
  } catch {
    return null;
  }
}

export type NewJob = {
  title: string;
  lang: "en" | "es";
  niche: string;
  notes?: string;
  scheduledAt: number;
  createdBy: string;
  batchId: string;
};

/** Create one queue row; returns the created job (null on failure). */
export async function createJob(j: NewJob): Promise<AutoLandingJob | null> {
  if (!STRAPI || !TOKEN) return null;
  try {
    const res = await strapiFetch(`${STRAPI}/api/mo-landing-jobs`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        data: {
          title: j.title,
          lang: j.lang,
          niche: j.niche,
          notes: j.notes ?? "",
          status: "scheduled",
          scheduled_at: String(j.scheduledAt),
          created_by: j.createdBy,
          batch_id: j.batchId,
          attempts: 0,
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { data?: StrapiJobRow };
    return body.data ? formatJob(body.data) : null;
  } catch {
    return null;
  }
}

export async function patchJob(
  documentId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!STRAPI || !TOKEN) return false;
  try {
    const res = await strapiFetch(`${STRAPI}/api/mo-landing-jobs/${encodeURIComponent(documentId)}`, {
      method: "PUT",
      headers: authJson,
      body: JSON.stringify({ data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteJob(documentId: string): Promise<boolean> {
  if (!STRAPI || !TOKEN) return false;
  try {
    const res = await strapiFetch(`${STRAPI}/api/mo-landing-jobs/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers: auth,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- published landings (the picker + launch-guard side) ------------------------------------

type StrapiLandingRow = {
  documentId?: string;
  title?: string;
  slug?: string;
  lang?: string;
  niche?: string;
};

export type AutoLanding = Landing & { documentId: string };

/** Published auto landings as picker `Landing`s, grouped under "Auto · <niche>" section headers
 *  (groups must stay CONTIGUOUS for SearchSelect, hence the niche sort). */
export async function fetchAutoLandings(): Promise<AutoLanding[] | null> {
  if (!STRAPI || !TOKEN) return null;
  const out: AutoLanding[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await strapiFetch(
        `${STRAPI}/api/mo-landings?fields[0]=title&fields[1]=slug&fields[2]=lang&fields[3]=niche` +
          `&sort[0]=niche:asc&sort[1]=createdAt:desc&pagination[page]=${page}&pagination[pageSize]=100`,
        { headers: auth, cache: "no-store" },
      );
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { data?: StrapiLandingRow[] };
      const rows = body.data ?? [];
      for (const r of rows) {
        if (!r?.slug || !r?.title || !r?.documentId) continue;
        out.push({
          documentId: String(r.documentId),
          slug: String(r.slug),
          title: String(r.title),
          lang: r.lang === "es" ? "ES" : "EN",
          niche: `Auto · ${String(r.niche ?? "") || "Auto"}`,
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  } catch {
    return null;
  }
}

// Short per-instance cache so the launch guard + picker route don't hammer Strapi; the catalog
// changes at generation cadence (minutes), 60s staleness is invisible.
let landingsCache: { at: number; rows: AutoLanding[] } | null = null;
const LANDINGS_TTL_MS = 60_000;

export async function cachedAutoLandings(): Promise<AutoLanding[]> {
  if (landingsCache && Date.now() - landingsCache.at < LANDINGS_TTL_MS) return landingsCache.rows;
  const rows = await fetchAutoLandings();
  if (rows === null) return landingsCache?.rows ?? []; // degrade to stale/empty, never throw
  landingsCache = { at: Date.now(), rows };
  return rows;
}

/** Launch-guard check: is `slug` a live auto landing? (Static catalog is checked by the caller.) */
export async function isAutoLandingSlug(slug: string): Promise<boolean> {
  const clean = String(slug ?? "").trim();
  if (!clean) return false;
  const rows = await cachedAutoLandings();
  return rows.some((l) => l.slug === clean);
}

export async function deleteLanding(documentId: string): Promise<boolean> {
  if (!STRAPI || !TOKEN) return false;
  try {
    const res = await strapiFetch(`${STRAPI}/api/mo-landings/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers: auth,
    });
    if (res.ok) landingsCache = null;
    return res.ok;
  } catch {
    return false;
  }
}

/** The landing documentId for a published job's slug (for unpublish). */
export async function findLandingBySlug(slug: string): Promise<string | null> {
  if (!STRAPI || !TOKEN) return null;
  try {
    const res = await strapiFetch(
      `${STRAPI}/api/mo-landings?filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=slug&pagination[pageSize]=1`,
      { headers: auth, cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { data?: StrapiLandingRow[] };
    return body.data?.[0]?.documentId ?? null;
  } catch {
    return null;
  }
}
