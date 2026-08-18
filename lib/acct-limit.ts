// Per-account launch rate limit: at most ACCT_LIMIT campaigns may be created in one ad account
// within ACCT_WINDOW_MS, the window ANCHORED at the first launch (owner pick 2026-08-18). Every
// campaign-creating route claims a slot here right before it builds; the UI reads the snapshot to
// badge account pickers and drive the header timer. State lives in the shared Strapi `app-cache`
// collection (unique ckey — the same store the HS wave claim already uses), because Vercel
// serverless instances share nothing and several users launch at once:
//   acct-window:<actId>            → { ws }                       — the window anchor
//   acct-slot:<actId>:<ws>:<n>     → { user, partner, channel, name, accountName, ts }
// Claims are race-safe the proven way (lib/gcm-claim / lib/aif-claim): POST against the unique
// ckey, then re-read and yield if we weren't first — plus an anchor re-check, because two claims
// racing across the window boundary could otherwise split onto two anchors. Server-only.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";

export const ACCT_LIMIT = 5;
export const ACCT_WINDOW_MS = 30 * 60_000;
/** Expired rows linger this long before the snapshot sweep deletes them (a just-expired window
 *  must not be churned by a claim re-creating it mid-sweep). */
const SWEEP_GRACE_MS = 5 * 60_000;
/** At most this many row deletions per snapshot call — the sweep piggybacks on a UI poll and
 *  must never turn it into a bulk-delete stall. */
const SWEEP_MAX_DELETES = 20;

const W_PREFIX = "acct-window:";
const S_PREFIX = "acct-slot:";

/** Canonical account key: numeric id, `act_` prefix stripped. */
export function acctKey(raw: string): string {
  return String(raw ?? "").trim().replace(/^act_/, "");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

/** Is a window anchored at `ws` still open at `now`? Garbage/zero anchors are never active. */
export function windowActive(ws: number, now: number): boolean {
  return Number.isFinite(ws) && ws > 0 && now < ws + ACCT_WINDOW_MS;
}

/** The human refusal every surface shows — countdown included so nobody has to guess. */
export function acctLimitMessage(resetAt: number, now: number = Date.now()): string {
  const left = Math.max(0, resetAt - now);
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000);
  return `Account limit: ${ACCT_LIMIT} campaigns / 30 min — resets in ${mm}:${String(ss).padStart(2, "0")}`;
}

export class AcctLimitedError extends Error {
  resetAt: number;
  accountId: string;
  constructor(accountId: string, resetAt: number) {
    super(acctLimitMessage(resetAt));
    this.name = "AcctLimitedError";
    this.resetAt = resetAt;
    this.accountId = accountId;
  }
}

export type AcctWindowInfo = { count: number; resetAt: number; name?: string };
export type AcctLimitSnapshot = {
  now: number;
  limit: number;
  windowMs: number;
  accounts: Record<string, AcctWindowInfo>;
};

type KeyedValue = { ckey: string; value: unknown };

/**
 * Pure snapshot derivation (unit-tested): active windows only, slots counted strictly against
 * their window's CURRENT anchor (stale-anchor slots are dead rows awaiting the sweep), account
 * display name from the latest slot's meta.
 */
export function deriveSnapshot(
  windows: KeyedValue[],
  slots: KeyedValue[],
  now: number,
): AcctLimitSnapshot {
  const accounts: Record<string, AcctWindowInfo> = {};
  const wsById = new Map<string, number>();
  for (const w of windows) {
    if (!w.ckey.startsWith(W_PREFIX)) continue;
    const id = w.ckey.slice(W_PREFIX.length);
    const ws = num((w.value as { ws?: unknown } | null)?.ws);
    if (!id || !windowActive(ws, now)) continue;
    wsById.set(id, ws);
    accounts[id] = { count: 0, resetAt: ws + ACCT_WINDOW_MS };
  }
  const nameTs = new Map<string, number>();
  for (const s of slots) {
    if (!s.ckey.startsWith(S_PREFIX)) continue;
    const [id, wsStr, nStr] = s.ckey.slice(S_PREFIX.length).split(":");
    if (!id || wsById.get(id) !== Number(wsStr) || !/^\d+$/.test(nStr ?? "")) continue;
    const a = accounts[id];
    a.count = Math.min(ACCT_LIMIT, a.count + 1);
    const v = s.value as { accountName?: unknown; ts?: unknown } | null;
    const nm = typeof v?.accountName === "string" ? v.accountName.trim() : "";
    const ts = Number(v?.ts) || 0;
    if (nm && ts >= (nameTs.get(id) ?? -1)) {
      nameTs.set(id, ts);
      a.name = nm;
    }
  }
  return { now, limit: ACCT_LIMIT, windowMs: ACCT_WINDOW_MS, accounts };
}

// ---------------------------------------------------------------------------
// Strapi I/O — own helpers, NOT lib/app-cache's: a claim must distinguish "unique violation"
// (someone holds the slot → walk on) from "store down" (FAIL CLOSED → the launch refuses),
// and app-cache's best-effort writer collapses both into one null.
// ---------------------------------------------------------------------------

type Row = { documentId: string; ckey: string; value: unknown };

function storeDown(detail: string): Error {
  return new Error(`acct_limit_unavailable — launch registry unreachable (${detail})`);
}

function assertConfigured(): void {
  if (!STRAPI || !TOKEN) throw storeDown("no STRAPI env");
}

const HEADERS = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

function shapeRow(r: { documentId?: unknown; ckey?: unknown; cvalue?: unknown }): Row | null {
  if (!r?.documentId || typeof r.ckey !== "string") return null;
  return { documentId: String(r.documentId), ckey: r.ckey, value: r.cvalue ?? null };
}

/** All rows whose ckey starts with `prefix` (paged — Strapi Cloud clamps pageSize to 100). */
async function listRows(prefix: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${STRAPI}/api/app-caches?filters[ckey][$startsWith]=${encodeURIComponent(prefix)}` +
        `&fields[0]=ckey&fields[1]=cvalue&pagination[page]=${page}&pagination[pageSize]=100`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
    ).catch((e) => {
      throw storeDown(String(e));
    });
    if (!res.ok) throw storeDown(`list ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
    const rows = (body.data ?? [])
      .map((r) => shapeRow(r as { documentId?: unknown; ckey?: unknown; cvalue?: unknown }))
      .filter((r): r is Row => r !== null);
    out.push(...rows);
    if ((body.data ?? []).length < 100) break;
  }
  return out;
}

async function readRow(ckey: string): Promise<Row | null> {
  const res = await fetch(
    `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(ckey)}&pagination[pageSize]=1`,
    { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
  ).catch((e) => {
    throw storeDown(String(e));
  });
  if (!res.ok) throw storeDown(`read ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return shapeRow((body.data?.[0] ?? {}) as { documentId?: unknown; ckey?: unknown; cvalue?: unknown });
}

/** POST a row. `{unique:true}` on a 400 (ckey taken — the atomic signal); throws when the store
 *  itself fails. */
async function postRow(
  ckey: string,
  cvalue: unknown,
): Promise<{ documentId: string; unique?: never } | { unique: true }> {
  const res = await fetch(`${STRAPI}/api/app-caches`, {
    method: "POST",
    headers: HEADERS(),
    body: JSON.stringify({ data: { ckey, cvalue, refreshed_at: Date.now() } }),
  }).catch((e) => {
    throw storeDown(String(e));
  });
  if (res.status === 400) return { unique: true };
  if (!res.ok) throw storeDown(`post ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { data?: { documentId?: unknown } };
  const documentId = body.data?.documentId ? String(body.data.documentId) : "";
  if (!documentId) throw storeDown("post: no documentId");
  return { documentId };
}

async function putRow(documentId: string, ckey: string, cvalue: unknown): Promise<void> {
  const res = await fetch(`${STRAPI}/api/app-caches/${documentId}`, {
    method: "PUT",
    headers: HEADERS(),
    body: JSON.stringify({ data: { ckey, cvalue, refreshed_at: Date.now() } }),
  }).catch((e) => {
    throw storeDown(String(e));
  });
  if (!res.ok) throw storeDown(`put ${res.status}`);
}

/** Best-effort delete — releasing/sweeping must never fail a launch. */
async function deleteRow(documentId: string): Promise<void> {
  await fetch(`${STRAPI}/api/app-caches/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  }).catch(() => {});
}

/** Did WE win this unique ckey? Strapi's app-level uniqueness has a TOCTOU window letting two
 *  concurrent POSTs both 2xx (proven live on the gcm registry) — earliest row wins, we yield
 *  otherwise. Optimistic true on a read failure (mirror of aif-claim). */
async function wonRow(ckey: string, documentId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(ckey)}` +
        `&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=ckey&pagination[pageSize]=10`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" },
    );
    if (!res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ documentId?: unknown }> };
    const rows = body.data ?? [];
    if (rows.length <= 1) return true;
    return String(rows[0]?.documentId ?? "") === documentId;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AcctSlotMeta = {
  user?: string;
  partner?: string;
  channel?: string;
  /** Campaign name (display only — the header panel's tooltip material). */
  name?: string;
  /** Account display name when the route has it from its catalog (display only). */
  accountName?: string;
};

/**
 * Claim one launch slot for the account, or throw:
 *  - AcctLimitedError — all ACCT_LIMIT slots of the current window are taken (carries resetAt);
 *  - Error("acct_limit_unavailable…") — the store is unreachable (FAIL CLOSED by design).
 * The caller keeps the slot once a campaign exists and releases it when the launch died earlier.
 */
export async function claimAcctSlot(
  accountId: string,
  meta: AcctSlotMeta,
): Promise<{ documentId: string; count: number }> {
  const id = acctKey(accountId);
  if (!/^\d{5,}$/.test(id)) throw new Error(`acct_limit: bad account id "${accountId}"`);
  assertConfigured();
  const wkey = `${W_PREFIX}${id}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    let wrow = await readRow(wkey);
    if (!wrow) {
      const res = await postRow(wkey, { ws: now });
      wrow = "documentId" in res ? { documentId: res.documentId, ckey: wkey, value: { ws: now } } : await readRow(wkey);
      if (!wrow) continue; // lost the race AND the winner's row isn't visible yet — retry
    }
    let ws = num((wrow.value as { ws?: unknown } | null)?.ws);
    if (!windowActive(ws, now)) {
      // Expired (or garbage) anchor → move it, then ADOPT whatever concurrent writers settled on:
      // last-write-wins converges, and every claimant keys its slots off the stored value.
      await putRow(wrow.documentId, wkey, { ws: now });
      const re = await readRow(wkey);
      if (!re) continue;
      wrow = re;
      ws = num((wrow.value as { ws?: unknown } | null)?.ws);
      if (!windowActive(ws, Date.now())) continue; // still not settled — retry
    }

    const sPrefix = `${S_PREFIX}${id}:${ws}:`;
    const taken = new Set(
      (await listRows(sPrefix))
        .map((r) => Number(r.ckey.slice(sPrefix.length)))
        .filter((x) => Number.isFinite(x)),
    );
    let anchorMoved = false;
    for (let slot = 1; slot <= ACCT_LIMIT; slot++) {
      if (taken.has(slot)) continue;
      const skey = `${sPrefix}${slot}`;
      const res = await postRow(skey, { ...meta, ts: Date.now() });
      if ("unique" in res) continue; // someone else holds n — walk on
      if (!(await wonRow(skey, res.documentId))) {
        await deleteRow(res.documentId); // concurrent double-2xx — earliest row wins, we yield
        continue;
      }
      // Anchor re-check: a claim racing the window boundary may have moved the anchor between our
      // read and this win — a slot keyed on the dead anchor would not count against the new
      // window, quietly widening the limit. Orphan it and retry on the fresh anchor.
      const wcheck = await readRow(wkey).catch(() => null);
      if (wcheck && num((wcheck.value as { ws?: unknown } | null)?.ws) !== ws) {
        await deleteRow(res.documentId);
        anchorMoved = true;
        break;
      }
      return { documentId: res.documentId, count: slot };
    }
    if (!anchorMoved) throw new AcctLimitedError(id, ws + ACCT_WINDOW_MS);
  }
  throw storeDown("claim did not settle");
}

/** Release a claimed slot (launch died before any campaign existed). Best-effort. */
export async function releaseAcctSlot(documentId: string | null | undefined): Promise<void> {
  if (documentId) await deleteRow(documentId);
}

/**
 * The live picture for the UI: every account with an active window. Also sweeps a bounded number
 * of expired rows (grace-delayed) so the collection never accumulates dead windows.
 */
export async function acctLimitSnapshot(): Promise<AcctLimitSnapshot> {
  assertConfigured();
  const now = Date.now();
  const [wins, slots] = await Promise.all([listRows(W_PREFIX), listRows(S_PREFIX)]);
  const snap = deriveSnapshot(wins, slots, now);

  // Sweep: window rows past anchor+window+grace, and slot rows whose ckey anchor is past the same
  // cutoff. Bounded and awaited (a handful of parallel DELETEs) — only runs when there IS garbage.
  // NOTE the direction: grace is measured PAST the window's end (a garbage/zero anchor is dead
  // immediately) — never by shifting `now`, which would extend the window instead.
  const deadStamp = (ws: number): boolean =>
    !(Number.isFinite(ws) && ws > 0) || now >= ws + ACCT_WINDOW_MS + SWEEP_GRACE_MS;
  const dead: string[] = [];
  for (const w of wins) {
    const ws = num((w.value as { ws?: unknown } | null)?.ws);
    if (deadStamp(ws)) dead.push(w.documentId);
    if (dead.length >= SWEEP_MAX_DELETES) break;
  }
  for (const s of slots) {
    if (dead.length >= SWEEP_MAX_DELETES) break;
    if (deadStamp(Number(s.ckey.slice(S_PREFIX.length).split(":")[1]))) dead.push(s.documentId);
  }
  if (dead.length > 0) await Promise.all(dead.map((d) => deleteRow(d)));
  return snap;
}
