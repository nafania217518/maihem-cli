// SQLite store for an org: data access only, no rules (those live in ops.ts). Every domain write logs an event.
//
// Event kinds (actor = who wrote; ticket = the ticket it concerns, when any):
//   ticket.created {kind, label, priority, assignee?, parent?, milestone?} | ticket.status {from, to} | ticket.assigned {from, to}
//   ticket.priority {priority, ord?} | ticket.milestone {from, to} | ticket.description {by} (the text is not logged)
//   ticket.gate {gate} | ticket.branch {branch} | ticket.merged {commit} | ticket.summary {summary}
//   ticket.question {asker, status, assignee?} | {cleared} | ticket.comment {comment, text}
//   approval.set {reviewer, state} | approval.removed {reviewer}
//   relation.added {from, to, kind} | relation.removed {from, to, kind} (ticket = from)
//   milestone.created {id, name} | milestone.renamed {id, name} | milestone.updated {id, name?, description?} | milestone.reordered {order} | milestone.deleted {id}
//   inbox.opened {id, kind} | inbox.answered {id, kind, approved, answer, asker}
//   free kinds through log(): session.*, org.*, git.*
// Meta is derived state: its writes log nothing.
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CLOSED } from "./types.ts";
import type { Approval, ApprovalState, Comment, InboxItem, Label, Milestone, OrgEvent, Priority, Relation, RelationKind, Status, Ticket, TicketKind } from "./types.ts";

export interface NewTicket { title: string; description?: string; status?: Status; label?: Label; priority?: Priority; assignee?: string; milestone?: string; parent?: string; kind?: TicketKind; gate?: Ticket["gate"] }
export type TicketView = Ticket & { approvals: Approval[]; relations: Relation[]; comments: Comment[] };

export interface Tracker {
  createTicket(t: NewTicket, actor: string): Ticket;
  setStatus(id: string, status: Status, actor: string): Ticket;
  setAssignee(id: string, member: string | null, actor: string): Ticket;
  setPriority(id: string, priority: Priority, actor: string, ord?: number): Ticket;
  setMilestone(id: string, milestone: string | null, actor: string): Ticket;
  setTitle(id: string, title: string, actor: string): Ticket;
  setDescription(id: string, text: string, actor: string): Ticket;
  setGate(id: string, gate: Ticket["gate"] | null, actor: string): Ticket;
  setBranch(id: string, branch: string | null, actor: string): Ticket;
  setMerged(id: string, commit: string, actor: string): Ticket;
  setSummary(id: string, summary: string, actor: string): Ticket;
  setApproval(ticket: string, reviewer: string, state: ApprovalState, actor: string): void;
  removeApproval(ticket: string, reviewer: string, actor: string): void;
  addRelation(from: string, to: string, kind: RelationKind, actor: string): void;
  removeRelation(from: string, to: string, kind: RelationKind, actor: string): void;
  createMilestone(name: string, description: string, actor: string): Milestone;
  updateMilestone(id: string, p: { name?: string; description?: string }, actor: string): Milestone;
  reorderMilestones(ids: string[], actor: string): void;
  deleteMilestone(id: string, actor: string): void;
  setQuestion(id: string, q: { asker: string; status: Status; assignee?: string } | null, actor: string): Ticket;
  addComment(ticket: string, text: string, actor: string): Comment;
  getTicket(id: string): TicketView;
  listTickets(f?: { status?: Status; assignee?: string; milestone?: string; parent?: string }): Ticket[];
  children(id: string): Ticket[];
  blockers(id: string): Ticket[];
  isBlocked(id: string): boolean;
  listMilestones(): Milestone[];
  getMilestone(id: string): Milestone;
  ask(text: string, actor: string, o?: { ticket?: string; files?: string[] }): InboxItem; // an approval
  answer(id: string, text: string, actor: string, approved: boolean): InboxItem;
  inbox(state?: "open" | "answered"): InboxItem[];
  getInbox(id: string): InboxItem;
  log(kind: string, actor: string, data?: Record<string, unknown>, ticket?: string): OrgEvent;
  events(afterId?: number, limit?: number): OrgEvent[];
  getMeta<T>(key: string): T | undefined;
  setMeta(key: string, value: unknown): void;
  close(): void;
}

type Row = Record<string, any>;
// row → object without null fields
const clean = <T>(r: Row): T => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as T;
const ticket = ({ seq: _, ...r }: Row): Ticket => clean(r);
const item = (r: Row): InboxItem => ({ id: r.id, kind: r.kind, author: r.author, ticket: r.ticket ?? undefined, text: r.text, files: JSON.parse(r.files), state: r.state, answer: r.answer ?? undefined, approved: r.approved == null ? undefined : !!r.approved, at: r.at });
const event = (r: Row): OrgEvent => ({ id: r.id, at: r.at, kind: r.kind, actor: r.actor, ticket: r.ticket ?? undefined, data: JSON.parse(r.data) });
const milestone = ({ seq: _, ...r }: Row): Milestone => r as Milestone;
// how a model finds a valid id (inbox items are the human's: no hint)
const LOOKUP: Record<string, string> = { ticket: "use ticket_list to see the ids", milestone: "use milestone_list to see the ids" };
// agents put ids into names: "M2 Login", "T-4: Login"; the tracker strips them
const mname = (n: string) => n.replace(/^M\d+\s+/, "");
const bare = (title: string) => title.replace(/^T-\d+:?\s+/, "");
const closed = CLOSED.map((s) => `'${s}'`).join(",");

export function openTracker(file: string, now: () => number = Date.now): Tracker {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tickets(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, title, description, status, label, priority, ord, owner, assignee, milestone, parent, branch, merged, summary, kind, gate, asker, return_status, return_assignee, created, updated);
    CREATE TABLE IF NOT EXISTS approvals(ticket, reviewer, state, PRIMARY KEY(ticket, reviewer));
    CREATE TABLE IF NOT EXISTS relations("from", "to", kind, PRIMARY KEY("from", "to", kind));
    CREATE TABLE IF NOT EXISTS milestones(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, name, description, ord);
    CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, ticket, author, text, at);
    CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, kind, author, ticket, text, files, state, answer, approved, at);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at, kind, actor, ticket, data);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value);`);
  const get = (sql: string, ...a: SQLInputValue[]) => db.prepare(sql).get(...a) as Row | undefined;
  const all = (sql: string, ...a: SQLInputValue[]) => db.prepare(sql).all(...a) as Row[];
  const run = (sql: string, ...a: SQLInputValue[]) => db.prepare(sql).run(...a);

  const log: Tracker["log"] = (kind, actor, data = {}, tk) => {
    const at = now();
    const r = run("INSERT INTO events(at,kind,actor,ticket,data) VALUES(?,?,?,?,?)", at, kind, actor, tk ?? null, JSON.stringify(data));
    return { id: Number(r.lastInsertRowid), at, kind, actor, ticket: tk, data };
  };
  const must = <T>(what: string, r: Row | undefined, id: string | number, map: (r: Row) => T): T => {
    if (!r) throw new Error(`no such ${what}: ${id}${LOOKUP[what] ? `; ${LOOKUP[what]}` : ""}`);
    return map(r);
  };
  const getT = (id: string) => must("ticket", get("SELECT * FROM tickets WHERE id=?", id), id, ticket);
  const getM = (id: string) => must("milestone", get("SELECT * FROM milestones WHERE id=?", id), id, milestone);
  const getInbox = (id: string) => must("inbox item", get("SELECT * FROM inbox WHERE id=?", id), id, item);
  const tickets = (where: string, ...a: SQLInputValue[]) => all(`SELECT * FROM tickets ${where} ORDER BY seq`, ...a).map(ticket);

  const blockers = (id: string) => tickets(`WHERE status NOT IN (${closed}) AND id IN (SELECT "from" FROM relations WHERE kind='blocks' AND "to"=?)`, id);
  // sets one ticket column and logs one event; a write that changes nothing logs nothing
  const change = (id: string, col: keyof Ticket, value: SQLInputValue, actor: string, kind: string, data: (old: unknown) => Record<string, unknown>): Ticket => {
    const cur = getT(id), old = cur[col] ?? null;
    if (old === value) return cur;
    run(`UPDATE tickets SET ${col}=?, updated=? WHERE id=?`, value, now(), id);
    log(kind, actor, data(old), id);
    return getT(id);
  };

  return {
    createTicket(t, actor) {
      if (t.parent) getT(t.parent);
      if (t.milestone) getM(t.milestone);
      const at = now(), f = { label: t.label ?? "other", priority: t.priority ?? 0, kind: t.kind ?? "normal" };
      const r = run("INSERT INTO tickets(title,description,status,label,priority,owner,assignee,milestone,parent,kind,gate,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        bare(t.title), t.description ?? "", t.status ?? "triage", f.label, f.priority, actor, t.assignee ?? null, t.milestone ?? null, t.parent ?? null, f.kind, t.gate ?? null, at, at);
      const id = `T-${r.lastInsertRowid}`;
      run("UPDATE tickets SET id=?, ord=seq WHERE seq=?", id, r.lastInsertRowid);
      log("ticket.created", actor, clean({ kind: f.kind, label: f.label, priority: f.priority, assignee: t.assignee ?? null, parent: t.parent ?? null, milestone: t.milestone ?? null }), id);
      return getT(id);
    },
    setStatus: (id, status, actor) => change(id, "status", status, actor, "ticket.status", (from) => ({ from, to: status })),
    setAssignee: (id, m, actor) => change(id, "assignee", m, actor, "ticket.assigned", (from) => ({ from, to: m })),
    setPriority(id, priority, actor, ord) {
      getT(id);
      run("UPDATE tickets SET priority=?, ord=COALESCE(?, ord), updated=? WHERE id=?", priority, ord ?? null, now(), id);
      log("ticket.priority", actor, ord === undefined ? { priority } : { priority, ord }, id);
      return getT(id);
    },
    setMilestone(id, m, actor) {
      if (m) getM(m);
      return change(id, "milestone", m, actor, "ticket.milestone", (from) => ({ from, to: m }));
    },
    setTitle: (id, title, actor) => change(id, "title", bare(title), actor, "ticket.title", (from) => ({ from, to: bare(title) })),
    setDescription: (id, text, actor) => change(id, "description", text, actor, "ticket.description", () => ({ by: actor })),
    setGate: (id, gate, actor) => change(id, "gate", gate ?? null, actor, "ticket.gate", () => ({ gate })),
    setBranch: (id, branch, actor) => change(id, "branch", branch, actor, "ticket.branch", () => ({ branch })),
    setMerged: (id, commit, actor) => change(id, "merged", commit, actor, "ticket.merged", () => ({ commit })),
    setSummary: (id, summary, actor) => change(id, "summary", summary, actor, "ticket.summary", () => ({ summary })),
    setApproval(tk, reviewer, state, actor) {
      getT(tk);
      run("INSERT INTO approvals(ticket,reviewer,state) VALUES(?,?,?) ON CONFLICT DO UPDATE SET state=excluded.state", tk, reviewer, state);
      log("approval.set", actor, { reviewer, state }, tk);
    },
    removeApproval(tk, reviewer, actor) {
      run("DELETE FROM approvals WHERE ticket=? AND reviewer=?", tk, reviewer);
      log("approval.removed", actor, { reviewer }, tk);
    },
    addRelation(from, to, kind, actor) {
      getT(from); getT(to);
      if (run('INSERT OR IGNORE INTO relations("from","to",kind) VALUES(?,?,?)', from, to, kind).changes) log("relation.added", actor, { from, to, kind }, from);
    },
    removeRelation(from, to, kind, actor) {
      run('DELETE FROM relations WHERE "from"=? AND "to"=? AND kind=?', from, to, kind);
      log("relation.removed", actor, { from, to, kind }, from);
    },
    createMilestone(name, description, actor) {
      const ord = Number(get("SELECT COALESCE(MAX(ord)+1, 0) AS n FROM milestones")!.n);
      const r = run("INSERT INTO milestones(name,description,ord) VALUES(?,?,?)", name = mname(name), description, ord);
      const id = `M${Number(r.lastInsertRowid) - 1}`;
      run("UPDATE milestones SET id=? WHERE seq=?", id, r.lastInsertRowid);
      log("milestone.created", actor, { id, name });
      return getM(id);
    },
    updateMilestone(id, p, actor) {
      const m = getM(id);
      if (p.name !== undefined) p = { ...p, name: mname(p.name) };
      run("UPDATE milestones SET name=?, description=? WHERE id=?", p.name ?? m.name, p.description ?? m.description, id);
      log("milestone.updated", actor, { id, ...p });
      return getM(id);
    },
    reorderMilestones(ids, actor) {
      ids.forEach(getM);
      ids.forEach((id, i) => run("UPDATE milestones SET ord=? WHERE id=?", i, id));
      log("milestone.reordered", actor, { order: ids });
    },
    deleteMilestone(id, actor) {
      getM(id);
      run("DELETE FROM milestones WHERE id=?", id);
      log("milestone.deleted", actor, { id });
    },
    setQuestion(id, q, actor) {
      getT(id);
      run("UPDATE tickets SET asker=?, return_status=?, return_assignee=?, updated=? WHERE id=?", q?.asker ?? null, q?.status ?? null, q?.assignee ?? null, now(), id);
      log("ticket.question", actor, q ? clean({ asker: q.asker, status: q.status, assignee: q.assignee ?? null }) : { cleared: true }, id);
      return getT(id);
    },
    addComment(tk, text, actor) {
      getT(tk);
      const at = now(), r = run("INSERT INTO comments(ticket,author,text,at) VALUES(?,?,?,?)", tk, actor, text, at), id = Number(r.lastInsertRowid);
      log("ticket.comment", actor, { comment: id, text }, tk);
      return { id, ticket: tk, author: actor, text, at };
    },
    getTicket(id) {
      const t = getT(id);
      return {
        ...t,
        approvals: all("SELECT * FROM approvals WHERE ticket=? ORDER BY rowid", id) as Approval[],
        relations: all('SELECT * FROM relations WHERE "from"=? OR "to"=? ORDER BY rowid', id, id) as Relation[],
        comments: all("SELECT * FROM comments WHERE ticket=? ORDER BY id", id) as Comment[],
      };
    },
    listTickets(f = {}) {
      const keys = (["status", "assignee", "milestone", "parent"] as const).filter((k) => f[k] !== undefined);
      return tickets(keys.length ? "WHERE " + keys.map((k) => `${k}=?`).join(" AND ") : "", ...keys.map((k) => f[k]!));
    },
    children: (id) => tickets("WHERE parent=?", id),
    blockers,
    isBlocked: (id) => blockers(id).length > 0,
    listMilestones: () => all("SELECT * FROM milestones ORDER BY ord, seq").map(milestone),
    getMilestone: getM,
    ask(text, actor, o = {}) {
      const kind = "approval";
      const r = run("INSERT INTO inbox(kind,author,ticket,text,files,state,at) VALUES(?,?,?,?,?,'open',?)", kind, actor, o.ticket ?? null, text, JSON.stringify(o.files ?? []), now());
      const id = `Q-${r.lastInsertRowid}`;
      run("UPDATE inbox SET id=? WHERE seq=?", id, r.lastInsertRowid);
      log("inbox.opened", actor, { id, kind }, o.ticket);
      return getInbox(id);
    },
    answer(id, text, actor, approved) {
      const it = getInbox(id);
      if (it.state === "answered") throw new Error(`${id} is already answered`);
      if (typeof approved !== "boolean") throw new Error(`${id} needs approve or reject`);
      run("UPDATE inbox SET state='answered', answer=?, approved=? WHERE id=?", text, approved ? 1 : 0, id);
      log("inbox.answered", actor, { id, kind: it.kind, approved, answer: text, asker: it.author }, it.ticket);
      return getInbox(id);
    },
    inbox: (state) => all(`SELECT * FROM inbox ${state ? "WHERE state=?" : ""} ORDER BY seq`, ...(state ? [state] : [])).map(item),
    getInbox,
    log,
    events: (afterId = 0, limit) => all("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", afterId, limit ?? -1).map(event),
    getMeta<T>(key: string) {
      const r = get("SELECT value FROM meta WHERE key=?", key);
      return r ? (JSON.parse(r.value) as T) : undefined;
    },
    setMeta: (key, value) => void run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value)),
    close: () => db.close(),
  };
}
