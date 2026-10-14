import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui/App.ts";
import type { AgentEvent } from "../src/protocol.ts";

const tick = () => new Promise((r) => setTimeout(r, 50));

function setup() {
  let cb: (e: AgentEvent) => void = () => {};
  const unsub = vi.fn();
  const send = vi.fn();
  const detach = vi.fn();
  const stop = vi.fn();
  const subscribe = (c: (e: AgentEvent) => void) => {
    cb = c;
    return unsub;
  };
  const r = render(React.createElement(App, { subscribe, send, detach, stop }));
  const emit = async (...es: AgentEvent[]) => {
    await tick();
    for (const e of es) cb(e);
    await tick();
  };
  return { ...r, emit, unsub, send, detach, stop };
}

const hello: AgentEvent = {
  type: "hello", name: "bot", model: "m1", provider: "p", sandbox: true, id: "abc", readonly: false, workdir: "/w", history: [],
};

describe("App", () => {
  it("shows connecting before hello", () => {
    const { lastFrame } = setup();
    expect(lastFrame()).toContain("connecting…");
  });

  it("header shows name/model/sandbox after hello", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    expect(lastFrame()).toContain("bot · p/m1 · sandbox · abc");
    await emit({ ...hello, sandbox: false } as AgentEvent);
    expect(lastFrame()).toContain("no-sandbox");
  });

  it("hello history is replayed", async () => {
    const { lastFrame, emit } = setup();
    await emit({ ...hello, history: [{ type: "user", text: "old" }, { type: "text", delta: "re" }, { type: "done" }] } as AgentEvent);
    expect(lastFrame()).toContain("you ▸ old");
    expect(lastFrame()).toContain("agent ▸ re");
  });

  it("text events append to the live line", async () => {
    const { lastFrame, emit } = setup();
    await emit({ type: "user", text: "q" }, { type: "text", delta: "a" }, { type: "text", delta: "b" });
    expect(lastFrame()).toContain("agent ▸ ab");
  });

  it("done moves text to Static and clears live", async () => {
    const { lastFrame, emit } = setup();
    await emit({ type: "user", text: "q" }, { type: "text", delta: "ans" }, { type: "done" });
    const f = lastFrame() ?? "";
    expect(f).toContain("agent ▸ ans");
    expect(f.match(/agent ▸/g)?.length).toBe(1);
    expect(f).not.toMatch(/[⠋⠙⠹]/);
  });

  it("spinner cycles frames", async () => {
    const { lastFrame, emit } = setup();
    await emit({ type: "user", text: "q" });
    expect(lastFrame()).toContain("⠋");
    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame()).toMatch(/[⠙⠹]/);
  });

  it("tool line shows ✓ and ✗", async () => {
    const { lastFrame, emit } = setup();
    await emit(
      { type: "tool", name: "ls", input: { p: "." } },
      { type: "tool-result", name: "ls", ok: true, preview: "fine" },
      { type: "tool-result", name: "ls", ok: false, preview: "bad" },
    );
    const f = lastFrame() ?? "";
    expect(f).toContain('⚙ ls {"p":"."}');
    expect(f).toContain("→ ✓ fine");
    expect(f).toContain("→ ✗ bad");
  });

  it("error renders", async () => {
    const { lastFrame, emit } = setup();
    await emit({ type: "error", message: "boom" });
    expect(lastFrame()).toContain("error: boom");
  });

  it("typing then Enter calls send with the text and clears input", async () => {
    const { lastFrame, stdin, send } = setup();
    await tick();
    stdin.write("hi");
    await tick();
    expect(lastFrame()).toContain("› hi");
    stdin.write("\r");
    await tick();
    expect(send).toHaveBeenCalledWith("hi");
    expect(lastFrame()).not.toContain("› hi");
  });

  it("Enter with empty input does not send", async () => {
    const { stdin, send } = setup();
    await tick();
    stdin.write("\r");
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  it("Enter while a turn is in progress does not send", async () => {
    const { stdin, send, emit } = setup();
    await emit({ type: "user", text: "q" });
    stdin.write("x");
    await tick();
    stdin.write("\r");
    await tick();
    expect(send).not.toHaveBeenCalled();
  });

  const key = async (stdin: { write: (s: string) => void }, ...ks: string[]) => {
    for (const k of ks) { stdin.write(k); await tick(); }
  };

  it("Esc asks to stop the agent", async () => {
    const { stdin, detach, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b");
    expect(lastFrame()).toContain("Stop agent abc? [y/N]");
    expect(detach).not.toHaveBeenCalled();
  });

  it("Ctrl+C asks to stop the agent", async () => {
    const { stdin, detach, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u0003");
    expect(lastFrame()).toContain("Stop agent abc? [y/N]");
    expect(detach).not.toHaveBeenCalled();
  });

  it("a key other than y detaches without stopping", async () => {
    for (const k of ["n", "\r"]) {
      const { stdin, detach, stop, emit } = setup();
      await emit(hello);
      await key(stdin, "\u001b", k);
      expect(detach).toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("y on a no-sandbox agent stops it with apply", async () => {
    const { stdin, detach, stop, emit, lastFrame } = setup();
    await emit({ ...hello, sandbox: false } as AgentEvent);
    await key(stdin, "\u001b", "y");
    expect(stop).toHaveBeenCalledWith(true);
    expect(detach).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("stopping…");
  });

  it("y on a sandboxed agent asks to apply changes", async () => {
    const { stdin, stop, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y");
    expect(lastFrame()).toContain("Apply changes to /w? [Y/n]");
    expect(stop).not.toHaveBeenCalled();
  });

  it("Enter on the apply question stops and applies", async () => {
    const { stdin, stop, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "\r");
    expect(stop).toHaveBeenCalledWith(true);
    expect(lastFrame()).toContain("stopping…");
  });

  it("n on the apply question stops and discards", async () => {
    const { stdin, stop, emit } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "n");
    expect(stop).toHaveBeenCalledWith(false);
  });

  it("Esc on the apply question detaches", async () => {
    const { stdin, stop, detach, emit } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "\u001b");
    expect(detach).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("readonly hides the input and shows read-only", async () => {
    const { stdin, send, emit, lastFrame } = setup();
    await emit({ ...hello, readonly: true } as AgentEvent);
    await key(stdin, "hi", "\r");
    expect(lastFrame()).toContain("read-only · Esc to leave");
    expect(lastFrame()).not.toContain("› ");
    expect(send).not.toHaveBeenCalled();
  });

  it("unsubscribe called on unmount", () => {
    const { unmount, unsub } = setup();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});
