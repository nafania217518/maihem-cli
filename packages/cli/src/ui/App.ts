import React, { useEffect, useMemo, useRef, useState } from "react";
import os from "node:os";
import { Box, Text, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import stringWidth from "string-width";
import type { AgentEvent } from "../protocol.ts";
import { VERSION } from "../version.ts";
import { k, renderTranscript, theme, toBlocks } from "./transcript.ts";

const h = React.createElement;
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Scheming", "Plotting", "Wreaking", "Brewing", "Conniving", "Tinkering"];
const MASCOT = "▗▙   ▟▖\n▐█▀█▀█▌\n ▀▘ ▝▀ ";
const HELP = [
  ["enter  send", "esc  interrupt / leave", "ctrl+c  stop agent", "ctrl+o  simplified / detailed", "ctrl+d  detach"],
  ["pgup/pgdn  scroll a page", "shift+↑/↓  scroll a line", "home/end  top / bottom", "?  close help"],
];

export interface AppProps {
  subscribe: (cb: (e: AgentEvent) => void) => () => void;
  send: (text: string) => void;
  detach: () => void;
  stop: (apply: boolean) => void;
  interrupt: () => void;
  size?: { columns: number; rows: number };
  view?: boolean; // read-only viewer: no input, Esc / Ctrl+C leave at once
}

type Hello = Extract<AgentEvent, { type: "hello" }>;
// A subscribe for App that replays the saved events of an ended session.
export const replaySource = (hello: Omit<Hello, "type" | "history">, events: AgentEvent[]): AppProps["subscribe"] => (cb) => {
  cb({ ...hello, type: "hello", readonly: true, history: events });
  return () => {};
};
// Shorten s to w columns by cutting the middle.
export const middle = (s: string, w: number): string => {
  if (stringWidth(s) <= w) return s;
  if (w < 2) return "…".slice(0, Math.max(0, w));
  const a = [...s];
  const left = Math.ceil((w - 1) / 2);
  const right = w - 1 - left;
  return a.slice(0, left).join("") + "…" + (right ? a.slice(-right).join("") : "");
};
const home = (p: string) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);

export function App(props: AppProps): React.ReactElement {
  const win = useWindowSize();
  const { columns, rows } = props.size ?? win;
  const [hello, setHello] = useState<Hello | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [turn, setTurn] = useState<{ start: number; verb: string; chars: number; stepChars: number; stepAt?: number; tps?: number; tpsAt: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [input, setInput] = useState("");
  const [ask, setAsk] = useState<null | "stop" | "apply" | "stopping">(null);
  const [detailed, setDetailed] = useState(false);
  const [help, setHelp] = useState(false);
  const [offset, setOffset] = useState(0);
  const [fresh, setFresh] = useState(0);
  const [ctx, setCtx] = useState<{ used: number; budget?: number } | null>(null);

  useEffect(() => {
    const on = (e: AgentEvent): void => {
      if (e.type === "hello") {
        setHello(e);
        setEvents([]);
        setTurn(null);
        setCtx(null);
        return e.history.forEach(on);
      }
      setEvents((es) => [...es, e]);
      if (e.type === "user") setTurn({ start: Date.now(), verb: VERBS[Math.floor(Math.random() * VERBS.length)], chars: 0, stepChars: 0, tpsAt: -Infinity });
      else if (e.type === "text" || e.type === "thinking") setTurn((t) => t && { ...t, chars: t.chars + e.delta.length, stepChars: t.stepChars + e.delta.length, stepAt: t.stepAt ?? Date.now() });
      else if (e.type === "step") setTurn((t) => t && { ...t, stepChars: 0, stepAt: undefined });
      else if (e.type === "context") {
        setCtx({ used: e.used, budget: e.budget });
        if (e.tps !== undefined) setTurn((t) => t && { ...t, tps: e.tps, tpsAt: Date.now() });
      }
      else if (e.type === "compacted") setCtx((c) => ({ ...c, used: e.after }));
      else if (e.type === "done" || e.type === "error") setTurn(null);
    };
    return props.subscribe(on);
  }, [props.subscribe]);

  const busy = turn !== null;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      setTurn((t) => {
        const now = Date.now(), secs = t?.stepAt === undefined ? 0 : (now - t.stepAt) / 1000;
        return t && now - t.tpsAt >= 1000 && secs >= 1 ? { ...t, tps: Math.round(t.stepChars / 4 / secs), tpsAt: now } : t;
      });
    }, 120);
    return () => clearInterval(t);
  }, [busy]);

  const lines = useMemo(() => renderTranscript(toBlocks(events, hello?.readonly), { width: columns, detailed }), [events, columns, detailed, hello?.readonly]);
  const height = Math.max(1, rows - 4 - (busy ? 1 : 0) - 3 - (help ? HELP[0].length : 1));
  const max = Math.max(0, lines.length - height);
  const off = Math.min(offset, max);

  // Hold the view still when new lines arrive while scrolled up.
  const prev = useRef({ events, len: lines.length });
  useEffect(() => {
    const added = lines.length - prev.current.len;
    if (prev.current.events !== events && off > 0 && added > 0) {
      setOffset(off + added);
      setFresh((n) => n + added);
    }
    prev.current = { events, len: lines.length };
  }, [lines]);

  const scroll = (to: number) => {
    const o = Math.max(0, Math.min(max, to));
    setOffset(o);
    if (!o) setFresh(0);
  };

  const halt = (apply: boolean) => {
    setAsk("stopping");
    props.stop(apply);
  };
  const quit = () => (hello ? setAsk("stop") : props.detach());
  useInput((ch, key) => {
    const leave = key.escape || (key.ctrl && ch === "c");
    if (key.ctrl && ch === "d") {
      setInput(input); // TextInput also received the "d"
      props.detach();
    } else if (ask === "stop") {
      if (ch !== "y") props.detach();
      else if (hello?.sandbox) setAsk("apply");
      else halt(true);
    } else if (ask === "apply") {
      if (leave) props.detach();
      else if (ch === "n") halt(false);
      else if (key.return || ch === "y") halt(true);
    } else if (ask) {
      return;
    } else if (props.view && leave) {
      props.detach();
    } else if (key.ctrl && ch === "o") {
      setDetailed((d) => !d);
      setInput(input); // TextInput also received the "o"
    } else if (key.ctrl && ch === "c") quit();
    else if (key.escape) {
      if (help) setHelp(false);
      else if (busy && !hello?.readonly) props.interrupt();
      else quit();
    } else if (ch === "?" && input === "") {
      setHelp((x) => !x);
      setInput("");
    } else if (key.pageUp) scroll(off + height - 1);
    else if (key.pageDown) scroll(off - height + 1);
    else if (key.shift && key.upArrow) scroll(off + 1);
    else if (key.shift && key.downArrow) scroll(off - 1);
    else if (key.home) scroll(max);
    else if (key.end) scroll(0);
  });

  const dim = (t: string) => h(Text, { dimColor: true, wrap: "truncate-end" }, t);
  const header = h(
    Box,
    { marginBottom: 1, height: 3 },
    h(Box, { flexShrink: 0 }, h(Text, { color: theme.accent }, MASCOT)),
    h(
      Box,
      { flexDirection: "column", marginLeft: 2, flexGrow: 1, flexShrink: 1, minWidth: 0 },
      hello
        ? [
            h(Text, { key: 1, wrap: "truncate-end" }, h(Text, { bold: true }, "MAIHEM"), h(Text, { dimColor: true }, ` v${VERSION}`), ` · ${hello.name}`),
            h(Text, { key: 2, dimColor: true, wrap: "truncate-end" }, `${hello.provider}/${hello.model} · ${hello.sandbox ? "sandbox" : "no-sandbox"}${hello.readonly ? " · read-only" : ""}`),
            h(Text, { key: 3, dimColor: true, wrap: "truncate-middle" }, `${home(hello.workdir)} · ${hello.id}`),
          ]
        : h(Text, null, "connecting…"),
    ),
  );

  const view = lines.slice(Math.max(0, lines.length - height - off), lines.length - off);
  const secs = turn ? Math.floor((Date.now() - turn.start) / 1000) : 0;
  const spinner = turn
    ? h(Text, null, h(Text, { color: theme.accent }, `${FRAMES[frame]} ${turn.verb}…`), h(Text, { dimColor: true }, ` (${secs}s · ↓ ${k(Math.round(turn.chars / 4))} tokens${turn.tps === undefined ? "" : ` · ${turn.tps} tok/s`})`))
    : null;

  const prompt =
    ask === "stop"
      ? h(Text, null, `Stop agent ${hello?.id}? [y/N]`)
      : ask === "apply"
        ? h(Text, { wrap: "truncate-end" }, `Apply changes to ${middle(hello?.workdir ?? "", columns - 26)}? [Y/n]`)
        : ask === "stopping"
          ? h(Text, null, "stopping…")
          : props.view
            ? dim("read-only · Esc to go back")
            : hello?.readonly
            ? dim("read-only · Esc to leave")
            : h(
                Box,
                null,
                h(Text, null, "❯ "),
                h(TextInput, {
                  value: input,
                  onChange: setInput,
                  onSubmit: (v: string) => {
                    if (busy || !v.trim()) return;
                    props.send(v);
                    setInput("");
                  },
                }),
              );

  const hint = off > 0
      ? `↓ ${fresh || off} more lines · end to jump`
      : busy && !hello?.readonly && !props.view
        ? "esc to interrupt · ctrl+d to detach"
        : "? for shortcuts";
  const pct = ctx?.budget ? Math.round((ctx.used / ctx.budget) * 100) : undefined;
  const gauge = ctx
    ? h(Text, { color: pct === undefined || pct < 70 ? undefined : pct < 90 ? theme.warning : theme.error, dimColor: pct === undefined || pct < 70 }, `ctx ${k(ctx.used)}${ctx.budget ? `/${k(ctx.budget)} · ${pct}%` : ""} · `)
    : null;
  const footer = help
    ? h(Box, { paddingX: 1, gap: 4 }, ...HELP.map((col, i) => h(Box, { key: i, flexDirection: "column" }, ...col.map((t) => h(Text, { key: t, dimColor: true }, t)))))
    : h(Box, { paddingX: 1, justifyContent: "space-between", gap: 1 }, h(Box, { flexShrink: 1, minWidth: 0 }, dim(hint)), h(Box, { flexShrink: 1, minWidth: 0 }, h(Text, { wrap: "truncate-end" }, gauge, h(Text, { dimColor: true }, detailed ? "detailed · ctrl+o for simplified" : "simplified · ctrl+o for details"))));

  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows },
    header,
    h(Box, { flexGrow: 1, overflow: "hidden", flexDirection: "column" }, h(Text, { wrap: "truncate-end" }, view.join("\n"))),
    spinner,
    h(Box, { borderStyle: "round", borderLeft: false, borderRight: false, borderColor: theme.border }, prompt),
    footer,
  );
}
