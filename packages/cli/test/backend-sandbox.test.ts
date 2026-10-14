import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createSandboxBackend, listFiles, readBytes, writeBytes, workspacePath } from "../src/backend-sandbox.ts";

const files = new Map<string, Buffer>();
const reqs: { method: string; url: string; body: string }[] = [];
let base: string;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    reqs.push({ method: req.method!, url: req.url!, body: body.toString() });
    const m = req.url!.match(/^\/w\/([^/]+)\/(file(\/.*)|files|exec)$/)!;
    if (m[1] === "boom") return res.writeHead(500).end("kaboom");
    m.shift();
    if (m[1] === "files") return res.end(JSON.stringify([...files].map(([path, b]) => ({ path, size: b.length, mtime: 1 }))));
    if (m[1] === "exec") return res.end(JSON.stringify({ stdout: body.toString(), stderr: "", exitCode: 0 }));
    if (req.method === "PUT") return (files.set(m[2]!, body), res.writeHead(204).end());
    const f = files.get(m[2]!);
    if (!f) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"ENOENT"}');
    res.end(f);
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("createSandboxBackend", () => {
  const be = () => createSandboxBackend(base, "ws");
  it("root is /workspace", () => expect(be().root).toBe("/workspace"));
  it("writeFile then readFile round-trips", async () => {
    await be().writeFile("/workspace/a.txt", "hi");
    expect(await be().readFile("/workspace/a.txt")).toBe("hi");
  });
  it("relative path maps under /workspace", async () => {
    await be().writeFile("sub/b.txt", "x");
    expect(reqs.at(-1)!.url).toBe("/w/ws/file/workspace/sub/b.txt");
    expect(await be().readFile("/workspace/sub/b.txt")).toBe("x");
  });
  it(".. escape throws", async () => {
    await expect(be().readFile("../etc/passwd")).rejects.toThrow(/escapes/);
    expect(() => workspacePath("/workspace/../x")).toThrow(/escapes/);
    expect(workspacePath("/workspace")).toBe("/workspace");
  });
  it("404 throws ENOENT", async () => {
    await expect(be().readFile("missing")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("exec posts command and cwd and returns json", async () => {
    const r = await be().exec("ls");
    expect(JSON.parse(reqs.at(-1)!.body)).toEqual({ command: "ls", cwd: "/workspace" });
    expect(r).toEqual({ stdout: '{"command":"ls","cwd":"/workspace"}', stderr: "", exitCode: 0 });
    await be().exec("ls", "/workspace/sub");
    expect(JSON.parse(reqs.at(-1)!.body).cwd).toBe("/workspace/sub");
  });
  it("500 throws with status and body", async () => {
    await expect(createSandboxBackend(base, "boom").exec("ls")).rejects.toThrow("worker 500: kaboom");
  });
  it("listFiles, readBytes, writeBytes handle binary", async () => {
    const bytes = new Uint8Array([0, 255, 7]);
    await writeBytes(base, "ws", "bin.dat", bytes);
    expect(await readBytes(base, "ws", "bin.dat")).toEqual(bytes);
    expect(await be().readBytes("bin.dat")).toEqual(bytes);
    await be().writeBytes("bin2.dat", bytes);
    expect(await listFiles(base, "ws")).toContainEqual({ path: "/workspace/bin2.dat", size: 3, mtime: 1 });
    expect(await be().listFiles()).toContainEqual({ path: "/workspace/bin.dat", size: 3, mtime: 1 });
  });
});
