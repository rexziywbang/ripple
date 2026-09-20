import { openDatabase } from "@/lib/db/client";
import { seedSampleProject } from "@/lib/db/seed";

const db = openDatabase();
seedSampleProject(db, { reset: true });
console.log("Sample project reset and reseeded.");
