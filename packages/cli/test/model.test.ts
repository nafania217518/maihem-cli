import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamText, generateText, RetryError, APICallError } from "ai";
import { createModel, retry } from "../src/model.ts";
import { parseDefinition } from "../src/definition.ts";

import type { Kind, Resolved } from "../src/providers.ts";

const D = parseDefinition(JSON.stringify({ name: "a", provider: "p", model: "m1" }));
const prov = (kind: Kind, base_url?: string, more: Partial<Resolved> = {}): Resolved => ({ name: "p", kind, base_url, ...more });

describe("model", () => {
  it("openai and anthropic get base_url, key and headers from the provider", async () => {
    for (const kind of ["openai", "anthropic"] as const) {
      let seen: http.IncomingHttpHeaders = {};
      const server = http.createServer((req, res) => { seen = req.headers; res.writeHead(400, { "content-type": "application/json" }); res.end("{}"); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const m = createModel(D, prov(kind, url, { api_key: "k1", headers: { "X-T": "v" } }));
        expect(m).toMatchObject({ modelId: "m1", provider: expect.stringMatching(new RegExp(`^${kind}`)) });
        await streamText({ model: m, prompt: "x", maxRetries: 0, onError: () => {} }).consumeStream();
        expect(seen["x-t"]).toBe("v");
        expect(JSON.stringify(seen)).toContain("k1");
      } finally { server.close(); }
    }
  });
  it("openai uses the chat completions API", () => {
    expect((createModel(D, prov("openai", "http://x")) as { provider: string }).provider).toBe("openai.chat");
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
  describe("retries", () => {
    let waits: number[];
    beforeEach(() => { waits = []; vi.spyOn(retry, "sleep").mockImplementation(async (ms) => { waits.push(ms); }); });
    afterEach(() => vi.restoreAllMocks());
    type Reply = number | [number, Record<string, string>];
    const sse = (o: object) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m1", ...o })}\n\n`;
    const serve = async (replies: Reply[], onHit?: () => void) => {
      let hits = 0;
      const server = http.createServer((_req, res) => {
        const r = replies[Math.min(hits++, replies.length - 1)];
        onHit?.();
        const [status, headers] = typeof r === "number" ? [r, {}] : r;
        if (r === 200) { // [200, headers] answers a malformed 2xx body
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
          return;
        }
        res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ error: "nope" }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, close: () => server.close() };
    };
    const fail = async (url: string, kind: Kind = "openai", abortSignal?: AbortSignal) => {
      let err: unknown;
      const r = streamText({ model: createModel(D, prov(kind, url, { api_key: "k" })), prompt: "x", maxRetries: 0, abortSignal, onError: ({ error }) => { err = error; } });
      await r.consumeStream();
      return err;
    };
    it("a 429 is retried 5 times with growing jittered delays, then fails with the status", async () => {
      for (const v of [0, 1, 0.5, 0, 1]) vi.spyOn(retry, "random").mockReturnValueOnce(v);
      const s = await serve([429]);
      try {
        const e = await fail(s.url);
        expect(s.hits()).toBe(6);
        expect(waits).toEqual([5000, 20000, 30000, 40000, 160000]);
        expect(RetryError.isInstance(e)).toBe(true);
        expect((e as Error).message).toMatch(/^Failed after 6 attempts\. Last error: /);
        expect((e as RetryError).reason).toBe("maxRetriesExceeded");
        expect((e as RetryError).errors).toHaveLength(6);
        expect(((e as RetryError).lastError as APICallError).statusCode).toBe(429);
      } finally { s.close(); }
    });
    it("a 5xx and a connection failure are retried; another 4xx is not", async () => {
      const s5 = await serve([500]);
      try { await fail(s5.url); expect(s5.hits()).toBe(6); } finally { s5.close(); }
      const s4 = await serve([400]);
      try { const e = await fail(s4.url); expect(s4.hits()).toBe(1); expect(RetryError.isInstance(e)).toBe(false); } finally { s4.close(); }
      const gone = await serve([500]);
      gone.close();
      const e = await fail(gone.url);
      expect(RetryError.isInstance(e)).toBe(true);
      expect((e as RetryError).errors).toHaveLength(6);
    });
    it("a malformed provider response (status 200, 'Failed to process successful response') is retried", async () => {
      const s = await serve([[200, {}]]);
      try {
        const e = await generateText({ model: createModel(D, prov("openai", s.url, { api_key: "k" })), prompt: "x", maxRetries: 0 }).catch((x: unknown) => x);
        expect(s.hits()).toBe(6);
        expect(((e as RetryError).lastError as APICallError).statusCode).toBe(200); // a body the provider cannot parse
      } finally { s.close(); }
    });
    it("Retry-After sets the minimum delay", async () => {
      vi.spyOn(retry, "random").mockReturnValue(0);
      const s = await serve([[429, { "retry-after": "7" }], [429, { "retry-after-ms": "15000" }], 400]);
      try { await fail(s.url); expect(waits).toEqual([7000, 15000]); } finally { s.close(); }
    });
    it("abort stops the retry wait at once", async () => {
      vi.mocked(retry.sleep).mockRestore();
      const real = retry.sleep;
      let waiting!: Promise<unknown>;
      vi.spyOn(retry, "sleep").mockImplementation((ms, signal) => (waiting = real(ms, signal)));
      const ac = new AbortController();
      const s = await serve([429], () => setTimeout(() => ac.abort(), 20));
      try {
        await fail(s.url, "openai", ac.signal);
        const settled = await Promise.race([waiting.then(() => "slept", () => "stopped"), new Promise((r) => setTimeout(() => r("waiting"), 300))]);
        expect(settled).toBe("stopped");
        expect(s.hits()).toBe(1);
      } finally { s.close(); }
    });
    it("a success after retries returns the stream", async () => {
      const s = await serve([429, 503, 200]);
      try {
        const r = streamText({ model: createModel(D, prov("openai", s.url, { api_key: "k" })), prompt: "x", maxRetries: 0 });
        expect(await r.text).toBe("hi");
        expect(s.hits()).toBe(3);
      } finally { s.close(); }
    });
    it("generateText gets the same retries", async () => {
      const s = await serve([429]);
      try {
        const e = await generateText({ model: createModel(D, prov("openai", s.url, { api_key: "k" })), prompt: "x", maxRetries: 0 }).catch((x: unknown) => x);
        expect(RetryError.isInstance(e)).toBe(true);
        expect(s.hits()).toBe(6);
      } finally { s.close(); }
    });
    it("ollama start errors with status 500 are retried 5 times", async () => {
      const s = await serve([500]);
      try { await fail(s.url, "ollama"); expect(s.hits()).toBe(6); } finally { s.close(); }
    });
    it("ollama gives up after 6 attempts with a RetryError", async () => {
      const s = await serve([500]);
      try {
        const e = await fail(s.url, "ollama");
        expect(RetryError.isInstance(e)).toBe(true);
        expect((e as Error).message).toMatch(/^Failed after 6 attempts\. Last error: /);
        expect((e as RetryError).errors).toHaveLength(6);
      } finally { s.close(); }
    });
    it("ollama 404 is not retried", async () => {
      const s = await serve([404]);
      try { const e = await fail(s.url, "ollama"); expect(s.hits()).toBe(1); expect(RetryError.isInstance(e)).toBe(false); } finally { s.close(); }
    });
    it("ollama connection refused is retried", async () => {
      const s = await serve([500]);
      s.close();
      const e = await fail(s.url, "ollama");
      expect(RetryError.isInstance(e)).toBe(true);
      expect((e as RetryError).errors).toHaveLength(6);
    });
  });
});
