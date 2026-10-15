import { describe, it, expect } from "vitest";
import { parseDefinition, applyOverrides, maskKey, TOOLS } from "../src/definition.ts";

const base = { name: "a", provider: "openai", model: "gpt" } as const;

describe("definition", () => {
  it("loads yaml", () => {
    const d = parseDefinition("name: a\nprovider: openai\nmodel: gpt\nsystem: hi\n");
    expect(d.name).toBe("a");
    expect(d.system).toBe("hi");
  });
  it("loads json", () => {
    expect(parseDefinition(JSON.stringify({ ...base, tools: ["read"] })).tools).toEqual(["read"]);
  });
  it("applies defaults", () => {
    const d = parseDefinition(JSON.stringify(base));
    expect(d.tools).toEqual([...TOOLS]);
    expect(d.sandbox).toBe(true);
    expect(d.max_steps).toBe(50);
  });
  it("provider is a name, not a kind", () => {
    expect(parseDefinition(JSON.stringify({ ...base, provider: "my-local" })).provider).toBe("my-local");
  });
  it("base_url in a definition fails with a hint", () => {
    expect(() => parseDefinition(JSON.stringify({ ...base, base_url: "http://x" }))).toThrow('definition: "base_url" moved to providers: maihem provider add|update NAME --base-url URL');
  });
  it("api_key in a definition fails with a hint", () => {
    expect(() => parseDefinition(JSON.stringify({ ...base, api_key: "k" }))).toThrow('definition: "api_key" moved to providers: maihem provider add|update NAME --api-key KEY | --api-key \'$VAR\'');
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
  it("applyOverrides changes sandbox/workdir/max_steps without mutating input", () => {
    const d = parseDefinition(JSON.stringify(base));
    expect(applyOverrides(d, { sandbox: false, workdir: "/w", max_steps: 3 })).toMatchObject({ sandbox: false, workdir: "/w", max_steps: 3 });
    expect(d).toMatchObject({ sandbox: true, max_steps: 50 });
    expect(applyOverrides(d, {})).toEqual(d);
    expect(() => applyOverrides(d, { max_steps: 0 })).toThrow("definition: max_steps must be a positive integer");
  });
  it("maskKey hides all but last 4 chars", () => {
    expect(maskKey("sk-abcdef")).toBe("****cdef");
    expect(maskKey("ab")).toBe("****");
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
