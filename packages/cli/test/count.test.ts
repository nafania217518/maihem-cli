import { describe, it, expect } from "vitest";
import { parseCount } from "../src/count.ts";

describe("count", () => {
  it("token counts accept the short form, case-insensitive", () => {
    const ok: [unknown, number][] = [[5, 5], ["10k", 10_000], ["10K", 10_000], ["1.5M", 1_500_000], ["1.5m", 1_500_000], ["230000", 230_000], [" 2k ", 2000]];
    for (const [v, n] of ok) expect(parseCount(v, "f")).toBe(n);
    for (const v of [0, -1, 1.5, "0", "-2k", "1.2345k", "8x", "k", "", "1e3", true, null]) expect(() => parseCount(v, "limits.tokens")).toThrow("limits.tokens must be a positive integer");
  });
});
