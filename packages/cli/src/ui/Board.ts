// Live org board: milestones, ticket columns, members, inbox and recent events. Data comes from boardData in org/cli.ts.
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Approval, InboxItem, Role, Status, Ticket, Wake } from "../org/types.ts";
import { ROLES } from "../org/types.ts";
import { App } from "./App.ts";
import type { AppProps } from "./App.ts";
import { Detail } from "./Detail.ts";
import { k, state, theme } from "./transcript.ts";

const h = React.createElement;
const COLUMNS: [Status, string][] = [["triage", "Triage"], ["todo", "Todo / Reply"], ["in_progress", "In Progress"], ["in_review", "In Review"], ["done", "Done"]];
const COLOR: Record<string, string | undefined> = { running: state.live, paused: state.wait, done: state.live, stopped: state.fail };
const MARK: Record<Approval["state"], string> = { approved: "✓", pending: "…", changes: "✗" };
const MARK_COLOR: Record<Approval["state"], string> = { approved: state.live, pending: state.wait, changes: state.fail };
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

// the state of an event line "HH:MM:SS actor kind rest" (formatEvent in org/cli.ts); undefined: no state
const EVENT_ROLE: Record<string, "live" | "wait" | "fail"> = {
  "session.failed": "fail", "git.push_failed": "fail", "git.conflict": "fail", "org.stopped": "fail",
  "review.done": "live", "ticket.merged": "live", "git.merged": "live", "org.done": "live", "milestone.completed": "live",
  "inbox.opened": "wait", "ticket.gate": "wait", "org.paused": "wait", "session.capped": "wait",
};
const ENDING: Record<string, [string, "live" | "wait" | "fail"][]> = {
  "approval.set": [["approved", "live"], ["pending", "wait"], ["changes", "fail"]],
  "ticket.status": [["done", "live"], ["canceled", "fail"], ["duplicate", "fail"]],
  "inbox.answered": [["approved", "live"], ["answered", "live"], ["rejected", "fail"]],
};
const EVENT = /^(\d\d:\d\d:\d\d \S+ )(\S+)(.*)$/;
export function eventRole(line: string): "live" | "wait" | "fail" | undefined {
  const [, , kind, rest = ""] = EVENT.exec(line) ?? [];
  if (!kind) return undefined;
  if (kind === "ticket.question") return rest.endsWith("answered") ? undefined : "wait";
  return ENDING[kind]?.find(([end]) => rest.endsWith(end))?.[1] ?? EVENT_ROLE[kind];
}
const eventColor = (line: string) => { const r = eventRole(line); return r && state[r]; };

// the command that answers an approval, and a ticket that waits for the human
export const hint = (org: string, i: InboxItem): string => `maihem org approve ${org} ${i.id} | maihem org reject ${org} ${i.id} -m TEXT`;
export const answerHint = (org: string, id: string): string => `maihem org answer ${org} ${id} TEXT`;

export type Action = { kind: "approve" | "reject" | "answer"; id: string; text: string };
// the action of a line typed on an approval: "/approve [note]" or "/reject TEXT"
export function command(id: string, text: string): Action {
  const [, verb, rest = ""] = /^\/(approve|reject)\b\s*([\s\S]*)$/.exec(text) ?? [];
  if (verb === "approve") return { kind: "approve", id, text: rest || "approved" };
  if (verb === "reject" && rest) return { kind: "reject", id, text: rest };
  throw new Error(verb ? "a reason is needed: /reject TEXT" : "use /approve [note] or /reject TEXT");
}

// the focus after an arrow key; the grid holds rows of columns of item keys, none empty.
// ↑ at the top of a column goes to the last item of the row above, ↓ at the bottom to the first item of the row below.
export function move(g: string[][][], at: string, dir: "up" | "down" | "left" | "right"): string {
  const r = g.findIndex((row) => row.some((c) => c.includes(at)));
  if (r < 0) return at;
  const c = g[r].findIndex((col) => col.includes(at)), i = g[r][c].indexOf(at);
  const pick = (r2: number, c2: number, i2: number) => {
    const col = g[r2][Math.max(0, Math.min(c2, g[r2].length - 1))];
    return col[Math.max(0, Math.min(i2, col.length - 1))];
  };
  if (dir === "left") return pick(r, c - 1, i);
  if (dir === "right") return pick(r, c + 1, i);
  if (dir === "up") return i > 0 ? g[r][c][i - 1] : r > 0 ? pick(r - 1, c, Infinity) : at;
  return i < g[r][c].length - 1 ? g[r][c][i + 1] : r < g.length - 1 ? pick(r + 1, c, 0) : at;
}

export interface Source { subscribe: AppProps["subscribe"]; close: () => void }
export interface BoardProps {
  read: () => BoardData; pollMs?: number; size?: { columns: number; rows: number }; onExit: () => void;
  act?: (a: Action) => string; // throws on error
  ticket?: (id: string) => string[];
  thread?: (ticket: string) => string[]; // the ticket summary and comments
  milestone?: (id: string) => { lines: string[]; tickets: { id: string; title: string; status: string }[] };
  sessions?: (ticket: string) => { id: string; member: string; kind: string; started: number }[];
  lastSession?: (member: string) => string | undefined;
  source?: (session: string) => Source; // a live socket or a replay
}
type View = { kind: "ticket" | "approval" | "human" | "milestone" | "session"; id: string };

// a session read-only in App; leaving closes its source
const noop = () => {};
function Session(p: { id: string; source: (id: string) => Source; size: { columns: number; rows: number }; onBack: () => void }): React.ReactElement {
  const s = useMemo(() => p.source(p.id), [p.id]);
  useEffect(() => s.close, [s]);
  return h(App, { subscribe: s.subscribe, view: true, detach: p.onBack, send: noop, stop: noop, interrupt: noop, size: p.size });
}

export function Board(props: BoardProps): React.ReactElement {
  const win = useWindowSize();
  const { rows, columns } = props.size ?? win;
  const [d, setD] = useState(props.read);
  const [focus, setFocus] = useState<string>();
  const [stack, setStack] = useState<View[]>([]);
  const [note, setNote] = useState("");
  useEffect(() => {
    const t = setInterval(() => setD(props.read()), props.pollMs ?? 1000);
    return () => clearInterval(t);
  }, [props.read, props.pollMs]);

  const dim = (s: string, key?: string) => h(Text, { dimColor: true, wrap: "truncate-end", key }, s);
  const line = (ch: React.ReactNode[], key?: string, inverse?: boolean) => h(Text, { wrap: "truncate-end", key, inverse }, ...ch);
  const pct = (n: number) => (n >= 100 ? MARK.approved : `${Math.round(n)}%`);
  const active = d.milestones.find((m) => m.active);

  // ponytail: width is an estimate (yoga splits the remainder), so detail lines cut 1 char early at worst
  const w = Math.floor(columns / COLUMNS.length) - 1, narrow = w < 24;
  const cut = (s: string) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
  const card = (t: BoardTicket, sub: boolean) => {
    // narrow columns: id and title only, no space after ↳, no detail lines
    const q = t.status === "needs_reply" ? "? " : "", qm = q && h(Text, { color: state.wait, key: "q" }, q);
    const inv = at === "t:" + t.id;
    if (narrow) return [line([t.parent ? (sub ? " ↳" : "↳") : "", qm, `${t.id} ${t.title}`], t.id, inv)];
    const arrow = t.parent ? (sub ? " ↳ " : "↳ ") : "", ind = " ".repeat(arrow.length + q.length + 1);
    // the info line: dim text, colored marks; cut to the width
    const parts: [string, string?][] = [[ind], ...(t.priority ? [[`P${t.priority} `] as [string]] : []), ...(t.blocked ? [["⊘ blocked", state.wait], [" "]] as [string, string?][] : []),
      ...t.approvals.flatMap((a): [string, string?][] => [[`${a.reviewer} `], [MARK[a.state], MARK_COLOR[a.state]], [" "]])];
    let room = w;
    const info = parts.map(([s, c], i) => { const x = s.length > room ? s.slice(0, Math.max(0, room - 1)) + "…" : s; room -= x.length; return h(Text, { key: i, color: c, dimColor: !c }, x); });
    return [line([arrow, qm, `${t.id} ${t.title}`, t.assignee ? h(Text, { dimColor: true, key: "a" }, ` @${t.assignee}`) : ""], t.id, inv),
      ...(parts.length > 1 ? [line(info, t.id + "i")] : []),
      ...(t.branch ? [dim(cut(`${ind}⎇ ${t.branch}`), t.id + "b")] : [])];
  };
  // a column lists its tickets in order; a sub-ticket follows its parent when the parent is in the same column
  const order = (ts: BoardTicket[]) => {
    const here = new Set(ts.map((t) => t.id));
    return ts.filter((t) => !t.parent || !here.has(t.parent)).flatMap((t) => [t, ...ts.filter((c) => c.parent === t.id)]);
  };
  // Done lists only the active milestone's tickets; none when every milestone is complete
  const cols = COLUMNS.map(([s, title]) => ({ s, title, ts: order(d.tickets.filter((t) => (t.status === s || (s === "todo" && t.status === "needs_reply")) && (s !== "done" || (!!active && t.milestone === active.id)))) }));
  const members = [...d.members].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  const grid = [
    d.milestones.map((m) => ["m:" + m.id]),
    cols.filter((c) => c.ts.length).map((c) => c.ts.map((t) => "t:" + t.id)),
    members.map((m) => ["u:" + m.name]),
    [[...d.inbox.map((i) => "q:" + i.id), ...d.human.map((x) => "h:" + x.id)]].filter((c) => c.length),
  ].filter((r) => r.length);
  const all = grid.flat(2);
  const at = focus && all.includes(focus) ? focus : grid.at(-1)?.[0][0].startsWith("q:") || grid.at(-1)?.[0][0].startsWith("h:") ? grid.at(-1)![0][0] : all.find((x) => x.startsWith("t:")) ?? all[0];
  const push = (v: View) => { setNote(""); setOk(false); setStack((s) => [...s, v]); };
  const pop = () => setStack((s) => s.slice(0, -1));
  const done = (result: string) => { setNote(result); setStack([]); };
  const [ok, setOk] = useState(false);
  const act = (a: Action) => { done(props.act?.(a) ?? ""); setOk(true); };
  const openItem = (key: string) => {
    const id = key.slice(2), kind = ({ m: "milestone", t: "ticket", q: "approval", h: "human" } as const)[key[0] as "m"];
    if (kind) return push({ kind, id });
    const s = d.sessions[id]?.id ?? props.lastSession?.(id);
    if (s) push({ kind: "session", id: s });
    else { setOk(false); setNote(`${id} has no session yet`); }
  };
  useInput((ch, key) => {
    if (ch === "q" || key.escape || (key.ctrl && ch === "c")) props.onExit();
    else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) setFocus(move(grid, at, key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : "right"));
    else if (key.return && at) openItem(at);
  }, { isActive: !stack.length });

  const view = stack.at(-1), size = { columns, rows };
  if (view?.kind === "session") return h(Session, { key: view.id, id: view.id, source: props.source!, size, onBack: pop });
  if (view?.kind === "ticket") {
    const ss = props.sessions?.(view.id) ?? [];
    return h(Detail, { key: view.kind + view.id, title: `ticket ${view.id}`, lines: props.ticket?.(view.id) ?? [], color: eventColor, size, onBack: pop,
      items: ss.map((s) => `${s.member} ${s.kind} ${new Date(s.started).toTimeString().slice(0, 8)} ${s.id}`), onPick: (i: number) => push({ kind: "session", id: ss[i].id }),
      ...(d.human.some((x) => x.id === view.id) && { hint: "type an answer", onSubmit: (text: string) => act({ kind: "answer", id: view.id, text }) }) });
  }
  if (view?.kind === "milestone") {
    const m = props.milestone?.(view.id) ?? { lines: [], tickets: [] };
    return h(Detail, { key: view.kind + view.id, title: `milestone ${view.id}`, lines: m.lines, size, onBack: pop,
      items: m.tickets.map((t) => `${t.status} ${t.id} ${t.title}`), onPick: (i: number) => push({ kind: "ticket", id: m.tickets[i].id }) });
  }
  if (view?.kind === "approval") {
    const i = d.inbox.find((x) => x.id === view.id);
    return h(Detail, { key: view.kind + view.id, title: `approval ${view.id}`, size, onBack: pop, hint: "/approve [note] · /reject TEXT",
      lines: i ? [`${i.id} ${i.kind}${i.ticket ? " " + i.ticket : ""}: ${i.text}`, "", ...(i.ticket ? props.thread?.(i.ticket) ?? [] : [])] : [],
      onSubmit: (text: string) => act(command(view.id, text)) });
  }
  if (view?.kind === "human") {
    const x = d.human.find((y) => y.id === view.id);
    return h(Detail, { key: view.kind + view.id, title: `question ${view.id}`, size, onBack: pop, hint: "type an answer",
      lines: x ? [`${x.id} ${x.title}: ${x.question}`, "", ...(props.thread?.(x.id) ?? [])] : [],
      onSubmit: (text: string) => act({ kind: "answer", id: view.id, text }) });
  }

  // a triage session has no ticket (ticket ""): "pm ● triaging", "pm ○ queued triage"
  const member = ({ name: m }: { name: string }) => {
    const s = d.sessions[m], q = d.queue.find((x) => x.member === m), u = d.memberUsage[m];
    const [mark, word, t] = s ? ["●", VERB[s.kind], s.ticket] : q ? ["○", q.kind === "triage" ? "queued triage" : "queued", q.ticket] : ["·", "idle", undefined];
    return h(Text, { key: m, wrap: "truncate-end", inverse: at === "u:" + m, color: s ? state.live : q ? state.wait : undefined, dimColor: !s && !q }, `${m} ${mark} ${word}${t ? " " + t : ""}${s ? " " + dur(d.now - s.started) : ""}${u ? ` ${k(u.input)}/${k(u.output)}` : ""}`);
  };
  const inbox = [...d.inbox.map((i) => line([`${i.id} ${i.kind}${i.ticket ? " " + i.ticket : ""}: ${i.text}`], "q" + i.id, at === "q:" + i.id)),
    ...d.human.map((x) => line([`${x.id} ${x.title}: ${x.question}`], "h" + x.id, at === "h:" + x.id))];
  const n = d.inbox.length + d.human.length;
  // milestones list: drop leading entries until the active one fits the width
  const ml = d.milestones.map((m) => `${m.id} ${m.name} ${pct(m.completion)}${m.active ? " ◀" : ""}`);
  const mark = (m: BoardData["milestones"][number], i: number) => m.completion >= 100 && !m.active
    ? [h(Text, { dimColor: true, key: "n" }, ml[i].slice(0, -1)), h(Text, { color: state.live, key: "c" }, MARK.approved)] : [ml[i]];
  const ai = d.milestones.findIndex((m) => m.active);
  let from = 0;
  while (from < ai && ml.slice(from, ai + 1).join(" · ").length > columns) from++;
  const total = d.usage.input + d.usage.output, lim = d.tokenLimit;
  const tokColor = lim && total > lim ? state.fail : lim && total >= 0.8 * lim ? state.wait : undefined;
  const closed = d.tickets.filter((t) => t.status === "canceled" || t.status === "duplicate").length;

  return h(Box, { flexDirection: "column", height: rows },
    line([h(Text, { bold: true, color: theme.accent, key: "t" }, "MAIHEM"), h(Text, { bold: true, key: "o" }, ` org ${d.org}`),
      h(Text, { dimColor: true, key: "m" }, " · "),
      h(Text, { color: COLOR[d.state.status], key: "st" }, d.state.status + (d.state.gate ? ` ${d.state.gate}` : "")),
      d.waiting ? h(Text, { color: state.wait, key: "w" }, " · waiting for human") : "",
      h(Text, { dimColor: true, key: "c" }, ` · ⏱ ${dur(d.time.running)} · `),
      h(Text, { color: tokColor, dimColor: !tokColor, key: "k" }, `tokens ${k(total, 2)}${lim ? ` / ${k(lim, 2)}` : ""}`),
      h(Text, { dimColor: true, key: "u" }, ` (↑ ${k(d.usage.input, 2)} / ↓ ${k(d.usage.output)})`)]),
    dim(`goal: ${d.goal}`),
    d.milestones.length ? line(d.milestones.slice(from).flatMap((m, i) => [i ? dim(" · ", m.id + "s") : "",
      h(Text, { key: m.id, inverse: at === "m:" + m.id, color: m.active ? "white" : undefined, dimColor: !m.active && m.completion < 100 }, ...mark(m, from + i))])) : null,
    h(Box, { marginTop: 1 }, ...cols.map(({ s, title, ts }) => {
      const here = new Set(ts.map((t) => t.id));
      return h(Box, { key: s, flexDirection: "column", flexGrow: 1, flexBasis: 0, paddingRight: 1 },
        h(Text, { bold: true, wrap: "truncate-end" }, `${title} (${ts.length})`),
        ...(s === "done" && closed ? [dim(`+${closed} canceled`)] : []),
        ...ts.flatMap((t) => card(t, !!t.parent && here.has(t.parent))));
    })),
    h(Box, { marginTop: 1, columnGap: 2, flexWrap: "wrap" }, ...members.map(member)),
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, { color: n ? state.wait : undefined, dimColor: !n }, n ? `Inbox (${n})` : "inbox empty"),
      ...inbox),
    h(Box, { marginTop: 1, flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden", justifyContent: "flex-end" }, ...d.recent.map((l, i) => {
      const c = eventColor(l), [, pre, kind, rest] = EVENT.exec(l) ?? [];
      return h(Box, { key: i, flexShrink: 0 }, c ? line([h(Text, { dimColor: true, key: "p" }, pre), h(Text, { color: c, key: "k" }, kind), h(Text, { dimColor: true, key: "r" }, rest)]) : dim(l));
    })),
    line([note ? h(Text, { color: ok ? state.live : undefined, dimColor: !ok, key: "n" }, note) : "", dim(`${note ? " · " : ""}↑↓←→ move · enter open · q quit`, "f")]));
}
