// Atomic gcm-code claim against the shared Strapi registry (unique `gcm` field → no two ads ever
// share a code). Same contract as app/api/launch/route.ts, extracted so the clone run reuses it
// without touching the launch route. Server-only.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

type Json = Record<string, unknown>;

async function usedCodes(): Promise<Set<string>> {
  const res = await fetch(`${STRAPI}/api/gcm-maps?fields[0]=gcm&pagination[pageSize]=200`, {
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) return new Set();
  const body = await res.json().catch(() => ({}));
  return new Set(((body.data ?? []) as Array<{ gcm?: string }>).map((r) => String(r.gcm ?? "")).filter(Boolean));
}

/**
 * Reserve a gcm code (2-digit 01–99, matching the buy-link contract gcm=NN). Tries `desired`, then
 * walks to the next free code on a unique-violation. Returns the code claimed + the Strapi
 * documentId (for later id back-fill / release).
 */
export async function claimGcm(
  desired: string,
  meta: Json,
): Promise<{ gcm: string; documentId: string | null }> {
  const used = await usedCodes();
  const candidates: string[] = [];
  const start = /^\d{1,2}$/.test(desired) ? Math.min(parseInt(desired, 10) || 1, 99) : 1;
  for (let n = start; n <= 99; n++) if (!used.has(String(n).padStart(2, "0"))) candidates.push(String(n).padStart(2, "0"));
  for (let n = 1; n < start; n++) if (!used.has(String(n).padStart(2, "0"))) candidates.push(String(n).padStart(2, "0"));

  for (const gcm of candidates) {
    const res = await fetch(`${STRAPI}/api/gcm-maps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { gcm, platform: "facebook", status: "active", ...meta } }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return { gcm, documentId: body?.data?.documentId ?? null };
    }
    if (res.status !== 400) {
      // 400 = unique violation (someone took it) → next candidate; anything else aborts.
      const body = await res.json().catch(() => ({}));
      throw new Error(`gcm claim failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
  throw new Error("gcm pool exhausted — no free code 01–99");
}

export async function backfillGcm(documentId: string | null, patch: Json): Promise<void> {
  if (!documentId) return;
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: patch }),
  }).catch(() => {});
}

/** Release a claimed code (delete the row) when a clone fails before any FB resource is created. */
export async function deleteGcm(documentId: string): Promise<void> {
  await fetch(`${STRAPI}/api/gcm-maps/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  }).catch(() => {});
}
