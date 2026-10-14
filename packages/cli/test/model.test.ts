import { describe, it, expect } from "vitest";
import { createModel } from "../src/model.ts";
import { parseDefinition } from "../src/definition.ts";

const def = (provider: string, base_url?: string) => parseDefinition(JSON.stringify({ name: "a", provider, model: "m1", base_url }));
const cfg = (m: unknown) => (m as { config: { baseURL?: string } }).config;

describe("model", () => {
  it("openai", () => {
    const m = createModel(def("openai", "http://x"), "k") as { modelId: string; provider: string };
    expect(m.modelId).toBe("m1");
    expect(m.provider).toMatch(/^openai/);
    expect(cfg(m).baseURL).toBe("http://x");
  });
  it("anthropic", () => {
    const m = createModel(def("anthropic", "http://y"), "k") as { modelId: string; provider: string };
    expect(m.modelId).toBe("m1");
    expect(m.provider).toMatch(/^anthropic/);
    expect(cfg(m).baseURL).toBe("http://y");
  });
  it("ollama", () => {
    const m = createModel(def("ollama"), undefined) as { modelId: string; provider: string };
    expect(m.modelId).toBe("m1");
    expect(m.provider).toMatch(/^ollama/);
  });
});
