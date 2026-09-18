import { handleTiktokWave } from "@/lib/tiktok-wave";

export const runtime = "nodejs";
// Fluid ceiling: the after() pump submits shots one at a time, waits out cold datasets and settles
// the sent tasks (lib/tiktok-pump-core).
export const maxDuration = 800;

/** JURO copies on the source's own advertiser through tiktok-weapon (`/juro/launch/`). */
export async function POST(req: Request) {
  return handleTiktokWave(req, "juro");
}
