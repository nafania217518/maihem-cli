import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamText, RetryError } from "ai";
import { createModel, retryDelays } from "../src/model.ts";
import { parseDefinition } from "../src/definition.ts";

import type { Kind, Resolved } from "../src/providers.ts";

const D = parseDefinition(JSON.stringify({ name: "a", provider: "p", model: "m1" }));
const prov = (kind: Kind, base_url?: string, more: Partial<Resolved> = {}): Resolved => ({ name: "p", kind, base_url, ...more });
const cfg = (m: unknown) => (m as { config: { baseURL?: string; headers: () => Record<string, string> } }).config;

describe("model", () => {
  it("openai and anthropic get base_url, key and headers from the provider", () => {
    for (const kind of ["openai", "anthropic"] as const) {
      const m = createModel(D, prov(kind, "http://x", { api_key: "k1", headers: { "X-T": "v" } })) as { modelId: string; provider: string };
      expect(m.modelId).toBe("m1");
      expect(m.provider).toMatch(new RegExp(`^${kind}`));
      expect(cfg(m).baseURL).toBe("http://x");
      const h = cfg(m).headers();
      expect(h["x-t"] ?? h["X-T"]).toBe("v");
      expect(JSON.stringify(h)).toContain("k1");
    }
  });
  it("ollama client gets host and headers", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => { seen = req.headers; res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "nope" })); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await streamText({ model: createModel(D, prov("ollama", url, { headers: { "X-T": "v" } })), prompt: "x", onError: () => {} }).consumeStream();
      expect(seen["x-t"]).toBe("v");
    } finally { server.close(); }
  });
  it("ollama", () => {
    const m = createModel(D, prov("ollama")) as { modelId: string; provider: string };
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
      const r = streamText({ model: createModel(D, prov("ollama", url)), prompt: "x", abortSignal: ac.signal, onError: () => {} });
      for await (const _ of r.textStream) break;
      ac.abort();
      const ok = await Promise.race([closedP.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
      expect(ok).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  describe("ollama retries", () => {
    retryDelays.splice(0, 2, 0, 0);
    const serve = async (status: number) => {
      let hits = 0;
      const server = http.createServer((_req, res) => { hits++; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "nope" })); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, close: () => server.close() };
    };
    const fail = async (url: string) => {
      let err: unknown;
      const r = streamText({ model: createModel(D, prov("ollama", url)), prompt: "x", onError: ({ error }) => { err = error; } });
      await r.consumeStream();
      return err;
    };
    it("ollama start errors with status 500 are retried twice", async () => {
      const s = await serve(500);
      try { await fail(s.url); expect(s.hits()).toBe(3); } finally { s.close(); }
    });
    it("ollama gives up after 3 attempts with a RetryError", async () => {
      const s = await serve(500);
      try {
        const e = await fail(s.url);
        expect(RetryError.isInstance(e)).toBe(true);
        expect((e as Error).message).toMatch(/^Failed after 3 attempts\. Last error: /);
        expect((e as RetryError).errors).toHaveLength(3);
      } finally { s.close(); }
    });
    it("ollama 404 is not retried", async () => {
      const s = await serve(404);
      try { const e = await fail(s.url); expect(s.hits()).toBe(1); expect(RetryError.isInstance(e)).toBe(false); } finally { s.close(); }
    });
    it("ollama connection refused is retried", async () => {
      const s = await serve(500);
      s.close();
      const e = await fail(s.url);
      expect(RetryError.isInstance(e)).toBe(true);
      expect((e as RetryError).errors).toHaveLength(3);
    });
  });
});
