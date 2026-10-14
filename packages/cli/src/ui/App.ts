import React, { useEffect, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentEvent } from "../protocol.ts";

const h = React.createElement;
const FRAMES = ["⠋", "⠙", "⠹"];

export interface AppProps {
  subscribe: (cb: (e: AgentEvent) => void) => () => void;
  send: (text: string) => void;
  detach: () => void;
}

type Line = { text: string; bold?: boolean; dim?: boolean; color?: string };
type Hello = Extract<AgentEvent, { type: "hello" }>;

export function App(props: AppProps): React.ReactElement {
  const [hello, setHello] = useState<Hello | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [input, setInput] = useState("");

  useEffect(() => {
    const push = (l: Line) => setLines((ls) => [...ls, l]);
    const on = (e: AgentEvent): void => {
      switch (e.type) {
        case "hello":
          setHello(e);
          e.history.forEach(on);
          break;
        case "user":
          push({ text: `you ▸ ${e.text}`, bold: true });
          setLive("");
          break;
        case "text":
          setLive((t) => (t ?? "") + e.delta);
          break;
        case "tool":
          push({ text: `⚙ ${e.name} ${JSON.stringify(e.input).slice(0, 60)}`, dim: true });
          break;
        case "tool-result":
          push({ text: `  → ${e.ok ? "✓" : "✗"} ${e.preview}`, dim: true });
          break;
        case "done":
          setLive((t) => {
            push({ text: `agent ▸ ${t ?? ""}` });
            return null;
          });
          break;
        case "error":
          push({ text: `error: ${e.message}`, color: "red" });
          break;
      }
    };
    return props.subscribe(on);
  }, [props.subscribe]);

  const busy = live !== null;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [busy]);

  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === "c")) props.detach();
  });

  const header = hello
    ? `${hello.name} · ${hello.provider}/${hello.model} · ${hello.sandbox ? "sandbox" : "no-sandbox"} · ${hello.id}`
    : "connecting…";

  return h(
    Box,
    { flexDirection: "column" },
    h(Box, { borderStyle: "round" }, h(Text, null, header)),
    h(Static, {
      items: lines,
      children: (item: unknown, i: number) => {
        const l = item as Line;
        return h(Text, { key: i, bold: l.bold, dimColor: l.dim, color: l.color }, l.text);
      },
    }),
    busy ? h(Text, null, `agent ▸ ${live} ${FRAMES[frame]}`) : null,
    h(
      Box,
      null,
      h(Text, null, "› "),
      h(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: (v: string) => {
          if (busy || !v.trim()) return;
          props.send(v);
          setInput("");
        },
      }),
    ),
  );
}
