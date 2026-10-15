import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui/App.ts";
import stringWidth from "string-width";
import chalk from "chalk";
import type { AgentEvent } from "../src/protocol.ts";

const tick = () => new Promise((r) => setTimeout(r, 50));
const SIZE = { columns: 80, rows: 24 };

function setup(size = SIZE) {
  let cb: (e: AgentEvent) => void = () => {};
  const unsub = vi.fn();
  const send = vi.fn();
  const detach = vi.fn();
  const stop = vi.fn();
  const interrupt = vi.fn();
  const subscribe = (c: (e: AgentEvent) => void) => {
    cb = c;
    return unsub;
  };
  const r = render(React.createElement(App, { subscribe, send, detach, stop, interrupt, size }));
  const emit = async (...es: AgentEvent[]) => {
    await tick();
    for (const e of es) cb(e);
    await tick();
  };
  return { ...r, emit, unsub, send, detach, stop, interrupt };
}

const hello: AgentEvent = {
  type: "hello", name: "bot", model: "m1", provider: "p", sandbox: true, id: "abc", readonly: false, workdir: "/w", history: [],
};
const key = async (stdin: { write: (s: string) => void }, ...ks: string[]) => {
  for (const k of ks) { stdin.write(k); await tick(); }
};
const turn = (n: number, from = 1): AgentEvent[] => [
  { type: "user", text: "q" },
  { type: "text", delta: Array.from({ length: n }, (_, i) => `row${i + from}`).join("\n\n") },
  { type: "done" },
];
const rows = (f: string | undefined) => (f ?? "").split("\n");

describe("App", () => {
  it("header shows mascot, version, name, model, sandbox, workdir and id", async () => {
    const { lastFrame, emit } = setup();
    await emit({ ...hello, workdir: `${os.homedir()}/proj` } as AgentEvent);
    const f = lastFrame() ?? "";
    expect(f).toContain("▗▙   ▟▖");
    expect(f).toContain("▐█▀█▀█▌");
    expect(f).toContain("MAIHEM v0.1.1 · bot");
    expect(f).toContain("p/m1 · sandbox");
    expect(f).toContain("~/proj · abc");
    await emit({ ...hello, sandbox: false, readonly: true } as AgentEvent);
    expect(lastFrame()).toContain("p/m1 · no-sandbox · read-only");
  });

  it("layout fills the window height with input and footer at the bottom", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    const r = rows(lastFrame());
    expect(r.length).toBe(24);
    expect(r[21]).toContain("❯");
    expect(r[22]).toContain("─");
    expect(r[23]).toContain("? for shortcuts");
    expect(r[23]).toContain("simplified · ctrl+o for details");
  });

  it("chat sticks to the newest line", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, ...turn(30));
    expect(lastFrame()).toContain("row30");
    expect(lastFrame()).not.toContain("row1\n");
    expect(lastFrame()).not.toMatch(/row1\b/);
    expect(rows(lastFrame()).length).toBe(24);
  });

  it("pgup scrolls up and end jumps back", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, ...turn(30));
    await key(stdin, "\u001b[5~");
    expect(lastFrame()).not.toContain("row30");
    expect(lastFrame()).toContain("more lines · end to jump");
    await key(stdin, "\u001b[H");
    expect(lastFrame()).toMatch(/row1\b/);
    await key(stdin, "\u001b[6~", "\u001b[1;2B", "\u001b[1;2A");
    expect(lastFrame()).not.toMatch(/row1\b/);
    await key(stdin, "\u001b[F");
    expect(lastFrame()).toContain("row30");
    expect(lastFrame()).toContain("? for shortcuts");
  });

  it("new lines while scrolled up keep the view still and show the new-lines hint", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, ...turn(30));
    await key(stdin, "\u001b[5~");
    const before = lastFrame();
    await emit(...turn(2, 100));
    const after = rows(lastFrame());
    expect(after.slice(4, 18)).toEqual(rows(before).slice(4, 18));
    expect(lastFrame()).toMatch(/↓ \d+ more lines · end to jump/);
    expect(lastFrame()).not.toContain("row100");
  });

  it("ctrl+o toggles simplified and detailed", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "tool", id: "t", name: "read", input: { path: "a.txt", n: 7 } }, { type: "done" });
    expect(lastFrame()).toContain("read(a.txt)");
    expect(lastFrame()).not.toContain("── step");
    await key(stdin, "\u000f");
    expect(lastFrame()).toContain("── step 1");
    expect(lastFrame()).toContain('"n": 7');
    expect(lastFrame()).toContain("detailed · ctrl+o for simplified");
    expect(lastFrame()).not.toContain("❯ o");
    await key(stdin, "\u000f");
    expect(lastFrame()).toContain("simplified · ctrl+o for details");
  });

  it("footer shows ? for shortcuts when idle and esc to interrupt when busy", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    expect(lastFrame()).toContain("? for shortcuts");
    await emit({ type: "user", text: "q" });
    expect(lastFrame()).toContain("esc to interrupt");
    await emit({ type: "done" });
    expect(lastFrame()).toContain("? for shortcuts");
  });

  it("ctrl+d detaches without interrupting while busy", async () => {
    const { stdin, emit, detach, interrupt, stop } = setup();
    await emit(hello, { type: "user", text: "q" });
    await key(stdin, "\u0004");
    expect(detach).toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("ctrl+d detaches when idle without asking", async () => {
    const { stdin, emit, detach, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u0004");
    expect(detach).toHaveBeenCalled();
    expect(lastFrame()).not.toContain("Stop agent");
  });

  it("ctrl+d detaches while a question is open", async () => {
    const { stdin, emit, detach, stop } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "\u0004");
    expect(detach).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("ctrl+d does not land in the input", async () => {
    const { stdin, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "a", "b", "\u0004");
    expect(rows(lastFrame()).find((l) => l.includes("❯"))?.trim()).toBe("❯ ab");
  });

  it("busy footer shows esc to interrupt and ctrl+d to detach", async () => {
    const { emit, lastFrame } = setup();
    await emit(hello, { type: "user", text: "q" });
    expect(lastFrame()).toContain("esc to interrupt · ctrl+d to detach");
  });

  it("help panel lists ctrl+d detach", async () => {
    const { stdin, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "?");
    expect(lastFrame()).toContain("ctrl+d  detach");
  });

  it("? on empty input toggles the help panel", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello);
    await key(stdin, "?");
    let f = lastFrame() ?? "";
    expect(f).toContain("pgup/pgdn");
    expect(f).toContain("?  close help");
    expect(f).not.toContain("❯ ?");
    expect(rows(f).length).toBe(24);
    await key(stdin, "?");
    expect(lastFrame()).not.toContain("pgup/pgdn");
    await key(stdin, "?", "\u001b");
    expect(lastFrame()).not.toContain("pgup/pgdn");
    await key(stdin, "a", "?");
    f = lastFrame() ?? "";
    expect(f).toContain("❯ a?");
    expect(f).not.toContain("pgup/pgdn");
  });

  it("esc while busy calls interrupt", async () => {
    const { stdin, emit, interrupt, lastFrame } = setup();
    await emit(hello, { type: "user", text: "q" });
    await key(stdin, "\u001b");
    expect(interrupt).toHaveBeenCalled();
    expect(lastFrame()).not.toContain("Stop agent");
  });

  it("spinner shows a verb with elapsed time while busy", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "text", delta: "x".repeat(8000) });
    expect(lastFrame()).toMatch(/(Scheming|Plotting|Wreaking|Brewing|Conniving|Tinkering)… \(0s · ↓ 2k tokens\)/);
    const a = lastFrame();
    await new Promise((r) => setTimeout(r, 150));
    expect(lastFrame()).not.toBe(a);
    await emit({ type: "done" });
    expect(lastFrame()).not.toMatch(/tokens\)/);
  });

  it("spinner token count includes thinking", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "thinking", delta: "x".repeat(4000) }, { type: "text", delta: "x".repeat(4000) });
    expect(lastFrame()).toContain("↓ 2k tokens");
  });

  describe("spinner speed", () => {
    let now = 0;
    const at = (ms: number) => { now = ms; vi.setSystemTime(ms); };
    const wait = () => new Promise((r) => setTimeout(r, 200)); // > one 120 ms spinner tick
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(1_000_000); });
    afterEach(() => vi.useRealTimers());

    it("spinner shows the exact speed when a step ends", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "context", used: 10, tps: 42 });
      expect(lastFrame()).toContain("tokens · 42 tok/s)");
    });
    it("spinner shows a live speed estimate while a step streams", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      at(now + 2000);
      await emit({ type: "text", delta: "x".repeat(399) });
      await wait();
      expect(lastFrame()).toContain("· 50 tok/s)");
    });
    it("spinner speed refreshes at most once per second", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      await emit({ type: "context", used: 10, tps: 42 });
      at(now + 900); // 1 s of streaming, but only 900 ms after the exact value
      await emit({ type: "text", delta: "x".repeat(399) });
      at(now + 50);
      await wait();
      expect(lastFrame()).toContain("· 42 tok/s)");
      at(now + 1000);
      await wait();
      expect(lastFrame()).toMatch(/· \d+ tok\/s\)/);
      expect(lastFrame()).not.toContain("· 42 tok/s)");
    });
    it("spinner waits for 1 s of streaming before the first estimate", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      at(now + 500);
      await emit({ type: "text", delta: "x".repeat(399) });
      await wait();
      expect(lastFrame()).not.toContain("tok/s");
    });
    it("spinner shows no speed before any value exists", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "context", used: 10, tps: 42 }, { type: "done" }, { type: "user", text: "r" });
      await wait();
      expect(lastFrame()).toContain("tokens)");
      expect(lastFrame()).not.toContain("tok/s");
    });
  });

  it("thinking does not change the context gauge", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "context", used: 12300, budget: 64000 }, { type: "thinking", delta: "x".repeat(40000) });
    expect(lastFrame()).toContain("ctx 12.3k/64k · 19%");
  });

  it("shows connecting before hello", () => {
    const { lastFrame } = setup();
    expect(lastFrame()).toContain("connecting…");
  });

  it("typing then Enter calls send with the text and clears input", async () => {
    const { lastFrame, stdin, send } = setup();
    await tick();
    stdin.write("hi");
    await tick();
    expect(lastFrame()).toContain("❯ hi");
    stdin.write("\r");
    await tick();
    expect(send).toHaveBeenCalledWith("hi");
    expect(lastFrame()).not.toContain("❯ hi");
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

  it("esc while idle asks to stop the agent", async () => {
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
    expect(lastFrame()).not.toContain("❯ ");
    expect(send).not.toHaveBeenCalled();
  });

  it("unsubscribe called on unmount", () => {
    const { unmount, unsub } = setup();
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
  const LONG = "/private/tmp/claude-501/-Users-oleksiiyakovenko-claude-projects-maihem-cli/7b5ea6df-27ae-4853-a94b-4c03cca8ba83/scratchpad/wd";

  it("a long workdir is shortened in the middle and the header stays 3 rows", async () => {
    const { emit, lastFrame } = setup({ columns: 60, rows: 20 });
    await emit({ ...hello, workdir: LONG, name: "n".repeat(80), model: "m".repeat(80) } as AgentEvent);
    const r = rows(lastFrame());
    expect(r.length).toBe(20);
    expect(r[0]).toContain("MAIHEM");
    expect(r[2]).toContain("abc");
    expect(r[2]).toContain("…");
    expect(r[2]).toContain("/private");
    expect(r[2]).toContain("wd · abc");
  });

  it("the frame never exceeds the window height with long single-line texts", async () => {
    const { stdin, emit, lastFrame } = setup({ columns: 40, rows: 16 });
    await emit({ ...hello, workdir: LONG } as AgentEvent);
    await key(stdin, "\u001b", "y");
    const r = rows(lastFrame());
    expect(r.length).toBe(16);
    expect(r[0]).toContain("MAIHEM");
    expect(lastFrame()).toContain("? [Y/n]");
  });
  it("no frame line is wider than the window", async () => {
    const wide: AgentEvent = { type: "hello", name: "local-helper", provider: "ollama", model: "qwen3.5:9b-mlx", sandbox: false, readonly: false, id: "797e017b13aa", workdir: "/private/tmp/claude-501/-Users-oleksiiyakovenko-claude-projects-maihem-cli/7b5ea6df-27ae-4853-a94b-4c03cca8ba83/scratchpad/wd", history: [] };
    for (const size of [{ columns: 100, rows: 30 }, { columns: 60, rows: 20 }]) {
      const { lastFrame, emit, unmount } = setup(size);
      await emit(wide);
      for (const line of lastFrame()!.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(size.columns);
      unmount();
    }
  });

  const last = (f: string | undefined) => rows(f).at(-1)!;

  it("footer gauge shows used, budget and percent", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    expect(lastFrame()).not.toContain("ctx ");
    await emit({ type: "context", used: 12300, budget: 64000 });
    expect(last(lastFrame())).toMatch(/ctx 12\.3k\/64k · 19%.*simplified/);
  });

  it("gauge turns yellow at 70% and red at 90%", async () => {
    chalk.level = 3;
    const { lastFrame, emit } = setup();
    const color = async (used: number) => {
      await emit({ type: "context", used, budget: 100 });
      return last(lastFrame()).match(/(\x1b\[[\d;]*m)+ctx/)?.[0] ?? "";
    };
    await emit(hello);
    const low = await color(10);
    const mid = await color(70);
    const high = await color(90);
    expect(new Set([low, mid, high]).size).toBe(3);
    expect(mid).toContain("38;2;255;193;7");
    expect(high).toContain("38;2;255;107;128");
    chalk.level = 0;
  });

  it("gauge shows only used tokens without a budget", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "context", used: 12300 });
    expect(last(lastFrame())).toContain("ctx 12.3k ·");
    expect(last(lastFrame())).not.toContain("%");
  });

  it("gauge updates after compaction", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "context", used: 52100, budget: 64000 }, { type: "compacted", before: 52100, after: 8700 });
    expect(last(lastFrame())).toContain("ctx 8.7k/64k · 14%");
    await emit({ type: "context", used: 9000, budget: 64000 });
    expect(last(lastFrame())).toContain("ctx 9k/64k");
  });
});
