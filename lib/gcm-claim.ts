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
 * Did WE win this code? After a POST "succeeds", re-read every row for the code (oldest first,
 * documentId as the tiebreak) — Strapi's app-level uniqueness has a TOCTOU window that lets two
 * CONCURRENT POSTs of the same code both return 2xx (proven live: a 3-wide launch wave produced two
 * rows for one code). The row that committed first (smallest createdAt, then documentId) is the sole
 * winner; every later claimant sees the collision and yields. Deterministic → all racers agree.
 * On a read failure we optimistically keep the row (degrade to the old best-effort behaviour).
 */
async function wonClaim(gcm: string, documentId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${STRAPI}/api/gcm-maps?filters[gcm][$eq]=${gcm}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=gcm&pagination[pageSize]=10`,
      { headers: { Authorization: `Bearer ${STRAPI_TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return true;
    const body = await res.json().catch(() => ({}));
    const rows = (body.data ?? []) as Array<{ documentId?: string }>;
    if (rows.length <= 1) return true;
    return rows[0]?.documentId === documentId; // we win only if ours is the earliest row
  } catch {
    return true;
  }
}

/**
 * Reserve a gcm code (2-digit 01–99, matching the buy-link contract gcm=NN). Tries `desired`, then
 * walks to the next free code on a unique-violation OR a lost concurrent race. Returns the code
 * claimed + the Strapi documentId (for later id back-fill / release). Race-safe (see wonClaim).
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
      const documentId: string | null = body?.data?.documentId ?? null;
      // Can't verify without a documentId → keep it (best-effort, pre-fix behaviour).
      if (!documentId || (await wonClaim(gcm, documentId))) return { gcm, documentId };
      // Lost a concurrent race for this code → release our loser row and try the next candidate.
      await deleteGcm(documentId);
      continue;
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
