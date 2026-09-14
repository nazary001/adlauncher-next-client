import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import {
  forgetTokenHealth,
  mutateRegistry,
  probeTokenIdentity,
  readRegistry,
  registryView,
  sealForVault,
  vaultOpen,
} from "@/lib/fb-tokens";
import {
  type SlotId,
  addToken,
  isSlotId,
  looksLikeFbToken,
  newTokenId,
  normalizeToken,
  removeToken,
  setIdentity,
  setSlot,
  updateToken,
  validateLabel,
  validatePartners,
} from "@/lib/fb-token-registry";
import { openToken, vaultKey } from "@/lib/fb-token-vault";

export const runtime = "nodejs";
// An add/re-check probes the Graph (≤ ~6 bounded reads) — give it headroom.
export const maxDuration = 60;

/**
 * Owner-only Facebook token registry (feeds the /tokens page) — owner ask 2026-09-14.
 *
 * GET    → the whole picture: vault tokens (registry + read-only env seeds) with identity and
 *          live health, the six partner×rail slots with what actually signs each, recent changes.
 *          NO token material ever leaves the server.
 * POST   → { token, label, partners, personal?, note?, assign?: SlotId[] } — probes the bearer
 *          (a dead token is refused up front), seals it, stores it, optionally assigns it to the
 *          named slots in the same write.
 * PATCH  → { op:"slot", slot, ids } · { op:"update", id, patch } · { op:"recheck", id }
 * DELETE → ?id=<registry id> — removes the token and clears it from every slot.
 *
 * Every write is a read-modify-write of the single Strapi row that REFUSES when the row could
 * not be read (a blip must never wipe the vault). Non-owners get 403.
 */
async function gate(req: Request): Promise<{ username: string } | NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return { username: session.username };
}

async function answerView(extra: Record<string, unknown> = {}): Promise<NextResponse> {
  const view = await registryView();
  if (!view) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
  return NextResponse.json({ ok: true, ...view, ...extra });
}

export async function GET(req: Request) {
  const g = await gate(req);
  if (g instanceof NextResponse) return g;
  return answerView();
}

export async function POST(req: Request) {
  const g = await gate(req);
  if (g instanceof NextResponse) return g;
  if (!vaultOpen()) return NextResponse.json({ ok: false, error: "vault_closed — AUTH_SECRET is missing/too short on this deployment" }, { status: 500 });

  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    label?: unknown;
    partners?: unknown;
    personal?: unknown;
    note?: unknown;
    assign?: unknown;
  } | null;
  const token = normalizeToken(body?.token);
  if (!looksLikeFbToken(token)) {
    return NextResponse.json({ ok: false, error: "token_invalid — paste the full access token (letters/digits only, 40+ chars)" }, { status: 400 });
  }
  const label = validateLabel(body?.label);
  if (!label) return NextResponse.json({ ok: false, error: "label_invalid — 1–40 chars: letters, digits, space . _ ( ) # / + -" }, { status: 400 });
  const partners = validatePartners(body?.partners);
  if (!partners) return NextResponse.json({ ok: false, error: "partners_required — tag at least one partner (MO / AIF / HS)" }, { status: 400 });
  const assign: SlotId[] = Array.isArray(body?.assign) ? (body!.assign as unknown[]).filter(isSlotId) : [];
  for (const slot of assign) {
    if (!partners.includes(slot.split(".")[0] as "mo" | "aif" | "hs")) {
      return NextResponse.json({ ok: false, error: `assign_mismatch — ${slot} needs the ${slot.split(".")[0].toUpperCase()} partner tag` }, { status: 400 });
    }
  }

  // Identity first: a token FB rejects is refused up front (the vault holds live bearers only).
  const identity = await probeTokenIdentity(token);
  if (!identity.ok) {
    return NextResponse.json({ ok: false, error: `token_rejected — Facebook refused this token: ${identity.error ?? "unknown"}`, identity }, { status: 400 });
  }
  const sealed = sealForVault(token);
  if (!sealed) return NextResponse.json({ ok: false, error: "vault_closed" }, { status: 500 });

  const id = newTokenId();
  const now = Date.now();
  const out = await mutateRegistry((reg, seeds) => {
    const added = addToken(
      reg,
      { label, sealed: sealed.sealed, fp: sealed.fp, partners, personal: body?.personal === true, note: String(body?.note ?? ""), addedBy: g.username, addedAt: now, identity },
      id,
      seeds,
      now,
    );
    if (!added.ok) return added;
    let cur = added.reg;
    const assignables = [...cur.tokens, ...seeds];
    for (const slot of assign) {
      // Pools (HS) append the new bearer as the LAST fallback; single-token rails replace.
      const ids = slot.startsWith("hs.") ? [...cur.slots[slot], id] : [id];
      const set = setSlot(cur, slot, ids, assignables, g.username, now);
      if (!set.ok) return set;
      cur = set.reg;
    }
    return { ok: true, reg: cur };
  });
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
  return answerView({ added: id });
}

export async function PATCH(req: Request) {
  const g = await gate(req);
  if (g instanceof NextResponse) return g;
  const body = (await req.json().catch(() => null)) as
    | { op?: unknown; slot?: unknown; ids?: unknown; id?: unknown; patch?: unknown }
    | null;
  const op = String(body?.op ?? "");
  const now = Date.now();

  if (op === "slot") {
    if (!isSlotId(body?.slot)) return NextResponse.json({ ok: false, error: "unknown_slot" }, { status: 400 });
    const slot = body!.slot as SlotId;
    const out = await mutateRegistry((reg, seeds) => setSlot(reg, slot, body?.ids, [...reg.tokens, ...seeds], g.username, now));
    if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
    return answerView();
  }

  if (op === "update") {
    const id = String(body?.id ?? "");
    const patch = (body?.patch ?? {}) as { label?: unknown; partners?: unknown; personal?: unknown; note?: unknown };
    const out = await mutateRegistry((reg) => updateToken(reg, id, patch, g.username, now));
    if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
    return answerView();
  }

  if (op === "recheck") {
    const id = String(body?.id ?? "");
    const row = await readRegistry();
    if (!row) return NextResponse.json({ ok: false, error: "store_unavailable" }, { status: 502 });
    const t = row.data.tokens.find((x) => x.id === id);
    if (!t) return NextResponse.json({ ok: false, error: "unknown_token" }, { status: 404 });
    const k = vaultKey(process.env.AUTH_SECRET ?? "");
    const bearer = k ? openToken(t.sealed, k) : null;
    if (!bearer) return NextResponse.json({ ok: false, error: "token_unreadable — sealed with another secret; remove and re-add it" }, { status: 409 });
    const identity = await probeTokenIdentity(bearer);
    forgetTokenHealth(t.fp);
    const out = await mutateRegistry((reg) => setIdentity(reg, id, identity, g.username, now));
    if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
    return answerView({ identity });
  }

  return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const g = await gate(req);
  if (g instanceof NextResponse) return g;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
  let removedFrom: SlotId[] = [];
  const out = await mutateRegistry((reg) => {
    const r = removeToken(reg, id, g.username, Date.now());
    if (r.ok) removedFrom = r.removedFrom ?? [];
    return r;
  });
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status });
  return answerView({ removedFrom });
}
