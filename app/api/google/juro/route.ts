import { handleGoogleWave } from "@/lib/google-wave";

// Thin route: the JURO wave shares the whole lifecycle with the clone route — only the mode
// differs (JURO lands on the source's own account, keeps its bidding strategy). See the spec.
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request) {
  return handleGoogleWave(req, "juro");
}
