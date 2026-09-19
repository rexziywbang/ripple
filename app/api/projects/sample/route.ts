import { db, json } from "@/lib/api/http";
import { seedSampleProject } from "@/lib/db/seed";

/** Re-seeds the sample event from fixtures, discarding all its workflow history. */
export async function POST() {
  const project = seedSampleProject(db(), { reset: true });
  return json({ project });
}
