import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";
import type { AgentEvent, Incomplete } from "../protocol.ts";

export const theme = { accent: "#E5484D", border: "#888888", userBg: "#373737", success: "#4EBA65", error: "#FF6B80", warning: "#FFC107" };

type Usage = { inputTokens?: number; outputTokens?: number };
export type Block =
  | { kind: "user"; text: string; at?: number }
  | { kind: "agent"; text: string; at?: number }
  | { kind: "tool"; id: string; name: string; input: unknown; at?: number; result?: { ok: boolean; output: string; at?: number } }
  | { kind: "step"; n: number; at?: number }
  | { kind: "thinking"; text: string; at?: number }
  | { kind: "compacted"; before: number; after: number; at?: number }
  | { kind: "turn-end"; usage?: Usage; ms?: number; interrupted?: boolean; incomplete?: Incomplete; steps?: number; tps?: number; rateLimits?: Record<string, string>; chat?: boolean; at?: number }
  | { kind: "error"; message: string; status?: number; attempts?: number; at?: number };
type Opts = { width: number; detailed: boolean };

export function toBlocks(events: AgentEvent[], readonly = false): Block[] {
  const out: Block[] = [];
  let step = 0;
  let userAt: number | undefined;
  for (const e of events) {
    const last = out.at(-1);
    if (e.type === "user") {
      step = 0;
      userAt = e.at;
      out.push({ kind: "user", text: e.text, at: e.at });
    } else if (e.type === "text") {
      if (last?.kind === "agent") last.text += e.delta;
      else out.push({ kind: "agent", text: e.delta, at: e.at });
    } else if (e.type === "thinking") {
      if (last?.kind === "thinking") last.text += e.delta;
      else out.push({ kind: "thinking", text: e.delta, at: e.at });
    } else if (e.type === "compacted") out.push({ kind: "compacted", before: e.before, after: e.after, at: e.at });
    else if (e.type === "tool") out.push({ kind: "tool", id: e.id, name: e.name, input: e.input, at: e.at });
    else if (e.type === "tool-result") {
      const t = out.findLast((b) => b.kind === "tool" && b.id === e.id);
      if (t?.kind === "tool") t.result = { ok: e.ok, output: e.output, at: e.at };
    } else if (e.type === "step") out.push({ kind: "step", n: ++step, at: e.at });
    else if (e.type === "done") {
      const ms = e.at !== undefined && userAt !== undefined ? e.at - userAt : undefined;
      out.push({ kind: "turn-end", usage: e.usage, ms, interrupted: e.interrupted, incomplete: e.incomplete, steps: e.steps, tps: e.tps, rateLimits: e.rateLimits, chat: !readonly, at: e.at });
    } else if (e.type === "error") out.push({ kind: "error", message: e.message, status: e.status, attempts: e.attempts, at: e.at });
  }
  return out;
}

const md = new Marked(markedTerminal({ tab: 2, showSectionPrefix: false }));
const len = (s: string) => stringWidth(s);
const wrap = (s: string, w: number) => wrapAnsi(s, Math.max(1, w), { hard: true, trim: false }).split("\n");
const red = (s: string) => chalk.hex(theme.error)(s);
const NOTICE: Record<Incomplete, string> = {
  "step limit": "Step limit reached",
  "output limit": "Output limit reached, the answer is cut",
  "context full": "Context full",
  "content filter": "Stopped by the content filter",
};
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
export const k = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

// Prefix the first line with `first`, the rest with `rest`; wrap the content to fit.
function gutter(lines: string[], width: number, first: string, rest: string, color = (s: string) => s): string[] {
  return lines.flatMap((l) => wrap(l, width - rest.length)).map((l, i) => (i && !l.trim() ? "" : color((i ? rest : first) + l)));
}

// Append the dim time right-aligned to the first line (detailed view only).
function stamp(lines: string[], at: number | undefined, o: Opts): string[] {
  if (!o.detailed || at === undefined || !lines.length) return lines;
  const t = clock(at);
  return [lines[0] + " ".repeat(Math.max(1, o.width - len(lines[0]) - t.length)) + chalk.dim(t), ...lines.slice(1)];
}

function summary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.path ?? i.command ?? Object.values(i).find((x) => typeof x === "string");
  return typeof v === "string" ? v : "";
}

function render(b: Block, o: Opts): string[] {
  const w = o.detailed ? o.width - 9 : o.width; // room for " HH:MM:SS"
  switch (b.kind) {
    case "user": {
      const l = stamp(gutter(b.text.split("\n"), w, "❯ ", "  "), b.at, o);
      return l.map((x) => chalk.bgHex(theme.userBg)(x + " ".repeat(Math.max(0, o.width - len(x)))));
    }
    case "agent": {
      const ansi = (md.parse(b.text) as string).replace(/\s+$/, "");
      return stamp(gutter(ansi.split("\n"), w, "● ", "  "), b.at, o);
    }
    case "error": {
      const l = stamp(gutter(`Error: ${b.message}`.split("\n"), w, "● ", "  ", red), b.at, o);
      const info = [b.status !== undefined && `HTTP ${b.status}`, (b.attempts ?? 0) > 1 && `${b.attempts} attempts`].filter(Boolean);
      return info.length ? [...l, chalk.dim(`  ⎿  ${info.join(" · ")}`)] : l;
    }
    case "thinking":
      return o.detailed
        ? [chalk.dim("∴ Thinking"), ...gutter(b.text.replace(/\s+$/, "").split("\n"), o.width, "  ", "  ", chalk.dim)]
        : [chalk.dim("∴ Thinking (ctrl+o to expand)")];
    case "compacted":
      return [chalk.dim(`  ⎿  Context compacted: ${k(b.before)} → ~${k(b.after)} tokens`)];
    case "step":
      return o.detailed ? [chalk.dim(`── step ${b.n} `.padEnd(o.width, "─"))] : [];
    case "turn-end": {
      if (b.interrupted) return [red("  ⎿  Interrupted")];
      const out: string[] = [];
      if (b.incomplete) {
        const n = b.incomplete === "step limit" && b.steps !== undefined ? ` (${b.steps})` : "";
        out.push(chalk.hex(theme.warning)(`  ⎿  ${NOTICE[b.incomplete]}${n}${b.chat ? " · send a message to continue" : ""}`));
      }
      if (!o.detailed) return out;
      const u = b.usage ?? {};
      const tok = [u.inputTokens !== undefined && `↑ ${k(u.inputTokens)}`, u.outputTokens !== undefined && `↓ ${k(u.outputTokens)}`].filter(Boolean);
      const parts = [tok.length ? `${tok.join(" ")} tokens` : "", b.ms !== undefined ? `${(b.ms / 1000).toFixed(1)}s` : "", b.tps !== undefined ? `${b.tps} tok/s` : ""].filter(Boolean);
      if (parts.length) out.push(chalk.dim(`  ⎿  ${parts.join(" · ")}`));
      const rl = Object.entries(b.rateLimits ?? {}).map(([a, v]) => `${a}=${v}`);
      if (rl.length) out.push(chalk.dim(`  ⎿  rate limits: ${rl.join(" · ")}`));
      return out;
    }
    case "tool": {
      const r = b.result;
      const bullet = !r ? chalk.dim("●") : chalk.hex(r.ok ? theme.success : theme.error)("●");
      let head = b.name;
      if (!o.detailed) {
        const s = summary(b.input);
        const max = o.width - b.name.length - 4;
        head += `(${s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s})`;
      }
      const lines = stamp([`${bullet} ${head}`], b.at, o);
      const color = r && !r.ok ? red : undefined;
      if (o.detailed) lines.push(...gutter(JSON.stringify(b.input ?? null, null, 2).split("\n"), o.width, "  ⎿  ", "     "));
      if (!r) return lines;
      let out = r.output.replace(/\n+$/, "").split("\n");
      let hidden = 0;
      if (!o.detailed && out.length > 4) {
        hidden = out.length - 3;
        out = out.slice(0, 3);
      }
      lines.push(...gutter(out, o.width, "  ⎿  ", "     ", color));
      if (hidden) lines.push(chalk.dim(`     … +${hidden} lines (ctrl+o to expand)`));
      return lines;
    }
  }
}

const cache = new WeakMap<Block, Map<string, string[]>>();

export function renderBlock(b: Block, o: Opts): string[] {
  let m = cache.get(b);
  if (!m) cache.set(b, (m = new Map()));
  const key = `${o.width}:${o.detailed}`;
  let l = m.get(key);
  if (!l) m.set(key, (l = render(b, o)));
  return l;
}

export function renderTranscript(blocks: Block[], o: Opts): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const l = renderBlock(b, o);
    if (!l.length) continue;
    if (out.length) out.push("");
    out.push(...l);
  }
  return out;
}
