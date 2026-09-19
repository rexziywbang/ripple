import { customAlphabet } from "nanoid";
import { createHash } from "node:crypto";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 14);

export function newId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function hashContent(input: unknown): string {
  return createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex").slice(0, 32);
}

export function now(): number {
  return Date.now();
}
