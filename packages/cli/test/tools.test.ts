import { describe, it, expect, vi } from "vitest";
import type { Backend } from "../src/backend.ts";
import { createTools } from "../src/tools.ts";

function fakeBackend(files: Record<string, string> = {}): Backend {
  return {
    root: "/root",
    readFile: async (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    writeFile: async (p, c) => { files[p] = c; },
    exec: vi.fn(async (command: string) => ({ stdout: `ran ${command}`, stderr: "", exitCode: 0 })),
  };
}
const opts = { toolCallId: "1", messages: [] } as never;
const call = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, opts);

describe("tools", () => {
  it("creates only the requested tools with root in descriptions", () => {
    const t = createTools(fakeBackend(), ["read", "exec"]);
    expect(Object.keys(t)).toEqual(["read", "exec"]);
    expect(t.read.description).toContain("/root");
  });
  it("read returns file text or an error message", async () => {
    const t = createTools(fakeBackend({ "a.txt": "hello" }), ["read"]);
    expect(await call(t.read, { path: "a.txt" })).toBe("hello");
    expect(await call(t.read, { path: "nope" })).toBe("error: nope does not exist; use list to see the files");
  });
  it("write stores content and reports", async () => {
    const files: Record<string, string> = {};
    const t = createTools(fakeBackend(files), ["write"]);
    expect(await call(t.write, { path: "x", content: "y" })).toBe("wrote x");
    expect(files.x).toBe("y");
  });
  it("write reports backend errors", async () => {
    const b = fakeBackend();
    b.writeFile = async () => { throw new Error("ro"); };
    expect(await call(createTools(b, ["write"]).write, { path: "x", content: "y" })).toBe("error: ro");
  });
  it("edit replaces exactly one occurrence", async () => {
    const files = { f: "a b a", g: "a b", h: "x" };
    const t = createTools(fakeBackend(files), ["edit"]);
    expect(await call(t.edit, { path: "g", old: "a", new: "$&c" })).toBe("edited g");
    expect(files.g).toBe("$&c b");
  });
  it("edit errors say how to fix them", async () => {
    const t = createTools(fakeBackend({ f: "a b a", h: "x" }), ["edit"]);
    expect(await call(t.edit, { path: "f", old: "a", new: "c" })).toBe("error: old text is not unique; include more surrounding lines");
    expect(await call(t.edit, { path: "h", old: "a", new: "c" })).toBe("error: old text not found; read the file again and copy the exact text");
  });
  it("a missing path error points to list", async () => {
    const b = fakeBackend();
    b.readFile = async () => { throw Object.assign(new Error("not found: http://w/x"), { code: "ENOENT" }); };
    const t = createTools(b, ["read", "edit", "list"]);
    const hint = "error: x does not exist; use list to see the files";
    expect(await call(t.read, { path: "x" })).toBe(hint);
    expect(await call(t.edit, { path: "x", old: "a", new: "c" })).toBe(hint);
    b.exec = async () => ({ stdout: "", stderr: "ls: x: No such file or directory", exitCode: 1 });
    expect(await call(t.list, { path: "x" })).toBe(hint);
  });
  it("reading a directory points to list", async () => {
    const b = fakeBackend();
    b.readFile = async () => { throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" }); };
    expect(await call(createTools(b, ["read"]).read, { path: "src" })).toBe("error: src is a directory; use list");
    b.readFile = async () => { throw new Error('worker 500: {"error":"is a directory","code":"EISDIR"}'); };
    expect(await call(createTools(b, ["read"]).read, { path: "src" })).toBe("error: src is a directory; use list");
  });
  it("list runs ls -la with quoted path and falls back to stderr", async () => {
    const b = fakeBackend();
    const t = createTools(b, ["list"]);
    expect(await call(t.list, {})).toBe("ran ls -la '.'");
    expect(await call(t.list, { path: "it's" })).toBe("ran ls -la 'it'\\''s'");
    b.exec = async () => ({ stdout: "", stderr: "no such dir", exitCode: 1 });
    expect(await call(t.list, { path: "x" })).toBe("no such dir");
  });
  it("list with an empty path lists the root", async () => {
    const b = fakeBackend();
    const t = createTools(b, ["list"]);
    expect(await call(t.list, { path: "" })).toBe("ran ls -la '.'");
    b.exec = async () => ({ stdout: "", stderr: "ls: no such file", exitCode: 1 });
    expect(await call(t.list, { path: "" })).toBe("error: . does not exist; use list to see the files");
  });
  it("exec formats stdout, stderr and exit code, and truncates", async () => {
    const b = fakeBackend();
    const t = createTools(b, ["exec"]);
    expect(await call(t.exec, { command: "ls", cwd: "sub" })).toBe("ran ls");
    expect(b.exec).toHaveBeenCalledWith("ls", "sub");
    b.exec = async () => ({ stdout: "out", stderr: "bad", exitCode: 2 });
    expect(await call(t.exec, { command: "x" })).toBe("out\nstderr:\nbad\nexit code 2");
    b.exec = async () => ({ stdout: "x".repeat(20000), stderr: "", exitCode: 0 });
    const r = (await call(t.exec, { command: "x" })) as string;
    expect(r.endsWith("\n[truncated]")).toBe(true);
    expect(r.length).toBe(16000 + "\n[truncated]".length);
    b.exec = async () => { throw new Error("boom"); };
    expect(await call(t.exec, { command: "x" })).toBe("error: boom");
  });
});
