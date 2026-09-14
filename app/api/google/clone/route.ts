import { handleGoogleWave } from "@/lib/google-wave";

// Thin route: the whole wave lifecycle (session → validate → stamp rows → claim → after(pump))
// lives in lib/google-wave.ts, shared with the JURO route. See the design spec.
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request) {
  return handleGoogleWave(req, "clone");
}
