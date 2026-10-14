import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { serveAgent } from "../src/daemon.ts";
import { encode, lineSplitter } from "../src/protocol.ts";
import type { AgentEvent } from "../src/protocol.ts";
import { runFile } from "../src/run.ts";
import { loadState, logPath, saveState } from "../src/state.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
const steps = () => [
  stream([{ type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: "out.txt", content: "data" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
  stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "answer" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
];
const w = vi.hoisted(() => ({ ensureWorker: vi.fn(async () => "http://w"), createSandboxBackend: vi.fn(), copyIn: vi.fn(async () => 1), copyOut: vi.fn(async () => 1) }));
vi.mock("../src/worker.ts", () => ({ ensureWorker: w.ensureWorker }));
vi.mock("../src/backend-sandbox.ts", () => ({ createSandboxBackend: w.createSandboxBackend }));
vi.mock("../src/sync.ts", () => ({ copyIn: w.copyIn, copyOut: w.copyOut }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(sock: string): { events: AgentEvent[]; send(text: string): void; wait(type: string, n?: number): Promise<void>; end(): void } {
  const events: AgentEvent[] = [];
  const c = net.connect(sock);
  c.on("data", lineSplitter((o) => events.push(o as AgentEvent)));
  return {
    events,
    send: (text) => c.write(encode({ type: "msg", text })),
    async wait(type, n = 1) { for (let i = 0; i < 100 && events.filter((e) => e.type === type).length < n; i++) await sleep(20); },
    end: () => c.end(),
  };
}

describe("daemon", () => {
  let work: string;
  let id: string;
  let out: string;
  let handle: Awaited<ReturnType<typeof serveAgent>> | undefined;
  const sock = () => path.join(os.tmpdir(), `maihem-test-${id}.sock`);
  const setup = (over: { task?: string; sandbox?: boolean } = {}) => {
    const def = { name: "bot", provider: "openai", model: "m", tools: ["read", "write", "edit", "list", "exec"], sandbox: over.sandbox ?? false, workdir: work, max_steps: 5 };
    saveState({ id, name: "bot", pid: 0, status: "running", workdir: work, sandbox: def.sandbox, started: "2026-01-01T00:00:00.000Z", log: logPath(id), sock: sock() });
    fs.writeFileSync(runFile(id), JSON.stringify({ def, task: over.task, apiKey: "k" }));
  };
  beforeEach(() => {
    process.env.MAIHEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    id = "abc123";
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out += s; return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.clearAllMocks();
  });
  afterEach(async () => { await handle?.shutdown(); handle = undefined; vi.restoreAllMocks(); });

  it("client gets hello and a msg yields events in order, file written", async () => {
    setup();
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(handle.sock);
    await c.wait("hello");
    expect(c.events[0]).toMatchObject({ type: "hello", name: "bot", model: "m", sandbox: false, id, history: [] });
    c.send("do it");
    await c.wait("done");
    expect(c.events.slice(1).map((e) => e.type)).toEqual(["user", "tool", "tool-result", "text", "done"]);
    expect(fs.readFileSync(path.join(work, "out.txt"), "utf8")).toBe("data");
    expect(out).toContain("answer");
    const c2 = client(handle.sock);
    await c2.wait("hello");
    expect((c2.events[0] as { history: AgentEvent[] }).history.map((e) => e.type)).toEqual(["user", "tool", "tool-result", "text", "done"]);
    c.end(); c2.end();
  });
  it("msg while busy gets a busy error", async () => {
    setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: async () => { await gate; return steps()[1]; } }) });
    const c = client(handle.sock);
    await c.wait("hello");
    c.send("one");
    await c.wait("user");
    c.send("two");
    await c.wait("error");
    expect(c.events.at(-1)).toEqual({ type: "error", message: "busy: a turn is in progress" });
    release();
    await c.wait("done");
    c.send("three");
    await c.wait("done", 2);
    c.end();
  });
  it("initial task runs without a client and logs", async () => {
    setup({ task: "go" });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    await sleep(200);
    expect(out).toContain("answer");
    expect(fs.readFileSync(path.join(work, "out.txt"), "utf8")).toBe("data");
  });
  it("agent error is swallowed and broadcast", async () => {
    setup();
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } }) });
    const c = client(handle.sock);
    await c.wait("hello");
    c.send("x");
    await c.wait("error");
    expect(c.events.at(-1)).toEqual({ type: "error", message: "boom" });
    c.end();
  });
  it("shutdown marks exited, removes sock and run.json, resolves done", async () => {
    setup();
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(h.sock);
    await c.wait("hello");
    await h.shutdown();
    await h.done;
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(fs.existsSync(h.sock)).toBe(false);
    expect(fs.existsSync(runFile(id))).toBe(false);
  });
  it("sandbox branch calls copyIn and copyOut", async () => {
    setup({ sandbox: true });
    const backend = { root: "/workspace", readFile: vi.fn(), writeFile: vi.fn(async () => {}), exec: vi.fn() };
    w.createSandboxBackend.mockReturnValue(backend);
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    expect(w.createSandboxBackend).toHaveBeenCalledWith("http://w", id);
    expect(w.copyIn).toHaveBeenCalledWith(work, backend);
    await h.shutdown();
    expect(w.copyOut).toHaveBeenCalledWith(backend, work);
  });
  it("SIGTERM triggers shutdown", async () => {
    setup();
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    process.emit("SIGTERM");
    await h.done;
    expect(fs.existsSync(h.sock)).toBe(false);
  });

  it("rejects instead of crashing when the socket cannot be opened", async () => {
    setup();
    const bad = { ...loadState(id), sock: "/nonexistent-dir/" + "y".repeat(120) + ".sock" };
    saveState(bad);
    await expect(serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) })).rejects.toThrow();
  });
});
