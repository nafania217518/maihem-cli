import React, { useEffect, useMemo, useRef, useState } from "react";
import { readFileSync } from "node:fs";
import os from "node:os";
import { Box, Text, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import stringWidth from "string-width";
import type { AgentEvent } from "../protocol.ts";
import { renderTranscript, theme, toBlocks } from "./transcript.ts";

const h = React.createElement;
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Scheming", "Plotting", "Wreaking", "Brewing", "Conniving", "Tinkering"];
const MASCOT = "▗▙   ▟▖\n▐█▀█▀█▌\n ▀▘ ▝▀ ";
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
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
}

type Hello = Extract<AgentEvent, { type: "hello" }>;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
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
  const [turn, setTurn] = useState<{ start: number; verb: string; chars: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [input, setInput] = useState("");
  const [ask, setAsk] = useState<null | "stop" | "apply" | "stopping">(null);
  const [detailed, setDetailed] = useState(false);
  const [help, setHelp] = useState(false);
  const [offset, setOffset] = useState(0);
  const [fresh, setFresh] = useState(0);

  useEffect(() => {
    const on = (e: AgentEvent): void => {
      if (e.type === "hello") {
        setHello(e);
        setEvents([]);
        setTurn(null);
        return e.history.forEach(on);
      }
      setEvents((es) => [...es, e]);
      if (e.type === "user") setTurn({ start: Date.now(), verb: VERBS[Math.floor(Math.random() * VERBS.length)], chars: 0 });
      else if (e.type === "text") setTurn((t) => t && { ...t, chars: t.chars + e.delta.length });
      else if (e.type === "done" || e.type === "error") setTurn(null);
    };
    return props.subscribe(on);
  }, [props.subscribe]);

  const busy = turn !== null;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [busy]);

  const lines = useMemo(() => renderTranscript(toBlocks(events), { width: columns, detailed }), [events, columns, detailed]);
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
    ? h(Text, null, h(Text, { color: theme.accent }, `${FRAMES[frame]} ${turn.verb}…`), h(Text, { dimColor: true }, ` (${secs}s · ↓ ${k(Math.round(turn.chars / 4))} tokens)`))
    : null;

  const prompt =
    ask === "stop"
      ? h(Text, null, `Stop agent ${hello?.id}? [y/N]`)
      : ask === "apply"
        ? h(Text, { wrap: "truncate-end" }, `Apply changes to ${middle(hello?.workdir ?? "", columns - 26)}? [Y/n]`)
        : ask === "stopping"
          ? h(Text, null, "stopping…")
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
      : busy && !hello?.readonly
        ? "esc to interrupt · ctrl+d to detach"
        : "? for shortcuts";
  const footer = help
    ? h(Box, { paddingX: 1, gap: 4 }, ...HELP.map((col, i) => h(Box, { key: i, flexDirection: "column" }, ...col.map((t) => h(Text, { key: t, dimColor: true }, t)))))
    : h(Box, { paddingX: 1, justifyContent: "space-between", gap: 1 }, h(Box, { flexShrink: 1, minWidth: 0 }, dim(hint)), h(Box, { flexShrink: 1, minWidth: 0 }, dim(detailed ? "detailed · ctrl+o for simplified" : "simplified · ctrl+o for details")));

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
