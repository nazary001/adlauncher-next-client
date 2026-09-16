import { handleSnapLaunch } from "@/lib/snap-wave";

// Thin route: the whole lifecycle (validate → stamp → claim → after(pump)) lives in lib/snap-wave.
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request) {
  return handleSnapLaunch(req);
}
