import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostBackend } from "../src/backend-host.ts";

describe("backend-host", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-")); });

  it("writeFile creates parent dirs and readFile reads relative and absolute paths", async () => {
    const b = createHostBackend(root);
    expect(b.root).toBe(root);
    await b.writeFile("a/b/c.txt", "hi");
    expect(await b.readFile("a/b/c.txt")).toBe("hi");
    expect(await b.readFile(path.join(root, "a/b/c.txt"))).toBe("hi");
  });
  it("exec runs in root by default and in cwd when given", async () => {
    const b = createHostBackend(root);
    fs.mkdirSync(path.join(root, "sub"));
    expect((await b.exec("pwd")).stdout.trim()).toBe(fs.realpathSync(root));
    expect((await b.exec("pwd", "sub")).stdout.trim()).toBe(fs.realpathSync(path.join(root, "sub")));
  });
  it("exec reports stderr and exit code", async () => {
    const r = await createHostBackend(root).exec("echo err >&2; exit 3");
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(3);
  });
  it("exec reports 124 on timeout", async () => {
    const b = createHostBackend(root);
    const orig = global.setTimeout;
    global.setTimeout = ((fn: () => void, _ms: number) => orig(fn, 50)) as typeof setTimeout;
    try {
      const r = await b.exec("sleep 5");
      expect(r.exitCode).toBe(124);
    } finally {
      global.setTimeout = orig;
    }
  });
  it("exec rejects when bash cannot start", async () => {
    await expect(createHostBackend(root).exec("true", "missing-dir")).rejects.toThrow();
  });
});
