import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyIn, copyOut, isExcluded, readExcludes } from "../src/sync.ts";
import type { SandboxBackend } from "../src/backend-sandbox.ts";

type Fake = SandboxBackend & { files: Map<string, Uint8Array>; mtimes: Map<string, number>; reads: string[]; writes: string[]; set(p: string, s: string): void };

function fake(): Fake {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, number>();
  const reads: string[] = [];
  const writes: string[] = [];
  const td = new TextDecoder();
  let clock = 1;
  const put = (p: string, b: Uint8Array) => (files.set(p, b), mtimes.set(p, ++clock), writes.push(p));
  return {
    files, mtimes, reads, writes,
    root: "/workspace",
    set: (p, s) => put(p, new TextEncoder().encode(s)),
    listFiles: async () => [...files].map(([p, b]) => ({ path: p, size: b.length, mtime: mtimes.get(p)! })),
    readBytes: async (p) => (reads.push(p), files.get(p)!),
    writeBytes: async (p, b) => void put(p, b),
    readFile: async (p) => td.decode(files.get(p)),
    writeFile: async (p, c) => void put(p, new TextEncoder().encode(c)),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("sync", () => {
  let dir: string;
  const w = (rel: string, s: string) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), s));
  const r = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sync-"));
    w("a.txt", "a");
    w("sub/deep.txt", "d");
  });

  it("copyIn copies every regular file, also in a non-git workdir", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    expect([...b.files.keys()].sort()).toEqual(["/workspace/a.txt", "/workspace/sub/deep.txt"]);
    expect([...b.files.get("/workspace/sub/deep.txt")!]).toEqual([100]);
    expect(snap.files).toBe(2);
  });

  it(".maihemignore skips matching files and does not walk matching directories", async () => {
    w(".maihemignore", "node_modules/\n*.log\n");
    w("node_modules/x/y/z.js", "z");
    w("pkg/node_modules/q.js", "q");
    w("run.log", "l");
    const b = fake();
    const snap = await copyIn(dir, b);
    expect([...b.files.keys()].sort()).toEqual(["/workspace/.maihemignore", "/workspace/a.txt", "/workspace/sub/deep.txt"]);
    expect(snap.excludes).toEqual(["node_modules/", "*.log"]);
  });

  it("a pattern without a slash matches at any depth; a pattern with a slash is anchored to the workdir", () => {
    expect(isExcluded("node_modules/a.js", ["node_modules/"])).toBe(true);
    expect(isExcluded("pkg/node_modules/x/y.js", ["node_modules/"])).toBe(true);
    expect(isExcluded(".env.local", [".env*"])).toBe(true);
    expect(isExcluded("sub/.env", [".env*"])).toBe(true);
    expect(isExcluded("docs/tmp/a", ["docs/tmp"])).toBe(true);
    expect(isExcluded("x/docs/tmp/a", ["docs/tmp"])).toBe(false);
    expect(isExcluded("build/a", ["/build"])).toBe(true);
    expect(isExcluded("x/build/a", ["/build"])).toBe(false);
    expect(isExcluded("a.txt", [])).toBe(false);
  });

  it("comments and blank lines in .maihemignore are ignored", () => {
    w(".maihemignore", "# note\n\n  *.log  \n   \n");
    expect(readExcludes(dir)).toEqual(["*.log"]);
    expect(readExcludes(path.join(dir, "sub"))).toEqual([]);
  });

  it("sandbox_exclude adds to .maihemignore", async () => {
    w(".maihemignore", "a.txt\n");
    expect(readExcludes(dir, ["sub/"])).toEqual(["a.txt", "sub/"]);
    const b = fake();
    await copyIn(dir, b, ["sub/"]);
    expect([...b.files.keys()]).toEqual(["/workspace/.maihemignore"]);
  });

  it("symlinks and special files are skipped and never followed", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mh-out-"));
    fs.writeFileSync(path.join(out, "secret.txt"), "s");
    fs.symlinkSync(path.join(out, "secret.txt"), path.join(dir, "link.txt"));
    fs.symlinkSync(out, path.join(dir, "linkdir"));
    const b = fake();
    const snap = await copyIn(dir, b);
    expect(snap.symlinks).toBe(2);
    expect([...b.files.keys()].sort()).toEqual(["/workspace/a.txt", "/workspace/sub/deep.txt"]);
  });

  it("copyIn refuses over the file or byte limit with the counts and a hint", async () => {
    const b = fake();
    const hint = "add paths to .maihemignore or sandbox_exclude, or use --no-sandbox";
    await expect(copyIn(dir, b, [], { files: 1, bytes: 1024 * 1024 })).rejects.toThrow(`workdir too large for the sandbox: 2 files, 0 MB (limit 1 files, 1 MB); ${hint}`);
    await expect(copyIn(dir, b, [], { files: 10, bytes: 1 })).rejects.toThrow("workdir too large for the sandbox: 2 files");
    expect(b.writes).toEqual([]);
  });

  it("copyIn records hash, size and the sandbox mtime in the baseline", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    expect(snap.baseline.get("a.txt")).toEqual({ hash: sha("a"), size: 1, mtime: b.mtimes.get("/workspace/a.txt") });
    expect(snap.baseline.has("sub/deep.txt")).toBe(true);
  });

  it("copyIn without writeBytes uses writeFile; the baseline has no mtime without listFiles", async () => {
    const b = fake();
    const plain = { root: b.root, readFile: b.readFile, writeFile: b.writeFile, exec: b.exec };
    const snap = await copyIn(dir, plain);
    expect(await b.readFile("/workspace/a.txt")).toBe("a");
    expect(snap.baseline.get("a.txt")!.mtime).toBeUndefined();
  });

  it("copyOut writes only files changed in the sandbox", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    b.set("/workspace/a.txt", "X");
    b.set("/workspace/sub/deep.txt", "d"); // touched, same content
    const res = await copyOut(b, dir, snap);
    expect(res).toEqual({ written: ["a.txt"], conflicts: [] });
    expect(r("a.txt")).toBe("X");
  });

  it("copyOut does not read sandbox files whose size and mtime match the baseline", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    b.set("/workspace/a.txt", "X");
    await copyOut(b, dir, snap);
    expect(b.reads).toEqual(["/workspace/a.txt"]);
  });

  it("a file changed on both sides is a conflict: host kept, sandbox copy saved as .sandbox", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    b.set("/workspace/a.txt", "S");
    w("a.txt", "H");
    const res = await copyOut(b, dir, snap);
    expect(res).toEqual({ written: [], conflicts: ["a.txt"] });
    expect(r("a.txt")).toBe("H");
    expect(r("a.txt.sandbox")).toBe("S");
  });

  it("a new sandbox file is written; a new host file at the same path with other content is a conflict", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    b.set("/workspace/new/n.txt", "N");
    b.set("/workspace/m.txt", "S");
    b.set("/workspace/same.txt", "eq");
    w("m.txt", "H");
    w("same.txt", "eq");
    const res = await copyOut(b, dir, snap);
    expect(res.written).toEqual(["new/n.txt"]);
    expect(res.conflicts).toEqual(["m.txt"]);
    expect(r("new/n.txt")).toBe("N");
    expect(r("m.txt")).toBe("H");
    expect(fs.existsSync(path.join(dir, "same.txt.sandbox"))).toBe(false);
  });

  it("copyOut never writes excluded paths, even new ones", async () => {
    const b = fake();
    const snap = await copyIn(dir, b, ["node_modules/"]);
    b.set("/workspace/node_modules/p/i.js", "x");
    const res = await copyOut(b, dir, snap);
    expect(res).toEqual({ written: [], conflicts: [] });
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
  });

  it("copyOut without listFiles writes nothing", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    const res = await copyOut({ root: b.root, readFile: b.readFile, writeFile: b.writeFile, exec: b.exec }, dir, snap);
    expect(res).toEqual({ written: [], conflicts: [] });
  });

  it("copyOut falls back to readFile without readBytes", async () => {
    const b = fake();
    const snap = await copyIn(dir, b);
    b.set("/workspace/x.txt", "Y");
    const { readBytes: _r, ...noRead } = b;
    expect((await copyOut(noRead, dir, snap)).written).toEqual(["x.txt"]);
    expect(r("x.txt")).toBe("Y");
  });
});
