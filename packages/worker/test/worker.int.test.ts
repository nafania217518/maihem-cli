import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const ID = Date.now().toString(36);
let child: ChildProcess;
let log = "";

const portFree = (port: number) =>
  new Promise<boolean>((r) => {
    const s = net.createServer().once("error", () => r(false)).listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });

beforeAll(async () => {
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is already in use; stop the process on it before running integration tests`);
  child = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`${BASE}/health`).then((r) => r.status === 200, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
}, 70_000);

afterAll(async () => {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise<void>((r) => {
    const t = setTimeout(() => (child.kill("SIGKILL"), r()), 3000);
    child.once("exit", () => (clearTimeout(t), r()));
  });
  expect(await portFree(PORT)).toBe(true);
}, 20_000);

it("PUT then GET round-trips bytes", async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const put = await fetch(`${BASE}/w/${ID}/file/workspace/bin/a.bin`, { method: "PUT", body: bytes });
  expect(put.status).toBe(204);
  const got = await fetch(`${BASE}/w/${ID}/file/workspace/bin/a.bin`);
  expect(got.status).toBe(200);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
});

it("lists files with size", async () => {
  await fetch(`${BASE}/w/${ID}/file/workspace/a.txt`, { method: "PUT", body: "hello" });
  const files = await fetch(`${BASE}/w/${ID}/files`).then((r) => r.json());
  expect(files).toContainEqual(expect.objectContaining({ path: "/workspace/a.txt", size: 5 }));
});

it("exec cat returns file content", async () => {
  const r = await fetch(`${BASE}/w/${ID}/exec`, { method: "POST", body: JSON.stringify({ command: "cat /workspace/a.txt" }) }).then((r) => r.json());
  expect(r).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
});

it("exec of a failing command returns non-zero exitCode", async () => {
  const r = await fetch(`${BASE}/w/${ID}/exec`, { method: "POST", body: JSON.stringify({ command: "cat /workspace/missing" }) }).then((r) => r.json());
  expect(r.exitCode).not.toBe(0);
});

it("GET missing file returns 404", async () => {
  const r = await fetch(`${BASE}/w/${ID}/file/workspace/nope.txt`);
  expect(r.status).toBe(404);
  expect(await r.json()).toHaveProperty("error");
});

it("DELETE clears the workspace", async () => {
  const id = `${ID}del`;
  await fetch(`${BASE}/w/${id}/file/workspace/x.txt`, { method: "PUT", body: "x" });
  expect((await fetch(`${BASE}/w/${id}`, { method: "DELETE" })).status).toBe(204);
  expect(await fetch(`${BASE}/w/${id}/files`).then((r) => r.json())).toEqual([]);
});
