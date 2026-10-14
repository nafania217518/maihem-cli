import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamText } from "ai";
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
  it("aborting an ollama stream closes the HTTP request", async () => {
    let closed!: () => void;
    const closedP = new Promise<void>((r) => (closed = r));
    const server = http.createServer((req, res) => {
      req.socket.on("close", () => closed());
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const chunk = JSON.stringify({ model: "m", created_at: "2026-01-01T00:00:00Z", message: { role: "assistant", content: "hi" }, done: false }) + "\n";
      const t = setInterval(() => res.write(chunk), 50);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ac = new AbortController();
      const r = streamText({ model: createModel(def("ollama", url), undefined), prompt: "x", abortSignal: ac.signal, onError: () => {} });
      for await (const _ of r.textStream) break;
      ac.abort();
      const ok = await Promise.race([closedP.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
      expect(ok).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
