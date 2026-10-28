export const pad = (rows: string[][]): string[] => {
  const w = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
};
