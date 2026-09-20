export type Money = { cents: number; currency: string };

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "Unknown";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const formatted = dollars.toLocaleString("en-US");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return rem === 0 ? `${sign}${symbol}${formatted}` : `${sign}${symbol}${formatted}.${String(rem).padStart(2, "0")}`;
}

export function formatDelta(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "Unknown";
  if (cents === 0) return "No change";
  return `${cents > 0 ? "+" : "−"}${formatCents(Math.abs(cents), currency)}`;
}

export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "").toLowerCase();
  const m = cleaned.match(/^(\d+(?:\.\d{1,2})?)(k)?$/);
  if (!m) return null;
  let value = Number(m[1]);
  if (m[2] === "k") value *= 1000;
  return Math.round(value * 100);
}

export function multiplyCents(unitCents: number, quantity: number): number {
  return unitCents * quantity;
}
