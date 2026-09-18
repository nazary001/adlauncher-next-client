import { handleTiktokWave } from "@/lib/tiktok-wave";

export const runtime = "nodejs";
// Fluid ceiling: the after() pump submits shots one at a time, waits out cold datasets and settles
// the sent tasks (lib/tiktok-pump-core).
export const maxDuration = 800;

/** Clones of existing TikTok campaigns through tiktok-weapon (`/clone/launch/`) — one wave per POST. */
export async function POST(req: Request) {
  return handleTiktokWave(req, "clone");
}
