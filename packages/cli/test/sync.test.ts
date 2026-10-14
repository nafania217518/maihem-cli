import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyIn, copyOut } from "../src/sync.ts";
import type { SandboxBackend } from "../src/backend-sandbox.ts";

function fake(): SandboxBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const td = new TextDecoder();
  return {
    files,
    root: "/workspace",
    listFiles: async () => [...files].map(([p, b]) => ({ path: p, size: b.length, mtime: 1 })),
    readBytes: async (p) => files.get(p)!,
    writeBytes: async (p, b) => void files.set(p, b),
    readFile: async (p) => td.decode(files.get(p)),
    writeFile: async (p, c) => void files.set(p, new TextEncoder().encode(c)),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

describe("sync", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sync-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "tracked.txt"), "t");
    fs.writeFileSync(path.join(dir, "untracked.txt"), "u");
    fs.writeFileSync(path.join(dir, "ignored.log"), "i");
    fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "deep.txt"), "d");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  });

  it("copyIn uploads non-ignored files only", async () => {
    const b = fake();
    expect(await copyIn(dir, b)).toBe(4);
    expect([...b.files.keys()].sort()).toEqual(["/workspace/.gitignore", "/workspace/sub/deep.txt", "/workspace/tracked.txt", "/workspace/untracked.txt"]);
    expect([...b.files.get("/workspace/sub/deep.txt")!]).toEqual([100]);
  });
  it("copyIn skips files git lists but which no longer exist", async () => {
    fs.rmSync(path.join(dir, "tracked.txt"));
    expect(await copyIn(dir, fake())).toBe(3);
  });
  it("copyIn falls back to writeFile without writeBytes", async () => {
    const b = fake();
    const plain = { root: b.root, readFile: b.readFile, writeFile: b.writeFile, exec: b.exec };
    expect(await copyIn(dir, plain)).toBe(4);
    expect(await b.readFile("/workspace/tracked.txt")).toBe("t");
  });
  it("copyIn throws on a non-git dir", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mh-nogit-"));
    await expect(copyIn(plain, fake())).rejects.toThrow("workdir must be a git repository for sandbox mode; use --no-sandbox");
  });

  it("copyOut writes new and changed, skips identical, creates subdirs", async () => {
    const b = fake();
    await copyIn(dir, b);
    b.files.set("/workspace/tracked.txt", new Uint8Array([88]));
    b.files.set("/workspace/new/n.txt", new Uint8Array([78]));
    const before = fs.statSync(path.join(dir, "untracked.txt")).mtimeMs;
    expect(await copyOut(b, dir)).toBe(2);
    expect(fs.readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("X");
    expect(fs.readFileSync(path.join(dir, "new", "n.txt"), "utf8")).toBe("N");
    expect(fs.statSync(path.join(dir, "untracked.txt")).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(dir, "ignored.log"))).toBe(true);
  });
  it("copyOut without listFiles writes nothing", async () => {
    const b = fake();
    expect(await copyOut({ root: b.root, readFile: b.readFile, writeFile: b.writeFile, exec: b.exec }, dir)).toBe(0);
  });
  it("copyOut falls back to readFile without readBytes", async () => {
    const b = fake();
    b.files.set("/workspace/x.txt", new Uint8Array([89]));
    const { readBytes: _r, ...noRead } = b;
    expect(await copyOut(noRead, dir)).toBe(1);
    expect(fs.readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("Y");
  });
});
