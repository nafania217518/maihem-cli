import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { main } from "../src/main.ts";
import { listStates } from "../src/state.ts";
import { deps, runFile } from "../src/run.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
const steps = () => [
  stream([{ type: "tool-call", toolCallId: "c1", toolName: "write", input: JSON.stringify({ path: "out.txt", content: "data" }) }, { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage }]),
  stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "answer" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "" }, usage }]),
];
let modelImpl: () => MockLanguageModelV4;
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
  it("no task returns 1", async () => {
    expect(await main(args("--no-sandbox"))).toBe(1);
    expect(err).toContain("error: run needs a task (or use -d)");
  });
  it("detach spawns __agent, writes run.json and updates pid", async () => {
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
    expect(JSON.parse(fs.readFileSync(runFile(s.id), "utf8"))).toMatchObject({ task: "x", apiKey: "k", def: { sandbox: false } });
    expect(w.ensureWorker).not.toHaveBeenCalled();
  });
  it("missing key returns 1", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await main(["run", "--provider", "openai", "--model", "m", "--no-sandbox", "x"])).toBe(1);
    expect(err).toMatch(/error: no API key for openai/);
  });
});
