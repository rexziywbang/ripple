import { z } from "zod";

export type LlmConfig = { apiKey: string; model: string; baseUrl: string; timeoutMs: number };

export function llmConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!apiKey || !model) return null;
  return {
    apiKey,
    model,
    baseUrl: (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20000),
  };
}

export type StructuredResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: string; kind: "timeout" | "rate_limit" | "http" | "invalid_json" | "schema" | "network" };

/**
 * Minimal OpenAI-compatible chat-completions client with a JSON-schema response format.
 * The key never leaves the server. Output is validated with Zod before use.
 */
export async function completeStructured<T>(
  cfg: LlmConfig,
  args: { system: string; user: string; schemaName: string; jsonSchema: Record<string, unknown>; zod: z.ZodType<T> },
): Promise<StructuredResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: args.schemaName, schema: args.jsonSchema } },
      }),
    });
    if (res.status === 429) return { ok: false, kind: "rate_limit", error: "LLM rate limit reached" };
    if (!res.ok) return { ok: false, kind: "http", error: `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, kind: "invalid_json", error: "LLM returned non-JSON output" };
    }
    const validated = args.zod.safeParse(parsed);
    if (!validated.success) return { ok: false, kind: "schema", error: `LLM output failed validation: ${validated.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}` };
    return { ok: true, value: validated.data, raw };
  } catch (e) {
    if ((e as Error).name === "AbortError") return { ok: false, kind: "timeout", error: "LLM request timed out" };
    return { ok: false, kind: "network", error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
