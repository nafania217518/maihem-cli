import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { main } from "../src/main.ts";
import { listStates } from "../src/state.ts";
import { Readable } from "node:stream";
import { deps, launchCommand, printEvent, runFile } from "../src/run.ts";
import { resolveRunArgs } from "../src/main.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
const steps = () => [
  stream([{ type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: "out.txt", content: "data" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
  stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "answer" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
];
let modelImpl: () => MockLanguageModelV4;
const fake = vi.hoisted(() => ({ agent: undefined as undefined | ((o: unknown) => unknown), opts: [] as unknown[] }));
vi.mock("../src/agent.ts", async (orig) => {
  const real = (await orig()) as { createAgent: (o: unknown) => unknown };
  return { ...real, createAgent: (o: unknown) => { fake.opts.push(o); return fake.agent ? fake.agent(o) : real.createAgent(o); } };
});
vi.mock("../src/model.ts", () => ({ createModel: () => modelImpl() }));
const w = vi.hoisted(() => ({ ensureWorker: vi.fn(async () => "http://w"), createSandboxBackend: vi.fn(), copyIn: vi.fn(async () => 1), copyOut: vi.fn(async () => 1) }));
vi.mock("../src/worker.ts", () => ({ ensureWorker: w.ensureWorker, startWorker: w.ensureWorker, stopWorker: vi.fn(), workerStatus: vi.fn() }));
vi.mock("../src/backend-sandbox.ts", () => ({ createSandboxBackend: w.createSandboxBackend }));
vi.mock("../src/sync.ts", () => ({ copyIn: w.copyIn, copyOut: w.copyOut }));

describe("run", () => {
  let home: string;
  let work: string;
  let out: string;
  let err: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
    work = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    out = ""; err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out += s; return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { err += s; return true; });
    vi.spyOn(console, "log").mockImplementation((s) => { out += s + "\n"; });
    vi.spyOn(console, "error").mockImplementation((s) => { err += s + "\n"; });
    modelImpl = () => new MockLanguageModelV4({ doStream: steps() });
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());
  const args = (...a: string[]) => ["run", "--provider", "openai", "--model", "m", "--api-key", "k", "--workdir", work, ...a];

  it("host run writes the file, prints the answer and exits state", async () => {
    expect(await main(args("--no-sandbox", "do it"))).toBe(0);
    expect(fs.readFileSync(path.join(work, "out.txt"), "utf8")).toBe("data");
    expect(out).toMatch(/^[0-9a-f]{12}\nanswer\n$/);
    expect(err).toContain("⚙ write");
    expect(err).toContain("✓ wrote out.txt");
    const [s] = listStates();
    expect(s).toMatchObject({ status: "exited", exitCode: 0, sandbox: false, workdir: work });
  });
  it("sandbox run calls ensureWorker, copyIn, copyOut in order", async () => {
    const backend = { root: "/workspace", readFile: vi.fn(), writeFile: vi.fn(async () => {}), exec: vi.fn() };
    w.createSandboxBackend.mockReturnValue(backend);
    expect(await main(args("do it"))).toBe(0);
    const [s] = listStates();
    expect(w.createSandboxBackend).toHaveBeenCalledWith("http://w", s.id);
    expect(w.copyIn).toHaveBeenCalledWith(work, backend);
    expect(w.copyOut).toHaveBeenCalledWith(backend, work);
    expect(backend.writeFile).toHaveBeenCalledWith("out.txt", "data");
    const order = [w.ensureWorker, w.copyIn, w.copyOut].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("copyOut runs and exit code is 1 when the agent throws", async () => {
    w.createSandboxBackend.mockReturnValue({ root: "/workspace" });
    modelImpl = () => new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } });
    expect(await main(args("do it"))).toBe(1);
    expect(w.copyOut).toHaveBeenCalledTimes(1);
    expect(err).toContain("error: boom");
    expect(listStates()[0]).toMatchObject({ status: "exited", exitCode: 1 });
  });
  it("foreground step limit returns 2 and prints the reason", async () => {
    fake.agent = () => ({ history: [], interrupt: () => {}, run: async (_t: string, emit: (e: unknown) => void) => { emit({ type: "done", incomplete: "step limit", steps: 5 }); } });
    try {
      expect(await main(args("--no-sandbox", "do it"))).toBe(2);
    } finally { fake.agent = undefined; }
    expect(err).toContain("incomplete: step limit reached (5)");
    expect((fake.opts.at(-1) as { oneShot: boolean }).oneShot).toBe(true);
    expect(listStates()[0]).toMatchObject({ status: "exited", exitCode: 2, detail: "step limit" });
  });
  it("run without a task on a TTY points to launch", async () => {
    deps.stdin = Object.assign(Readable.from([]), { isTTY: true });
    expect(await main(args("--no-sandbox"))).toBe(1);
    expect(err).toContain("error: run needs a task; use maihem launch for chat");
  });
  it("run without a task reads it from piped stdin", async () => {
    deps.stdin = Readable.from(["piped task\n"]);
    const spawn = vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref: vi.fn() } as never);
    expect(await main(args("-d", "--no-sandbox"))).toBe(0);
    expect(spawn).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(runFile(listStates()[0].id), "utf8")).task).toBe("piped task");
  });
  it("run -d spawns a one-shot agent in run mode", async () => {
    const spawn = vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref: vi.fn() } as never);
    expect(await main(args("-d", "--no-sandbox", "x"))).toBe(0);
    const [s] = listStates();
    expect(out).toBe(`${s.id}\n`);
    expect(s).toMatchObject({ pid: 4242, status: "running" });
    const [cmd, argv, opts] = spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(argv).toEqual([expect.stringMatching(/bin\/maihem\.js$/), "__agent", s.id]);
    expect(opts).toMatchObject({ detached: true });
    expect(fs.statSync(runFile(s.id)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(runFile(s.id), "utf8"))).toMatchObject({ task: "x", apiKey: "k", mode: "run", def: { sandbox: false } });
    expect(w.ensureWorker).not.toHaveBeenCalled();
  });
  const launch = (...a: string[]) => launchCommand(resolveRunArgs(args(...a).slice(1)));
  it("launch -d prints the id without attaching", async () => {
    vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref: vi.fn() } as never);
    const attach = vi.spyOn(deps, "attach").mockResolvedValue();
    expect(await launch("-d", "--no-sandbox")).toBe(0);
    const [s] = listStates();
    expect(out).toBe(`${s.id}\n`);
    expect(attach).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(runFile(s.id), "utf8")).mode).toBe("chat");
  });
  it("launch passes the first message to the agent", async () => {
    vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref: vi.fn() } as never);
    expect(await launch("-d", "--no-sandbox", "hello there")).toBe(0);
    expect(JSON.parse(fs.readFileSync(runFile(listStates()[0].id), "utf8"))).toMatchObject({ task: "hello there", mode: "chat" });
  });
  it("launch attaches once the socket exists", async () => {
    vi.spyOn(deps, "spawn").mockReturnValue({ pid: process.pid, unref: vi.fn() } as never);
    const attach = vi.spyOn(deps, "attach").mockResolvedValue();
    deps.pollMs = 5;
    setTimeout(() => fs.writeFileSync(listStates()[0].sock, ""), 30);
    expect(await launch("--no-sandbox")).toBe(0);
    const [s] = listStates();
    expect(attach).toHaveBeenCalledWith(s.sock);
    fs.rmSync(s.sock, { force: true });
  });
  it("launch fails with the logs hint when the agent dies before its socket opens", async () => {
    vi.spyOn(deps, "spawn").mockReturnValue({ pid: 999999, unref: vi.fn() } as never);
    const attach = vi.spyOn(deps, "attach").mockResolvedValue();
    expect((await launch("--no-sandbox").catch((e) => e)).message).toBe(`agent exited, see maihem logs ${listStates()[0].id}`);
    expect(attach).not.toHaveBeenCalled();
  });
  it("missing key returns 1", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await main(["run", "--provider", "openai", "--model", "m", "--no-sandbox", "x"])).toBe(1);
    expect(err).toMatch(/error: no API key for openai/);
  });
  it("printEvent shows the first output line of a tool result", () => {
    printEvent({ type: "tool-result", id: "c1", name: "x", ok: true, output: "line one " + "y".repeat(100) + "\nline two" });
    printEvent({ type: "tool-result", id: "c2", name: "x", ok: false, output: "bad" });
    expect(err).toBe(`\x1b[2m  → ✓ ${("line one " + "y".repeat(100)).slice(0, 80)}\x1b[0m\n\x1b[2m  → ✗ bad\x1b[0m\n`);
  });
  it("printEvent starts a tool on a new line after answer text", () => {
    const log: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { log.push(`out:${s}`); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => { log.push("err"); return true; });
    printEvent({ type: "text", delta: "abc" });
    printEvent({ type: "tool", id: "c1", name: "read", input: {} } as never);
    printEvent({ type: "text", delta: "x\n" });
    printEvent({ type: "text", delta: "" });
    printEvent({ type: "tool", id: "c2", name: "read", input: {} } as never);
    expect(log).toEqual(["out:abc", "out:\n", "err", "out:x\n", "out:", "err"]);
  });
});
