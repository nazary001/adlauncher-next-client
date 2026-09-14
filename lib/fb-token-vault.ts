// Sealing of Facebook access tokens at rest (the owner-managed token registry lives in a shared
// Strapi row — see lib/fb-tokens). AES-256-GCM under a key DERIVED from AUTH_SECRET (HKDF), so a
// leaked registry row is opaque without the app secret; the same secret on every instance means
// any cold start can open what another sealed. Deliberately dependency-free (node:crypto only) so
// `node --test tests/fb-token-vault.test.ts` runs it straight off Node's type stripping.
//
// Envelope: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". Opening a foreign/tampered/
// malformed envelope answers null — never garbage that could be sent to the Graph as a bearer.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_SALT = "adlauncher-fb-token-vault";
const KEY_INFO = "fb-token-registry:v1";

/** Same floor as lib/session: a short secret is treated as UNSET (the vault stays closed). */
export function vaultKey(secret: string): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", secret, KEY_SALT, KEY_INFO, 32));
}

/** Short stable identity of a bearer (the HS health row already keys on this shape). */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function sealToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

export function openToken(sealed: string, key: Buffer): string | null {
  const parts = String(sealed ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ct = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return out || null;
  } catch {
    return null;
  }
}
