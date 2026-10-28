// `maihem org ...`: ls, inspect, rm, start, stop, resume, log, board, inbox, approve, reject, answer, cancel, assign, ticket, tickets, milestones.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import React from "react";
import { render } from "ink";
import YAML from "yaml";
import { answerHint, Board, hint } from "../ui/Board.ts";
import type { Action, BoardData, Source } from "../ui/Board.ts";
import { replaySource } from "../ui/App.ts";
import { lineSplitter } from "../protocol.ts";
import type { AgentEvent } from "../protocol.ts";
import { loadState, readEvents, refresh, sockPath } from "../state.ts";
import { k } from "../ui/transcript.ts";
import { pad } from "../pad.ts";
import { deps, runFile } from "../run.ts";
import { prepareRepo } from "./git.ts";
import { dbFile, loadRunnable, orgDir, orgPid, pidFile } from "./daemon.ts";
import { createOps } from "./ops.ts";
import { listOrgs, loadOrg, removeOrg } from "./store.ts";
import { openTracker } from "./tracker.ts";
import type { Tracker, TicketView } from "./tracker.ts";
import { STATUSES } from "./types.ts";
import type { OrgEvent, Role, Status } from "./types.ts";

type D = Record<string, unknown>;
const PRIORITY = ["none", "low", "medium", "high", "urgent"];
const status = (t: Tracker) => t.getMeta<{ status?: string }>("state")?.status;

// first line of a text; "…" marks that more lines follow
const first = (v: unknown): string => {
  const [line, ...more] = String(v ?? "").split("\n");
  return more.length ? `${line} …` : line;
};
const title = (t: Tracker, e: OrgEvent) => (e.kind === "ticket.created" ? t.getTicket(e.ticket!).title : undefined);
const short = (c: unknown) => String(c).slice(0, 7);

// a short detail per event kind: the ticket, then what changed; a session without a ticket is a triage session
const who = (m: unknown) => (m ? `@${m}` : "unassigned");
const DETAIL: Record<string, (d: D, tk: string | undefined, title?: string) => unknown[]> = {
  "ticket.created": (d, tk, title) => [tk, title && `"${title}"`, d.assignee && `@${d.assignee}`, d.parent && `under ${d.parent}`, d.milestone && `in ${d.milestone}`],
  "ticket.status": (d, tk) => [tk, `${d.from} → ${d.to}`],
  "ticket.assigned": (d, tk) => [tk, `${who(d.from)} → ${who(d.to)}`],
  "ticket.title": (d, tk) => [tk, `"${d.from}" → "${d.to}"`],
  "ticket.comment": (d, tk) => [tk, first(d.text)],
  "ticket.question": (d, tk) => [tk, d.cleared ? "answered" : `${d.asker} asks, back to ${who(d.assignee)} ${d.status}`],
  "ticket.priority": (d, tk) => [tk, `P${d.priority}`],
  "ticket.milestone": (d, tk) => [tk, `${d.from ?? "-"} → ${d.to ?? "-"}`],
  "ticket.description": (d, tk) => [tk, "edited"],
  "ticket.summary": (d, tk) => [tk, first(d.summary)],
  "ticket.gate": (d, tk) => [tk, `gate ${d.gate ?? "cleared"}`],
  "ticket.branch": (d, tk) => [tk, `⎇ ${d.branch}`],
  "ticket.merged": (d, tk) => [tk, short(d.commit)],
  "approval.set": (d, tk) => [tk, d.reviewer, d.state],
  "approval.removed": (d, tk) => [tk, d.reviewer, "removed"],
  "relation.added": (d, tk) => [tk, d.kind, d.to],
  "relation.removed": (d, tk) => [tk, d.kind, d.to],
  "milestone.created": (d) => [d.id, d.name],
  "milestone.renamed": (d) => [d.id, d.name], // old runs
  "milestone.updated": (d) => [d.id, d.name, d.description],
  "milestone.reordered": (d) => [(d.order as string[]).join(", ")],
  "milestone.deleted": (d) => [d.id],
  "milestone.completed": (d) => [d.id],
  "inbox.opened": (d) => [d.id, d.kind],
  "inbox.answered": (d) => [d.id, d.approved === undefined ? "answered" : d.approved ? "approved" : "rejected"],
  "review.done": (d, tk) => [tk, "all reviewers approved"],
  "review.undecided": (d, tk) => [tk, `${d.member} ended without a decision`],
  "git.init": (d) => [d.repo],
  "git.merged": (d, tk) => [tk, "merged", d.commit ? short(d.commit) : "(no changes)"],
  "git.conflict": (d, tk) => [tk, `conflict: ${(d.files as string[]).join(", ")}`],
  "git.discarded": (d, tk) => [tk, `discarded ${(d.files as string[]).join(", ")} (${d.member})`],
  "git.error": (d, tk) => [tk, `${d.op}: ${first(d.message)}`],
  "git.tagged": (d) => [d.milestone, "tagged", d.tag],
  "git.push_failed": (d) => [`push of ${d.milestone} failed: ${first(d.message)}`],
  "session.started": (d, tk) => tk ? [tk, d.kind] : ["triage"],
  "session.ended": (d, tk) => d.input === undefined ? [`${d.tokens} tokens`] : [tk || "triage", `${k(Number(d.input))} in / ${k(Number(d.output))} out`],
  "session.failed": (d, tk) => [tk || "triage", d.status && `HTTP ${d.status}`, first(d.error)],
  "session.capped": (d, tk) => [tk || "triage", "step cap", d.steps],
  "org.paused": (d) => [first(d.reason)],
  "org.started": (d) => [first(d.goal)],
  "org.resumed": () => [],
  "org.done": () => [],
  "org.stopped": (d) => [first(d.reason)],
};
export const EVENT_KINDS = Object.keys(DETAIL);

// one line per event: time, actor, kind, then the detail; unknown kinds show their data as JSON
export function formatEvent(e: OrgEvent, title?: string): string {
  const d = e.data as D;
  const parts = DETAIL[e.kind]?.(d, e.ticket, title) ?? (Object.keys(d).length ? [JSON.stringify(d)] : []);
  return [new Date(e.at).toTimeString().slice(0, 8), e.actor, e.kind, ...parts.filter((p) => p !== undefined && p !== null && p !== "")].join(" ");
}

// time since the first org.started minus the paused spans (org.paused/org.stopped until org.resumed/org.started)
function times(t: Tracker, status: string, now: number): BoardData["time"] {
  const es = t.events().filter((e) => e.kind.startsWith("org."));
  const start = es.find((e) => e.kind === "org.started")?.at;
  if (start === undefined) return { running: 0 };
  const end = status === "done" || status === "stopped" ? es.findLast((e) => e.kind === "org.done" || e.kind === "org.stopped")?.at ?? now : now;
  let paused = 0, from: number | undefined;
  for (const e of es) {
    if ((e.kind === "org.paused" || e.kind === "org.stopped") && from === undefined) from = e.at;
    else if ((e.kind === "org.resumed" || e.kind === "org.started") && from !== undefined) { paused += Math.min(e.at, end) - from; from = undefined; }
  }
  if (from !== undefined && from < end) paused += end - from;
  return { running: end - start - paused };
}

// tickets in Needs Reply for the human, with the last comment (the question)
const waitsForHuman = (t: Tracker): BoardData["human"] =>
  t.listTickets({ status: "needs_reply" }).filter((x) => x.assignee === "human").map((x) => ({ id: x.id, title: x.title, question: t.getTicket(x.id).comments.at(-1)?.text ?? "" }));

export function boardData(name: string, t: Tracker, now = Date.now()): BoardData {
  const o = loadOrg(name), ops = createOps(t, o), active = ops.active()?.id;
  const usage = { input: 0, output: 0 }, memberUsage: BoardData["memberUsage"] = {};
  for (const e of t.events()) if (e.kind === "session.ended" && e.data.input !== undefined) {
    const m = (memberUsage[e.actor] ??= { input: 0, output: 0 }), i = Number(e.data.input), out = Number(e.data.output ?? 0);
    m.input += i; m.output += out; usage.input += i; usage.output += out;
  }
  return {
    org: name,
    goal: t.getMeta<string>("goal") ?? "",
    state: t.getMeta<BoardData["state"]>("state") ?? { status: "-" },
    usage, memberUsage,
    members: Object.entries(o.members).map(([n, x]) => ({ name: n, role: x.role as Role })),
    milestones: t.listMilestones().map((m) => ({ id: m.id, name: m.name, completion: ops.completion(m.id), active: m.id === active })),
    tickets: t.listTickets().map((x) => ({ ...x, blocked: t.isBlocked(x.id), approvals: t.getTicket(x.id).approvals })),
    time: times(t, t.getMeta<BoardData["state"]>("state")?.status ?? "-", now), now,
    tokenLimit: t.getMeta<number>("tokenLimit") ?? undefined,
    sessions: Object.fromEntries(Object.entries(t.getMeta<Record<string, Omit<BoardData["sessions"][string], "started">>>("sessions") ?? {}).map(([m, s]) =>
      [m, { ...s, started: t.events().find((e) => e.kind === "session.started" && e.data.id === s.id)?.at ?? now }])),
    queue: t.getMeta("queue") ?? [],
    inbox: t.inbox("open"),
    human: waitsForHuman(t),
    waiting: t.getMeta<boolean>("waiting") ?? false,
    recent: t.events().slice(-200).map((e) => formatEvent(e, title(t, e))),
  };
}

// a ticket's comments, a comment's later lines indented
const comments = (tk: TicketView) => (tk.comments.length ? ["comments", tk.comments.map((c) => `  ${c.author}: ${c.text.replaceAll("\n", "\n    ")}`).join("\n")] : []);

// the full ticket: fields, description, comments, then its history
export function ticketLines(t: Tracker, id: string): string[] {
  const tk = t.getTicket(id), rel = tk.relations;
  const ids = (xs: string[]) => xs.join(", ") || "-";
  // the other end of each relation of a kind, on the given side (relations hold only links of this ticket)
  const ends = (kind: string, side: "from" | "to") => ids(rel.filter((r) => r.kind === kind && r[side] !== id).map((r) => r[side]));
  const fields = [
    ["status", tk.status], ["kind", tk.kind], ["label", tk.label], ["priority", PRIORITY[tk.priority]], ["milestone", tk.milestone ?? "-"],
    ["owner", tk.owner], ["assignee", tk.assignee ?? "-"], ["reviewers", tk.approvals.map((a) => `${a.reviewer} ${a.state}`).join(", ") || "-"],
    ["parent", tk.parent ?? "-"], ["sub-tickets", ids(t.children(id).map((c) => c.id))],
    ["blocked by", ends("blocks", "from")], ["blocks", ends("blocks", "to")],
    ["related", ids(rel.filter((r) => r.kind === "related").map((r) => (r.from === id ? r.to : r.from)))],
    ["original", ends("duplicate", "to")], ["duplicates", ends("duplicate", "from")],
    ["branch", tk.branch ?? "-"], ["merged", tk.merged ? short(tk.merged) : "-"],
  ];
  const c = comments(tk);
  return [`${tk.id} ${tk.title}`, ...pad(fields), "", tk.description || "(no description)", ...(c.length ? ["", ...c] : []),
    "", "history", t.events().filter((e) => e.ticket === id).map((e) => formatEvent(e, title(t, e))).join("\n")].join("\n").split("\n");
}

// an approval or a question thread: the ticket summary and comments
const thread = (t: Tracker, id: string): string[] => {
  const tk = t.getTicket(id), ls = [...(tk.summary ? [`summary: ${tk.summary}`] : []), ...comments(tk)];
  return ls.length ? ls.join("\n").split("\n") : [];
};

// a milestone: completion, its acceptance summary, its tickets by status
function milestoneDetail(t: Tracker, name: string, id: string) {
  const m = t.listMilestones().find((x) => x.id === id), ops = createOps(t, loadOrg(name));
  const ts = t.listTickets({ milestone: id }).sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
  const acc = ts.find((x) => x.kind === "acceptance");
  return {
    lines: [`${id} ${m?.name ?? ""} ${Math.round(ops.completion(id))}%`, "", acc ? `acceptance ${acc.id}: ${acc.summary ?? "(no summary yet)"}` : "no acceptance ticket"],
    tickets: ts.map((x) => ({ id: x.id, title: x.title, status: x.status })),
  };
}

const started = (t: Tracker) => t.events().filter((e) => e.kind === "session.started");

// a session for the board: the live socket while it runs, else a replay of its saved events
export function sessionSource(id: string): Source {
  const s = refresh(loadState(id));
  if (s.status === "running" && fs.existsSync(sockPath(id))) {
    const sock = net.connect(sockPath(id));
    sock.on("error", () => {});
    return {
      subscribe: (cb) => {
        const feed = lineSplitter((o) => cb(o as AgentEvent));
        sock.on("data", feed);
        return () => sock.off("data", feed);
      },
      close: () => sock.end(),
    };
  }
  const def = fs.existsSync(runFile(id)) ? JSON.parse(fs.readFileSync(runFile(id), "utf8")).def : {};
  return { subscribe: replaySource({ name: s.name, model: def.model ?? "-", provider: def.provider ?? "-", sandbox: s.sandbox, id, workdir: s.workdir, readonly: true }, readEvents(id)), close: () => {} };
}

const mustRun = (name: string) => {
  if (!orgPid(name)) throw new Error(`org ${name} is not running; start it: maihem org start ${name} "GOAL"`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function orgCommand(argv: string[]): Promise<boolean> {
  const [sub, name, ...rest] = argv;
  const { values: v, positionals: pos } = parseArgs({
    args: rest, allowPositionals: true,
    options: { f: { type: "boolean", short: "f" }, m: { type: "string", short: "m" }, ticket: { type: "string" }, milestone: { type: "string" }, status: { type: "string" } },
  });
  // open the org db; a missing db means the org never ran
  const open = (): Tracker => {
    if (!fs.existsSync(dbFile(name))) throw new Error(`org ${name} has not run yet; start it: maihem org start ${name} "GOAL"`);
    return openTracker(dbFile(name));
  };
  const using = async (fn: (t: Tracker) => unknown) => {
    const t = open();
    try { await fn(t); } finally { t.close(); }
  };
  // the human acts; the org must run to act on it
  const human = async (fn: (t: Tracker) => string) => {
    await using((t) => {
      mustRun(name);
      console.log(fn(t));
    });
    return true;
  };
  const approval = (id: string | undefined, text: string | undefined, approved: boolean) =>
    id && text !== undefined ? human((t) => (t.answer(id, text, "user", approved), `answered ${id}`)) : false;
  const ops = (fn: (o: ReturnType<typeof createOps>) => string) => human((t) => fn(createOps(t, loadOrg(name))));

  if (sub === "ls") {
    const st = (n: string) => {
      if (!fs.existsSync(dbFile(n))) return "-";
      const t = openTracker(dbFile(n));
      try { return status(t) ?? "-"; } finally { t.close(); }
    };
    const rows = listOrgs().map((o) => [o.name, Object.keys(o.members).join(","), o.repo, st(o.name)]);
    for (const l of pad([["NAME", "MEMBERS", "REPO", "STATUS"], ...rows])) console.log(l);
  } else if (sub === "inspect" && name) {
    console.log(YAML.stringify(loadOrg(name)));
  } else if (sub === "rm" && name) {
    if (orgPid(name)) throw new Error(`org ${name} is running; stop it first: maihem org stop ${name}`);
    removeOrg(name);
    console.log(`removed ${name}`);
  } else if ((sub === "start" && name && pos[0]) || (sub === "resume" && name)) {
    const { org } = loadRunnable(name);
    if (orgPid(name)) throw new Error(`org ${name} is already running`);
    const resume = sub === "resume";
    if (resume) await using((t) => { if (status(t) === "done") throw new Error(`org ${name} is done; start it over: maihem org start ${name} "GOAL"`); });
    if (prepareRepo(org.repo).created) console.log(`created an initial commit in ${org.repo}`);
    fs.mkdirSync(orgDir(name), { recursive: true });
    if (!resume) fs.writeFileSync(path.join(orgDir(name), "start.json"), JSON.stringify({ goal: pos[0] }));
    const fd = fs.openSync(path.join(orgDir(name), "org.log"), "a");
    const bin = fileURLToPath(new URL("../../bin/maihem.js", import.meta.url));
    const child = deps.spawn(process.execPath, [bin, "__org", name, ...(resume ? ["--resume"] : [])], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    fs.closeSync(fd);
    child.unref();
    fs.writeFileSync(pidFile(name), String(child.pid));
    console.log(`${resume ? "resumed" : "started"} org ${name}; watch: maihem org board ${name}`);
  } else if (sub === "stop" && name) {
    const pid = orgPid(name);
    if (!pid) throw new Error(`org ${name} is not running`);
    process.kill(pid, "SIGTERM");
    console.log(`stopped org ${name}`);
  } else if (sub === "log" && name) {
    await using(async (t) => {
      for (let last = 0; ;) {
        const done = !v.f || ["done", "stopped"].includes(status(t) ?? "");
        for (const e of t.events(last)) { last = e.id; if (!v.ticket || e.ticket === v.ticket) console.log(formatEvent(e, title(t, e))); }
        if (done) break;
        await sleep(deps.pollMs);
      }
    });
  } else if (sub === "board" && name) {
    await using((t) => new Promise<void>((resolve) => {
      const act = (a: Action) => {
        mustRun(name);
        if (a.kind === "answer") return createOps(t, loadOrg(name)).answer(a.id, a.text, "user");
        t.answer(a.id, a.text, "user", a.kind === "approve");
        return `answered ${a.id}`;
      };
      const board = React.createElement(Board, {
        read: () => boardData(name, t), onExit: () => { app.unmount(); resolve(); }, act,
        ticket: (id) => ticketLines(t, id), thread: (id) => thread(t, id), milestone: (id) => milestoneDetail(t, name, id),
        sessions: (tk) => started(t).filter((e) => e.ticket === tk).map((e) => ({ id: String(e.data.id), member: e.actor, kind: String(e.data.kind ?? "session"), started: e.at })),
        lastSession: (m) => started(t).findLast((e) => e.actor === m)?.data.id as string | undefined,
        source: sessionSource,
      });
      const app = render(board, { alternateScreen: true, exitOnCtrlC: false, patchConsole: false });
    }));
  } else if (sub === "inbox" && name) {
    await using((t) => {
      const items = t.inbox("open"), hs = waitsForHuman(t);
      if (!items.length && !hs.length) return console.log("inbox empty");
      const rows = pad(items.map((i) => [i.id, i.kind, i.author, i.ticket ?? "-", first(i.text), i.files.join(", ")]));
      items.forEach((i, n) => console.log(`${rows[n]}\n  ${hint(name, i)}`));
      const hr = pad(hs.map((x) => [x.id, x.title, first(x.question)]));
      hs.forEach((x, n) => console.log(`${hr[n]}\n  ${answerHint(name, x.id)}`));
    });
  } else if (sub === "approve" && name) return approval(pos[0], v.m ?? "approved", true);
  else if (sub === "reject" && name) return approval(pos[0], v.m, false);
  else if (sub === "answer" && name && pos[0] && pos[1] !== undefined) return ops((o) => o.answer(pos[0], pos[1], "user"));
  else if (sub === "cancel" && name && pos[0] && pos[1]) return ops((o) => o.cancel(pos[0], pos[1], "user"));
  else if (sub === "assign" && name && pos[0] && pos[1]) return ops((o) => o.assign(pos[0], pos[1], "user"));
  else if (sub === "ticket" && name && pos[0]) await using((t) => console.log(ticketLines(t, pos[0]).join("\n")));
  else if (sub === "tickets" && name) {
    await using((t) => {
      if (v.status && !(STATUSES as readonly string[]).includes(v.status)) throw new Error(`unknown status ${v.status}; use one of ${STATUSES.join(", ")}`);
      const ts = t.listTickets({ milestone: v.milestone, status: v.status as Status | undefined });
      if (!ts.length) return console.log("no tickets");
      for (const l of pad(ts.map((x) => [x.id, x.status, `P${x.priority}`, x.milestone ?? "-", x.assignee ? `@${x.assignee}` : "-", x.title]))) console.log(l);
    });
  } else if (sub === "milestones" && name) {
    await using((t) => {
      const ms = t.listMilestones(), ops = createOps(t, loadOrg(name)), active = ops.active()?.id;
      if (!ms.length) return console.log("no milestones");
      const rows = ms.map((m) => {
        const ts = t.listTickets({ milestone: m.id }).filter((x) => x.status !== "canceled" && x.status !== "duplicate");
        return [m.id, m.name, `${Math.round(ops.completion(m.id))}%`, `${ts.filter((x) => x.status === "done").length}/${ts.length} done`, m.id === active ? "◀ active" : ""];
      });
      for (const l of pad(rows)) console.log(l);
    });
  } else return false;
  return true;
}
