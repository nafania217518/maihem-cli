import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createSandboxBackend } from "../src/backend-sandbox.ts";
import { copyIn, copyOut } from "../src/sync.ts";
import { startWorker, stopWorker } from "../src/worker.ts";

const PORT = 8798;
let dir: string;
let url: string;

const portFree = (port: number) =>
  new Promise<boolean>((r) => {
    const s = net.createServer().once("error", () => r(false)).listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });

beforeAll(async () => {
  process.env.MAIHEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mh-int-"));
  process.env.MAIHEM_WORKER_PORT = String(PORT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello a");
  fs.writeFileSync(path.join(dir, "b.txt"), "hello b");
  url = await startWorker();
}, 70_000);

afterAll(async () => {
  await stopWorker();
  expect(await portFree(PORT)).toBe(true);
}, 20_000);

it("copyIn, exec, writeFile, copyOut round-trip through a real worker", async () => {
  const b = createSandboxBackend(url, `int-${Date.now().toString(36)}`);
  expect(await copyIn(dir, b)).toBe(2);
  expect((await b.exec("cat a.txt")).stdout).toBe("hello a");
  await b.writeFile("out/c.txt", "made inside");
  expect(await copyOut(b, dir)).toBe(1);
  expect(fs.readFileSync(path.join(dir, "out", "c.txt"), "utf8")).toBe("made inside");
}, 90_000);
