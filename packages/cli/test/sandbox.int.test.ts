import { afterAll, beforeAll, expect, it } from "vitest";
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
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is already in use; stop the process on it before running integration tests`);
  process.env.MAIHEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mh-int-"));
  process.env.MAIHEM_WORKER_PORT = String(PORT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-repo-"));
  fs.mkdirSync(path.join(dir, "skip"));
  fs.writeFileSync(path.join(dir, ".maihemignore"), "skip/\n");
  fs.writeFileSync(path.join(dir, "skip", "s.txt"), "secret");
  fs.writeFileSync(path.join(dir, "e.txt"), "base");
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
  const snap = await copyIn(dir, b);
  expect(snap.files).toBe(4);
  expect((await b.exec("cat a.txt")).stdout).toBe("hello a");
  expect((await b.exec("test -e skip/s.txt && echo yes || echo no")).stdout.trim()).toBe("no");
  await b.writeFile("out/c.txt", "made inside");
  await b.writeFile("e.txt", "sandbox edit");
  fs.writeFileSync(path.join(dir, "e.txt"), "host edit");
  const res = await copyOut(b, dir, snap);
  expect(res.written).toContain("out/c.txt");
  expect(res.conflicts).toEqual(["e.txt"]);
  expect(fs.readFileSync(path.join(dir, "out", "c.txt"), "utf8")).toBe("made inside");
  expect(fs.readFileSync(path.join(dir, "e.txt"), "utf8")).toBe("host edit");
  expect(fs.readFileSync(path.join(dir, "e.txt.sandbox"), "utf8")).toBe("sandbox edit");
}, 90_000);
