import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { App, replaySource } from "../src/ui/App.ts";
import stringWidth from "string-width";
import chalk from "chalk";
import type { AgentEvent } from "../src/protocol.ts";
import { VERSION } from "../src/version.ts";

const tick = () => new Promise((r) => setTimeout(r, 50));
const SIZE = { columns: 80, rows: 24 };
// Ink renders asynchronously: wait for the expected frame instead of a fixed sleep.
const see = (fn: () => void) => vi.waitFor(fn, { timeout: 2000, interval: 10 });
let frame: () => string | undefined = () => "";
// Wait (softly) until the frame changes, so the next input sees the new state.
const changed = (before: string | undefined) =>
  vi.waitFor(() => { if (frame() === before) throw new Error("same frame"); }, { timeout: 1000, interval: 5 }).catch(() => {});

function setup(size = SIZE, view?: boolean) {
  let cb: (e: AgentEvent) => void = () => {};
  let subscribed = false;
  const unsub = vi.fn();
  const send = vi.fn();
  const detach = vi.fn();
  const stop = vi.fn();
  const interrupt = vi.fn();
  const subscribe = (c: (e: AgentEvent) => void) => {
    cb = c;
    subscribed = true;
    return unsub;
  };
  const r = render(React.createElement(App, { subscribe, send, detach, stop, interrupt, size, view }));
  frame = r.lastFrame;
  const emit = async (...es: AgentEvent[]) => {
    await tick();
    await see(() => expect(subscribed).toBe(true));
    const before = r.lastFrame();
    for (const e of es) cb(e);
    await tick();
    await changed(before);
  };
  return { ...r, emit, unsub, send, detach, stop, interrupt };
}

const hello: AgentEvent = {
  type: "hello", name: "bot", model: "m1", provider: "p", sandbox: true, id: "abc", readonly: false, workdir: "/w", history: [],
};
const key = async (stdin: { write: (s: string) => void; listenerCount: (e: string) => number }, ...ks: string[]) => {
  // Ink drops input written before it attaches its stdin listener (a passive effect).
  await see(() => expect(stdin.listenerCount("readable")).toBeGreaterThan(0));
  for (const [i, k] of ks.entries()) {
    const before = frame();
    stdin.write(k);
    await tick();
    // The next key must see the new state. A lone Esc is delivered late (Ink waits for a sequence).
    if (i < ks.length - 1 || k === "\u001b") await changed(before);
  }
};
const turn = (n: number, from = 1): AgentEvent[] => [
  { type: "user", text: "q" },
  { type: "text", delta: Array.from({ length: n }, (_, i) => `row${i + from}`).join("\n\n") },
  { type: "done" },
];
const rows = (f: string | undefined) => (f ?? "").split("\n");

afterEach(cleanup);

describe("App", () => {
  it("header shows mascot, version, name, model, sandbox, workdir and id", async () => {
    const { lastFrame, emit } = setup();
    await emit({ ...hello, workdir: `${os.homedir()}/proj` } as AgentEvent);
    await see(() => expect(lastFrame()).toContain("~/proj · abc"));
    const f = lastFrame() ?? "";
    expect(f).toContain("▗▙   ▟▖");
    expect(f).toContain("▐█▀█▀█▌");
    expect(f).toContain(`MAIHEM v${VERSION} · bot`);
    expect(f).toContain("p/m1 · sandbox");
    expect(f).toContain("~/proj · abc");
    await emit({ ...hello, sandbox: false, readonly: true } as AgentEvent);
    await see(() => expect(lastFrame()).toContain("p/m1 · no-sandbox · read-only"));
  });

  it("layout fills the window height with input and footer at the bottom", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
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
    await see(() => expect(lastFrame()).toContain("row30"));
    expect(lastFrame()).not.toContain("row1\n");
    expect(lastFrame()).not.toMatch(/row1\b/);
    await see(() => expect(rows(lastFrame()).length).toBe(24));
  });

  it("pgup scrolls up and end jumps back", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, ...turn(30));
    await key(stdin, "\u001b[5~");
    await see(() => expect(lastFrame()).toContain("more lines · end to jump"));
    expect(lastFrame()).not.toContain("row30");
    await key(stdin, "\u001b[H");
    await see(() => expect(lastFrame()).toMatch(/row1\b/));
    await key(stdin, "\u001b[6~", "\u001b[1;2B", "\u001b[1;2A");
    await see(() => expect(lastFrame()).not.toMatch(/row1\b/));
    await key(stdin, "\u001b[F");
    await see(() => expect(lastFrame()).toContain("row30"));
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
  });

  it("new lines while scrolled up keep the view still and show the new-lines hint", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, ...turn(30));
    await key(stdin, "\u001b[5~");
    await see(() => expect(lastFrame()).toContain("more lines · end to jump"));
    const before = lastFrame();
    await emit(...turn(2, 100));
    await see(() => expect(lastFrame()).toMatch(/↓ \d+ more lines · end to jump/));
    await see(() => expect(rows(lastFrame()).slice(4, 18)).toEqual(rows(before).slice(4, 18)));
    expect(lastFrame()).not.toContain("row100");
  });

  it("ctrl+o toggles simplified and detailed", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "tool", id: "t", name: "read", input: { path: "a.txt", n: 7 } }, { type: "done" });
    await see(() => expect(lastFrame()).toContain("read(a.txt)"));
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
    expect(lastFrame()).not.toContain("── step");
    await key(stdin, "\u000f");
    await see(() => expect(lastFrame()).toContain("── step 1"));
    await see(() => expect(lastFrame()).toContain('"n": 7'));
    await see(() => expect(lastFrame()).toContain("detailed · ctrl+o for simplified"));
    expect(lastFrame()).not.toContain("❯ o");
    await key(stdin, "\u000f");
    await see(() => expect(lastFrame()).toContain("simplified · ctrl+o for details"));
  });

  it("footer shows ? for shortcuts when idle and esc to interrupt when busy", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
    await emit({ type: "user", text: "q" });
    await see(() => expect(lastFrame()).toContain("esc to interrupt"));
    await emit({ type: "done" });
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
  });

  it("ctrl+d detaches without interrupting while busy", async () => {
    const { stdin, emit, detach, interrupt, stop } = setup();
    await emit(hello, { type: "user", text: "q" });
    await key(stdin, "\u0004");
    await see(() => expect(detach).toHaveBeenCalled());
    expect(interrupt).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("ctrl+d detaches when idle without asking", async () => {
    const { stdin, emit, detach, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u0004");
    await see(() => expect(detach).toHaveBeenCalled());
    expect(lastFrame()).not.toContain("Stop agent");
  });

  it("ctrl+d detaches while a question is open", async () => {
    const { stdin, emit, detach, stop } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "\u0004");
    await see(() => expect(detach).toHaveBeenCalled());
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
    await see(() => expect(lastFrame()).toContain("esc to interrupt · ctrl+d to detach"));
  });

  it("help panel lists ctrl+d detach", async () => {
    const { stdin, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "?");
    await see(() => expect(lastFrame()).toContain("ctrl+d  detach"));
  });

  it("? on empty input toggles the help panel", async () => {
    const { lastFrame, emit, stdin } = setup();
    await emit(hello);
    await key(stdin, "?");
    await see(() => expect(lastFrame()).toContain("?  close help"));
    let f = lastFrame() ?? "";
    expect(f).toContain("pgup/pgdn");
    expect(f).toContain("?  close help");
    expect(f).not.toContain("❯ ?");
    expect(rows(f).length).toBe(24);
    await key(stdin, "?");
    await see(() => expect(lastFrame()).not.toContain("pgup/pgdn"));
    await key(stdin, "?", "\u001b");
    await see(() => expect(lastFrame()).not.toContain("pgup/pgdn"));
    await key(stdin, "a", "?");
    await see(() => expect(lastFrame()).toContain("❯ a?"));
    f = lastFrame() ?? "";
    expect(f).toContain("❯ a?");
    expect(f).not.toContain("pgup/pgdn");
  });

  it("esc while busy calls interrupt", async () => {
    const { stdin, emit, interrupt, lastFrame } = setup();
    await emit(hello, { type: "user", text: "q" });
    await key(stdin, "\u001b");
    await see(() => expect(interrupt).toHaveBeenCalled());
    expect(lastFrame()).not.toContain("Stop agent");
  });

  it("spinner shows a verb with elapsed time while busy", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "text", delta: "x".repeat(8000) });
    await see(() => expect(lastFrame()).toMatch(/(Scheming|Plotting|Wreaking|Brewing|Conniving|Tinkering)… \(0s · ↓ 2k tokens\)/));
    const a = lastFrame();
    await see(() => expect(lastFrame()).not.toBe(a));
    await emit({ type: "done" });
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
    expect(lastFrame()).not.toMatch(/tokens\)/);
  });

  it("spinner token count includes thinking", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "thinking", delta: "x".repeat(4000) }, { type: "text", delta: "x".repeat(4000) });
    await see(() => expect(lastFrame()).toContain("↓ 2k tokens"));
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
      await see(() => expect(lastFrame()).toContain("tokens · 42 tok/s)"));
    });
    it("spinner shows a live speed estimate while a step streams", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      at(now + 2000);
      await emit({ type: "text", delta: "x".repeat(399) });
      await wait();
      await see(() => expect(lastFrame()).toContain("· 50 tok/s)"));
    });
    it("spinner speed refreshes at most once per second", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      await emit({ type: "context", used: 10, tps: 42 });
      at(now + 900); // 1 s of streaming, but only 900 ms after the exact value
      await emit({ type: "text", delta: "x".repeat(399) });
      at(now + 50);
      await wait();
      await see(() => expect(lastFrame()).toContain("· 42 tok/s)"));
      at(now + 1000);
      await wait();
      await see(() => { expect(lastFrame()).toMatch(/· \d+ tok\/s\)/); expect(lastFrame()).not.toContain("· 42 tok/s)"); });
    });
    it("spinner waits for 1 s of streaming before the first estimate", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "step" }, { type: "text", delta: "x" });
      at(now + 500);
      await emit({ type: "text", delta: "x".repeat(399) });
      await wait();
      await see(() => expect(lastFrame()).toContain("tokens)"));
      expect(lastFrame()).not.toContain("tok/s");
    });
    it("spinner shows no speed before any value exists", async () => {
      const { lastFrame, emit } = setup();
      await emit(hello, { type: "user", text: "q" }, { type: "context", used: 10, tps: 42 }, { type: "done" }, { type: "user", text: "r" });
      await wait();
      await see(() => expect(lastFrame()).toContain("tokens)"));
      expect(lastFrame()).not.toContain("tok/s");
    });
  });

  it("thinking does not change the context gauge", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "user", text: "q" }, { type: "context", used: 12300, budget: 64000 }, { type: "thinking", delta: "x".repeat(40000) });
    await see(() => expect(lastFrame()).toContain("ctx 12.3k/64k · 19%"));
  });

  it("shows connecting before hello", async () => {
    const { lastFrame } = setup();
    await see(() => expect(lastFrame()).toContain("connecting…"));
  });

  it("typing then Enter calls send with the text and clears input", async () => {
    const { lastFrame, stdin, send } = setup();
    await tick();
    await key(stdin, "hi");
    await see(() => expect(lastFrame()).toContain("❯ hi"));
    await key(stdin, "\r");
    await see(() => expect(send).toHaveBeenCalledWith("hi"));
    await see(() => expect(lastFrame()).not.toContain("❯ hi"));
  });

  it("Enter with empty input does not send", async () => {
    const { stdin, send } = setup();
    await tick();
    await key(stdin, "\r");
    expect(send).not.toHaveBeenCalled();
  });

  it("Enter while a turn is in progress does not send", async () => {
    const { stdin, send, emit } = setup();
    await emit({ type: "user", text: "q" });
    await key(stdin, "x");
    await key(stdin, "\r");
    expect(send).not.toHaveBeenCalled();
  });

  it("esc while idle asks to stop the agent", async () => {
    const { stdin, detach, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b");
    await see(() => expect(lastFrame()).toContain("Stop agent abc? [y/N]"));
    expect(detach).not.toHaveBeenCalled();
  });

  it("Ctrl+C asks to stop the agent", async () => {
    const { stdin, detach, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u0003");
    await see(() => expect(lastFrame()).toContain("Stop agent abc? [y/N]"));
    expect(detach).not.toHaveBeenCalled();
  });

  it("a key other than y detaches without stopping", async () => {
    for (const k of ["n", "\r"]) {
      const { stdin, detach, stop, emit } = setup();
      await emit(hello);
      await key(stdin, "\u001b", k);
      await see(() => expect(detach).toHaveBeenCalled());
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("y on a no-sandbox agent stops it with apply", async () => {
    const { stdin, detach, stop, emit, lastFrame } = setup();
    await emit({ ...hello, sandbox: false } as AgentEvent);
    await key(stdin, "\u001b", "y");
    await see(() => expect(stop).toHaveBeenCalledWith(true));
    expect(detach).not.toHaveBeenCalled();
    await see(() => expect(lastFrame()).toContain("stopping…"));
  });

  it("y on a sandboxed agent asks to apply changes", async () => {
    const { stdin, stop, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y");
    await see(() => expect(lastFrame()).toContain("Apply changes to /w? [Y/n]"));
    expect(stop).not.toHaveBeenCalled();
  });

  it("Enter on the apply question stops and applies", async () => {
    const { stdin, stop, emit, lastFrame } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "\r");
    await see(() => expect(stop).toHaveBeenCalledWith(true));
    await see(() => expect(lastFrame()).toContain("stopping…"));
  });

  it("n on the apply question stops and discards", async () => {
    const { stdin, stop, emit } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "n");
    await see(() => expect(stop).toHaveBeenCalledWith(false));
  });

  it("Esc on the apply question detaches", async () => {
    const { stdin, stop, detach, emit } = setup();
    await emit(hello);
    await key(stdin, "\u001b", "y", "\u001b");
    await see(() => expect(detach).toHaveBeenCalled());
    expect(stop).not.toHaveBeenCalled();
  });

  it("readonly hides the input and shows read-only", async () => {
    const { stdin, send, emit, lastFrame } = setup();
    await emit({ ...hello, readonly: true } as AgentEvent);
    await key(stdin, "hi", "\r");
    await see(() => expect(lastFrame()).toContain("read-only · Esc to leave"));
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
    await see(() => expect(lastFrame()).toContain("wd · abc"));
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
    await see(() => expect(lastFrame()).toContain("? [Y/n]"));
    const r = rows(lastFrame());
    expect(r.length).toBe(16);
    expect(r[0]).toContain("MAIHEM");
    await see(() => expect(lastFrame()).toContain("? [Y/n]"));
  });
  it("no frame line is wider than the window", async () => {
    const wide: AgentEvent = { type: "hello", name: "local-helper", provider: "ollama", model: "qwen3.5:9b-mlx", sandbox: false, readonly: false, id: "797e017b13aa", workdir: "/private/tmp/claude-501/-Users-oleksiiyakovenko-claude-projects-maihem-cli/7b5ea6df-27ae-4853-a94b-4c03cca8ba83/scratchpad/wd", history: [] };
    for (const size of [{ columns: 100, rows: 30 }, { columns: 60, rows: 20 }]) {
      const { lastFrame, emit, unmount } = setup(size);
      await emit(wide);
      await see(() => expect(lastFrame()).toContain("797e017b13aa"));
      for (const line of lastFrame()!.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(size.columns);
      unmount();
    }
  });

  const last = (f: string | undefined) => rows(f).at(-1)!;

  it("footer gauge shows used, budget and percent", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello);
    await see(() => expect(lastFrame()).toContain("? for shortcuts"));
    expect(lastFrame()).not.toContain("ctx ");
    await emit({ type: "context", used: 12300, budget: 64000 });
    await see(() => expect(last(lastFrame())).toMatch(/ctx 12\.3k\/64k · 19%.*simplified/));
  });

  it("gauge turns yellow at 70% and red at 90%", async () => {
    chalk.level = 3;
    const { lastFrame, emit } = setup();
    const color = async (used: number) => {
      await emit({ type: "context", used, budget: 100 });
      await see(() => expect(last(lastFrame())).toContain(`ctx ${used}/100`));
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
    await see(() => expect(last(lastFrame())).toContain("ctx 12.3k ·"));
    expect(last(lastFrame())).not.toContain("%");
  });

  it("gauge updates after compaction", async () => {
    const { lastFrame, emit } = setup();
    await emit(hello, { type: "context", used: 52100, budget: 64000 }, { type: "compacted", before: 52100, after: 8700 });
    await see(() => expect(last(lastFrame())).toContain("ctx 8.7k/64k · 14%"));
    await emit({ type: "context", used: 9000, budget: 64000 });
    await see(() => expect(last(lastFrame())).toContain("ctx 9k/64k"));
  });
  it("a replay feeds the saved events as history", async () => {
    const { type: _t, history: _h, ...base } = hello as Extract<AgentEvent, { type: "hello" }>;
    const subscribe = replaySource(base, [{ type: "user", text: "old question" }, { type: "text", delta: "old answer" }, { type: "done" }]);
    const r = render(React.createElement(App, { subscribe, send: vi.fn(), detach: vi.fn(), stop: vi.fn(), interrupt: vi.fn(), size: SIZE, view: true }));
    await see(() => expect(r.lastFrame()).toContain("old question"));
    expect(r.lastFrame()).toContain("old answer");
  });
  it("in view mode Esc and Ctrl+C leave without the stop prompt", async () => {
    for (const k of ["\u001b", "\u0003"]) {
      const { stdin, emit, detach, stop, lastFrame } = setup(SIZE, true);
      await emit({ ...hello, readonly: true } as AgentEvent);
      await key(stdin, k);
      await see(() => expect(detach).toHaveBeenCalledTimes(1));
      expect(lastFrame()).not.toContain("Stop agent");
      expect(stop).not.toHaveBeenCalled();
      cleanup();
    }
  });
  it("in view mode there is no input line", async () => {
    const { lastFrame, emit } = setup(SIZE, true);
    await emit(hello);
    await see(() => expect(lastFrame()).toContain("read-only · Esc to go back"));
    expect(lastFrame()).not.toContain("❯");
  });
});
