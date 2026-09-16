// Snapchat rail — the one-time OAuth dance that mints the REFRESH TOKEN the rail runs on. Owner
// only. The token is shown once in the browser and pasted into .env.local by hand (single-account
// rail → no vault); the same page is how it gets rotated. State = HMAC-signed nonce in a
// short-lived cookie so a forged callback can't hand the owner someone else's code.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AUTH_SECRET ?? "";
export const SNAP_OAUTH_STATE_COOKIE = "snap_oauth_state";

/** The client app pair exists before any refresh token does — this is the helper's own gate. */
export const snapClientConfigured = (): boolean => Boolean(process.env.SNAP_CLIENT_ID && process.env.SNAP_CLIENT_SECRET);

export function snapOauthRedirectUri(req: Request): string {
  return process.env.SNAP_OAUTH_REDIRECT_URI || `${new URL(req.url).origin}/api/snap/oauth/callback`;
}

export function signOauthState(): string {
  const nonce = randomBytes(16).toString("hex");
  return `${nonce}.${createHmac("sha256", SECRET).update(nonce).digest("hex")}`;
}

export function verifyOauthState(state: string | null, cookie: string | null): boolean {
  if (!SECRET || !state || !cookie || state !== cookie) return false;
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = createHmac("sha256", SECRET).update(nonce).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
