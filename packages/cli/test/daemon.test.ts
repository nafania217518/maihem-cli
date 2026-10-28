import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { serveAgent } from "../src/daemon.ts";
import { encode, lineSplitter } from "../src/protocol.ts";
import type { AgentEvent } from "../src/protocol.ts";
import { openTracker } from "../src/org/tracker.ts";
import { saveOrg } from "../src/org/store.ts";
import { runFile } from "../src/run.ts";
import { loadState, logPath, saveState } from "../src/state.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
const steps = () => [
  stream([{ type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: "out.txt", content: "data" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
  stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "answer" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
];
const w = vi.hoisted(() => ({ ensureWorker: vi.fn(async () => "http://w"), createSandboxBackend: vi.fn(), copyIn: vi.fn(async () => ({ baseline: new Map(), excludes: [], files: 1, symlinks: 0 })), copyOut: vi.fn(async () => ({ written: [], conflicts: [] })) }));
vi.mock("../src/worker.ts", () => ({ ensureWorker: w.ensureWorker }));
vi.mock("../src/backend-sandbox.ts", () => ({ createSandboxBackend: w.createSandboxBackend }));
vi.mock("../src/sync.ts", () => ({ copyIn: w.copyIn, copyOut: w.copyOut }));
const fake = vi.hoisted(() => ({ agent: undefined as undefined | ((o: unknown) => unknown), opts: [] as unknown[] }));
vi.mock("../src/agent.ts", async (orig) => {
  const real = (await orig()) as { createAgent: (o: unknown) => unknown };
  return { ...real, createAgent: (o: unknown) => { fake.opts.push(o); return fake.agent ? fake.agent(o) : real.createAgent(o); } };
});
const stepLimitAgent = () => ({ history: [], interrupt: () => {}, run: async (_t: string, emit: (e: unknown) => void) => { emit({ type: "done", incomplete: "step limit", steps: 5 }); } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// an org with every role
const acme = (repo: string) => ({ name: "acme", repo, members: Object.fromEntries((["ba", "sa", "pm", "tl", "dev"] as const).map((r) => [r, { role: r, definition: "bot" }])), limits: { parallel: 1 } });

function client(sock: string): { events: AgentEvent[]; send(text: string): void; raw(m: object): void; wait(type: string, n?: number): Promise<void>; end(): void } {
  const events: AgentEvent[] = [];
  const c = net.connect(sock);
  c.on("data", lineSplitter((o) => events.push(o as AgentEvent)));
  return {
    events,
    send: (text) => c.write(encode({ type: "msg", text })),
    raw: (m) => c.write(encode(m)),
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
  const setup = (over: { task?: string; sandbox?: boolean; mode?: "run" | "chat" } = {}) => {
    const def = { name: "bot", provider: "p1", model: "m", tools: ["read", "write", "edit", "list", "exec"], sandbox: over.sandbox ?? false, workdir: work, max_steps: 5 };
    saveState({ id, name: "bot", pid: 0, status: "running", workdir: work, sandbox: def.sandbox, started: "2026-01-01T00:00:00.000Z", log: logPath(id), sock: sock() });
    fs.writeFileSync(runFile(id), JSON.stringify({ def, task: over.task, provider: { name: "p1", kind: "openai", base_url: "http://snap", api_key: "k" }, mode: over.mode ?? "chat" }));
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
  afterEach(async () => { await handle?.shutdown(); handle = undefined; fake.agent = undefined; vi.restoreAllMocks(); });

  it("an org session logs session.started and session.ended with input and output tokens on its ticket", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    saveOrg(acme(work));
    const model = new MockLanguageModelV4({ doStream: [
      stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
    ] });
    handle = await serveAgent(id, { model });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    const ev = t.events().filter((e) => e.kind.startsWith("session."));
    expect(ev.map((e) => e.kind)).toEqual(["session.started", "session.ended"]);
    expect(ev[0]).toMatchObject({ actor: "ba", ticket: "T-1", data: { member: "ba", id } });
    expect(ev[1]).toMatchObject({ actor: "ba", ticket: "T-1", data: { member: "ba", id, tokens: 4, input: 3, output: 1 } });
    t.close();
  });
  it("session.ended carries the last text", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    const long = "y".repeat(600);
    const model = new MockLanguageModelV4({ doStream: [
      stream([{ type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "first" }, { type: "text-end", id: "a" },
        { type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: "out.txt", content: "data" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
      stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "last " }, { type: "text-delta", id: "t", delta: long }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
    ] });
    handle = await serveAgent(id, { model });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    expect(t.events().find((e) => e.kind === "session.ended")!.data.text).toBe(`last ${long}`.slice(0, 500));
    t.close();
  });

  it("an org session that throws logs session.failed with the error on its ticket", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } }) });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.failed"); i++) await sleep(20);
    const ev = t.events().filter((e) => e.kind.startsWith("session."));
    expect(ev.map((e) => e.kind)).toEqual(["session.started", "session.failed"]);
    expect(ev[1]).toMatchObject({ actor: "ba", ticket: "T-1", data: { member: "ba", id, error: "boom" } });
    t.close();
  });
  it("an org session that ends with no output tokens and no tool call logs session.failed, not session.ended", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    const empty = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [stream([{ type: "finish", finishReason: { unified: "stop", raw: "" }, usage: empty }])] }) });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.failed" || e.kind === "session.ended"); i++) await sleep(20);
    const ev = t.events().filter((e) => e.kind.startsWith("session."));
    expect(ev.map((e) => e.kind)).toEqual(["session.started", "session.failed"]);
    expect(ev[1]).toMatchObject({ actor: "ba", ticket: "T-1", data: { member: "ba", id, error: "empty answer: no output and no tool call" } });
    t.close();
    await handle.shutdown();
    expect(loadState(id).exitCode).toBe(1);
  });
  it("an org session whose stream is cut logs session.failed with a stream cut error", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "half" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "other", raw: "" }, usage }])] }) });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.failed" || e.kind === "session.ended"); i++) await sleep(20);
    const ev = t.events().filter((e) => e.kind.startsWith("session."));
    expect(ev.map((e) => e.kind)).toEqual(["session.started", "session.failed"]);
    expect(ev[1]).toMatchObject({ data: { error: "stream cut: the provider stream ended without a finish reason" } });
    t.close();
    await handle.shutdown();
    expect(loadState(id).exitCode).toBe(1);
  });
  it("an invalid tool input logs the full validation error", async () => {
    setup({ task: "go" });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [
      stream([{ type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: 5 }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
      steps()[1]] }) });
    for (let i = 0; i < 100 && !err.mock.calls.some((c) => String(c[0]).includes("tokens:")); i++) await sleep(20);
    const log = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(log).toContain("Invalid input for tool write");
    expect(log).toContain('{"path":5}');
    expect(log).toMatch(/path[\s\S]*expected string/i);
  });
  // a git repo in the workdir: main has one commit; branch t-1-a adds a.txt
  const gitRepo = () => {
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", ...a], { cwd: work });
    g("init", "-q", "-b", "main"); g("commit", "-q", "--allow-empty", "-m", "init"); g("checkout", "-q", "-b", "t-1-a");
    fs.writeFileSync(path.join(work, "a.txt"), "hi\n"); g("add", "-A"); g("commit", "-qm", "a"); g("checkout", "-q", "main");
    return g;
  };
  const orgSession = (member: string, kind: string) => {
    setup({ task: "go" });
    const db = path.join(process.env.MAIHEM_HOME!, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member, db, kind, ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    return openTracker(db);
  };
  it("an org session's review_diff shows the diff of the ticket branch against main", async () => {
    gitRepo();
    const t = orgSession("tl", "review");
    t.createTicket({ title: "a", status: "in_review", assignee: "dev" }, "org"); t.setApproval("T-1", "tl", "pending", "org"); t.setBranch("T-1", "t-1-a", "org");
    const model = new MockLanguageModelV4({ doStream: [
      stream([{ type: "tool-call", toolCallId: "c1", toolName: "review_diff", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
      stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
    ] });
    handle = await serveAgent(id, { model });
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("+hi");
    t.close();
  });
  it("a stop tool in a session without write tools sees the dirty-worktree guard", async () => {
    gitRepo();
    fs.writeFileSync(path.join(work, ".gitignore"), "keep.log\n");
    fs.writeFileSync(path.join(work, "keep.log"), "k");
    const t = orgSession("tl", "review");
    t.createTicket({ title: "a", status: "in_review", assignee: "dev" }, "org"); t.setApproval("T-1", "tl", "pending", "org"); t.setBranch("T-1", "t-1-a", "org");
    fs.writeFileSync(path.join(work, "junk.txt"), "j");
    const approve = stream([{ type: "tool-call", toolCallId: "c1", toolName: "approve", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]);
    const model = new MockLanguageModelV4({ doStream: [approve, { ...approve, stream: simulateReadableStream({ chunks: [{ type: "tool-call", toolCallId: "c2", toolName: "approve", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }] }) }] });
    handle = await serveAgent(id, { model });
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("your worktree has changes (.gitignore, junk.txt)");
    expect(fs.existsSync(path.join(work, "junk.txt"))).toBe(false);
    expect(fs.existsSync(path.join(work, "keep.log"))).toBe(true);
    expect(t.getTicket("T-1").approvals).toMatchObject([{ reviewer: "tl", state: "approved" }]);
    t.close();
  });
  // a submit_review session of `member` on T-1 (reviewer `reviewer`) after writing docs/<file>: the ticket status and the
  // model's prompts (a refused submit does not end the turn)
  const submitWith = async (member: string, reviewer: string, file: string, text: string, emptyDir?: string) => {
    const g = gitRepo();
    g("checkout", "-q", "t-1-a");
    fs.mkdirSync(path.join(work, "docs"));
    if (emptyDir) fs.mkdirSync(path.join(work, emptyDir));
    fs.writeFileSync(path.join(work, "docs", file), text);
    const t = orgSession(member, "work");
    t.createTicket({ title: "a", status: "in_progress", assignee: member }, "org"); t.setApproval("T-1", reviewer, "pending", "org");
    const model = new MockLanguageModelV4({ doStream: [
      stream([{ type: "tool-call", toolCallId: "c1", toolName: "submit_review", input: JSON.stringify({ summary: "did it" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
      stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "late" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
    ] });
    handle = await serveAgent(id, { model });
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    expect(String(g("status", "--porcelain")).trim()).toBe("?? docs/"); // no branch on the ticket: no commit, no merge
    const status = t.getTicket("T-1").status;
    t.close();
    return { status, prompts: model.doStreamCalls.map((c) => JSON.stringify(c.prompt)) };
  };
  it("an org session ends its turn after a stop tool", async () => {
    const r = await submitWith("ba", "sa", "business-summary.txt", "x".repeat(4000));
    expect(r.status).toBe("in_review");
    expect(r.prompts).toHaveLength(1);
  });
  it("submit_review passes the changed files", async () => {
    const r = await submitWith("dev", "tl", "business-requirements.md", "# BR\n");
    expect(r.status).toBe("in_progress");
    expect(r.prompts[1]).toContain("docs/business-requirements.md belongs to BA");
  });
  it("submit_review passes the size of each changed file", async () => {
    const r = await submitWith("ba", "sa", "business-summary.txt", "x".repeat(4001));
    expect(r.status).toBe("in_progress");
    expect(r.prompts[1]).toContain("docs/business-summary.txt has 4001 characters; the cap is 4000");
  });
  it("submit_review checks the workdir for empty directories", async () => {
    const r = await submitWith("dev", "tl", "notes.md", "n\n", "tests");
    expect(r.status).toBe("in_progress");
    expect(r.prompts[1]).toContain("tests/ is empty, and git does not store empty directories");
  });
  it("a work session's submit_review commits the work and merges main into the branch first", async () => {
    const g = gitRepo();
    fs.writeFileSync(path.join(work, "b.txt"), "main\n"); g("add", "-A"); g("commit", "-qm", "b on main");
    g("checkout", "-q", "t-1-a");
    fs.writeFileSync(path.join(work, "c.txt"), "work\n");
    const t = orgSession("dev", "work");
    t.createTicket({ title: "a", status: "in_progress", assignee: "dev" }, "org"); t.setApproval("T-1", "tl", "pending", "org"); t.setBranch("T-1", "t-1-a", "org");
    const model = new MockLanguageModelV4({ doStream: [
      stream([{ type: "tool-call", toolCallId: "c1", toolName: "submit_review", input: JSON.stringify({ summary: "did it" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
    ] });
    handle = await serveAgent(id, { model });
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    expect(t.getTicket("T-1").status).toBe("in_review");
    expect(fs.readFileSync(path.join(work, "b.txt"), "utf8")).toBe("main\n");
    expect(String(g("status", "--porcelain"))).toBe("");
    expect(String(g("log", "--format=%an %s", "-2", "--first-parent")).trim()).toMatch(/^maihem Merge branch 'main' into t-1-a\ndev dev: T-1 a$/);
    t.close();
  });
  it("client gets hello and a msg yields events in order, file written", async () => {
    setup();
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(handle.sock);
    await c.wait("hello");
    expect(c.events[0]).toMatchObject({ type: "hello", name: "bot", model: "m", sandbox: false, id, history: [] });
    c.send("do it");
    await c.wait("done");
    expect(c.events.slice(1).map((e) => e.type)).toEqual(["user", "step", "tool", "tool-result", "context", "step", "text", "context", "done"]);
    expect(fs.readFileSync(path.join(work, "out.txt"), "utf8")).toBe("data");
    expect(out).toContain("answer");
    const c2 = client(handle.sock);
    await c2.wait("hello");
    expect((c2.events[0] as { history: AgentEvent[] }).history.map((e) => e.type)).toEqual(["user", "step", "tool", "tool-result", "context", "step", "text", "context", "done"]);
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
    expect(c.events.at(-1)).toMatchObject({ type: "error", message: "boom" });
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
    expect(w.copyIn).toHaveBeenCalledWith(work, backend, undefined);
    await h.shutdown();
    expect(w.copyOut).toHaveBeenCalledWith(backend, work, expect.objectContaining({ files: 1 }));
  });
  it("SIGTERM triggers shutdown", async () => {
    setup();
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    process.emit("SIGTERM");
    await h.done;
    expect(fs.existsSync(h.sock)).toBe(false);
  });

  const sandboxed = () => { setup({ sandbox: true }); w.createSandboxBackend.mockReturnValue({ root: "/workspace", writeFile: vi.fn(async () => {}) }); };
  it("hello reports readonly and workdir", async () => {
    setup({ mode: "run" });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(handle.sock);
    await c.wait("hello");
    expect(c.events[0]).toMatchObject({ readonly: true, workdir: work });
    c.end(); await handle.shutdown();
    setup({ mode: "chat" });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c2 = client(handle.sock);
    await c2.wait("hello");
    expect(c2.events[0]).toMatchObject({ readonly: false, workdir: work });
    c2.end();
  });
  it("stop message with apply copies out", async () => {
    sandboxed();
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(h.sock);
    await c.wait("hello");
    c.raw({ type: "stop", apply: true });
    await h.done;
    expect(w.copyOut).toHaveBeenCalledTimes(1);
    expect(loadState(id).status).toBe("exited");
  });
  it("stop message without apply skips copy-out", async () => {
    sandboxed();
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(h.sock);
    await c.wait("hello");
    c.raw({ type: "stop", apply: false });
    await h.done;
    expect(w.copyOut).not.toHaveBeenCalled();
  });
  it("run mode rejects msg from clients", async () => {
    setup({ mode: "run" });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    const c = client(handle.sock);
    await c.wait("hello");
    c.send("hi");
    await c.wait("error");
    expect(c.events.at(-1)).toEqual({ type: "error", message: "read-only: this agent runs one task" });
    expect(c.events.some((e) => e.type === "user")).toBe(false);
    c.end();
  });
  it("run mode stops itself after the task and applies changes", async () => {
    sandboxed();
    fs.writeFileSync(runFile(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(runFile(id), "utf8")), task: "go", mode: "run" }));
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) });
    await h.done;
    expect(w.copyOut).toHaveBeenCalledTimes(1);
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 0 });
  });
  it("run mode exit code is 1 when the task fails", async () => {
    setup({ mode: "run", task: "go" });
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } }) });
    await h.done;
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 1 });
  });

  it("daemon uses the provider snapshot even after the provider is removed", async () => {
    setup();
    fake.agent = () => ({ history: [], interrupt: () => {}, run: async () => {} });
    handle = await serveAgent(id);
    const model = (fake.opts.at(-1) as { model: LanguageModelV4 }).model;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await Promise.resolve(model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }] })).catch(() => {});
    expect(String(fetch.mock.calls[0][0])).toMatch(/^http:\/\/snap\//);
    fetch.mockRestore();
    const c = client(handle.sock);
    await c.wait("hello");
    expect(c.events[0]).toMatchObject({ type: "hello", provider: "p1" });
    c.end();
  });
  it("rejects instead of crashing when the socket cannot be opened", async () => {
    setup();
    const bad = { ...loadState(id), sock: "/nonexistent-dir/" + "y".repeat(120) + ".sock" };
    saveState(bad);
    await expect(serveAgent(id, { model: new MockLanguageModelV4({ doStream: steps() }) })).rejects.toThrow();
  });
  const slow = () => ({ stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks: [{ type: "text-start", id: "t" }, ...Array.from({ length: 50 }, () => ({ type: "text-delta" as const, id: "t", delta: "z" })), { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }], chunkDelayInMs: 20 }) });
  it("interrupt message aborts the running turn", async () => {
    setup();
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [slow(), steps()[1]] }) });
    const c = client(handle.sock);
    await c.wait("hello");
    c.send("one");
    await c.wait("text");
    c.raw({ type: "interrupt" });
    await c.wait("done");
    expect(c.events.at(-1)).toMatchObject({ type: "done", interrupted: true });
    c.send("two");
    await c.wait("done", 2);
    expect(c.events.at(-1)).toMatchObject({ type: "done" });
    expect(c.events.some((e) => e.type === "error")).toBe(false);
    c.end();
  });
  it("interrupt on a read-only agent is rejected", async () => {
    setup({ mode: "run", task: "go" });
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [slow()] }) });
    const c = client(handle.sock);
    await c.wait("text");
    c.raw({ type: "interrupt" });
    await c.wait("error");
    expect(c.events.find((e) => e.type === "error")).toEqual({ type: "error", message: "read-only: this agent runs one task" });
    await c.wait("done");
    expect(c.events.find((e) => e.type === "done")).not.toHaveProperty("interrupted");
    c.end();
  });
  it("read-only step limit stores exit code 2 and the step limit detail", async () => {
    setup({ mode: "run", task: "go" });
    fake.agent = stepLimitAgent;
    const h = await serveAgent(id);
    await h.done;
    expect((fake.opts.at(-1) as { oneShot: boolean }).oneShot).toBe(true);
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 2, detail: "step limit" });
  });
  it("run -d with an empty final step exits 2 with detail no output", async () => {
    setup({ mode: "run", task: "go" });
    const h = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: [stream([{ type: "finish", finishReason: { unified: "stop", raw: "" }, usage }])] }) });
    await h.done;
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 2, detail: "no output" });
  });
  it("chat clears the detail on the next message", async () => {
    setup();
    let calls = 0;
    fake.agent = () => ({ history: [], interrupt: () => {}, run: async (_t: string, emit: (e: unknown) => void) => {
      if (calls++ === 0) emit({ type: "done", incomplete: "step limit", steps: 5 }); else { await sleep(50); emit({ type: "done" }); }
    } });
    handle = await serveAgent(id);
    const c = client(handle.sock);
    await c.wait("hello");
    c.send("one");
    await c.wait("done");
    expect(loadState(id).detail).toBe("step limit");
    expect((fake.opts.at(-1) as { oneShot: boolean }).oneShot).toBe(false);
    c.send("two");
    await sleep(20);
    expect(loadState(id).detail).toBeUndefined();
    await c.wait("done", 2);
    await handle.shutdown();
    expect(loadState(id)).toMatchObject({ status: "exited", exitCode: 0 });
    c.end();
  });
  it("an inject message reaches the running agent even in read-only mode", async () => {
    setup({ mode: "run", task: "go" });
    const injected: string[] = [];
    fake.agent = () => ({ history: [], interrupt: () => {}, inject: (t: string) => injected.push(t), run: async (_t: string, emit: (e: unknown) => void) => {
      for (let i = 0; i < 100 && !injected.length; i++) await sleep(20);
      emit({ type: "done" });
    } });
    const h = await serveAgent(id);
    const c = client(h.sock);
    await c.wait("hello");
    c.raw({ type: "inject", text: "also check b" });
    await h.done;
    expect(injected).toEqual(["also check b"]);
    expect(c.events.some((e) => e.type === "error")).toBe(false);
  });
  it("an org session logs session.capped on its ticket when a turn ends with step limit", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    fake.agent = stepLimitAgent;
    handle = await serveAgent(id);
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.ended"); i++) await sleep(20);
    const ev = t.events().filter((e) => e.kind.startsWith("session."));
    expect(ev.map((e) => e.kind)).toEqual(["session.started", "session.capped", "session.ended"]);
    expect(ev[1]).toMatchObject({ actor: "ba", ticket: "T-1", data: { member: "ba", id, steps: 5 } });
    t.close();
  });
  it("session.failed carries the HTTP status of the error", async () => {
    setup({ task: "go" });
    const db = path.join(work, "org.db");
    const run = JSON.parse(fs.readFileSync(runFile(id), "utf8"));
    fs.writeFileSync(runFile(id), JSON.stringify({ ...run, org: { name: "acme", member: "ba", db, kind: "reply", ticket: "T-1", main: "main" } }));
    saveOrg(acme(work));
    handle = await serveAgent(id, { model: new MockLanguageModelV4({ doStream: async () => {
      throw new APICallError({ message: "overloaded", url: "x", requestBodyValues: {}, statusCode: 503, responseHeaders: { "retry-after-ms": "0" } });
    } }) });
    const t = openTracker(db);
    for (let i = 0; i < 100 && !t.events().some((e) => e.kind === "session.failed"); i++) await sleep(20);
    expect(t.events().find((e) => e.kind === "session.failed")).toMatchObject({ ticket: "T-1", data: { member: "ba", id, status: 503 } });
    t.close();
  });
});
