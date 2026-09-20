import { defineConfig } from "vitest/config";
import path from "node:path";
const __dirname = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
  resolve: { alias: { "@": path.resolve(__dirname) } },
});
