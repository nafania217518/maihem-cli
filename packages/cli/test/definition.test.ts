import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDefinition, loadDefinition, definitionFromFlags, applyOverrides, resolveKey, maskKey, mask, TOOLS } from "../src/definition.ts";

const base = { name: "a", provider: "openai", model: "gpt" } as const;

describe("definition", () => {
  it("loads yaml", () => {
    const d = parseDefinition("name: a\nprovider: openai\nmodel: gpt\nsystem: hi\n");
    expect(d.name).toBe("a");
    expect(d.system).toBe("hi");
  });
  it("loads json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    const f = path.join(dir, "d.json");
    fs.writeFileSync(f, JSON.stringify({ ...base, tools: ["read"] }));
    expect(loadDefinition(f).tools).toEqual(["read"]);
  });
  it("applies defaults", () => {
    const d = parseDefinition(JSON.stringify(base));
    expect(d.tools).toEqual([...TOOLS]);
    expect(d.sandbox).toBe(true);
    expect(d.max_steps).toBe(50);
  });
  it("rejects unknown provider", () => {
    expect(() => parseDefinition(JSON.stringify({ ...base, provider: "x" }))).toThrow(/provider/);
  });
  it("rejects unknown tool", () => {
    expect(() => parseDefinition(JSON.stringify({ ...base, tools: ["nope"] }))).toThrow(/tool/);
  });
  it("rejects missing model", () => {
    expect(() => parseDefinition("name: a\nprovider: openai\n")).toThrow(/model/);
  });
  it("rejects bad max_steps", () => {
    expect(() => parseDefinition(JSON.stringify({ ...base, max_steps: 0 }))).toThrow(/max_steps/);
    expect(() => parseDefinition("just a string")).toThrow();
  });
  it("inline form builds a definition from flags", () => {
    const d = definitionFromFlags({ provider: "ollama", model: "llama", tools: "read, exec", system: "s", base_url: "http://x" });
    expect(d).toMatchObject({ name: "inline", provider: "ollama", model: "llama", tools: ["read", "exec"], system: "s", base_url: "http://x", sandbox: true });
    expect(() => definitionFromFlags({ provider: "ollama" })).toThrow(/model/);
  });
  it("applyOverrides changes sandbox/workdir/tools without mutating input", () => {
    const d = parseDefinition(JSON.stringify(base));
    const o = applyOverrides(d, { sandbox: false, workdir: "/w", tools: "read" });
    expect(o).toMatchObject({ sandbox: false, workdir: "/w", tools: ["read"] });
    expect(d.sandbox).toBe(true);
    expect(d.tools.length).toBe(5);
    expect(applyOverrides(d, {})).toEqual(d);
  });
  it("key precedence flag > definition > env", () => {
    const d = parseDefinition(JSON.stringify({ ...base, api_key: "def" }));
    expect(resolveKey(d, "flag", { OPENAI_API_KEY: "env" })).toBe("flag");
    expect(resolveKey(d, undefined, { OPENAI_API_KEY: "env" })).toBe("def");
    expect(resolveKey(parseDefinition(JSON.stringify(base)), undefined, { OPENAI_API_KEY: "env" })).toBe("env");
    expect(resolveKey({ ...d, provider: "anthropic", api_key: undefined }, undefined, { ANTHROPIC_API_KEY: "a" })).toBe("a");
  });
  it("ollama needs no key", () => {
    expect(resolveKey(definitionFromFlags({ provider: "ollama", model: "m" }), undefined, {})).toBeUndefined();
  });
  it("missing key error names all three sources", () => {
    const d = parseDefinition(JSON.stringify(base));
    expect(() => resolveKey(d, undefined, {})).toThrow(/--api-key.*api_key.*OPENAI_API_KEY/s);
  });
  it("maskKey hides all but last 4 chars", () => {
    expect(maskKey("sk-abcdef")).toBe("****cdef");
    expect(maskKey("ab")).toBe("****");
  });
  it("mask does not change a definition without api_key", () => {
    const d = parseDefinition(JSON.stringify(base));
    expect(mask(d)).toEqual(d);
    expect(mask({ ...d, api_key: "sk-abcdef" }).api_key).toBe("****cdef");
  });

  const pd = (extra: object) => parseDefinition(JSON.stringify({ ...base, ...extra }));

  it("reasoning accepts only the neutral levels", () => {
    expect(() => pd({ reasoning: "turbo" })).toThrow(/reasoning/);
    expect(pd({ reasoning: "high" }).reasoning).toBe("high");
    expect(pd({}).reasoning).toBeUndefined();
  });

  it("context must be a positive integer", () => {
    for (const v of [0, -1, 1.5, "8k"]) expect(() => pd({ context: v })).toThrow(/context/);
    expect(pd({ context: 64000 }).context).toBe(64000);
    expect(pd({}).context).toBeUndefined();
  });

  it("on_context_full defaults to compact", () => {
    expect(pd({}).on_context_full).toBe("compact");
    expect(pd({ on_context_full: "fail" }).on_context_full).toBe("fail");
    expect(() => pd({ on_context_full: "drop" })).toThrow(/on_context_full/);
  });

  it("compact_at defaults to 0.8 and must be in (0,1]", () => {
    expect(pd({}).compact_at).toBe(0.8);
    for (const v of [0, 1.2, "x"]) expect(() => pd({ compact_at: v })).toThrow(/compact_at/);
    expect(pd({ compact_at: 1 }).compact_at).toBe(1);
    expect(pd({ compact_at: 0.5 }).compact_at).toBe(0.5);
  });
});
