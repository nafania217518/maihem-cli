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
  const subscribe = (c: (e: AgentEvent) => void) => {
    cb = c;
    return unsub;
  };
  const r = render(React.createElement(App, { subscribe, send, detach }));
  const emit = async (...es: AgentEvent[]) => {
    await tick();
    for (const e of es) cb(e);
    await tick();
  };
  return { ...r, emit, unsub, send, detach };
}

const hello: AgentEvent = {
  type: "hello", name: "bot", model: "m1", provider: "p", sandbox: true, id: "abc", history: [],
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

  it("Escape calls detach", async () => {
    const { stdin, detach } = setup();
    await tick();
    stdin.write("\u001b");
    await tick();
    expect(detach).toHaveBeenCalled();
  });

  it("Ctrl+C calls detach", async () => {
    const { stdin, detach } = setup();
    await tick();
    stdin.write("\u0003");
    await tick();
    expect(detach).toHaveBeenCalled();
  });

  it("unsubscribe called on unmount", () => {
    const { unmount, unsub } = setup();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});
