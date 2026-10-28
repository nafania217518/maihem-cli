// A full-screen detail of the board: a title, scrollable lines, an optional list to pick from, an optional input line.
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import chalk from "chalk";
import { state, theme, wrap } from "./transcript.ts";

const h = React.createElement;

export interface DetailProps {
  title: string;
  lines: string[];
  size: { columns: number; rows: number };
  items?: string[];
  onPick?: (i: number) => void;
  hint?: string; // the commands of the input line
  onSubmit?: (text: string) => void; // set: the detail has an input line; a throw shows on the status line and keeps the input
  onBack: () => void;
  color?: (line: string) => string | undefined; // a chalk color name per line, applied to its wrapped rows
}

export function Detail(p: DetailProps): React.ReactElement {
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const items = p.items ?? [];
  const height = Math.max(1, p.size.rows - 3 - items.length - (p.onSubmit ? 4 : 0));
  const rows = p.lines.flatMap((l) => { const c = p.color?.(l); return wrap(l, p.size.columns).map((r) => (c ? (chalk as unknown as Record<string, (s: string) => string>)[c](r) : r)); });
  const max = Math.max(0, rows.length - height);
  const off = Math.min(offset, max);
  const scroll = (to: number) => setOffset(Math.max(0, Math.min(max, to)));
  useInput((_, key) => {
    if (key.escape) p.onBack();
    else if (key.pageDown) scroll(off + height - 1);
    else if (key.pageUp) scroll(off - height + 1);
    else if (key.home) scroll(0);
    else if (key.end) scroll(max);
    else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(items.length - 1, s + 1));
    else if (key.return && !input && items.length) p.onPick?.(Math.min(sel, items.length - 1));
  });
  const submit = (v: string) => {
    if (!v.trim()) return;
    try {
      p.onSubmit!(v.trim());
      setInput("");
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  const dim = (t: string) => h(Text, { dimColor: true, wrap: "truncate-end" }, t);
  return h(Box, { flexDirection: "column", width: p.size.columns, height: p.size.rows },
    h(Text, { bold: true, wrap: "truncate-end" }, p.title),
    h(Box, { flexGrow: 1, overflow: "hidden", flexDirection: "column" }, h(Text, null, rows.slice(off, off + height).join("\n"))),
    ...items.map((t, i) => h(Text, { key: i, inverse: i === Math.min(sel, items.length - 1), wrap: "truncate-end" }, t)),
    ...(p.onSubmit ? [
      h(Box, { key: "in", borderStyle: "round", borderLeft: false, borderRight: false, borderColor: theme.border },
        h(Text, null, "❯ "), h(TextInput, { value: input, onChange: setInput, onSubmit: submit })),
      h(Text, { key: "st", color: state.fail, wrap: "truncate-end" }, status || " "),
    ] : []),
    dim(`${p.hint ? p.hint + " · " : ""}${items.length ? "↑↓ select · enter open · " : ""}pgup/pgdn scroll · esc back`));
}
