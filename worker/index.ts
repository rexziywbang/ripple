import { openDatabase } from "@/lib/db/client";
import { seedSampleProject } from "@/lib/db/seed";
import { workerLoop } from "@/lib/jobs/worker";

const db = openDatabase();
seedSampleProject(db);
const workerId = `worker-${process.pid}`;
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[ripple-worker] ${sig} received; finishing current job and exiting`);
    controller.abort();
  });
}
console.log(`[ripple-worker] ${workerId} started; database ${process.env.DATABASE_PATH ?? "data/ripple.db"}`);
workerLoop(db, workerId, { signal: controller.signal }).then(() => {
  console.log("[ripple-worker] stopped");
  process.exit(0);
});
