import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { deps, startWorker, stopWorker, workerDir, workerStatus, ensureWorker } from "../src/worker.ts";
import { main } from "../src/main.ts";

const fakeChild = (pid: number) => ({ pid, unref() {} }) as never;

describe("worker", () => {
  let home: string;
  let server: http.Server | undefined;
  const serve = async (): Promise<number> => {
    server = http.createServer((_, res) => res.end("ok"));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.MAIHEM_WORKER_PORT = String(port);
    return port;
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-w-"));
    process.env.MAIHEM_HOME = home;
    process.env.MAIHEM_WORKER_TIMEOUT_MS = "600";
    delete process.env.MAIHEM_WORKER_PORT;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it("workerDir points at packages/worker", () => {
    expect(fs.existsSync(path.join(workerDir(), "wrangler.jsonc"))).toBe(true);
  });
  it("status is not running without state", async () => {
    expect(await workerStatus()).toEqual({ running: false, url: "http://127.0.0.1:8799" });
  });
  it("startWorker spawns wrangler and resolves when health answers", async () => {
    const port = await serve();
    const spy = vi.spyOn(deps, "spawn").mockReturnValue(fakeChild(process.pid));
    expect(await startWorker()).toBe(`http://127.0.0.1:${port}`);
    expect(spy).toHaveBeenCalledWith("npx", ["wrangler", "dev", "--port", String(port)], expect.objectContaining({ cwd: workerDir(), detached: true }));
    expect(JSON.parse(fs.readFileSync(path.join(home, "worker.json"), "utf8"))).toMatchObject({ pid: process.pid, port });
    expect(await workerStatus()).toEqual({ running: true, url: `http://127.0.0.1:${port}`, pid: process.pid });
    expect(await ensureWorker()).toBe(`http://127.0.0.1:${port}`);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("startWorker times out, kills, and throws with the log tail", async () => {
    vi.spyOn(deps, "spawn").mockImplementation(() => {
      fs.writeFileSync(path.join(home, "worker.log"), "line1\nboom\n");
      return fakeChild(2 ** 30);
    });
    process.env.MAIHEM_WORKER_PORT = "1";
    await expect(startWorker()).rejects.toThrow(/did not start on port 1:\nline1\nboom$/);
    expect(fs.existsSync(path.join(home, "worker.json"))).toBe(false);
  });
  it("stopWorker ends a real child and removes state", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ pid: child.pid, port: 1, log: "" }));
    await stopWorker();
    expect(() => process.kill(child.pid!, 0)).toThrow();
    expect(fs.existsSync(path.join(home, "worker.json"))).toBe(false);
    await stopWorker();
  });
  it("main worker start|status|stop", async () => {
    const port = await serve();
    vi.spyOn(deps, "spawn").mockReturnValue(fakeChild(process.pid));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = () => log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(await main(["worker", "status"])).toBe(0);
    expect(out()).toBe("stopped");
    expect(await main(["worker", "start"])).toBe(0);
    expect(out()).toContain(`http://127.0.0.1:${port}`);
    expect(await main(["worker", "status"])).toBe(0);
    expect(out()).toContain(`running http://127.0.0.1:${port} (pid ${process.pid})`);
    // state points at this test process; swap pid so stop does not signal vitest
    fs.writeFileSync(path.join(home, "worker.json"), JSON.stringify({ pid: 2 ** 30, port, log: "" }));
    expect(await main(["worker", "stop"])).toBe(0);
    expect(out().endsWith("stopped")).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["worker", "bogus"])).toBe(1);
  });
});
