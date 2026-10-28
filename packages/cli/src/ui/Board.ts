// Live org board: milestones, ticket columns, members, inbox and recent events. Data comes from boardData in org/cli.ts.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Approval, InboxItem, Role, Status, Ticket, Wake } from "../org/types.ts";
import { ROLES } from "../org/types.ts";
import { k, theme } from "./transcript.ts";

const h = React.createElement;
const COLUMNS: [Status, string][] = [["triage", "Triage"], ["todo", "Todo / Reply"], ["in_progress", "In Progress"], ["in_review", "In Review"], ["done", "Done"]];
const COLOR: Record<string, string | undefined> = { paused: theme.warning, done: theme.success, stopped: theme.error };
const MARK: Record<Approval["state"], string> = { approved: "✓", pending: "…", changes: "✗" };
const VERB: Record<Wake["kind"], string> = { triage: "triaging", work: "working", review: "reviewing", reply: "replying" };

export type BoardTicket = Ticket & { blocked: boolean; approvals: Approval[] };
export interface BoardData {
  org: string; goal: string; state: { status: string; gate?: string };
  usage: { input: number; output: number }; memberUsage: Record<string, { input: number; output: number }>;
  members: { name: string; role: Role }[];
  milestones: { id: string; name: string; completion: number; active: boolean }[];
  tickets: BoardTicket[];
  time: { running: number }; now: number; tokenLimit?: number;
  sessions: Record<string, { id: string; ticket: string; kind: Wake["kind"]; started: number }>;
  queue: Wake[];
  inbox: InboxItem[]; // open approvals
  human: { id: string; title: string; question: string }[]; // tickets in Needs Reply for the human, with the last comment
  waiting: boolean; // idle until the human answers
  recent: string[];
}

// a duration: "45s", "12m 03s", "7h 05m"
const p2 = (n: number) => String(n).padStart(2, "0");
export const dur = (ms: number): string => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), hr = Math.floor(m / 60);
  return m < 1 ? `${s}s` : hr < 1 ? `${m}m ${p2(s % 60)}s` : `${hr}h ${p2(m % 60)}m`;
};

// the command that answers an approval, and a ticket that waits for the human
export const hint = (org: string, i: InboxItem): string => `maihem org approve ${org} ${i.id} | maihem org reject ${org} ${i.id} -m TEXT`;
export const answerHint = (org: string, id: string): string => `maihem org answer ${org} ${id} TEXT`;

export function Board(props: { read: () => BoardData; pollMs?: number; size?: { columns: number; rows: number }; onExit: () => void }): React.ReactElement {
  const win = useWindowSize();
  const { rows, columns } = props.size ?? win;
  const [d, setD] = useState(props.read);
  useEffect(() => {
    const t = setInterval(() => setD(props.read()), props.pollMs ?? 1000);
    return () => clearInterval(t);
  }, [props.read, props.pollMs]);
  useInput((ch, key) => { if (ch === "q" || key.escape || (key.ctrl && ch === "c")) props.onExit(); });

  const dim = (s: string, key?: string) => h(Text, { dimColor: true, wrap: "truncate-end", key }, s);
  const line = (ch: React.ReactNode[], key?: string) => h(Text, { wrap: "truncate-end", key }, ...ch);
  const pct = (n: number) => (n >= 100 ? MARK.approved : `${Math.round(n)}%`);
  const active = d.milestones.find((m) => m.active);

  // ponytail: width is an estimate (yoga splits the remainder), so detail lines cut 1 char early at worst
  const w = Math.floor(columns / COLUMNS.length) - 1, narrow = w < 24;
  const cut = (s: string) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
  const card = (t: BoardTicket, sub: boolean) => {
    // narrow columns: id and title only, no space after ↳, no detail lines
    const q = t.status === "needs_reply" ? "? " : "";
    if (narrow) return [line([`${t.parent ? (sub ? " ↳" : "↳") : ""}${q}${t.id} ${t.title}`], t.id)];
    const pre = (t.parent ? (sub ? " ↳ " : "↳ ") : "") + q;
    const info = [t.priority ? `P${t.priority}` : "", t.blocked ? "⛔ blocked" : "", ...t.approvals.map((a) => `${a.reviewer} ${MARK[a.state]}`)].filter(Boolean).join(" "), ind = " ".repeat(pre.length + 1);
    return [line([`${pre}${t.id} ${t.title}`, t.assignee ? h(Text, { dimColor: true, key: "a" }, ` @${t.assignee}`) : ""], t.id),
      ...(info ? [dim(cut(ind + info), t.id + "i")] : []),
      ...(t.branch ? [dim(cut(`${ind}⎇ ${t.branch}`), t.id + "b")] : [])];
  };
  // a column lists its tickets in order; a sub-ticket follows its parent when the parent is in the same column
  const column = (ts: BoardTicket[]) => {
    const here = new Set(ts.map((t) => t.id));
    return ts.filter((t) => !t.parent || !here.has(t.parent))
      .flatMap((t) => [...card(t, false), ...ts.filter((c) => c.parent === t.id).flatMap((c) => card(c, true))]);
  };
  // a triage session has no ticket (ticket ""): "pm ● triaging", "pm ○ queued triage"
  const member = ({ name: m }: { name: string }) => {
    const s = d.sessions[m], q = d.queue.find((x) => x.member === m), u = d.memberUsage[m];
    const [mark, word, t] = s ? ["●", VERB[s.kind], s.ticket] : q ? ["○", q.kind === "triage" ? "queued triage" : "queued", q.ticket] : ["·", "idle", undefined];
    return h(Text, { key: m, wrap: "truncate-end", color: s || q ? theme.accent : undefined, dimColor: !s && !q }, `${m} ${mark} ${word}${t ? " " + t : ""}${s ? " " + dur(d.now - s.started) : ""}${u ? ` ${k(u.input)}/${k(u.output)}` : ""}`);
  };
  const inbox = d.inbox.flatMap((i) => [line([`${i.id} ${i.kind}${i.ticket ? " " + i.ticket : ""}: ${i.text}`], i.id), dim(`  ${hint(d.org, i)}`, i.id + "h")]);
  inbox.push(...d.human.flatMap((x) => [line([`${x.id} ${x.title}: ${x.question}`], x.id), dim(`  ${answerHint(d.org, x.id)}`, x.id + "h")]));
  const n = d.inbox.length + d.human.length;
  const recent = d.recent.slice(-Math.max(1, rows - 24 - inbox.length));
  // milestones list: drop leading entries until the active one fits the width
  const ml = d.milestones.map((m) => `${m.id} ${m.name} ${pct(m.completion)}${m.active ? " ◀" : ""}`);
  const ai = d.milestones.findIndex((m) => m.active);
  let from = 0;
  while (from < ai && ml.slice(from, ai + 1).join(" · ").length > columns) from++;
  const closed = d.tickets.filter((t) => t.status === "canceled" || t.status === "duplicate").length;

  return h(Box, { flexDirection: "column", height: rows },
    line([h(Text, { bold: true, color: theme.accent, key: "t" }, `MAIHEM org ${d.org}`),
      h(Text, { dimColor: true, key: "m" }, " · "),
      h(Text, { color: COLOR[d.state.status], key: "st" }, d.state.status + (d.state.gate ? ` ${d.state.gate}` : "") + (d.waiting ? " · waiting for human" : "")),
      h(Text, { dimColor: true, key: "k" }, ` · ⏱ ${dur(d.time.running)} · tokens ${k(d.usage.input + d.usage.output, 2)}${d.tokenLimit ? ` / ${k(d.tokenLimit, 2)}` : ""} (↑ ${k(d.usage.input, 2)} / ↓ ${k(d.usage.output)})`)]),
    dim(`goal: ${d.goal}`),
    d.milestones.length ? line(d.milestones.slice(from).flatMap((m, i) => [i ? dim(" · ", m.id + "s") : "",
      h(Text, { key: m.id, color: m.active ? "white" : undefined, dimColor: !m.active }, ml[from + i])])) : null,
    h(Box, { marginTop: 1 }, ...COLUMNS.map(([s, title]) => {
      // Done lists only the active milestone's tickets; none when every milestone is complete
      const ts = d.tickets.filter((t) => (t.status === s || (s === "todo" && t.status === "needs_reply")) && (s !== "done" || (!!active && t.milestone === active.id)));
      return h(Box, { key: s, flexDirection: "column", flexGrow: 1, flexBasis: 0, paddingRight: 1 },
        h(Text, { bold: true, wrap: "truncate-end" }, `${title} (${ts.length})`),
        ...(s === "done" && closed ? [dim(`+${closed} canceled`)] : []),
        ...column(ts));
    })),
    h(Box, { marginTop: 1, columnGap: 2, flexWrap: "wrap" }, ...[...d.members].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)).map(member)),
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, { color: n ? theme.warning : undefined, dimColor: !n }, n ? `Inbox (${n})` : "inbox empty"),
      ...inbox),
    h(Box, { marginTop: 1, flexDirection: "column", flexGrow: 1 }, ...recent.map((l, i) => dim(l, String(i)))),
    dim("q quit"));
}
