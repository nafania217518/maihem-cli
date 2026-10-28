import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";

const dirs: string[] = [];
const open: Tracker[] = [];
let t = 0;
const clock = () => ++t;
function mk(file?: string) {
  const dir = mkdtempSync(join(tmpdir(), "trk-"));
  dirs.push(dir);
  const path = file ?? join(dir, "sub", "org.db");
  const tr = openTracker(path, clock);
  open.push(tr);
  return { tr, path };
}
afterEach(() => {
  for (const o of open.splice(0)) try { o.close(); } catch {}
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  t = 0;
});
const last = (tr: Tracker) => tr.events().at(-1)!;

describe("tracker", () => {
  it("creates tickets with sequential ids, defaults and a created event", () => {
    const { tr } = mk();
    const a = tr.createTicket({ title: "A" }, "ba");
    expect(a).toMatchObject({ id: "T-1", title: "A", description: "", status: "triage", label: "other", priority: 0, ord: 1, owner: "ba", kind: "normal" });
    for (const k of ["assignee", "milestone", "parent", "branch", "merged", "gate"]) expect(a).not.toHaveProperty(k);
    expect(last(tr)).toMatchObject({ kind: "ticket.created", actor: "ba", ticket: "T-1", data: { kind: "normal", label: "other", priority: 0 } });
    tr.createMilestone("M", "", "ba");
    const b = tr.createTicket({ title: "B", description: "d", status: "todo", label: "bug", priority: 3, assignee: "dev", parent: "T-1", milestone: "M0", kind: "breakdown", gate: "pending" }, "org");
    expect(b).toMatchObject({ id: "T-2", status: "todo", label: "bug", priority: 3, ord: 2, assignee: "dev", parent: "T-1", milestone: "M0", kind: "breakdown", gate: "pending" });
    expect(last(tr).data).toEqual({ kind: "breakdown", label: "bug", priority: 3, assignee: "dev", parent: "T-1", milestone: "M0" });
  });

  it("fields given as undefined take the defaults", () => {
    const { tr } = mk();
    expect(tr.createTicket({ title: "A", label: undefined, priority: undefined, kind: undefined }, "u")).toMatchObject({ label: "other", priority: 0, kind: "normal" });
  });

  it("a ticket references an existing parent and milestone", () => {
    const { tr } = mk();
    expect(() => tr.createTicket({ title: "A", parent: "T-9" }, "u")).toThrow("no such ticket: T-9");
    expect(() => tr.createTicket({ title: "A", milestone: "M9" }, "u")).toThrow("no such milestone: M9");
    tr.createTicket({ title: "A" }, "u");
    expect(() => tr.setMilestone("T-1", "M9", "u")).toThrow("no such milestone: M9");
    expect(() => tr.getTicket("T-9")).toThrow("no such ticket: T-9");
    expect(() => tr.setStatus("T-9", "done", "u")).toThrow("no such ticket: T-9");
  });

  it("field writes log one event each and update the ticket", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.createMilestone("M", "", "ba");
    const n = tr.events().length;
    expect(tr.setStatus("T-1", "todo", "pm").status).toBe("todo");
    expect(tr.setAssignee("T-1", "dev", "pm").assignee).toBe("dev");
    expect(tr.setPriority("T-1", 4, "pm").priority).toBe(4);
    expect(tr.setMilestone("T-1", "M0", "pm").milestone).toBe("M0");
    expect(tr.setDescription("T-1", "secret text", "sa").description).toBe("secret text");
    expect(tr.setGate("T-1", "pending", "org").gate).toBe("pending");
    expect(tr.setBranch("T-1", "t-1-a", "org").branch).toBe("t-1-a");
    expect(tr.setMerged("T-1", "abc", "org").merged).toBe("abc");
    expect(tr.setSummary("T-1", "did A", "dev").summary).toBe("did A");
    expect(tr.events(n).map((e) => [e.kind, e.actor, e.ticket, e.data])).toEqual([
      ["ticket.status", "pm", "T-1", { from: "triage", to: "todo" }],
      ["ticket.assigned", "pm", "T-1", { from: null, to: "dev" }],
      ["ticket.priority", "pm", "T-1", { priority: 4 }],
      ["ticket.milestone", "pm", "T-1", { from: null, to: "M0" }],
      ["ticket.description", "sa", "T-1", { by: "sa" }],
      ["ticket.gate", "org", "T-1", { gate: "pending" }],
      ["ticket.branch", "org", "T-1", { branch: "t-1-a" }],
      ["ticket.merged", "org", "T-1", { commit: "abc" }],
      ["ticket.summary", "dev", "T-1", { summary: "did A" }],
    ]);
    expect(tr.getTicket("T-1").updated).toBeGreaterThan(tr.getTicket("T-1").created);
    expect(tr.setAssignee("T-1", null, "pm").assignee).toBeUndefined();
    expect(tr.setMilestone("T-1", null, "pm").milestone).toBeUndefined();
  });

  it("a write that changes nothing logs no event", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A", assignee: "dev" }, "u");
    const n = tr.events().length;
    tr.setStatus("T-1", "triage", "pm");
    tr.setAssignee("T-1", "dev", "pm");
    expect(tr.events(n)).toEqual([]);
  });

  it("setPriority sets the manual order when given", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    expect(tr.setPriority("T-1", 2, "pm", 0.5)).toMatchObject({ priority: 2, ord: 0.5 });
    expect(last(tr).data).toEqual({ priority: 2, ord: 0.5 });
    expect(tr.setPriority("T-1", 2, "pm", 7).ord).toBe(7);
  });

  it("approvals are rows per reviewer; set replaces the state and remove deletes it", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.setApproval("T-1", "tl", "pending", "pm");
    tr.setApproval("T-1", "sa", "pending", "pm");
    tr.setApproval("T-1", "tl", "approved", "tl");
    expect(tr.getTicket("T-1").approvals).toEqual([{ ticket: "T-1", reviewer: "tl", state: "approved" }, { ticket: "T-1", reviewer: "sa", state: "pending" }]);
    expect(last(tr)).toMatchObject({ kind: "approval.set", actor: "tl", ticket: "T-1", data: { reviewer: "tl", state: "approved" } });
    tr.removeApproval("T-1", "sa", "pm");
    expect(last(tr)).toMatchObject({ kind: "approval.removed", actor: "pm", ticket: "T-1", data: { reviewer: "sa" } });
    expect(tr.getTicket("T-1").approvals.map((a) => a.reviewer)).toEqual(["tl"]);
    expect(() => tr.setApproval("T-9", "tl", "pending", "pm")).toThrow("no such ticket: T-9");
  });

  it("relations are added and removed with events; getTicket shows both directions", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.createTicket({ title: "B" }, "u");
    tr.addRelation("T-1", "T-2", "blocks", "sa");
    tr.addRelation("T-1", "T-2", "blocks", "sa"); // once
    expect(last(tr)).toMatchObject({ kind: "relation.added", actor: "sa", ticket: "T-1", data: { from: "T-1", to: "T-2", kind: "blocks" } });
    expect(tr.events().filter((e) => e.kind === "relation.added")).toHaveLength(1);
    expect(tr.getTicket("T-2").relations).toEqual([{ from: "T-1", to: "T-2", kind: "blocks" }]);
    expect(tr.getTicket("T-1").relations).toEqual([{ from: "T-1", to: "T-2", kind: "blocks" }]);
    tr.removeRelation("T-1", "T-2", "blocks", "pm");
    expect(last(tr)).toMatchObject({ kind: "relation.removed", actor: "pm", ticket: "T-1", data: { from: "T-1", to: "T-2", kind: "blocks" } });
    expect(tr.getTicket("T-2").relations).toEqual([]);
    expect(() => tr.addRelation("T-1", "T-9", "related", "u")).toThrow("no such ticket: T-9");
  });

  it("blockers lists only open blocking tickets", () => {
    const { tr } = mk();
    for (const x of ["A", "B", "C", "D"]) tr.createTicket({ title: x }, "u");
    tr.addRelation("T-1", "T-4", "blocks", "sa");
    tr.addRelation("T-2", "T-4", "blocks", "sa");
    tr.addRelation("T-3", "T-4", "related", "sa");
    tr.setStatus("T-2", "done", "org");
    expect(tr.blockers("T-4").map((x) => x.id)).toEqual(["T-1"]);
    expect(tr.isBlocked("T-4")).toBe(true);
    tr.setStatus("T-1", "canceled", "pm");
    expect(tr.blockers("T-4")).toEqual([]);
    expect(tr.isBlocked("T-4")).toBe(false);
  });

  it("children lists the sub-tickets; listTickets filters by status, assignee, milestone and parent", () => {
    const { tr } = mk();
    tr.createMilestone("M", "", "ba");
    tr.createTicket({ title: "A", milestone: "M0" }, "u");
    tr.createTicket({ title: "B", parent: "T-1", assignee: "dev", status: "todo", milestone: "M0" }, "u");
    tr.createTicket({ title: "C", parent: "T-1", status: "todo" }, "u");
    expect(tr.children("T-1").map((x) => x.id)).toEqual(["T-2", "T-3"]);
    expect(tr.listTickets().map((x) => x.id)).toEqual(["T-1", "T-2", "T-3"]);
    expect(tr.listTickets({ status: "todo" }).map((x) => x.id)).toEqual(["T-2", "T-3"]);
    expect(tr.listTickets({ assignee: "dev" }).map((x) => x.id)).toEqual(["T-2"]);
    expect(tr.listTickets({ milestone: "M0" }).map((x) => x.id)).toEqual(["T-1", "T-2"]);
    expect(tr.listTickets({ parent: "T-1", milestone: "M0" }).map((x) => x.id)).toEqual(["T-2"]);
  });

  it("a milestone id counts from M0", () => {
    const { tr } = mk();
    expect(tr.createMilestone("Start", "requirements", "org")).toEqual({ id: "M0", name: "Start", description: "requirements", ord: 0 });
    expect(last(tr)).toMatchObject({ kind: "milestone.created", actor: "org", data: { id: "M0", name: "Start" } });
    expect(tr.createMilestone("One", "", "ba").id).toBe("M1");
    tr.deleteMilestone("M1", "ba");
    expect(tr.createMilestone("Two", "", "ba").id).toBe("M2"); // ids are never reused
  });

  it("milestones rename, reorder and delete with events", () => {
    const { tr } = mk();
    for (const n of ["A", "B", "C"]) tr.createMilestone(n, "", "ba");
    expect(tr.updateMilestone("M1", { name: "Bee" }, "ba").name).toBe("Bee");
    expect(last(tr)).toMatchObject({ kind: "milestone.updated", actor: "ba", data: { id: "M1", name: "Bee" } });
    tr.reorderMilestones(["M0", "M2", "M1"], "ba");
    expect(last(tr)).toMatchObject({ kind: "milestone.reordered", data: { order: ["M0", "M2", "M1"] } });
    expect(tr.listMilestones().map((m) => m.id)).toEqual(["M0", "M2", "M1"]);
    tr.deleteMilestone("M2", "ba");
    expect(last(tr)).toMatchObject({ kind: "milestone.deleted", data: { id: "M2" } });
    expect(tr.listMilestones().map((m) => m.id)).toEqual(["M0", "M1"]);
    expect(() => tr.getMilestone("M2")).toThrow("no such milestone: M2");
    expect(() => tr.reorderMilestones(["M9"], "ba")).toThrow("no such milestone: M9");
  });
  it("milestone_update changes the name or the description and keeps the id", () => {
    const { tr } = mk();
    for (const n of ["Z", "A"]) tr.createMilestone(n, "BR-1", "pm");
    expect(tr.updateMilestone("M1", { description: "BR-1, BR-6" }, "pm")).toMatchObject({ id: "M1", name: "A", description: "BR-1, BR-6" });
    expect(last(tr)).toMatchObject({ kind: "milestone.updated", actor: "pm", data: { id: "M1", description: "BR-1, BR-6" } });
    expect(tr.updateMilestone("M1", { name: "B", description: "BR-2" }, "pm")).toMatchObject({ id: "M1", name: "B", description: "BR-2" });
    expect(last(tr)).toMatchObject({ kind: "milestone.updated", data: { id: "M1", name: "B", description: "BR-2" } });
    expect(tr.listMilestones().map((m) => m.id)).toEqual(["M0", "M1"]);
  });

  it("setTitle renames a ticket", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    expect(tr.setTitle("T-1", "B", "tl").title).toBe("B");
    expect(last(tr)).toMatchObject({ kind: "ticket.title", actor: "tl", ticket: "T-1", data: { from: "A", to: "B" } });
  });

  it("ticket.assigned logs the previous assignee", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A", assignee: "a" }, "u");
    tr.setAssignee("T-1", "b", "pm");
    expect(last(tr).data).toEqual({ from: "a", to: "b" });
  });

  it("setQuestion stores the asker, the return status and the return assignee", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    expect(tr.setQuestion("T-1", { asker: "tl", status: "in_review", assignee: "dev" }, "tl")).toMatchObject({ asker: "tl", return_status: "in_review", return_assignee: "dev" });
    expect(last(tr)).toMatchObject({ kind: "ticket.question", actor: "tl", ticket: "T-1", data: { asker: "tl", status: "in_review", assignee: "dev" } });
  });

  it("setQuestion(null) clears the question", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.setQuestion("T-1", { asker: "tl", status: "todo" }, "tl");
    const t = tr.setQuestion("T-1", null, "sa");
    expect([t.asker, t.return_status, t.return_assignee]).toEqual([undefined, undefined, undefined]);
    expect(last(tr)).toMatchObject({ kind: "ticket.question", data: { cleared: true } });
  });

  it("comments are a flat list per ticket, in order", () => {
    const { tr } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.createTicket({ title: "B" }, "u");
    expect(tr.addComment("T-1", "one", "dev")).toMatchObject({ id: 1, ticket: "T-1", author: "dev", text: "one" });
    tr.addComment("T-2", "x", "dev");
    tr.addComment("T-1", "two", "sa");
    expect(last(tr)).toMatchObject({ kind: "ticket.comment", actor: "sa", ticket: "T-1", data: { comment: 3, text: "two" } });
    expect(tr.getTicket("T-1").comments.map((c) => [c.author, c.text])).toEqual([["dev", "one"], ["sa", "two"]]);
    expect(() => tr.addComment("T-9", "x", "dev")).toThrow("no such ticket: T-9");
  });

  it("approvals open inbox items with an event", () => {
    const { tr } = mk();
    const a = tr.ask("ok?", "org", { ticket: "T-1", files: ["a.md"] });
    expect(a).toMatchObject({ id: "Q-1", kind: "approval", ticket: "T-1", files: ["a.md"], state: "open", author: "org" });
    expect(tr.events().map((e) => [e.kind, e.data])).toEqual([["inbox.opened", { id: "Q-1", kind: "approval" }]]);
    tr.answer("Q-1", "go", "user", true);
    expect(last(tr).data).toMatchObject({ approved: true, asker: "org" });
    expect(() => tr.getInbox("Q-9")).toThrow("no such inbox item: Q-9");
  });

  it("every write logs an event with its actor and ticket", () => {
    const { tr } = mk();
    tr.createMilestone("M", "", "ba");
    tr.createTicket({ title: "A" }, "u");
    tr.createTicket({ title: "B" }, "u");
    const writes: [() => unknown, string | undefined][] = [
      [() => tr.setStatus("T-1", "todo", "x"), "T-1"], [() => tr.setAssignee("T-1", "d", "x"), "T-1"], [() => tr.setPriority("T-1", 1, "x"), "T-1"],
      [() => tr.setMilestone("T-1", "M0", "x"), "T-1"], [() => tr.setDescription("T-1", "d", "x"), "T-1"], [() => tr.setGate("T-1", "approved", "x"), "T-1"],
      [() => tr.setBranch("T-1", "b", "x"), "T-1"], [() => tr.setMerged("T-1", "c", "x"), "T-1"], [() => tr.setApproval("T-1", "r", "pending", "x"), "T-1"],
      [() => tr.removeApproval("T-1", "r", "x"), "T-1"], [() => tr.addRelation("T-1", "T-2", "related", "x"), "T-1"], [() => tr.removeRelation("T-1", "T-2", "related", "x"), "T-1"],
      [() => tr.addComment("T-2", "b", "x"), "T-2"], [() => tr.setQuestion("T-2", { asker: "x", status: "todo" }, "x"), "T-2"],
      [() => tr.createMilestone("N", "", "x"), undefined], [() => tr.updateMilestone("M1", { name: "O" }, "x"), undefined], [() => tr.reorderMilestones(["M1", "M0"], "x"), undefined],
      [() => tr.deleteMilestone("M1", "x"), undefined], [() => tr.ask("q", "x", { ticket: "T-1" }), "T-1"], [() => tr.answer("Q-1", "a", "x", true), "T-1"],
      [() => tr.createTicket({ title: "C" }, "x"), "T-3"],
    ];
    for (const [w, ticket] of writes) {
      const n = tr.events().length;
      w();
      const ev = tr.events(n);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor: "x", ticket });
    }
  });

  it("answering an approval needs approve or reject and answers once", () => {
    const { tr } = mk();
    tr.ask("ok?", "org");
    expect(() => tr.answer("Q-1", "yes", "user", undefined as never)).toThrow("Q-1 needs approve or reject");
    const r = tr.answer("Q-1", "no", "user", false);
    expect(r).toMatchObject({ state: "answered", answer: "no", approved: false });
    expect(() => tr.answer("Q-1", "again", "user", true)).toThrow("Q-1 is already answered");
    expect(tr.inbox("answered")).toHaveLength(1);
    expect(tr.inbox("open")).toHaveLength(0);
  });

  it("log appends free events; events reads after a cursor with a limit", () => {
    const { tr } = mk();
    const e1 = tr.log("org.paused", "org", { reason: "x" });
    tr.log("session.started", "dev", undefined, "T-1");
    tr.log("org.done", "org");
    expect(e1).toMatchObject({ id: 1, kind: "org.paused", data: { reason: "x" } });
    expect(tr.events(1).map((e) => e.id)).toEqual([2, 3]);
    expect(tr.events(0, 2).map((e) => e.id)).toEqual([1, 2]);
    expect(tr.events(1)[0]).toMatchObject({ ticket: "T-1", data: {} });
  });

  it("meta stores JSON values", () => {
    const { tr } = mk();
    expect(tr.getMeta("k")).toBeUndefined();
    tr.setMeta("k", { a: [1] });
    tr.setMeta("k", { a: [2] });
    expect(tr.getMeta("k")).toEqual({ a: [2] });
  });

  it("two connections to one file can both write (WAL)", () => {
    const { tr, path } = mk();
    const tr2 = openTracker(path, clock);
    open.push(tr2);
    tr.createTicket({ title: "A" }, "u");
    tr2.createTicket({ title: "B" }, "u");
    expect(tr.listTickets()).toHaveLength(2);
    expect(tr2.listTickets().map((x) => x.id)).toEqual(["T-1", "T-2"]);
  });

  it("reopening the file keeps the data", () => {
    const { tr, path } = mk();
    tr.createTicket({ title: "A" }, "u");
    tr.setMeta("k", 1);
    tr.close();
    const tr2 = openTracker(path, clock);
    open.push(tr2);
    expect(tr2.getTicket("T-1").title).toBe("A");
    expect(tr2.getMeta("k")).toBe(1);
  });
  it("milestone names and ticket titles lose a leading id", () => {
    const { tr: t } = mk();
    expect(t.createMilestone("M3 Login flow", "", "org").name).toBe("Login flow");
    expect(t.updateMilestone("M0", { name: "M12  Sign up" }, "org").name).toBe("Sign up");
    expect(t.updateMilestone("M0", { description: "d" }, "org").name).toBe("Sign up");
    expect(t.createTicket({ title: "T-4: Build A" }, "org").title).toBe("Build A");
    expect(t.createTicket({ title: "T-12 Build B" }, "org").title).toBe("Build B");
    expect(t.createTicket({ title: "Build T-1 C" }, "org").title).toBe("Build T-1 C");
    expect(t.setTitle("T-1", "T-9: Build D", "org").title).toBe("Build D");
  });
});
