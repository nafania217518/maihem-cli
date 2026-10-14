import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { attach } from "../src/attach.ts";
import { encode, lineSplitter } from "../src/protocol.ts";

const sockPath = path.join(os.tmpdir(), `maihem-attach-${process.pid}.sock`);
let server: net.Server;
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function fakeIo() {
  let out = "";
  const stdout = Object.assign(new Writable({ write(c, _e, cb) { out += c; cb(); } }), { columns: 80, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  return { stdin, stdout, out: () => out };
}

describe("attach", () => {
  it("sends msg to the server and renders the echoed reply", async () => {
    const received: unknown[] = [];
    server = net.createServer((c) => {
      c.write(encode({ type: "hello", name: "bot", model: "m", provider: "p", sandbox: false, id: "x1", history: [] }));
      c.on("data", lineSplitter((o) => {
        received.push(o);
        const { text } = o as { text: string };
        c.write(encode({ type: "user", text }) + encode({ type: "text", delta: `echo:${text}` }) + encode({ type: "done" }));
      }));
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    const io = fakeIo();
    const done = attach(sockPath, { stdin: io.stdin, stdout: io.stdout });
    await new Promise((r) => setTimeout(r, 100));
    io.stdin.write("hey");
    await new Promise((r) => setTimeout(r, 50));
    io.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ type: "msg", text: "hey" }]);
    expect(io.out()).toContain("bot · p/m");
    expect(io.out()).toContain("echo:hey");
    io.stdin.write("\u001b");
    await done;
  });

  it("rejects when the socket does not exist", async () => {
    server = net.createServer();
    await expect(attach(path.join(os.tmpdir(), "nope.sock"))).rejects.toThrow();
  });
});
