import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import {
  SnapApiError,
  snapAdAccounts,
  snapConfigured,
  snapDefaults,
  snapPixels,
  snapProfiles,
  snapRailEnabled,
  type SnapAdAccount,
  type SnapPixel,
  type SnapProfile,
} from "@/lib/snap-api";

export const runtime = "nodejs";
export const maxDuration = 60;

/** An ad account with its pixels; `status` rides through from SnapAdAccount (every status is listed —
 *  the picker tags a non-ACTIVE one, Snapchat itself is the authority at the create). */
export type SnapCatalogAccount = SnapAdAccount & { pixels: SnapPixel[]; pixelsError?: string };
export type SnapCatalog = {
  accounts: SnapCatalogAccount[];
  profiles: SnapProfile[];
  profilesError?: string;
  defaults: { adAccount: string; pixel: string; profile: string; brandName: string };
};

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Run a batch of async jobs with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * GET → everything the launcher's pickers need in ONE call: our ad accounts (each with its
 * pixels), the organization's Public Profiles and the env defaults. Per-account pixel reads and
 * the profiles read are best-effort (an error string rides along instead of sinking the call).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  let accounts: SnapAdAccount[];
  try {
    accounts = await snapAdAccounts();
  } catch (e) {
    const auth = e instanceof SnapApiError && e.status === 401;
    return bad(`${auth ? "snap_auth_failed" : "snap_unavailable"}: ${(e as Error).message}`, 502);
  }
  const withPixels: SnapCatalogAccount[] = accounts.map((a) => ({ ...a, pixels: [] }));
  await eachLimit(withPixels, 5, async (a) => {
    try {
      a.pixels = await snapPixels(a.id);
    } catch (e) {
      a.pixelsError = (e as Error).message;
    }
  });
  const defaults = snapDefaults();
  const orgId = defaults.organization || accounts[0]?.organizationId || "";
  let profiles: SnapProfile[] = [];
  let profilesError: string | undefined;
  if (orgId) {
    try {
      profiles = await snapProfiles(orgId);
    } catch (e) {
      profilesError = (e as Error).message;
    }
  } else {
    profilesError = "no organization id (no ad accounts and SNAP_ORGANIZATION_ID unset)";
  }
  const body: { ok: true } & SnapCatalog = {
    ok: true,
    accounts: withPixels,
    profiles,
    ...(profilesError ? { profilesError } : {}),
    defaults: { adAccount: defaults.adAccount, pixel: defaults.pixel, profile: defaults.profile, brandName: defaults.brandName },
  };
  return NextResponse.json(body);
}
