import { handleGoogleLaunch } from "@/lib/google-wave";

export const runtime = "nodejs";
// Fluid ceiling: the after() pump submits shots one at a time and polls their tasks (lib/google-pump).
export const maxDuration = 800;

/** Fresh Demand Gen launches through google-weapon (`/campaign/launch/`) — one wave per POST. */
export async function POST(req: Request) {
  return handleGoogleLaunch(req);
}
