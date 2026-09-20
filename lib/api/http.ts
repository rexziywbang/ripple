import { NextResponse } from "next/server";
import { z } from "zod";
import { openDatabase } from "@/lib/db/client";
import { seedSampleProject } from "@/lib/db/seed";

export function db() {
  const d = openDatabase();
  seedSampleProject(d);
  return d;
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function error(message: string, status = 400) {
  return json({ error: message }, status);
}

export async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<{ ok: true; value: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: error("Request body must be JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: error(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) };
  return { ok: true, value: parsed.data };
}
