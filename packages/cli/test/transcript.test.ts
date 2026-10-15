import { describe, it, expect } from "vitest";
import { stripVTControlCharacters as strip } from "node:util";
import chalk from "chalk";
import stringWidth from "string-width";
import type { AgentEvent } from "../src/protocol.ts";
import { k, toBlocks, renderBlock, renderTranscript, theme, type Block } from "../src/ui/transcript.ts";

const S = { width: 60, detailed: false };
const D = { width: 60, detailed: true };
const txt = (l: string[]) => l.map(strip);
const tool = (n: number, ok = true): Block => ({
  kind: "tool", id: "1", name: "read", input: { path: "a.txt" },
  result: { ok, output: Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") },
});

describe("toBlocks", () => {
  it("builds blocks from events", () => {
    const b = toBlocks([
      { type: "hello" } as never,
      { type: "user", text: "hi", at: 1000 },
      { type: "text", delta: "a" }, { type: "text", delta: "b" },
      { type: "step" },
      { type: "tool", id: "t", name: "write", input: {} },
      { type: "tool-result", id: "t", name: "write", ok: true, output: "ok" },
      { type: "text", delta: "c" },
      { type: "step" },
      { type: "error", message: "x" },
      { type: "done", at: 3500, usage: { inputTokens: 5 } },
      { type: "user", text: "again" }, { type: "step" },
    ]);
    expect(b.map((x) => x.kind)).toEqual(["user", "agent", "step", "tool", "agent", "step", "error", "turn-end", "user", "step"]);
    expect(b[1]).toMatchObject({ text: "ab" });
    expect(b[3]).toMatchObject({ result: { ok: true, output: "ok" } });
    expect(b[5]).toMatchObject({ n: 2 });
    expect(b[7]).toMatchObject({ ms: 2500, usage: { inputTokens: 5 } });
    expect(b[9]).toMatchObject({ n: 1 });
  });
});

describe("renderBlock", () => {
  it("user block renders with the ❯ prompt", () => {
    chalk.level = 1;
    const l = renderBlock({ kind: "user", text: "hello" }, S);
    expect(strip(l[0])).toBe("❯ hello".padEnd(60));
    expect(l[0]).toMatch(/\x1b\[(4|10)\d/);
    chalk.level = 0;
  });

  it("agent text renders Markdown bold and lists", () => {
    const l = txt(renderBlock({ kind: "agent", text: "**bold** text\n\n- one\n- two\n\n" }, S));
    expect(l[0].startsWith("● ")).toBe(true);
    expect(l.slice(1).every((x) => x === "" || x.startsWith("  "))).toBe(true);
    expect(l.join("\n")).not.toContain("**");
    expect(l.join("\n")).toMatch(/one[\s\S]*two/);
    expect(l.at(-1)!.trim()).not.toBe("");
  });

  it("lines wrap to the given width", () => {
    const long = "word ".repeat(40);
    for (const b of [{ kind: "agent", text: long }, { kind: "tool", id: "1", name: "bash", input: { command: long }, result: { ok: true, output: long } }] as Block[]) {
      for (const o of [{ width: 30, detailed: false }, { width: 30, detailed: true }]) {
        const l = txt(renderBlock(b, o));
        expect(l.every((x) => x.length <= 30)).toBe(true);
        expect(l.slice(1).every((x) => x.startsWith("  "))).toBe(true);
      }
    }
  });

  it("simplified tool block shows name and first string argument", () => {
    expect(txt(renderBlock({ kind: "tool", id: "1", name: "write", input: { path: "hello.txt", content: "x" } }, S))).toEqual(["● write(hello.txt)"]);
    expect(txt(renderBlock({ kind: "tool", id: "1", name: "bash", input: { n: 1, q: "ls" } }, S))[0]).toBe("● bash(ls)");
    expect(txt(renderBlock({ kind: "tool", id: "1", name: "x", input: null }, S))[0]).toBe("● x()");
    const cut = txt(renderBlock({ kind: "tool", id: "1", name: "bash", input: { command: "a".repeat(100) } }, S))[0];
    expect(cut.length).toBe(60);
    expect(cut.endsWith("…)")).toBe(true);
    chalk.level = 1;
    const dim = renderBlock({ kind: "tool", id: "1", name: "x", input: {} }, S)[0];
    const ok = renderBlock(tool(1), S)[0];
    expect(dim).toContain("\x1b[2m●");
    expect(ok).not.toBe(dim);
    chalk.level = 0;
  });

  it("simplified tool output folds after 3 lines with the +N hint", () => {
    expect(txt(renderBlock(tool(6), S))).toEqual([
      "● read(a.txt)", "  ⎿  line1", "     line2", "     line3", "     … +3 lines (ctrl+o to expand)",
    ]);
  });

  it("one hidden line is shown instead of the hint", () => {
    expect(txt(renderBlock(tool(4), S))).toEqual(["● read(a.txt)", "  ⎿  line1", "     line2", "     line3", "     line4"]);
  });

  it("failed tool marks the call as failed", () => {
    chalk.level = 1;
    const ok = renderBlock(tool(1), S);
    const bad = renderBlock(tool(1, false), S);
    expect(bad[0]).not.toBe(ok[0]);
    expect(bad[1]).not.toBe(ok[1]);
    expect(bad[1]).toBe(chalk.hex(theme.error)("  ⎿  line1"));
    chalk.level = 0;
  });

  it("detailed tool block shows full input and full output", () => {
    expect(txt(renderBlock(tool(6), D))).toEqual([
      "● read", "  ⎿  {", '       "path": "a.txt"', "     }",
      "  ⎿  line1", "     line2", "     line3", "     line4", "     line5", "     line6",
    ]);
  });

  it("detailed blocks carry hh:mm:ss timestamps", () => {
    const at = new Date(2026, 0, 1, 9, 5, 7).getTime();
    for (const b of [
      { kind: "user", text: "hi", at }, { kind: "agent", text: "hi", at },
      { kind: "tool", id: "1", name: "x", input: {}, at }, { kind: "error", message: "m", at },
    ] as Block[]) {
      const l = txt(renderBlock(b, D))[0];
      expect(l.trimEnd().endsWith("09:05:07")).toBe(true);
      expect(l.trimEnd().length).toBe(60);
      expect(txt(renderBlock(b, S))[0]).not.toContain("09:05:07");
    }
    expect(txt(renderBlock({ kind: "error", message: "m" }, D))).toEqual(["● Error: m"]);
  });

  it("detailed view shows step dividers and turn tokens with duration", () => {
    const step = txt(renderBlock({ kind: "step", n: 2 }, D))[0];
    expect(step.startsWith("── step 2 ──")).toBe(true);
    expect(step).toBe("── step 2 " + "─".repeat(50));
    expect(txt(renderBlock({ kind: "turn-end", usage: { inputTokens: 1234, outputTokens: 340 }, ms: 12400 }, D))).toEqual(["  ⎿  ↑ 1.2k ↓ 340 tokens · 12.4s"]);
    expect(txt(renderBlock({ kind: "turn-end", ms: 500 }, D))).toEqual(["  ⎿  0.5s"]);
    expect(renderBlock({ kind: "turn-end" }, D)).toEqual([]);
  });

  it("simplified view hides step and turn-end blocks", () => {
    expect(renderBlock({ kind: "step", n: 1 }, S)).toEqual([]);
    expect(renderBlock({ kind: "turn-end", ms: 5 }, S)).toEqual([]);
  });

  it("interrupted turn shows Interrupted", () => {
    expect(txt(renderBlock({ kind: "turn-end", interrupted: true }, S))).toEqual(["  ⎿  Interrupted"]);
    expect(txt(renderBlock({ kind: "turn-end", interrupted: true, ms: 5 }, D))).toEqual(["  ⎿  Interrupted"]);
  });

  it("error block renders in red", () => {
    expect(txt(renderBlock({ kind: "error", message: "boom" }, S))).toEqual(["● Error: boom"]);
  });

  it("wide characters count as two columns", () => {
    for (const b of [{ kind: "user", text: "你好世界🎉".repeat(8) }, { kind: "agent", text: "日本語のテキスト".repeat(6) }, { kind: "user", text: "漢字", at: 0 }] as Block[]) {
      for (const o of [S, D]) expect(txt(renderBlock(b, o)).every((x) => stringWidth(x) <= 60)).toBe(true);
    }
  });

  it("markdown lists indent by 2 and headings have no # prefix", () => {
    const l = txt(renderBlock({ kind: "agent", text: "# Title\n\npara\n\n- one\n- two" }, S));
    expect(l).toEqual(["● Title", "", "  para", "", "    * one", "    * two"]);
  });

  it("cache reuses lines of unchanged blocks", () => {
    const b: Block = { kind: "user", text: "x" };
    const a = renderBlock(b, S);
    expect(renderBlock(b, { ...S })).toBe(a);
    expect(renderBlock(b, D)).not.toBe(a);
    expect(renderBlock({ ...b }, S)).not.toBe(a);
  });
});

describe("renderTranscript", () => {
  it("joins blocks with one empty line and skips empty ones", () => {
    const l = txt(renderTranscript([{ kind: "user", text: "a" }, { kind: "step", n: 1 }, { kind: "error", message: "e" }], S));
    expect(l.map((x) => x.trimEnd())).toEqual(["❯ a", "", "● Error: e"]);
  });
});

describe("agent signals", () => {
  const both = (b: Block[]) => [S, D].map((o) => txt(renderTranscript(b, o)));

  it("thinking is collapsed in simplified and full in detailed", () => {
    chalk.level = 1;
    const b = toBlocks([{ type: "thinking", delta: "a b" }, { type: "thinking", delta: "\nc" }, { type: "text", delta: "x" }]);
    expect(b.map((x) => x.kind)).toEqual(["thinking", "agent"]);
    const s = renderBlock(b[0], S);
    expect(txt(s)).toEqual(["∴ Thinking (ctrl+o to expand)"]);
    expect(s[0]).toContain("\x1b[2m");
    const d = renderBlock(b[0], D);
    expect(txt(d)).toEqual(["∴ Thinking", "  a b", "  c"]);
    expect(d.every((l) => l.includes("\x1b[2m"))).toBe(true);
    chalk.level = 0;
  });

  it("compacted line shows before and after", () => {
    for (const l of both(toBlocks([{ type: "compacted", before: 52100, after: 8700 }]))) expect(l).toEqual(["  ⎿  Context compacted: 52.1k → ~8.7k tokens"]);
  });

  it("incomplete notices show in both views", () => {
    chalk.level = 1;
    const cases: [AgentEvent, string][] = [
      [{ type: "done", incomplete: "step limit", steps: 20 }, "Step limit reached (20)"],
      [{ type: "done", incomplete: "output limit" }, "Output limit reached, the answer is cut"],
      [{ type: "done", incomplete: "context full" }, "Context full"],
      [{ type: "done", incomplete: "content filter" }, "Stopped by the content filter"],
    ];
    for (const [e, t] of cases) {
      const b = toBlocks([e]);
      for (const l of both(b)) expect(l[0]).toBe(`  ⎿  ${t} · send a message to continue`);
      expect(renderBlock(b[0], S)[0]).toBe(chalk.hex(theme.warning)(`  ⎿  ${t} · send a message to continue`));
    }
    chalk.level = 0;
  });

  it("read-only agents get no 'send a message' hint", () => {
    for (const l of both(toBlocks([{ type: "done", incomplete: "context full" }], true))) expect(l).toEqual(["  ⎿  Context full"]);
  });

  it("error shows the HTTP status and attempts line", () => {
    expect(txt(renderTranscript(toBlocks([{ type: "error", message: "x", status: 429, attempts: 3 }]), S))).toEqual(["● Error: x", "  ⎿  HTTP 429 · 3 attempts"]);
    expect(txt(renderTranscript(toBlocks([{ type: "error", message: "x", status: 500, attempts: 1 }]), S))).toEqual(["● Error: x", "  ⎿  HTTP 500"]);
    expect(txt(renderTranscript(toBlocks([{ type: "error", message: "x", attempts: 2 }]), S))).toEqual(["● Error: x", "  ⎿  2 attempts"]);
  });

  it("detailed turn-end shows rate limits", () => {
    const b = toBlocks([{ type: "done", usage: { inputTokens: 5 }, rateLimits: { a: "1", b: "2" } }]);
    expect(txt(renderTranscript(b, D))).toEqual(["  ⎿  ↑ 5 tokens", "  ⎿  rate limits: a=1 · b=2"]);
    expect(renderTranscript(b, S)).toEqual([]);
  });
  it("token counts drop a trailing .0", () => {
    expect([64000, 12300, 9000, 999].map(k)).toEqual(["64k", "12.3k", "9k", "999"]);
  });
});
