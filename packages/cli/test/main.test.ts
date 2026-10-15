import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { main, resolveRunArgs } from "../src/main.ts";
import { loadImage, saveImage } from "../src/registry.ts";
import { saveState, loadState, logPath, sockPath } from "../src/state.ts";
import { parseDefinition } from "../src/definition.ts";
import { loadProvider, saveProvider } from "../src/providers.ts";
import net from "node:net";
import { deps, runFile } from "../src/run.ts";
import { lineSplitter } from "../src/protocol.ts";

import { PassThrough } from "node:stream";
const w = vi.hoisted(() => ({ ensureWorker: vi.fn(async () => "http://w"), removeWorkspace: vi.fn(async () => {}) }));
const d = vi.hoisted(() => ({ serveAgent: vi.fn() }));
vi.mock("../src/daemon.ts", async (orig) => {
  const m = await orig<Record<string, unknown>>();
  d.serveAgent.mockImplementation(m.serveAgent as never);
  return { ...m, serveAgent: d.serveAgent };
});
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

  describe("image", () => {
    const img = (...a: string[]) => main(["image", ...a]);
    const yaml = (y: string) => { const f = path.join(home, "i.yaml"); fs.writeFileSync(f, y); return f; };
    beforeEach(() => saveProvider({ name: "op", kind: "openai" }));
    it("image add saves an image and refuses an existing name", async () => {
      expect(await img("add", "--name", "a", "--provider", "op", "--model", "gpt", "--system", "hi", "--tools", "read,list", "--no-sandbox", "--max-steps", "7", "--reasoning", "low", "--context", "1000", "--on-context-full", "fail", "--compact-at", "0.5")).toBe(0);
      expect(out()).toBe("added a");
      expect(loadImage("a")).toEqual({ name: "a", provider: "op", model: "gpt", system: "hi", tools: ["read", "list"], sandbox: false, max_steps: 7, reasoning: "low", context: 1000, on_context_full: "fail", compact_at: 0.5 });
      expect(await img("add", "--name", "a", "--provider", "op", "--model", "x")).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: image "a" already exists; use maihem image update a');
      expect(loadImage("a").model).toBe("gpt");
      expect(await img("add", "--name", "b", "--provider", "op")).toBe(1);
    });
    it("image add fails for an unknown provider", async () => {
      expect(await img("add", "--name", "a", "--provider", "nope", "--model", "m")).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/^error: provider "nope" not found; add it: maihem provider add/);
      expect(() => loadImage("a")).toThrow();
    });
    it("image add validates numeric and enum flags", async () => {
      const base = ["add", "--name", "a", "--provider", "op", "--model", "m"];
      expect(await img(...base, "--max-steps", "x")).toBe(1);
      expect(await img(...base, "--context", "0")).toBe(1);
      expect(await img(...base, "--compact-at", "2")).toBe(1);
      expect(await img(...base, "--reasoning", "huge")).toBe(1);
      expect(await img(...base, "--on-context-full", "x")).toBe(1);
      expect(await img(...base, "--tools", "nope")).toBe(1);
      expect(err.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        "error: definition: max_steps must be a positive integer",
        "error: definition: context must be a positive integer",
        "error: definition: compact_at must be a number in (0, 1]",
        expect.stringMatching(/^error: definition: unknown reasoning "huge"/),
        'error: definition: on_context_full must be "compact" or "fail"',
        expect.stringMatching(/^error: definition: unknown tool "nope"/),
      ]);
      expect(() => loadImage("a")).toThrow();
    });
    it("image update patches flags and --unset restores defaults", async () => {
      await img("add", "--name", "a", "--provider", "op", "--model", "m", "--no-sandbox", "--max-steps", "3", "--system", "s");
      expect(await img("update", "a", "--model", "m2", "--context", "500")).toBe(0);
      expect(loadImage("a")).toMatchObject({ model: "m2", context: 500, sandbox: false, max_steps: 3, system: "s" });
      expect(await img("update", "a", "--unset", "sandbox", "--unset", "max_steps", "--unset", "system", "--unset", "context")).toBe(0);
      const d = loadImage("a");
      expect([d.sandbox, d.max_steps, d.system, d.context]).toEqual([true, 50, undefined, undefined]);
      expect(out()).toBe("added a\nupdated a\nupdated a");
      expect(await img("update", "a", "--unset", "model")).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/^error: image: --unset takes system, tools, sandbox/);
      expect(await img("update", "a", "--provider", "nope")).toBe(1);
      expect(loadImage("a").provider).toBe("op");
      expect(await img("update", "nope")).toBe(1);
      expect(await img("update")).toBe(1);
    });
    it("image rm, ls and inspect work", async () => {
      saveImage(def("a"));
      expect(await img("ls")).toBe(0);
      expect(out()).toMatch(/NAME\s+PROVIDER\s+MODEL\s+SANDBOX\s+TOOLS/);
      expect(out()).toMatch(/a\s+openai\s+gpt\s+true\s+read,write,edit,list,exec/);
      log.mockClear();
      expect(await img("inspect", "a")).toBe(0);
      expect(out()).toContain("provider: openai");
      log.mockClear();
      expect(await img("rm", "a")).toBe(0);
      expect(out()).toBe("removed a");
      expect(await img("inspect", "a")).toBe(1);
      expect(err.mock.calls[0][0]).toBe("error: no such image: a; add it: maihem image add --name a … or maihem apply -f FILE");
      expect(await img("rm", "a")).toBe(1);
      expect(await img("rm")).toBe(1);
      expect(await img("inspect")).toBe(1);
      expect(await img("bogus")).toBe(1);
    });
    it("maihem apply saves providers before images and lets images use providers from the same file", async () => {
      saveImage(parseDefinition("name: old\nprovider: op\nmodel: m\n"));
      const f = yaml("providers:\n  ol: {kind: ollama}\n  op: {kind: openai, api_key: k}\nimages:\n  h: {provider: ol, model: m}\n  old: {provider: op, model: m2}\n");
      expect(await main(["apply", "-f", f])).toBe(0);
      expect(out()).toBe("created provider ol\nreplaced provider op\ncreated image h\nreplaced image old");
      expect(err.mock.calls[0][0]).toMatch(/^warning: api_key for "op"/);
      expect(loadImage("h").provider).toBe("ol");
      expect(await main(["apply", "-f", yaml("images:\n  x: {provider: op, model: m}\n")])).toBe(0);
      expect(await main(["apply", "-f", yaml("providers:\n  z: {kind: ollama}\n")])).toBe(0);
      expect(await main(["apply", "-f", yaml("providers:\n  q: {kind: ollama}\nimages:\n  y: {provider: nope, model: m}\n")])).toBe(1);
      expect(() => loadProvider("q")).toThrow(/not found/);
      expect(await main(["apply", "-f", f, "--name", "z"])).toBe(1);
      expect(await main(["apply"])).toBe(1);
    });
    it("apply reads providers and images as maps keyed by name", async () => {
      const f = yaml("providers:\n  ollama:\n    kind: ollama\nimages:\n  local-helper:\n    provider: ollama\n    model: qwen3.5:9b-mlx\n    tools: [read, write, edit, list, exec]\n    max_steps: 30\n");
      expect(await main(["apply", "-f", f])).toBe(0);
      expect(out()).toBe("created provider ollama\ncreated image local-helper");
      expect(loadProvider("ollama")).toEqual({ name: "ollama", kind: "ollama" });
      expect(loadImage("local-helper")).toMatchObject({ name: "local-helper", provider: "ollama", max_steps: 30 });
    });
    it("apply rejects the old list format with a hint", async () => {
      expect(await main(["apply", "-f", yaml("providers:\n  - name: o\n    kind: ollama\n")])).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: apply file: "providers" must be a map of name: settings');
      expect(await main(["apply", "-f", yaml("images:\n  - {name: a, provider: p, model: m}\n")])).toBe(1);
      expect(err.mock.calls[1][0]).toBe('error: apply file: "images" must be a map of name: settings');
    });
    it("apply rejects a name field inside an entry", async () => {
      expect(await main(["apply", "-f", yaml("images:\n  x: {name: x, provider: p, model: m}\n")])).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: apply file: unknown field "name" in image "x" (the key is the name)');
      expect(await main(["apply", "-f", yaml("providers:\n  o: {name: o, kind: ollama}\n")])).toBe(1);
      expect(err.mock.calls[1][0]).toBe('error: apply file: unknown field "name" in provider "o" (the key is the name)');
    });
    it("apply rejects an entry that is not a map", async () => {
      expect(await main(["apply", "-f", yaml("providers:\n  ollama:\n")])).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: apply file: provider "ollama" must be a map');
      expect(await main(["apply", "-f", yaml("images:\n  x: 1\n")])).toBe(1);
      expect(err.mock.calls[1][0]).toBe('error: apply file: image "x" must be a map');
    });
    it("apply rejects duplicate keys", async () => {
      expect(await main(["apply", "-f", yaml("providers:\n  o: {kind: ollama}\n  o: {kind: openai}\n")])).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/Map keys must be unique/);
      expect(() => loadProvider("o")).toThrow(/not found/);
    });
    it("provider apply and image apply are gone", async () => {
      const f = yaml("providers:\n  o: {kind: ollama}\n");
      expect(await main(["provider", "apply", "-f", f])).toBe(1);
      expect(await main(["image", "apply", "-f", f])).toBe(1);
      expect(err.mock.calls.map((c: unknown[]) => String(c[0]).split("\n")[0])).toEqual(["usage:", "usage:"]);
      expect(() => loadProvider("o")).toThrow(/not found/);
    });
    it("maihem apply rejects unknown sections", async () => {
      expect(await main(["apply", "-f", yaml("providers:\n  z: {kind: ollama}\nfoo: 1\n")])).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: apply file: unknown section "foo" (use providers, images)');
      expect(await main(["apply", "-f", yaml("providers: {}\n")])).toBe(1);
      expect(await main(["apply", "-f", yaml("- 1\n")])).toBe(1);
      expect(() => loadProvider("z")).toThrow(/not found/);
    });
  });
  it("build, images, inspect and rmi are gone", async () => {
    saveImage(def("a"));
    for (const c of [["build", "-f", file], ["images"], ["inspect", "a"], ["rmi", "a"]]) expect(await main(c)).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/^usage/);
    expect(err.mock.calls[0][0]).not.toMatch(/maihem (build|images|inspect|rmi)\b/);
    expect(loadImage("a").name).toBe("a");
  });
  describe("provider", () => {
    const add = (...a: string[]) => main(["provider", "add", ...a]);
    it("provider add then ls and inspect (masked)", async () => {
      expect(await add("--name", "op", "--kind", "openai", "--base-url", "http://x", "--api-key", "sk-abcdef", "--header", "X-A=b=c")).toBe(0);
      expect(await add("--name", "an", "--kind", "anthropic", "--api-key", "$MY_KEY")).toBe(0);
      expect(await add("--name", "ol", "--kind", "ollama")).toBe(0);
      expect(await add("--name", "o2", "--kind", "openai")).toBe(0);
      expect(out()).toBe("added op\nadded an\nadded ol\nadded o2");
      expect(loadProvider("op").headers).toEqual({ "X-A": "b=c" });
      log.mockClear();
      expect(await main(["provider", "ls"])).toBe(0);
      expect(out()).toMatch(/NAME\s+KIND\s+BASE_URL\s+KEY/);
      expect(out()).toMatch(/an\s+anthropic\s+-\s+\$MY_KEY/);
      expect(out()).toMatch(/o2\s+openai\s+-\s+env OPENAI_API_KEY/);
      expect(out()).toMatch(/ol\s+ollama\s+-\s+none/);
      expect(out()).toMatch(/op\s+openai\s+http:\/\/x\s+stored/);
      log.mockClear();
      expect(await main(["provider", "inspect", "op"])).toBe(0);
      expect(out()).not.toContain("sk-abcdef");
      expect(out()).toContain("****cdef");
      expect(await add("--name", "x", "--kind", "openai", "--header", "bad")).toBe(1);
      expect(err.mock.calls.at(-1)[0]).toBe("error: provider: --header needs K=V");
      expect(await add("--kind", "openai")).toBe(1);
      expect(await main(["provider", "bogus"])).toBe(1);
    });
    it("provider add refuses an existing name", async () => {
      expect(await add("--name", "op", "--kind", "openai")).toBe(0);
      expect(await add("--name", "op", "--kind", "ollama")).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: provider "op" already exists; use maihem provider update op');
      expect(loadProvider("op").kind).toBe("openai");
    });
    it("provider update patches, --unset clears, --header adds", async () => {
      saveProvider({ name: "op", kind: "openai", base_url: "http://x", api_key: "k", headers: { A: "1" } });
      expect(await main(["provider", "update", "op", "--base-url", "http://y", "--header", "B=2", "--header", "A=3"])).toBe(0);
      expect(loadProvider("op")).toEqual({ name: "op", kind: "openai", base_url: "http://y", api_key: "k", headers: { A: "3", B: "2" } });
      expect(await main(["provider", "update", "op", "--unset", "base_url", "--unset", "headers"])).toBe(0);
      expect(loadProvider("op")).toEqual({ name: "op", kind: "openai", api_key: "k" });
      expect(out()).toBe("updated op\nupdated op");
      expect(await main(["provider", "update", "op", "--unset", "kind"])).toBe(1);
      expect(await main(["provider", "update", "nope"])).toBe(1);
      expect(await main(["provider", "update"])).toBe(1);
    });
    it("provider ls shows a reference as written", async () => {
      saveProvider({ name: "a", kind: "openai", api_key: "$LAB_KEY" });
      saveProvider({ name: "b", kind: "openai", api_key: "$$lit" });
      expect(await main(["provider", "ls"])).toBe(0);
      expect(out()).toMatch(/a\s+openai\s+-\s+\$LAB_KEY/);
      expect(out()).toMatch(/b\s+openai\s+-\s+stored/);
    });
    it("provider rm refuses when an image uses it and -f forces", async () => {
      saveProvider({ name: "op", kind: "openai" });
      saveImage(def("a"));
      saveImage(parseDefinition(JSON.stringify({ name: "b", provider: "op", model: "m" })));
      saveImage(parseDefinition(JSON.stringify({ name: "c", provider: "op", model: "m" })));
      expect(await main(["provider", "rm", "op"])).toBe(1);
      expect(err.mock.calls[0][0]).toBe('error: provider "op" is used by images: b, c; use -f to remove it anyway');
      expect(await main(["provider", "rm", "-f", "op"])).toBe(0);
      expect(out()).toBe("removed op");
      expect(() => loadProvider("op")).toThrow(/not found/);
    });
    it("provider rm of an unknown name fails", async () => {
      expect(await main(["provider", "rm", "nope"])).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/^error: provider "nope" not found/);
      expect(await main(["provider", "rm"])).toBe(1);
    });
    it("image add and run no longer accept --api-key", async () => {
      saveProvider({ name: "op", kind: "openai" });
      expect(await main(["image", "add", "--name", "a", "--provider", "op", "--model", "m", "--api-key", "k"])).toBe(1);
      saveImage(def("a"));
      expect(await main(["run", "a", "--api-key", "k", "x"])).toBe(1);
      expect(await main(["launch", "a", "--api-key", "k"])).toBe(1);
      expect(await main(["run", "a", "--base-url", "http://x", "x"])).toBe(1);
    });
  });
  it("ps lists agents and refreshes status", async () => {
    saveState({ id: "x1", name: "a", pid: 999999, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("x1"), sock: sockPath("x1") });
    expect(await main(["ps"])).toBe(0);
    expect(out()).toMatch(/ID\s+NAME\s+STATUS\s+SANDBOX\s+WORKDIR\s+STARTED/);
    expect(out()).toMatch(/x1\s+a\s+exited/);
  });
  it("ps shows idle (step limit) and exited (step limit)", async () => {
    saveState({ id: "r1", name: "a", pid: process.pid, status: "running", workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("r1"), sock: sockPath("r1"), detail: "step limit" });
    saveState({ id: "e1", name: "a", pid: 999999, status: "exited", exitCode: 2, workdir: "/w", sandbox: true, started: "2026-01-01T00:00:00.000Z", log: logPath("e1"), sock: sockPath("e1"), detail: "step limit" });
    expect(await main(["ps"])).toBe(0);
    expect(out()).toMatch(/r1\s+a\s+idle \(step limit\)/);
    expect(out()).toMatch(/e1\s+a\s+exited \(step limit\)/);
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
    saveProvider({ name: "openai", kind: "openai", api_key: "k" });
    saveImage(def("a"));
    expect(await main(["launch", "a", "-d", "--no-sandbox", "hi"])).toBe(0);
    const id = out();
    expect(JSON.parse(fs.readFileSync(runFile(id), "utf8"))).toMatchObject({ task: "hi", mode: "chat", def: { name: "a", sandbox: false } });
  });
  it("--version and -v print the version", async () => {
    const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(await main(["--version"])).toBe(0);
    expect(await main(["-v"])).toBe(0);
    expect(out()).toBe(`${version}\n${version}`);
  });
  it("usage lists launch", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/maihem launch NAME \[FIRST_MESSAGE\] \[-d\]/);
    expect(err.mock.calls[0][0]).toContain("maihem stop [--discard] ID");
    expect(err.mock.calls[0][0]).toContain("[TASK] [-d] [--no-sandbox] [--workdir DIR] [--max-steps N] [--allow-empty]\n");
    expect(err.mock.calls[0][0]).not.toContain("--api-key KEY]\n  maihem run");
    expect(err.mock.calls[0][0]).toContain("maihem provider add --name NAME --kind openai|anthropic|ollama");
  });
  it("unknown command returns 1 with usage", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/usage/i);
    expect(await main([])).toBe(1);
    expect(await main(["image"])).toBe(1);
    expect(await main(["apply"])).toBe(1);
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
  it("run and launch start an image by name", () => {
    saveImage(def("reg"));
    const r = resolveRunArgs(["reg", "do it"]);
    expect(r).toMatchObject({ def: { name: "reg" }, task: "do it", detach: false });
    expect(resolveRunArgs(["-d", "reg"])).toMatchObject({ task: undefined, detach: true });
  });
  it("run and launch without a name fail with a hint", async () => {
    expect(await main(["run"])).toBe(1);
    expect(err.mock.calls[0][0]).toBe("error: run needs an image name: maihem run NAME [TASK]");
    expect(await main(["launch", "-d"])).toBe(1);
    expect(err.mock.calls[1][0]).toBe("error: launch needs an image name: maihem launch NAME [FIRST_MESSAGE]");
  });
  it("an unknown image name fails with the add hint", async () => {
    expect(await main(["run", "x", "t"])).toBe(1);
    expect(err.mock.calls[0][0]).toBe("error: no such image: x; add it: maihem image add --name x … or maihem apply -f FILE");
  });
  it("launch rejects --allow-empty", async () => {
    saveImage(def("reg"));
    expect(await main(["launch", "reg", "--allow-empty", "x"])).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/Unknown option/);
  });
  it("run and launch reject -f, --name and inline flags", async () => {
    saveImage(def("reg"));
    for (const c of ["run", "launch"])
      for (const f of [["-f", file], ["--name", "reg"], ["--provider", "op"], ["--model", "m"], ["--system", "s"], ["--tools", "read"]]) {
        err.mockClear();
        expect(await main([c, "reg", ...f, "x"])).toBe(1);
        expect(err.mock.calls[0][0]).toMatch(/Unknown option/);
      }
  });
  it("--max-steps overrides the image for one run without changing it", () => {
    saveImage(def("reg"));
    expect(resolveRunArgs(["reg", "--max-steps", "3"]).def.max_steps).toBe(3);
    expect(loadImage("reg").max_steps).toBe(50);
    for (const n of ["0", "x", "1.5"]) expect(() => resolveRunArgs(["reg", "--max-steps", n])).toThrow("definition: max_steps must be a positive integer");
  });
  it("--no-sandbox and --workdir still apply", () => {
    saveImage(def("reg"));
    const r = resolveRunArgs(["reg", "--no-sandbox", "--workdir", "sub"]);
    expect(r.def.sandbox).toBe(false);
    expect(r.def.workdir).toBe(path.resolve("sub"));
    expect(loadImage("reg").sandbox).toBe(true);
    expect(resolveRunArgs(["reg"]).def.workdir).toBe(process.cwd());
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
  it("__agent exits the process after the agent shuts down", async () => {
    d.serveAgent.mockResolvedValueOnce({ done: Promise.resolve(), shutdown: vi.fn(), sock: "s" } as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await main(["__agent", "x"]);
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});
