// A count of tokens: a positive integer, or the short form "10k", "1.5M" (case-insensitive). field names it in the error.
export function parseCount(v: unknown, field: string): number {
  const m = typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)([km]?)\s*$/i.exec(v) : null;
  const n = typeof v === "number" ? v : m ? Number(m[1]) * { "": 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as "" | "k" | "m"] : NaN;
  // ponytail: float scaling; "1.0000001M"-style inputs near an integer may round wrong, fine for config values
  const r = Math.round(n * 1e6) / 1e6;
  if (!Number.isInteger(r) || r < 1) throw new Error(`${field} must be a positive integer`);
  return r;
}
