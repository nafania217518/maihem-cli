import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOps } from "../src/org/ops.ts";
import { validateOrg } from "../src/org/config.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import { createBus, execute } from "../src/org/bus.ts";
import type { Command, View } from "../src/org/bus.ts";
import { FINAL, handlers } from "../src/org/flow.ts";
import type { Ops } from "../src/org/ops.ts";
import type { OrgEvent } from "../src/org/types.ts";

const m = (role: string, reports_to?: string) => ({ role, definition: "d", ...(reports_to ? { reports_to } : {}) });
const org = validateOrg({ name: "x", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev"), dev2: m("dev") } });
const DOCS = ["docs/business-requirements.md", "docs/business-summary.txt", "docs/technical-requirements.md", "docs/tech-summary.txt"];
const bus = createBus(handlers);
const noop = () => {};

let dir: string, t: Tracker, ops: Ops, v: View, cmds: Command[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flow-"));
  t = openTracker(join(dir, "org.db"));
  ops = createOps(t, org);
  v = { t, ops, org, goal: "Build a todo app" };
  cmds = [];
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

// runs the bus to the end; cmds = the commands since the last call
const drain = () => {
  cmds = [];
  bus.drain(t, v, (c) => { cmds.push(c); execute(c, v, { merge: noop, stop: noop, done: noop, tag: (ms) => void t.log("git.tagged", "org", { milestone: ms, tag: ms }) }); });
};
const of = (kind: Command["kind"]) => cmds.filter((c) => c.kind === kind);
const last = (kind: string): OrgEvent => t.events().filter((e) => e.kind === kind).at(-1)!;
const again = (e: OrgEvent) => bus.handle(e, v);
const id = (r: string) => r.match(/T-\d+/)![0];
const mk = (f: Parameters<Ops["create"]>[0], actor = "org") => id(ops.create(f, actor));
const close = (...ids: string[]) => { ids.forEach((x) => t.setStatus(x, "done", "org")); drain(); };
const reviewers = (tk: string) => t.getTicket(tk).approvals.map((a) => a.reviewer);

// M0 with T-1 Requirements and its children T-2 Business requirements, T-3 Technical requirements
const start = () => { t.log("org.started", "org", { goal: v.goal }); drain(); };
// both documents closed; Q-1 is the approval
const pending = () => { start(); close("T-2", "T-3"); };
// the gate approved; T-4 is the roadmap
const approved = () => { pending(); t.answer("Q-1", "ok", "user", true); drain(); };
const ofKind = (ms: string, kind: string) => t.listTickets({ milestone: ms }).find((x) => x.kind === kind);
const completed = () => t.events().filter((e) => e.kind === "milestone.completed").map((e) => e.data.id);

describe("flow: start (org-design.md §7)", () => {
  it("the start creates business and technical requirements with summaries, chained", () => {
    start();
    expect(t.listMilestones()).toMatchObject([{ id: "M0", name: "Requirements" }]);
    expect(t.getTicket("T-1")).toMatchObject({ title: "Requirements", kind: "requirements", assignee: "ba", status: "todo", milestone: "M0" });
    expect(reviewers("T-1")).toEqual([]);
    const [br, tr, ...rest] = t.children("T-1");
    expect(rest).toEqual([]);
    expect(br).toMatchObject({ id: "T-2", title: "Business requirements", assignee: "ba", kind: "normal", status: "todo", milestone: "M0" });
    expect(br.description).toBe("The business requirements and the business summary for the goal."); // the business requirements ticket does not repeat the goal
    expect(tr).toMatchObject({ id: "T-3", title: "Technical requirements", assignee: "sa", status: "todo", milestone: "M0",
      description: "The technical requirements and the tech summary for the business requirements." }); // the technical requirements ticket does not repeat the process
    expect([reviewers("T-2"), reviewers("T-3")]).toEqual([["sa"], ["ba"]]);
    expect(t.blockers("T-3").map((x) => x.id)).toEqual(["T-2"]);
    for (const e of t.events()) expect(again(e).filter((c) => c.kind !== "log")).toEqual([]);
  });

  it("the requirements sub-tickets are urgent", () => {
    start();
    expect([t.getTicket("T-2").priority, t.getTicket("T-3").priority]).toEqual([4, 4]);
  });
  it("the roadmap and final ticket descriptions are one line", () => {
    approved();
    expect(t.getTicket("T-4").description).toBe("Plan the roadmap: the milestones in order.");
    expect(FINAL).toBe("Final acceptance: check the product against the business requirements.");
  });

  it("org.started after a crash between the milestone and the parent creates only the parent", () => {
    t.createMilestone("Requirements", "", "org");
    t.log("org.started", "org", {});
    drain();
    expect(t.listMilestones()).toHaveLength(1);
    expect(t.getTicket("T-1").title).toBe("Requirements");
    expect(t.children("T-1")).toHaveLength(2);
  });
});

describe("flow: requirements approval and roadmap (org-design.md §7)", () => {
  it("when the last child of a requirements parent closes, the human gets an approval of the four files and the gate turns pending", () => {
    start();
    close("T-2");
    expect(t.inbox()).toEqual([]);
    close("T-3");
    const [q] = t.inbox();
    expect(q).toMatchObject({ id: "Q-1", kind: "approval", ticket: "T-1", state: "open", author: "org" });
    expect([...q.files].sort()).toEqual([...DOCS].sort());
    for (const d of DOCS) expect(q.text).toContain(d);
    expect(q.text).toContain("Approve to accept the documents, or reject with feedback");
    expect(t.getTicket("T-1").gate).toBe("pending");
    expect(again(last("ticket.status"))).toEqual([]);
  });

  it("the business update ticket says what to update before the human's feedback", () => {
    pending();
    t.answer("Q-1", "add login", "user", false);
    drain();
    const [ub] = t.children("T-1").slice(2);
    expect(ub.description).toBe("Update docs/business-requirements.md and docs/business-summary.txt for the human's feedback.\nThe human's feedback: add login");
  });
  it("a rejected requirements gate creates the chained BA and SA update pair", () => {
    pending();
    t.answer("Q-1", "add login", "user", false);
    drain();
    const [ub, ut, ...rest] = t.children("T-1").slice(2);
    expect(rest).toEqual([]);
    expect(ub).toMatchObject({ title: "Update business requirements", assignee: "ba", status: "todo", milestone: "M0", priority: 4 });
    expect(ut).toMatchObject({ title: "Update technical requirements", assignee: "sa", status: "todo", milestone: "M0", priority: 4 });
    expect(ub.description).toContain("add login");
    expect(ut.description).toContain("add login");
    expect([reviewers(ub.id), reviewers(ut.id)]).toEqual([["sa"], ["ba"]]);
    expect(t.blockers(ut.id).map((x) => x.id)).toEqual([ub.id]);
    expect(t.getTicket("T-1").gate).toBeUndefined();
    expect(ofKind("M0", "roadmap")).toBeUndefined();
    expect(again(last("inbox.answered"))).toEqual([]);
    close(ub.id, ut.id);
    expect(t.inbox("open")).toMatchObject([{ id: "Q-2", kind: "approval", ticket: "T-1" }]);
    expect(t.getTicket("T-1").gate).toBe("pending");
    t.answer("Q-2", "add logout", "user", false);
    drain();
    const [ub2, ut2] = t.children("T-1").slice(4);
    expect(t.blockers(ut2.id).map((x) => x.id)).toEqual([ub2.id]);
  });

  it("an approved requirements gate creates the roadmap ticket", () => {
    approved();
    expect(t.getTicket("T-1")).toMatchObject({ gate: "approved", status: "todo" });
    const r = t.getTicket("T-4");
    expect(r).toMatchObject({ title: "Roadmap", kind: "roadmap", assignee: "pm", status: "todo", priority: 4, milestone: "M0" });
    expect(r.parent).toBeUndefined();
    expect(reviewers("T-4")).toEqual(["ba", "tl"]);
    expect(again(last("inbox.answered"))).toEqual([]);
  });

  it("M0 completes after the roadmap is done", () => {
    approved();
    t.createMilestone("Core", "", "org");
    drain();
    expect(t.getTicket("T-1").status).toBe("todo");
    expect(completed()).toEqual([]);
    close("T-4");
    expect(t.getTicket("T-1").status).toBe("done");
    expect(completed()).toEqual(["M0"]);
    expect(ofKind("M0", "acceptance")).toBeUndefined();
    expect(ofKind("M0", "summary")).toBeUndefined();
  });

  it("an approved requirements parent closes after the roadmap even before any later milestone exists", () => {
    approved();
    close("T-4");
    expect(t.getTicket("T-1").status).toBe("done");
    expect(completed()).toEqual(["M0"]);
  });
});

describe("flow: milestones (org-design.md §7)", () => {
  // M0 done with milestones Core (M1) and, unless `one`, Polish (M2); T-5 is the breakdown of M1
  const m0done = (one = false) => {
    approved();
    t.createMilestone("Core", "", "org");
    if (!one) t.createMilestone("Polish", "", "org");
    close("T-4");
  };
  // M1's breakdown closed with tickets A and B, both closed: returns the acceptance ticket
  const built = (one = false) => {
    m0done(one);
    const a = mk({ title: "A", status: "todo", milestone: "M1", assignee: "dev1" }), b = mk({ title: "B", status: "todo", milestone: "M1", assignee: "dev2" });
    close("T-5", a, b);
    return ofKind("M1", "acceptance")!;
  };
  // M1 complete: acceptance and summary closed
  const m1done = (one = false) => { close(built(one).id); close(ofKind("M1", "summary")!.id); };

  it("a breakdown ticket's description is one line", () => {
    m0done();
    expect(t.getTicket("T-5").description).toBe("Break down the milestone's scope into tickets with dependencies.");
  });
  it("an active milestone gets a breakdown ticket", () => {
    m0done();
    const b = t.getTicket("T-5");
    expect(b).toMatchObject({ title: "Break down Core", kind: "breakdown", assignee: "tl", status: "todo", priority: 4, milestone: "M1" });
    expect(b.description).toContain("dependencies");
    expect(reviewers("T-5")).toEqual(["sa"]);
    expect(t.listTickets({ milestone: "M2" })).toEqual([]);
    expect(again(last("milestone.completed"))).toEqual([]);
  });

  it("a milestone whose approved breakdown leaves no work ticket gets the acceptance ticket", () => {
    m0done();
    close("T-5");
    expect(ofKind("M1", "acceptance")).toMatchObject({ title: "Accept Core", assignee: "tl" });
    expect(completed()).toEqual(["M0"]);
  });
  it("a milestone whose approved breakdown leaves no work ticket completes after its acceptance without a summary", () => {
    m0done();
    const x = mk({ title: "Dropped", status: "todo", milestone: "M1" });
    t.setStatus(x, "canceled", "org");
    close("T-5");
    close(ofKind("M1", "acceptance")!.id);
    expect(ofKind("M1", "summary")).toBeUndefined();
    expect(completed()).toEqual(["M0", "M1"]);
    expect(ofKind("M2", "breakdown")).toMatchObject({ title: "Break down Polish" });
  });
  it("an empty last milestone is followed by the final ticket", () => {
    m0done(true);
    close("T-5");
    close(ofKind("M1", "acceptance")!.id);
    expect(completed()).toEqual(["M0", "M1"]);
    expect(ofKind("M1", "final")).toMatchObject({ title: "Final acceptance", assignee: "ba" });
  });

  it("a completed milestone tags main", () => {
    m1done();
    expect(of("tag")).toEqual([{ kind: "tag", milestone: "M1" }]);
    expect(t.events().filter((e) => e.kind === "git.tagged").map((e) => e.data.milestone)).toEqual(["M0", "M1"]);
    expect(again(last("milestone.completed"))).toEqual([]);
  });

  it("closed milestone tickets create the acceptance ticket", () => {
    m0done();
    const a = mk({ title: "A", status: "todo", milestone: "M1" }), b = mk({ title: "B", status: "todo", milestone: "M1" });
    close("T-5", a);
    expect(ofKind("M1", "acceptance")).toBeUndefined();
    close(b);
    const acc = ofKind("M1", "acceptance")!;
    expect(acc).toMatchObject({ title: "Accept Core", assignee: "tl", status: "todo", priority: 4 });
    expect(reviewers(acc.id)).toEqual(["pm"]);
    expect(completed()).toEqual(["M0"]);
    expect(again(last("ticket.status"))).toEqual([]);
  });

  it("the summary ticket does not escalate or repeat the process", () => {
    close(built().id);
    const s = ofKind("M1", "summary")!;
    expect(s.description).toBe("Update the tech summary and check the repo for runtime files.");
    expect(s.description).not.toContain(s.title);
  });
  it("an acceptance ticket's description is one line", () => {
    const acc = built();
    expect(t.getTicket(acc.id).description).toBe("Accept the milestone.");
  });
  it("acceptance done creates the summary and cleanup ticket", () => {
    close(built().id);
    const s = ofKind("M1", "summary")!;
    expect(s).toMatchObject({ title: "Tech summary and repo cleanup after Core", assignee: "sa", status: "todo", priority: 4 });
    expect(s.description).toBe("Update the tech summary and check the repo for runtime files.");
    expect(reviewers(s.id)).toEqual(["tl"]);
    expect(again(last("ticket.status"))).toEqual([]);
  });

  it("a milestone completes only after acceptance and summary", () => {
    const acc = built();
    expect(completed()).toEqual(["M0"]);
    close(acc.id);
    expect(completed()).toEqual(["M0"]);
    close(ofKind("M1", "summary")!.id);
    expect(completed()).toEqual(["M0", "M1"]);
    expect(ofKind("M2", "breakdown")).toMatchObject({ title: "Break down Polish" });
    expect(again(last("ticket.status")).filter((c) => c.kind !== "close")).toEqual([]);
  });

  it("the last milestone creates the final acceptance ticket", () => {
    m1done(true);
    expect(completed()).toEqual(["M0", "M1"]);
    const f = ofKind("M1", "final")!;
    expect(f).toMatchObject({ title: "Final acceptance", assignee: "ba", status: "todo", priority: 4 });
    expect(reviewers(f.id)).toEqual(["sa"]);
    expect(t.listMilestones()).toHaveLength(2);
    expect(t.inbox("open")).toEqual([]);
    expect(again(last("milestone.completed"))).toEqual([]);
  });

  it("final acceptance done asks the human", () => {
    m1done(true);
    close(ofKind("M1", "final")!.id);
    expect(completed()).toEqual(["M0", "M1"]);
    const [q] = t.inbox("open");
    expect(q).toMatchObject({ kind: "approval", state: "open", text: "Final review: all milestones are complete. Approve to finish, or reject with what is missing." });
    expect(q.ticket).toBeUndefined();
    expect([...q.files].sort()).toEqual([...DOCS].sort());
    expect(t.getMeta("final")).toBe(q.id);
    expect(again(last("ticket.status"))).toEqual([]);
    t.answer(q.id, "ship it", "user", true);
    drain();
    expect(of("done")).toEqual([{ kind: "done" }]);
  });

  it("a rejected final review opens a plan change with business and technical updates", () => {
    m1done(true);
    close(ofKind("M1", "final")!.id);
    t.answer(t.getMeta<string>("final")!, "add tests", "user", false);
    drain();
    expect(of("done")).toEqual([]);
    expect(t.listMilestones().at(-1)).toMatchObject({ id: "M2", name: "Plan change 1" });
    const [pc] = t.listTickets({ milestone: "M2" });
    expect(pc).toMatchObject({ title: "Plan change", kind: "requirements", assignee: "ba", status: "todo" });
    const [ub, ut, ...rest] = t.children(pc.id);
    expect(rest).toEqual([]);
    expect(ub).toMatchObject({ title: "Update business requirements", assignee: "ba", milestone: "M2" });
    expect(ut).toMatchObject({ title: "Update technical requirements", assignee: "sa", milestone: "M2" });
    expect(ub.description).toContain("add tests");
    expect(ub.description).toContain("Update docs/business-requirements.md and docs/business-summary.txt for the human's feedback.");
    expect([reviewers(ub.id), reviewers(ut.id)]).toEqual([["sa"], ["ba"]]);
    expect(t.blockers(ut.id).map((x) => x.id)).toEqual([ub.id]);
    expect(again(last("inbox.answered"))).toEqual([]);
    expect(again(last("milestone.created"))).toEqual([]);
    close(ub.id, ut.id);
    const q = t.inbox("open").find((x) => x.ticket === pc.id)!;
    t.answer(q.id, "ok", "user", true);
    drain();
    expect(ofKind("M2", "roadmap")).toMatchObject({ assignee: "pm", status: "todo", priority: 4 });
  });

  it("a final review is asked again after a plan change and its milestones", () => {
    m1done(true);
    close(ofKind("M1", "final")!.id);
    t.answer(t.getMeta<string>("final")!, "more", "user", false);
    drain();
    const pc = t.listTickets({ milestone: "M2" })[0].id;
    close(...t.children(pc).map((c) => c.id));
    t.answer(t.inbox("open")[0].id, "ok", "user", true);
    drain();
    t.createMilestone("Extra", "", "org");
    close(ofKind("M2", "roadmap")!.id);
    expect(completed()).toEqual(["M0", "M1", "M2"]);
    expect(ofKind("M2", "acceptance")).toBeUndefined();
    close(ofKind("M3", "breakdown")!.id);
    close(ofKind("M3", "acceptance")!.id);
    close(ofKind("M3", "final")!.id);
    expect(t.getMeta("final")).toBe(t.inbox("open")[0].id);
    expect(t.getMeta("final")).not.toBe("Q-2");
  });
});

describe("flow: parents and merges (org-design.md §8.3, §8.5, §8.7)", () => {
  beforeEach(() => { t.createMilestone("M0", "", "org"); });
  const parent = () => {
    const p = mk({ title: "P", status: "todo", milestone: "M0", assignee: "dev1", reviewers: ["tl"] });
    return [p, mk({ title: "C1", parent: p }), mk({ title: "C2", parent: p })];
  };

  it("a normal parent closes when all children are closed and it has no branch or is merged", () => {
    const [p, c1, c2] = parent();
    close(c1);
    expect(t.getTicket(p).status).toBe("todo");
    close(c2);
    expect(t.getTicket(p).status).toBe("done");
    const [q, d1] = parent();
    t.setBranch(q, "maihem/q", "org");
    close(d1);
    const d2 = t.children(q)[1].id;
    close(d2);
    expect(t.getTicket(q).status).toBe("todo"); // branch not merged
  });

  it("git.merged on a parent with open children keeps it In Review", () => {
    const [p, c1, c2] = parent();
    t.setBranch(p, "maihem/p", "org");
    t.setStatus(p, "in_review", "org");
    t.setMerged(p, "abc", "org");
    t.log("git.merged", "org", { commit: "abc" }, p);
    drain();
    expect(t.getTicket(p).status).toBe("in_review");
    close(c1, c2);
    expect(t.getTicket(p).status).toBe("done");
  });

  it("git.merged on a ticket without open children closes it", () => {
    const tk = mk({ title: "A", status: "in_review", milestone: "M0", assignee: "dev1" });
    t.setMerged(tk, "abc", "org");
    t.log("git.merged", "org", { commit: "abc" }, tk);
    drain();
    expect(t.getTicket(tk).status).toBe("done");
    expect(again(last("git.merged"))).toEqual([]);
  });

  it("a conflict at merge time sends the ticket back to In Progress with a comment", () => {
    const tk = mk({ title: "A", status: "in_review", milestone: "M0", assignee: "dev1" });
    t.log("git.conflict", "org", { files: ["a", "b"] }, tk);
    drain();
    expect(t.getTicket(tk)).toMatchObject({ status: "in_progress", comments: [{ author: "org", text: expect.stringContaining("a, b") }] });
    expect(again(last("git.conflict"))).toEqual([]);
  });

  it("review.done requests a merge", () => {
    const tk = mk({ title: "A", status: "in_review", milestone: "M0", assignee: "dev1" });
    t.log("review.done", "org", {}, tk);
    drain();
    expect(of("merge")).toEqual([{ kind: "merge", ticket: tk }]);
    t.setStatus(tk, "done", "org");
    expect(again(last("review.done"))).toEqual([]);
  });
});

describe("flow: changes during work (org-design.md §12.5)", () => {
  beforeEach(() => { t.createMilestone("M0", "", "org"); });

  it("a ticket sent back from review stops the other reviewers' sessions", () => {
    const a = mk({ title: "A", status: "in_review", milestone: "M0", assignee: "dev1", reviewers: ["tl", "sa"] });
    drain();
    ops.requestChanges(a, ["fix x"], "tl");
    drain();
    expect(of("stop")).toEqual([{ kind: "stop", member: "tl", ticket: a }, { kind: "stop", member: "sa", ticket: a }]);
    t.setStatus(a, "todo", "org");
    drain();
    expect(of("stop")).toEqual([]);
  });

  it("a ticket created while the final ticket is open blocks the final ticket", () => {
    const a = mk({ title: "A" }, "sa");
    drain();
    expect(of("link")).toEqual([]);
    const f = mk({ title: "F", kind: "final", status: "in_progress", milestone: "M0", assignee: "ba" });
    drain();
    expect(of("link")).toEqual([]);
    const d = mk({ title: "D" }, "sa");
    drain();
    expect(of("link")).toEqual([{ kind: "link", from: d, to: f, rel: "blocks" }]);
    expect(t.blockers(f).map((x) => x.id)).toEqual([d]);
    expect(again(last("ticket.created"))).toEqual([]);
    expect(t.blockers(a)).toEqual([]);
  });

  it("a new blocker on the final ticket stops no session", () => {
    const f = mk({ title: "F", kind: "final", status: "in_progress", milestone: "M0", assignee: "ba" });
    mk({ title: "D" }, "sa");
    drain();
    expect(cmds.filter((c) => c.kind === "stop" || c.kind === "todo")).toEqual([]);
    expect(t.getTicket(f).status).toBe("in_progress");
  });

  it("an approved final ticket with open blockers goes to Todo instead of the merge", () => {
    const f = mk({ title: "F", kind: "final", status: "in_review", milestone: "M0", assignee: "ba", reviewers: ["sa"] });
    mk({ title: "D" }, "sa");
    drain();
    ops.approve(f, "sa");
    drain();
    expect(of("merge")).toEqual([]);
    expect(of("todo")).toEqual([{ kind: "todo", ticket: f }]);
    expect(t.getTicket(f)).toMatchObject({ status: "todo", approvals: [{ reviewer: "sa", state: "pending" }] });
  });

  it("a change request on a blocked final ticket moves it to Todo", () => {
    const f = mk({ title: "F", kind: "final", status: "in_review", milestone: "M0", assignee: "ba", reviewers: ["sa"] });
    mk({ title: "D" }, "sa");
    drain();
    ops.requestChanges(f, ["x"], "sa");
    drain();
    expect(cmds.filter((c) => c.kind === "stop" || c.kind === "todo")).toEqual([{ kind: "stop", member: "sa", ticket: f }, { kind: "todo", ticket: f }]);
    expect(t.getTicket(f).status).toBe("todo");
  });

  it("reviewBack stops the reviewers even when the ticket moved on", () => {
    const f = mk({ title: "F", kind: "final", status: "in_review", milestone: "M0", assignee: "ba", reviewers: ["sa"] });
    mk({ title: "D" }, "sa");
    drain();
    ops.requestChanges(f, ["x"], "sa");
    drain();
    expect(t.getTicket(f).status).toBe("todo");
    const e = t.events().filter((x) => x.kind === "ticket.status" && x.ticket === f && x.data.to === "in_progress").at(-1)!;
    expect(again(e)).toEqual([{ kind: "stop", member: "sa", ticket: f }]);
  });

  it("a new blocker on an In Progress ticket stops the session and moves the ticket to Todo", () => {
    const a = mk({ title: "A", status: "todo", milestone: "M0" });
    const b = mk({ title: "B", status: "in_progress", milestone: "M0", assignee: "dev1" });
    drain();
    ops.link(a, b, "blocks", "sa");
    drain();
    expect(cmds.filter((c) => c.kind === "stop" || c.kind === "todo")).toEqual([{ kind: "stop", member: "dev1", ticket: b }, { kind: "todo", ticket: b }]);
    expect(t.getTicket(b).status).toBe("todo");
    expect(again(last("relation.added"))).toEqual([]);
  });
});
