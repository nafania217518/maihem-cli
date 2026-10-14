import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { main, resolveRunArgs } from "../src/main.ts";
import { saveImage } from "../src/registry.ts";
import { saveState, loadState, logPath, sockPath } from "../src/state.ts";
import { parseDefinition } from "../src/definition.ts";
import net from "node:net";
import { deps, runFile } from "../src/run.ts";
import { lineSplitter } from "../src/protocol.ts";

import { PassThrough } from "node:stream";
const w = vi.hoisted(() => ({ ensureWorker: vi.fn(async () => "http://w"), removeWorkspace: vi.fn(async () => {}) }));
vi.mock("../src/worker.ts", async (orig) => ({ ...(await orig<object>()), ensureWorker: w.ensureWorker }));
vi.mock("../src/backend-sandbox.ts", async (orig) => ({ ...(await orig<object>()), removeWorkspace: w.removeWorkspace }));

const def = (name: string) => parseDefinition(JSON.stringify({ name, provider: "openai", model: "gpt" }));

describe("main", () => {
  let home: string;
  let file: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const out = () => log.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
    file = path.join(home, "d.yaml");
    fs.writeFileSync(file, "name: a\nprovider: openai\nmodel: gpt\n");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("build saves image and prints built", async () => {
    expect(await main(["build", "-f", file, "--api-key", "sk-abcdef", "--name", "b"])).toBe(0);
    expect(out()).toBe("built b");
    expect(fs.existsSync(path.join(home, "images", "b.yaml"))).toBe(true);
  });
  it("images prints a table", async () => {
    saveImage(def("a"));
    expect(await main(["images"])).toBe(0);
    expect(out()).toMatch(/NAME\s+PROVIDER\s+MODEL\s+SANDBOX\s+TOOLS/);
    expect(out()).toMatch(/a\s+openai\s+gpt\s+true\s+read,write,edit,list,exec/);
  });
  it("inspect output has no raw key", async () => {
    saveImage({ ...def("a"), api_key: "sk-abcdef" });
    expect(await main(["inspect", "a"])).toBe(0);
    expect(out()).not.toContain("sk-abcdef");
    expect(out()).toContain("****cdef");
  });
  it("rmi removes image", async () => {
    saveImage(def("a"));
    expect(await main(["rmi", "a"])).toBe(0);
    expect(out()).toBe("removed a");
    expect(await main(["inspect", "a"])).toBe(1);
    expect(err.mock.calls[0][0]).toBe("error: no such image: a");
  });
  it("ps lists agents and refreshes status", async () => {
    saveState({ id: "x1", name: "a", pid: 999999, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("x1"), sock: sockPath("x1") });
    expect(await main(["ps"])).toBe(0);
    expect(out()).toMatch(/ID\s+NAME\s+STATUS\s+SANDBOX\s+WORKDIR\s+STARTED/);
    expect(out()).toMatch(/x1\s+a\s+exited/);
  });
  it("stop on a real child process ends it", async () => {
    const child = spawn("sleep", ["30"]);
    saveState({ id: "c1", name: "a", pid: child.pid!, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("c1"), sock: sockPath("c1") });
    expect(await main(["stop", "c1"])).toBe(0);
    expect(out()).toBe("stopped c1");
    expect(loadState("c1").status).toBe("exited");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("stop ignores a dead pid and removes the leftover run file and socket", async () => {
    saveState({ id: "d1", name: "a", pid: 999999, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("d1"), sock: sockPath("d1") });
    fs.writeFileSync(runFile("d1"), "{}");
    fs.writeFileSync(sockPath("d1"), "");
    expect(await main(["stop", "d1"])).toBe(0);
    expect(loadState("d1").status).toBe("exited");
    expect(fs.existsSync(runFile("d1"))).toBe(false);
    expect(fs.existsSync(sockPath("d1"))).toBe(false);
  });
  it("stop --discard sends a stop message without apply", async () => {
    const sock = path.join(os.tmpdir(), `mh-stop-${process.pid}.sock`);
    fs.rmSync(sock, { force: true });
    const got: unknown[] = [];
    const server = net.createServer((c) => c.on("data", lineSplitter((m) => { got.push(m); c.end(); })));
    await new Promise<void>((r) => server.listen(sock, r));
    saveState({ id: "s1", name: "a", pid: 999999, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("s1"), sock });
    expect(await main(["stop", "--discard", "s1"])).toBe(0);
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
    server.close();
    expect(got).toEqual([{ type: "stop", apply: false }]);
    expect(loadState("s1").status).toBe("exited");
  });
  it("stop falls back to SIGTERM when the socket does not answer", async () => {
    const child = spawn("sleep", ["30"]);
    saveState({ id: "c2", name: "a", pid: child.pid!, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("c2"), sock: sockPath("c2") });
    expect(await main(["stop", "c2"])).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(child.signalCode).toBe("SIGTERM");
  });
  it("launch is dispatched with the run source forms", async () => {
    vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref: vi.fn() } as never);
    saveImage({ ...def("a"), api_key: "k" });
    expect(await main(["launch", "a", "-d", "--no-sandbox", "hi"])).toBe(0);
    const id = out();
    expect(JSON.parse(fs.readFileSync(runFile(id), "utf8"))).toMatchObject({ task: "hi", mode: "chat", def: { name: "a", sandbox: false } });
  });
  it("usage lists launch", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/maihem launch \[NAME \| -f FILE \| --provider P --model M\] \[FIRST_MESSAGE\] \[-d\]/);
    expect(err.mock.calls[0][0]).toContain("maihem stop [--discard] ID");
    expect(err.mock.calls[0][0]).toContain("[TASK] [-d] [--no-sandbox] [--workdir DIR] [--api-key KEY]");
  });
  it("unknown command returns 1 with usage", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/usage/i);
    expect(await main([])).toBe(1);
    expect(await main(["inspect"])).toBe(1);
    expect(await main(["build"])).toBe(1);
  });
  it("attach on an exited agent returns 1", async () => {
    saveState({ id: "e1", name: "a", pid: 999999, status: "running", workdir: "/w", sandbox: false, started: "2026-01-01T00:00:00.000Z", log: logPath("e1"), sock: sockPath("e1") });
    expect(await main(["attach", "e1"])).toBe(1);
    expect(err.mock.calls[0][0]).toBe("error: agent e1 is not running");
  });
  it("logs prints the log file, nothing when missing", async () => {
    saveState({ id: "l1", name: "a", pid: 1, status: "exited", workdir: "/w", sandbox: false, started: "2026-01-01T00:00:00.000Z", log: logPath("l1"), sock: sockPath("l1") });
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out += s; return true; });
    expect(await main(["logs", "l1"])).toBe(0);
    expect(out).toBe("");
    fs.writeFileSync(logPath("l1"), "hello log");
    expect(await main(["logs", "l1"])).toBe(0);
    expect(out).toBe("hello log");
  });
  it("attach/logs/__agent without id return usage", async () => {
    for (const c of ["attach", "logs", "__agent"]) expect(await main([c])).toBe(1);
  });
  it("resolveRunArgs: -f wins over name when both given", () => {
    saveImage(def("reg"));
    const r = resolveRunArgs(["reg", "-f", file]);
    expect(r.def.name).toBe("a");
  });
  it("resolveRunArgs: name from positional loads registry", () => {
    saveImage(def("reg"));
    const r = resolveRunArgs(["reg", "do it"]);
    expect(r.def.name).toBe("reg");
    expect(r.task).toBe("do it");
    expect(r.detach).toBe(false);
    expect(resolveRunArgs(["--name", "reg", "task2"]).task).toBe("task2");
  });
  it("resolveRunArgs: inline flags build a definition", () => {
    const r = resolveRunArgs(["--provider", "ollama", "--model", "m", "-d", "--api-key", "k", "hello"]);
    expect(r.def).toMatchObject({ name: "inline", provider: "ollama", model: "m" });
    expect(r.task).toBe("hello");
    expect(r.detach).toBe(true);
    expect(r.apiKey).toBe("k");
  });
  it("resolveRunArgs: task positional captured in both forms", () => {
    expect(resolveRunArgs(["-f", file, "t1"]).task).toBe("t1");
    expect(resolveRunArgs(["-f", file]).task).toBeUndefined();
  });
  it("resolveRunArgs: --no-sandbox and --workdir override", () => {
    const r = resolveRunArgs(["-f", file, "--no-sandbox", "--workdir", "sub"]);
    expect(r.def.sandbox).toBe(false);
    expect(r.def.workdir).toBe(path.resolve("sub"));
    expect(resolveRunArgs(["-f", file]).def.workdir).toBe(process.cwd());
  });
  it("resolveRunArgs: missing source returns usage error", () => {
    expect(() => resolveRunArgs([])).toThrow(/usage/i);
  });
  describe("prune", () => {
    const agent = (id: string, pid: number, sandbox = false) =>
      saveState({ id, name: "a", pid, status: "running", workdir: "/w", sandbox, started: "2026-01-01T00:00:00.000Z", log: logPath(id), sock: sockPath(id) });
    const has = (id: string) => fs.existsSync(path.join(home, "agents", `${id}.json`));
    const origStdin = deps.stdin;
    const tty = (answer: string) => {
      const s = Object.assign(new PassThrough(), { isTTY: true });
      s.write(answer);
      deps.stdin = s;
    };
    let write: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      w.ensureWorker.mockClear();
      w.removeWorkspace.mockReset().mockResolvedValue(undefined);
      write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });
    afterEach(() => { deps.stdin = origStdin; });

    it("prune -f removes stopped agents and keeps running ones", async () => {
      agent("dead1", 999999);
      agent("live1", process.pid);
      fs.writeFileSync(logPath("dead1"), "x");
      expect(await main(["prune", "-f"])).toBe(0);
      expect(has("dead1")).toBe(false);
      expect(fs.existsSync(logPath("dead1"))).toBe(false);
      expect(has("live1")).toBe(true);
      expect(out()).toContain("dead1");
    });
    it("prune -f clears sandbox data in the worker for sandboxed agents", async () => {
      agent("nosb", 999999);
      expect(await main(["prune", "-f"])).toBe(0);
      expect(w.ensureWorker).not.toHaveBeenCalled();
      agent("sb1", 999999, true);
      agent("nosb2", 999999);
      expect(await main(["prune", "-f"])).toBe(0);
      expect(w.ensureWorker).toHaveBeenCalledTimes(1);
      expect(w.removeWorkspace).toHaveBeenCalledWith("http://w", "sb1");
      expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
    });
    it("prune keeps local files when the worker delete fails", async () => {
      agent("sb2", 999999, true);
      w.removeWorkspace.mockRejectedValue(new Error("worker 500: x"));
      expect(await main(["prune", "-f"])).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/^error: /);
      expect(has("sb2")).toBe(true);
    });
    it("prune asks for confirmation and y removes", async () => {
      agent("d1", 999999);
      tty("y\n");
      expect(await main(["prune"])).toBe(0);
      expect(write.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("This removes 1 stopped agents. Continue? [y/N] ");
      expect(has("d1")).toBe(false);
    });
    it("prune answer other than y removes nothing", async () => {
      agent("d2", 999999);
      tty("n\n");
      expect(await main(["prune"])).toBe(0);
      expect(has("d2")).toBe(true);
    });
    it("prune without a terminal and without -f refuses", async () => {
      agent("d3", 999999);
      deps.stdin = new PassThrough();
      expect(await main(["prune"])).toBe(1);
      expect(err.mock.calls[0][0]).toBe("error: prune needs -f when stdin is not a terminal");
      expect(has("d3")).toBe(true);
    });
    it("prune with no stopped agents says nothing to prune", async () => {
      agent("live2", process.pid);
      expect(await main(["prune"])).toBe(0);
      expect(out()).toBe("nothing to prune");
      expect(write).not.toHaveBeenCalled();
    });
    it("usage lists prune", async () => {
      expect(await main([])).toBe(1);
      expect(err.mock.calls[0][0]).toContain("maihem prune [-f]");
    });
  });
});
