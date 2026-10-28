import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOps, OWNED, SUMMARY_CAP } from "../src/org/ops.ts";
import { validateOrg } from "../src/org/config.ts";
import { ticketText } from "../src/org/prompt.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import type { Org } from "../src/org/types.ts";

const m = (role: string, reports_to?: string) => ({ role, definition: "d", ...(reports_to ? { reports_to } : {}) });
const org = validateOrg({ name: "x", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev"), dev2: m("dev") } });

let dir: string, t: Tracker, ops: ReturnType<typeof createOps>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-"));
  t = openTracker(join(dir, "org.db"));
  ops = createOps(t, org);
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const id = (r: string) => r.match(/T-\d+/)![0];
const mk = (f: Parameters<typeof ops.create>[0], actor = "org") => id(ops.create(f, actor));
const reviewers = (tk: string) => t.getTicket(tk).approvals.map((a) => a.reviewer);
const milestones = (n: number) => { for (let i = 0; i < n; i++) t.createMilestone(`M${i}`, "", "org"); };
const S = { summary: "did it" };
const ACC = { milestone: "M0", assignee: "dev1" };

describe("ops: create", () => {
  it("a new ticket starts in Triage with label other and priority none by default", () => {
    expect(ops.create({ title: "A" }, "dev1")).toBe("created T-1 in triage");
    expect(t.getTicket("T-1")).toMatchObject({ status: "triage", label: "other", priority: 0, kind: "normal", description: "" });
    expect(t.getTicket(mk({ title: "B", label: "bug", priority: 2, description: "d" }, "tl"))).toMatchObject({ status: "triage", label: "bug", priority: 2, description: "d" });
  });
  it("the creator is the owner", () => {
    expect(t.getTicket(mk({ title: "A" }, "sa")).owner).toBe("sa");
  });
  it("only the system sets status, kind, gate or milestone at creation; only PM sets assignee and reviewers", () => {
    milestones(1);
    for (const f of [{ status: "todo" }, { kind: "breakdown" }, { gate: "pending" }, { milestone: "M0" }] as const) expect(() => ops.create({ title: "A", ...f }, "pm")).toThrow(/only the system/);
    expect(() => ops.create({ title: "A", assignee: "dev1" }, "dev2")).toThrow("only PM assigns");
    expect(() => ops.create({ title: "A", reviewers: ["tl"] }, "dev2")).toThrow("only PM sets reviewers");
    expect(t.getTicket(mk({ title: "A", assignee: "dev1", reviewers: ["tl"] }, "pm"))).toMatchObject({ status: "triage", assignee: "dev1" });
    expect(() => ops.create({ title: "A", assignee: "zz" }, "pm")).toThrow("zz is not a member");
  });
  it("a sub-ticket starts in Todo in the parent's milestone and inherits priority, assignee and reviewers", () => {
    milestones(1);
    const p = mk({ title: "P", status: "todo", milestone: "M0", priority: 3, assignee: "dev1", reviewers: ["tl", "sa"] });
    const c = mk({ title: "C", parent: p }, "dev1");
    expect(t.getTicket(c)).toMatchObject({ status: "todo", milestone: "M0", priority: 3, assignee: "dev1", parent: p, owner: "dev1" });
    expect(reviewers(c)).toEqual(["tl", "sa"]);
    const d = mk({ title: "D", parent: p, priority: 1, assignee: "dev2", reviewers: ["tl"] }, "pm");
    expect(t.getTicket(d)).toMatchObject({ priority: 1, assignee: "dev2" });
    expect(reviewers(d)).toEqual(["tl"]);
  });
  it("only PM or the parent's assignee creates a sub-ticket of an open parent", () => {
    milestones(1);
    const p = mk({ title: "P", status: "todo", milestone: "M0", assignee: "dev1" });
    expect(() => ops.create({ title: "C", parent: p }, "dev2")).toThrow(`only PM or ${p}'s assignee creates its sub-tickets`);
    const q = mk({ title: "Q", status: "done" });
    expect(() => ops.create({ title: "C", parent: q }, "pm")).toThrow(`${q} is done`);
  });
  it("a sub-ticket of a sub-ticket is refused", () => {
    const p = mk({ title: "P", status: "todo", assignee: "dev1" });
    const c = mk({ title: "C", parent: p }, "pm");
    expect(() => ops.create({ title: "D", parent: c }, "pm")).toThrow(`${c} is a sub-ticket; a sub-ticket has no sub-tickets`);
  });
  it("a breakdown ticket goes to Triage blocked by its breakdown", () => {
    milestones(2);
    const bd = mk({ title: "Break down M1", kind: "breakdown", status: "in_progress", milestone: "M1", assignee: "tl" });
    const a = mk({ title: "A" }, "tl");
    const b = id(ops.create({ title: "B", priority: 2 }, "tl", { breakdown: bd }));
    expect(t.getTicket(a).status).toBe("triage");
    expect(t.getTicket(b)).toMatchObject({ status: "triage", milestone: "M1", priority: 2 });
    expect(t.getTicket(b).assignee).toBeUndefined();
    expect(reviewers(b)).toEqual([]);
    expect(t.blockers(b).map((x) => x.id)).toEqual([bd]);
    expect(() => ops.create({ title: "C", reviewers: ["sa"] }, "tl", { breakdown: bd })).toThrow("only PM sets reviewers");
    expect(() => ops.create({ title: "D", assignee: "dev1" }, "tl", { breakdown: bd })).toThrow("only PM assigns");
    expect(() => ops.create({ title: "D" }, "tl", { breakdown: a })).toThrow(`${a} is not a breakdown ticket`);
    expect(() => ops.create({ title: "D" }, "pm", { breakdown: bd })).toThrow("only TL breaks a milestone down");
  });
  it("the breakdown edits and drops only its own Triage tickets", () => {
    milestones(1);
    const bd = mk({ title: "Break down", kind: "breakdown", status: "in_progress", milestone: "M0", assignee: "tl" });
    const [a, b] = ["A", "B"].map((title) => id(ops.create({ title }, "tl", { breakdown: bd })));
    const other = mk({ title: "X" }, "dev1");
    expect(ops.editOwn(a, { description: "new" }, "tl", bd)).toBe(`edited ${a}`);
    expect(t.getTicket(a).description).toBe("new");
    ops.editOwn(a, { title: "A2" }, "tl", bd);
    expect(t.getTicket(a).title).toBe("A2");
    expect(() => ops.editOwn(a, { description: "x" }, "sa", bd)).toThrow("only TL reworks a breakdown");
    expect(() => ops.editOwn(other, { description: "x" }, "tl", bd)).toThrow(`${other} is not a Triage ticket of ${bd}`);
    expect(ops.dropOwn(b, "tl", bd)).toBe(`dropped ${b}`);
    expect(t.getTicket(b)).toMatchObject({ status: "canceled", comments: [{ author: "tl", text: "dropped by the breakdown" }] });
    expect(() => ops.dropOwn(b, "tl", bd)).toThrow(`${b} is not a Triage ticket of ${bd}`);
    ops.accept(a, "pm", { milestone: "M0", assignee: "dev1" });
    expect(() => ops.editOwn(a, { description: "x" }, "tl", bd)).toThrow(`${a} is not a Triage ticket of ${bd}`);
  });
  it("the system creates tickets of any kind and status", () => {
    milestones(1);
    const r = mk({ title: "Requirements", kind: "requirements", status: "todo", milestone: "M0", assignee: "ba", reviewers: ["sa"], gate: "pending" });
    expect(t.getTicket(r)).toMatchObject({ kind: "requirements", status: "todo", milestone: "M0", assignee: "ba", gate: "pending", owner: "org" });
    expect(reviewers(r)).toEqual(["sa"]);
    expect(t.getTicket(mk({ title: "C", parent: r, status: "in_progress" })).status).toBe("in_progress");
  });
});

describe("ops: triage", () => {
  it("only PM accepts a Triage ticket", () => {
    milestones(1);
    const a = mk({ title: "A" }, "dev1");
    expect(() => ops.accept(a, "dev1", ACC)).toThrow("only PM accepts");
    expect(ops.accept(a, "pm", ACC)).toBe(`accepted ${a}: todo in M0 for dev1, reviewed by tl`);
    expect(() => ops.accept(a, "pm", ACC)).toThrow(`${a} is todo; only a triage ticket can be accepted`);
  });
  it("accept needs a milestone and an assignee", () => {
    milestones(2);
    const a = mk({ title: "feature" }, "dev1");
    expect(() => ops.accept(a, "pm", { assignee: "dev1" })).toThrow("accept needs a milestone; milestone_list shows them");
    expect(() => ops.accept(a, "pm", { milestone: "M9", assignee: "dev1" })).toThrow("no such milestone: M9");
    expect(() => ops.accept(a, "pm", { milestone: "M1" })).toThrow("accept needs an assignee; name the member who does the work");
    expect(() => ops.accept(a, "pm", { milestone: "M1", assignee: "zz" })).toThrow("zz is not a member");
    expect(t.getTicket(a)).toMatchObject({ status: "triage" });
    ops.accept(a, "pm", { milestone: "M1", assignee: "dev2", priority: 3 });
    expect(t.getTicket(a)).toMatchObject({ status: "todo", milestone: "M1", assignee: "dev2", priority: 3 });
    expect(reviewers(a)).toEqual(["tl"]);
  });
  it("accept takes an assignee with write tools and sets the reviewer by the grid", () => {
    milestones(1);
    const [a, b, c, d] = ["A", "B", "C", "D"].map((x) => mk({ title: x }));
    ops.accept(a, "pm", { milestone: "M0", assignee: "dev1" });
    expect(reviewers(a)).toEqual(["tl"]);
    expect(ops.accept(b, "pm", { milestone: "M0", assignee: "ba" })).toBe(`accepted ${b}: todo in M0 for ba, reviewed by sa`);
    ops.accept(c, "pm", { milestone: "M0", assignee: "sa" });
    expect(reviewers(c)).toEqual(["ba"]);
    for (const [x, r] of [["tl", "TL"], ["pm", "PM"]]) expect(() => ops.accept(d, "pm", { milestone: "M0", assignee: x })).toThrow(`${x} is ${r}; TL and PM change no files, so the assignee is a DEV, BA or SA`);
    expect(t.getTicket(d).status).toBe("triage");
  });
  it("reject cancels with the reason as a comment", () => {
    const a = mk({ title: "A" }, "dev1");
    expect(() => ops.reject(a, "no", "sa")).toThrow("only PM rejects");
    expect(() => ops.reject(a, " ", "pm")).toThrow("a reason is required");
    expect(ops.reject(a, "out of scope", "pm")).toBe(`rejected ${a}`);
    expect(t.getTicket(a)).toMatchObject({ status: "canceled", comments: [{ author: "pm", text: "out of scope" }] });
    expect(() => ops.reject(a, "again", "pm")).toThrow(`${a} is canceled`);
  });
  it("only PM marks a Triage ticket as a duplicate of another ticket", () => {
    const a = mk({ title: "A" }, "dev1"), b = mk({ title: "B" }, "dev2");
    expect(() => ops.duplicate(b, a, "tl")).toThrow("only PM marks duplicates");
    expect(() => ops.duplicate(b, b, "pm")).toThrow("a ticket cannot duplicate itself");
    expect(() => ops.duplicate(b, "T-9", "pm")).toThrow("no such ticket: T-9");
    expect(ops.duplicate(b, a, "pm")).toBe(`marked ${b} as a duplicate of ${a}`);
    expect(t.getTicket(b).status).toBe("duplicate");
    expect(t.getTicket(b).relations).toEqual([{ from: b, to: a, kind: "duplicate" }]);
    milestones(1);
    ops.accept(a, "pm", ACC);
    expect(() => ops.duplicate(a, b, "pm")).toThrow(`${a} is todo`);
  });
});

describe("ops: start", () => {
  it("start moves a Todo ticket in the active milestone to In Progress", () => {
    milestones(1);
    const a = mk({ title: "A", status: "todo", milestone: "M0", assignee: "dev1" });
    expect(() => ops.start(a, "pm")).toThrow("only the system starts work");
    expect(ops.start(a, "org")).toBe(`started ${a}`);
    expect(t.getTicket(a).status).toBe("in_progress");
    expect(() => ops.start(a, "org")).toThrow(`${a} is in_progress; only a todo ticket can be started`);
  });
  it("start refuses a blocked ticket, a ticket outside the active milestone and a parent with open children", () => {
    milestones(2);
    const a = mk({ title: "A", status: "todo", milestone: "M0" });
    const b = mk({ title: "B", status: "todo", milestone: "M0" });
    t.addRelation(a, b, "blocks", "sa");
    expect(() => ops.start(b, "org")).toThrow(`${b} is blocked by ${a}`);
    const c = mk({ title: "C", status: "todo", milestone: "M1" });
    expect(() => ops.start(c, "org")).toThrow(`${c} is not in the active milestone M0`);
    const d = mk({ title: "D", status: "todo", milestone: "M0" });
    mk({ title: "E", parent: d });
    expect(() => ops.start(d, "org")).toThrow(`${d} has open sub-tickets`);
  });
});

describe("ops: cancel, priority, assign, reviewers, description", () => {
  it("only PM cancels an open ticket, with a reason", () => {
    const a = mk({ title: "A", status: "in_progress" });
    expect(() => ops.cancel(a, "x", "dev1")).toThrow("only PM cancels");
    expect(() => ops.cancel(a, "", "pm")).toThrow("a reason is required");
    expect(ops.cancel(a, "not needed", "pm")).toBe(`canceled ${a}`);
    expect(t.getTicket(a)).toMatchObject({ status: "canceled", comments: [{ author: "pm", text: "not needed" }] });
  });
  it("cancel by the human writes the reason", () => {
    const a = mk({ title: "A", status: "needs_reply", assignee: "human" });
    expect(ops.cancel(a, "obsolete", "user")).toBe(`canceled ${a}`);
    expect(t.getTicket(a)).toMatchObject({ status: "canceled", comments: [{ author: "user", text: "obsolete" }] });
  });
  it("a ticket that blocks an open ticket cannot be canceled", () => {
    const a = mk({ title: "A", status: "todo" }), b = mk({ title: "B", status: "todo" });
    t.addRelation(a, b, "blocks", "sa");
    expect(() => ops.cancel(a, "x", "pm")).toThrow(`${a} blocks ${b}; remove the link first`);
    t.setStatus(b, "done", "org");
    expect(() => ops.cancel(a, "x", "pm")).not.toThrow();
  });
  it("a closed ticket cannot be canceled", () => {
    const a = mk({ title: "A", status: "done" });
    expect(() => ops.cancel(a, "x", "pm")).toThrow(`${a} is done`);
  });
  it("only PM changes priority after Triage; the reporter may set it at creation", () => {
    const a = mk({ title: "A", priority: 2 }, "dev1");
    expect(t.getTicket(a).priority).toBe(2);
    expect(ops.setPriority(a, 3, "dev1")).toBe(`${a} priority 3`); // still in Triage
    expect(() => ops.setPriority(a, 1, "dev2")).toThrow("only PM changes priority");
    milestones(1);
    ops.accept(a, "pm", ACC);
    expect(() => ops.setPriority(a, 1, "dev1")).toThrow("only PM changes priority");
    ops.setPriority(a, 4, "pm");
    expect(t.getTicket(a).priority).toBe(4);
    expect(() => ops.setPriority(a, 7 as never, "pm")).toThrow("priority must be 0 (none) to 4 (urgent)");
  });
  it("assign is for the human only", () => {
    const a = mk({ title: "A", status: "in_review", assignee: "dev1", reviewers: ["tl"] });
    expect(() => ops.assign(a, "dev2", "pm")).toThrow("only the human assigns");
    expect(ops.assign(a, "dev2", "user")).toBe(`assigned ${a} to dev2`);
    expect(t.getTicket(a)).toMatchObject({ assignee: "dev2", status: "in_review" });
    expect(() => ops.assign(a, "zz", "user")).toThrow("zz is not a member");
    expect(() => ops.assign(a, "tl", "user")).toThrow("tl cannot review its own ticket");
  });
});

describe("ops: links", () => {
  it("only PM and SA add or remove blocking links", () => {
    const a = mk({ title: "A" }), b = mk({ title: "B" });
    expect(() => ops.link(a, b, "blocks", "tl")).toThrow("only PM or SA manages blocking links");
    expect(ops.link(a, b, "blocks", "sa")).toBe(`${a} blocks ${b}`);
    expect(t.isBlocked(b)).toBe(true);
    expect(() => ops.unlink(a, b, "blocks", "dev1")).toThrow("only PM or SA manages blocking links");
    expect(ops.unlink(a, b, "blocks", "pm")).toBe(`removed ${a} blocks ${b}`);
    expect(t.isBlocked(b)).toBe(false);
  });
  it("a blocking link that makes a cycle or a self link is refused", () => {
    const a = mk({ title: "A" }), b = mk({ title: "B" }), c = mk({ title: "C" });
    expect(() => ops.link(a, a, "blocks", "sa")).toThrow("a ticket cannot link to itself");
    ops.link(a, b, "blocks", "sa");
    ops.link(b, c, "blocks", "sa");
    expect(() => ops.link(c, a, "blocks", "sa")).toThrow(`${c} blocks ${a} would make a cycle`);
    expect(() => ops.link(b, a, "blocks", "sa")).toThrow("would make a cycle");
  });
  it("a blocker in a later milestone than the blocked ticket is refused", () => {
    milestones(2);
    const a = mk({ title: "A", status: "todo", milestone: "M1" }), b = mk({ title: "B", status: "todo", milestone: "M0" });
    expect(() => ops.link(a, b, "blocks", "sa")).toThrow(`${a} is in a later milestone (M1) than ${b} (M0)`);
    expect(() => ops.link(b, a, "blocks", "sa")).not.toThrow();
    t.reorderMilestones(["M1", "M0"], "ba");
    expect(() => ops.link(a, b, "blocks", "pm")).toThrow("would make a cycle");
  });
  it("a related link is added by anyone (the system adds it on mentions of T-n in a comment)", () => {
    const a = mk({ title: "A" }), b = mk({ title: "B" });
    expect(ops.link(a, b, "related", "dev1")).toBe(`${a} relates to ${b}`);
    expect(ops.link(b, a, "related", "org")).toBe(`${b} relates to ${a}`);
    expect(t.getTicket(a).relations).toHaveLength(2);
    expect(ops.unlink(a, b, "related", "tl")).toBe(`removed ${a} relates to ${b}`);
  });
});

describe("ops: milestones", () => {
  it("completion counts done tickets over all but canceled and duplicate; started tickets count half", () => {
    milestones(1);
    expect(ops.completion("M0")).toBe(0);
    for (const s of ["done", "in_progress", "in_review", "todo", "canceled", "duplicate"] as const) mk({ title: s, status: s, milestone: "M0" });
    expect(ops.completion("M0")).toBe(50); // (1 + 0.5 + 0.5 + 0) / 4
  });
  it("the active milestone is the first by order that is not complete; next is the one after it", () => {
    expect(ops.active()).toBeUndefined();
    expect(ops.next()).toBeUndefined();
    milestones(3);
    expect(ops.active()?.id).toBe("M0"); // a milestone with no tickets is not complete
    mk({ title: "A", status: "done", milestone: "M0" });
    expect(ops.active()?.id).toBe("M1");
    expect(ops.next()?.id).toBe("M2");
    t.reorderMilestones(["M0", "M2", "M1"], "ba");
    expect(ops.next()?.id).toBe("M1");
    mk({ title: "B", status: "done", milestone: "M2" });
    mk({ title: "C", status: "done", milestone: "M1" });
    expect(ops.active()).toBeUndefined();
  });
});

describe("ops: review", () => {
  const working = (assignee: string, revs: string[] = []) => {
    const tk = t.createTicket({ title: "W", status: "in_progress", assignee }, "org").id;
    for (const r of revs) t.setApproval(tk, r, "pending", "org");
    return tk;
  };
  const states = (tk: string) => t.getTicket(tk).approvals.map((a) => [a.reviewer, a.state]);
  const doneEvents = (tk: string) => t.events().filter((e) => e.kind === "review.done" && e.ticket === tk);

  it("only the assignee submits an In Progress ticket", () => {
    const a = working("dev1", ["tl"]);
    expect(() => ops.submit(a, "dev2", S)).toThrow(`only ${a}'s assignee submits`);
    const b = mk({ title: "B", status: "todo", assignee: "dev1", reviewers: ["tl"] });
    expect(() => ops.submit(b, "dev1", S)).toThrow(`${b} is todo; only a in_progress ticket can be submitted`);
    expect(ops.submit(a, "dev1", S)).toBe(`submitted ${a} for review by tl`);
  });
  it("submit refuses a blocked ticket and a parent with open children", () => {
    const x = mk({ title: "X", status: "todo" });
    const a = working("dev1", ["tl"]);
    t.addRelation(x, a, "blocks", "sa");
    expect(() => ops.submit(a, "dev1", S)).toThrow(`${a} is blocked by ${x}`);
    const c = working("dev1", ["tl"]);
    mk({ title: "child", parent: c });
    expect(() => ops.submit(c, "dev1", S)).toThrow(`${c} has open sub-tickets`);
  });
  it("submit of a blocked final ticket saves the verdict and moves it to Todo", () => {
    const x = mk({ title: "X", status: "todo" }), y = mk({ title: "Y", status: "todo" });
    const f = mk({ title: "F", kind: "final", status: "in_progress", assignee: "ba", reviewers: ["sa"] });
    t.addRelation(x, f, "blocks", "org");
    t.addRelation(y, f, "blocks", "org");
    expect(ops.submit(f, "ba", { summary: "BR-1 met" })).toBe(`${f} waits for ${x}, ${y}; it is in Todo until they close`);
    expect(t.getTicket(f)).toMatchObject({ status: "todo", summary: "BR-1 met" });
  });
  it("submit sets every approval to pending and moves the ticket to In Review", () => {
    const a = working("dev1", ["tl", "sa"]);
    t.setApproval(a, "tl", "approved", "tl");
    t.setApproval(a, "sa", "changes", "sa");
    ops.submit(a, "dev1", S);
    expect(states(a)).toEqual([["tl", "pending"], ["sa", "pending"]]);
    expect(t.getTicket(a).status).toBe("in_review");
  });
  it("submit adds the assignee's manager as reviewer when no reviewer is set", () => {
    const a = working("pm");
    expect(ops.submit(a, "pm", S)).toBe(`submitted ${a} for review by ba`);
    const b = working("dev1");
    ops.submit(b, "dev1", S);
    expect(reviewers(b)).toEqual(["tl"]);
    const c = working("ba"); // BA has no manager
    expect(() => ops.submit(c, "ba", S)).toThrow(`${c} has no reviewer`);
    ops.submit(c, "ba", { ...S, files: ["src/a.ts"] });
    expect(reviewers(c)).toEqual(["tl"]);
  });
  it("submit adds a TL or SA reviewer for a DEV assignee", () => {
    const o2 = { ...org, members: { ...org.members, tl2: m("tl"), dev3: m("dev", "tl2"), dev4: m("dev") } } as Org; // dev4 names no TL: unvalidated
    const ops2 = createOps(t, o2);
    const a = working("dev3", ["dev1"]);
    ops2.submit(a, "dev3", S);
    expect(reviewers(a)).toEqual(["dev1", "tl2"]); // the TL in the reporting line
    const b = working("dev4", ["dev1"]);
    ops2.submit(b, "dev4", S);
    expect(reviewers(b)).toEqual(["dev1", "tl"]); // any TL
    const c = working("dev1", ["sa"]);
    ops2.submit(c, "dev1", S);
    expect(reviewers(c)).toEqual(["sa"]); // an SA is already there
    const noTl = { ...org, members: { sa: org.members.sa, dev1: { role: "dev", definition: "d" } } } as Org;
    const d = working("dev1", ["dev2"]);
    createOps(t, noTl).submit(d, "dev1", S);
    expect(reviewers(d)).toEqual(["dev2", "sa"]); // no TL at all
  });
  it("submit adds the TL as reviewer for changed code; an owner's own documents add nobody", () => {
    expect(OWNED).toEqual({ "docs/business-requirements.md": "ba", "docs/business-summary.txt": "ba", "docs/technical-requirements.md": "sa", "docs/tech-summary.txt": "sa" });
    const a = working("sa", ["ba"]);
    ops.submit(a, "sa", { ...S, files: ["docs/technical-requirements.md", "docs/tech-summary.txt", "src/a.ts", "docs/notes.md"] });
    expect(reviewers(a)).toEqual(["ba", "tl"]);
    const b = working("ba", ["sa"]);
    ops.submit(b, "ba", { ...S, files: ["docs/business-requirements.md", "docs/business-summary.txt"] });
    expect(reviewers(b)).toEqual(["sa"]);
  });
  it("submit refuses a file owned by another role", () => {
    const a = working("dev1", ["tl"]);
    expect(() => ops.submit(a, "dev1", { ...S, files: ["src/a.ts", "docs/tech-summary.txt"] })).toThrow("docs/tech-summary.txt belongs to SA; revert your change to it");
    const b = working("sa", ["ba"]);
    expect(() => ops.submit(b, "sa", { ...S, files: ["docs/business-requirements.md"] })).toThrow("docs/business-requirements.md belongs to BA; revert your change to it");
    expect(t.getTicket(a).status).toBe("in_progress");
    expect(t.getTicket(b).status).toBe("in_progress");
  });
  it("submit refuses a summary over 4,000 characters", () => {
    expect(SUMMARY_CAP).toBe(4000);
    const sizes: Record<string, number> = { "docs/business-summary.txt": 4001, "docs/business-requirements.md": 90000 };
    const size = (f: string) => sizes[f] ?? 0;
    const a = working("ba", ["sa"]);
    expect(() => ops.submit(a, "ba", { ...S, files: ["docs/business-summary.txt"], size })).toThrow("docs/business-summary.txt has 4001 characters; the cap is 4000. Shorten it.");
    sizes["docs/business-summary.txt"] = 4000;
    expect(ops.submit(a, "ba", { ...S, files: ["docs/business-summary.txt", "docs/business-requirements.md"], size })).toBe(`submitted ${a} for review by sa`);
    const b = working("sa", ["ba"]);
    expect(() => ops.submit(b, "sa", { ...S, files: ["docs/tech-summary.txt"], size: () => 5000 })).toThrow("docs/tech-summary.txt has 5000 characters; the cap is 4000. Shorten it.");
  });
  it("submit takes a work summary of any length", () => {
    const a = working("dev1", ["tl"]), long = "x".repeat(5000);
    for (const s of [undefined, "", "  "]) expect(() => ops.submit(a, "dev1", { summary: s })).toThrow("summary is required: what you did, what you used, what you decided");
    expect(t.getTicket(a).status).toBe("in_progress");
    expect(ops.submit(a, "dev1", { summary: ` ${long} ` })).toBe(`submitted ${a} for review by tl`);
    expect(t.getTicket(a).summary).toBe(long);
    expect(t.events().filter((e) => e.kind === "ticket.summary").map((e) => [e.actor, e.ticket, e.data.summary])).toEqual([["dev1", a, long]]);
    const b = t.createTicket({ title: "Break down", kind: "breakdown", status: "in_progress", assignee: "tl" }, "org").id;
    t.setApproval(b, "sa", "pending", "org");
    expect(() => ops.submit(b, "tl")).toThrow("summary is required");
  });
  it("the summary ticket may change .gitignore", () => {
    const a = t.createTicket({ title: "Update tech summary", kind: "summary", status: "in_progress", assignee: "sa" }, "org").id;
    t.setApproval(a, "tl", "pending", "org");
    expect(ops.submit(a, "sa", { ...S, files: ["docs/tech-summary.txt", "docs/technical-requirements.md", ".gitignore"], size: () => 10 })).toBe(`submitted ${a} for review by tl`);
  });
  it("the review-round cap sends the ticket to the rejecting reviewer's manager", () => {
    const o2 = createOps(t, org, { reviewRounds: 2 });
    const round = (tk: string, r: string, f: string) => { ops.submit(tk, "dev1", S); return o2.requestChanges(tk, [f], r); };
    const a = working("dev1", ["tl"]);
    expect(round(a, "tl", "one")).toBe(`requested changes on ${a}: 1 findings`);
    expect(t.getTicket(a)).toMatchObject({ status: "in_progress", assignee: "dev1" });
    expect(round(a, "tl", "two")).toBe(`requested changes on ${a}: 1 findings; round 2 of 2, so it goes to sa`);
    const tk = t.getTicket(a);
    expect(tk).toMatchObject({ status: "needs_reply", assignee: "sa", asker: "tl", return_status: "in_progress", return_assignee: "dev1" });
    expect(tk.comments.at(-1)!.text).toContain("tl requested changes 2 times");
    expect(tk.comments.at(-1)!.text).toContain("1. two");
    expect(o2.answer(a, "keep it simple", "sa")).toBe(`answered ${a}; it is in_progress again`);
    expect(t.getTicket(a)).toMatchObject({ status: "in_progress", assignee: "dev1" });
    // SA and BA have no manager: the ticket waits for the human
    const b = working("dev1", ["sa"]);
    round(b, "sa", "x");
    expect(round(b, "sa", "y")).toContain("so it goes to the human");
    expect(t.getTicket(b)).toMatchObject({ status: "needs_reply", assignee: "human", asker: "org", return_status: "in_progress", return_assignee: "dev1" });
    // the default cap is 3
    const c = working("dev1", ["tl"]);
    for (const f of ["1", "2"]) { ops.submit(c, "dev1", S); ops.requestChanges(c, [f], "tl"); }
    ops.submit(c, "dev1", S);
    expect(ops.requestChanges(c, ["3"], "tl")).toContain("round 3 of 3");
  });
  it("the review-round cap comes from limits.review_rounds", () => {
    const o1 = createOps(t, { ...org, limits: { ...org.limits, review_rounds: 1 } });
    const a = working("dev1", ["tl"]);
    ops.submit(a, "dev1", S);
    expect(o1.requestChanges(a, ["one"], "tl")).toContain("round 1 of 1, so it goes to sa");
  });
  it("an answer resets the review-round count", () => {
    const o2 = createOps(t, org, { reviewRounds: 2 });
    const a = working("dev1", ["tl"]);
    const round = (f: string) => { o2.submit(a, "dev1", S); return o2.requestChanges(a, [f], "tl"); };
    round("1"); round("2");
    o2.answer(a, "go on", "sa");
    expect(round("3")).toBe(`requested changes on ${a}: 1 findings`);
    expect(round("4")).toContain("round 2 of 2");
  });
  it("only a reviewer with a pending approval approves", () => {
    const a = working("dev1", ["tl", "sa"]);
    ops.submit(a, "dev1", S);
    expect(() => ops.approve(a, "dev2")).toThrow(`dev2 has no pending review on ${a}`);
    expect(ops.approve(a, "tl")).toBe(`approved ${a}`);
    expect(() => ops.approve(a, "tl")).toThrow(`tl has no pending review on ${a}`);
  });
  it("when every reviewer approved, approve logs review.done on the ticket", () => {
    const a = working("dev1", ["tl", "sa"]);
    ops.submit(a, "dev1", S);
    ops.approve(a, "tl");
    expect(doneEvents(a)).toHaveLength(0);
    ops.approve(a, "sa");
    expect(doneEvents(a)).toMatchObject([{ actor: "org", ticket: a }]);
  });
  it("approve on a ticket that is not In Review is refused", () => {
    const a = working("dev1", ["tl"]);
    expect(() => ops.approve(a, "tl")).toThrow(`${a} is in_progress; only a in_review ticket can be approved`);
  });
  it("request_changes writes the comment as '<reviewer> requests changes:'", () => {
    const a = working("dev1", ["tl"]);
    ops.submit(a, "dev1", S);
    ops.requestChanges(a, ["no tests"], "tl");
    expect(t.getTicket(a).comments[0].text).toBe("tl requests changes:\n1. no tests");
    expect(ticketText(t.getTicket(a), t)).toMatch(/^tl requests changes:\n1. no tests$/m);
  });
  it("request_changes writes one numbered comment and moves the ticket back", () => {
    const a = working("dev1", ["tl", "sa"]);
    ops.submit(a, "dev1", S);
    expect(() => ops.requestChanges(a, ["x"], "dev2")).toThrow(`dev2 has no pending review on ${a}`);
    expect(ops.requestChanges(a, ["no tests", " ", "typo in README"], "tl")).toBe(`requested changes on ${a}: 2 findings`);
    expect(t.getTicket(a).comments).toMatchObject([{ author: "tl", text: "tl requests changes:\n1. no tests\n2. typo in README" }]);
    expect(states(a)).toEqual([["tl", "changes"], ["sa", "pending"]]);
    expect(t.getTicket(a).status).toBe("in_progress");
  });
  it("findings must not be empty", () => {
    const a = working("dev1", ["tl"]);
    ops.submit(a, "dev1", S);
    expect(() => ops.requestChanges(a, [], "tl")).toThrow("findings must not be empty");
    expect(() => ops.requestChanges(a, [" "], "tl")).toThrow("findings must not be empty");
  });
});

describe("ops: questions", () => {
  it("the PM may ask about a Triage ticket and the answer returns it to Triage", () => {
    const a = mk({ title: "Idea" }, "dev1");
    expect(() => ops.ask(a, "tl", "q", "tl")).toThrow();
    ops.ask(a, "ba", "why?", "pm");
    expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "ba", return_status: "triage" });
    ops.answer(a, "users want it", "ba");
    expect(t.getTicket(a)).toMatchObject({ status: "triage" });
    expect(t.getTicket(a).assignee ?? null).toBeNull();
  });
  const work = (assignee = "dev1") => mk({ title: "W", status: "in_progress", assignee });

  it("ask reaches only a grid neighbour", () => {
    const a = work();
    expect(() => ops.ask(a, "sa", "which db?", "dev1")).toThrow("dev1 cannot ask sa; ask tl");
    expect(() => ops.ask(a, "dev2", "hi", "dev1")).toThrow("dev1 cannot ask dev2; ask tl");
    expect(() => ops.ask(a, "human", "hi", "dev1")).toThrow("dev1 cannot ask human; ask tl");
    expect(() => ops.ask(a, "zz", "hi", "dev1")).toThrow("zz is not a member");
    expect(() => ops.ask(a, "tl", "hi", "dev2")).toThrow(`only ${a}'s assignee asks`);
    expect(() => ops.ask(a, "tl", " ", "dev1")).toThrow("a question is required");
    const b = work("pm");
    expect(() => ops.ask(b, "dev1", "fix", "pm")).toThrow("pm cannot ask dev1; ask ba");
    expect(t.getTicket(a).status).toBe("in_progress");
    const c = mk({ title: "T", status: "todo", assignee: "dev1" });
    expect(() => ops.ask(c, "tl", "q", "dev1")).toThrow(`${c} is todo; only a in_progress or in_review or triage ticket can be asked about`);
  });
  it("BA and SA may ask the human", () => {
    for (const m of ["ba", "sa"]) {
      const a = work(m);
      expect(ops.ask(a, "human", "scope?", m)).toMatch(/^asked human on/);
      expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "human" });
    }
  });
  it("ask stores the return status and assignee and gives the ticket to the answerer", () => {
    const a = work();
    expect(ops.ask(a, "tl", "which db?", "dev1")).toBe(`asked tl on ${a}; end the session, the answer comes back on the ticket`);
    expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "tl", asker: "dev1", return_status: "in_progress", return_assignee: "dev1", comments: [{ author: "dev1", text: "dev1 asks tl: which db?" }] });
  });
  it("answer restores the status and the assignee", () => {
    const a = work();
    ops.ask(a, "tl", "which db?", "dev1");
    expect(() => ops.answer(a, "x", "dev1")).toThrow(`only ${a}'s assignee answers`);
    expect(() => ops.answer(a, " ", "tl")).toThrow("an answer is required");
    expect(ops.answer(a, "postgres", "tl")).toBe(`answered ${a}; it is in_progress again`);
    const v = t.getTicket(a);
    expect(v).toMatchObject({ status: "in_progress", assignee: "dev1" });
    expect(v.asker).toBeUndefined();
    expect(v.comments.at(-1)).toMatchObject({ author: "tl", text: "tl answers: postgres" });
    expect(() => ops.answer(a, "x", "tl")).toThrow(`${a} is in_progress; only a needs_reply ticket can be answered`);
  });
  it("a reviewer's question returns the ticket to In Review with its assignee", () => {
    const a = work();
    t.setApproval(a, "tl", "pending", "org");
    ops.submit(a, "dev1", S);
    expect(() => ops.ask(a, "tl", "q", "dev1")).toThrow(`dev1 has no pending review on ${a}`);
    ops.ask(a, "sa", "is this allowed?", "tl");
    expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "sa", return_status: "in_review", return_assignee: "dev1" });
    ops.answer(a, "yes", "sa");
    expect(t.getTicket(a)).toMatchObject({ status: "in_review", assignee: "dev1" });
  });
  it("forward passes the question up the grid", () => {
    const a = work();
    ops.ask(a, "tl", "which db?", "dev1");
    expect(() => ops.forward(a, "sa", "dev1")).toThrow(`only ${a}'s assignee forwards`);
    expect(() => ops.forward(a, "ba", "tl")).toThrow("tl cannot ask ba; ask sa");
    expect(ops.forward(a, "sa", "tl")).toBe(`forwarded ${a} to sa`);
    expect(ops.forward(a, "human", "sa")).toBe(`forwarded ${a} to human`);
    expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "human", return_assignee: "dev1" });
    expect(t.getTicket(a).comments.map((c) => c.text)).toEqual(["dev1 asks tl: which db?", "tl forwards to sa", "sa forwards to human"]);
  });
  it("forward rejects the asker", () => {
    const a = work();
    ops.ask(a, "tl", "which db?", "dev1");
    expect(() => ops.forward(a, "dev1", "tl")).toThrow("the asker cannot answer its own question");
    expect(ops.forward(a, "sa", "tl")).toBe(`forwarded ${a} to sa`);
  });
  it("the human answers a ticket that waits for the human", () => {
    const a = work("ba");
    ops.ask(a, "human", "scope?", "ba");
    expect(() => ops.answer(a, "x", "pm")).toThrow(`only ${a}'s assignee answers`);
    expect(ops.answer(a, "", "user")).toBe(`answered ${a}; it is in_progress again`);
    expect(t.getTicket(a)).toMatchObject({ status: "in_progress", assignee: "ba" });
    expect(t.getTicket(a).comments.at(-1)).toMatchObject({ author: "user", text: "user answers: try again" });
  });
  it("parkForHuman gives the ticket to the human with a note", () => {
    const a = mk({ title: "W", status: "todo", assignee: "dev1" });
    expect(ops.parkForHuman(a, "dev1 ended 3 sessions without a transition")).toBe(`${a} waits for the human`);
    expect(t.getTicket(a)).toMatchObject({ status: "needs_reply", assignee: "human", asker: "org", return_status: "todo", return_assignee: "dev1", comments: [{ author: "org", text: "dev1 ended 3 sessions without a transition" }] });
    expect(() => ops.parkForHuman(a, "again")).toThrow(`${a} already waits for the human`);
    ops.answer(a, "go on", "user");
    expect(t.getTicket(a)).toMatchObject({ status: "todo", assignee: "dev1" });
  });
  it("the merge-conflict comment does not ask for git", () => {
    const a = mk({ title: "W", status: "in_review", assignee: "dev1" });
    ops.conflictBack(a, ["a.ts", "b.ts"]);
    expect(t.getTicket(a).comments.map((c) => c.text)).toEqual(["main changed a.ts, b.ts since your branch; MAIHEM merges main into your branch at your next session"]);
  });
  it("conflictBack moves the ticket back with a note", () => {
    const a = mk({ title: "W", status: "in_review", assignee: "dev1" });
    expect(ops.conflictBack(a, ["a.ts", "b.ts"])).toBe(`moved ${a} back to in_progress: merge conflict`);
    expect(t.getTicket(a)).toMatchObject({ status: "in_progress", comments: [{ author: "org", text: "main changed a.ts, b.ts since your branch; MAIHEM merges main into your branch at your next session" }] });
  });
});

describe("ops: milestone management", () => {
  it("only PM creates milestones", () => {
    expect(() => ops.createMilestone("Core", "", "ba")).toThrow("only PM creates milestones");
    expect(ops.createMilestone("Core", "the core", "pm")).toBe("created milestone M0");
    expect(ops.createMilestone("Next", "", "org")).toBe("created milestone M1");
    expect(t.getMilestone("M0")).toMatchObject({ name: "Core", description: "the core" });
  });
  it("milestone_update refuses a completed milestone", () => {
    milestones(2);
    t.log("milestone.completed", "org", { id: "M0" });
    expect(() => ops.updateMilestone("M0", { name: "X" }, "pm")).toThrow("M0 is done; plan new requirement ids in a new milestone");
    expect(ops.updateMilestone("M1", { name: "Y" }, "pm")).toBe("updated M1");
  });
  it("only PM renames and reorders", () => {
    milestones(2);
    expect(() => ops.updateMilestone("M0", { name: "X" }, "ba")).toThrow("only PM updates milestones");
    expect(ops.updateMilestone("M0", { name: "Setup" }, "pm")).toBe("updated M0");
    expect(ops.updateMilestone("M0", { description: "BR-6" }, "pm")).toBe("updated M0");
    expect(t.getMilestone("M0").description).toBe("BR-6");
    expect(() => ops.updateMilestone("M0", {}, "pm")).toThrow("give a name or a description");
    expect(t.getMilestone("M0").name).toBe("Setup");
    expect(() => ops.reorderMilestones(["M1", "M0"], "ba")).toThrow("only PM reorders milestones");
    expect(ops.reorderMilestones(["M1", "M0"], "user")).toBe("milestones: M1, M0");
    expect(t.listMilestones().map((x) => x.id)).toEqual(["M1", "M0"]);
  });
  it("reorder needs every milestone id exactly once", () => {
    milestones(2);
    for (const ids of [["M0"], ["M0", "M0"], ["M0", "M9"], ["M0", "M1", "M1"]]) expect(() => ops.reorderMilestones(ids, "pm")).toThrow("reorder needs every milestone id exactly once");
  });
  it("only an empty milestone can be deleted", () => {
    milestones(2);
    mk({ title: "A", status: "canceled", milestone: "M0" });
    expect(() => ops.deleteMilestone("M1", "ba")).toThrow("only PM deletes milestones");
    expect(() => ops.deleteMilestone("M0", "pm")).toThrow("M0 has tickets; only an empty milestone can be deleted");
    expect(ops.deleteMilestone("M1", "pm")).toBe("deleted milestone M1");
    expect(t.listMilestones().map((x) => x.id)).toEqual(["M0"]);
  });
});

describe("ops: system moves", () => {
  it("the system closes a ticket as done", () => {
    const a = mk({ title: "A", status: "in_review" });
    expect(() => ops.closeTicket(a, "pm")).toThrow("only the system closes tickets");
    expect(ops.closeTicket(a, "org")).toBe(`closed ${a}`);
    expect(t.getTicket(a).status).toBe("done");
    expect(() => ops.closeTicket(a, "org")).toThrow(`${a} is done`);
  });
  it("the system moves a blocked In Progress ticket back to Todo", () => {
    const x = mk({ title: "X", status: "todo" }), a = mk({ title: "A", status: "in_progress" });
    expect(() => ops.reopenToTodo(a, "org")).toThrow(`${a} is not blocked`);
    t.addRelation(x, a, "blocks", "sa");
    expect(() => ops.reopenToTodo(a, "pm")).toThrow("only the system moves work back to Todo");
    expect(ops.reopenToTodo(a, "org")).toBe(`moved ${a} back to todo`);
    expect(t.getTicket(a).status).toBe("todo");
    expect(() => ops.reopenToTodo(a, "org")).toThrow(`${a} is todo; only a in_progress or in_review ticket can be moved back`);
  });
  it("reopenToTodo moves a blocked In Review ticket back and resets its approvals", () => {
    const x = mk({ title: "X", status: "todo" }), a = mk({ title: "A", status: "in_review", reviewers: ["sa", "tl"] });
    t.setApproval(a, "sa", "approved", "sa");
    t.addRelation(x, a, "blocks", "org");
    expect(ops.reopenToTodo(a, "org")).toBe(`moved ${a} back to todo`);
    expect(t.getTicket(a).status).toBe("todo");
    expect(t.getTicket(a).approvals.map((r) => r.state)).toEqual(["pending", "pending"]);
  });
});

describe("ops: breakdown dependencies", () => {
  // M1 with a breakdown ticket and three tickets A, B, C; X is in M2
  const setup = () => {
    milestones(3);
    const plan = mk({ title: "Break down M1", kind: "breakdown", status: "in_progress", milestone: "M1", assignee: "tl", reviewers: ["sa"] });
    const [a, b, c] = ["A", "B", "C"].map((title) => id(ops.create({ title }, "tl", { breakdown: plan })));
    const x = mk({ title: "X", status: "todo", milestone: "M2" });
    return { plan, a, b, c, x };
  };
  const blockedBy = (tk: string) => t.blockers(tk).map((x) => x.id).sort();

  it("TL sets the dependencies of a milestone's tickets in one call", () => {
    const { plan, a, b, c } = setup();
    expect(ops.setDependencies({ [c]: [a, b], [b]: [a] }, "tl", plan)).toBe(`dependencies set: ${c} after ${a}, ${b}; ${b} after ${a}`);
    expect(blockedBy(c)).toEqual([a, b, plan].sort());
    expect(blockedBy(b)).toEqual([a, plan].sort());
    expect(blockedBy(a)).toEqual([plan]);
    expect(() => ops.setDependencies({ [b]: [a] }, "sa", plan)).toThrow("only TL sets dependencies");
    expect(() => ops.setDependencies({ [b]: [a] }, "tl", a)).toThrow(`${a} is not a breakdown ticket`);
  });
  it("set_dependencies refuses a ticket outside the milestone", () => {
    const { plan, a, b, x } = setup();
    expect(() => ops.setDependencies({ [b]: [x] }, "tl", plan)).toThrow(`${x} is not a ticket of M1`);
    expect(() => ops.setDependencies({ [x]: [a] }, "tl", plan)).toThrow(`${x} is not a ticket of M1`);
    expect(() => ops.setDependencies({ [b]: [plan] }, "tl", plan)).toThrow(`${plan} is not a ticket of M1`);
    expect(() => ops.setDependencies({ [b]: ["T-99"] }, "tl", plan)).toThrow("T-99 is not a ticket of M1");
    expect(blockedBy(b)).toEqual([plan]);
  });
  it("set_dependencies replaces the previous dependencies", () => {
    const { plan, a, b, c, x } = setup();
    ops.setDependencies({ [c]: [a, b] }, "tl", plan);
    t.addRelation(c, x, "blocks", "sa"); // a link out of the milestone stays
    ops.setDependencies({ [a]: [b] }, "tl", plan);
    expect(blockedBy(a)).toEqual([b, plan].sort());
    expect(blockedBy(c)).toEqual([plan]);
    expect(blockedBy(x)).toEqual([c]);
  });
  it("a cycle in set_dependencies is refused and nothing changes", () => {
    const { plan, a, b, c } = setup();
    ops.setDependencies({ [b]: [a] }, "tl", plan);
    expect(() => ops.setDependencies({ [a]: [c], [c]: [b], [b]: [a] }, "tl", plan)).toThrow("the dependencies make a cycle");
    expect(() => ops.setDependencies({ [a]: [a] }, "tl", plan)).toThrow("the dependencies make a cycle");
    expect(blockedBy(b)).toEqual([a, plan].sort());
    expect(blockedBy(a)).toEqual([plan]);
    expect(blockedBy(c)).toEqual([plan]);
  });
});

describe("ops: errors say how to fix them", () => {
  const working = (assignee: string, revs: string[] = []) => {
    const tk = t.createTicket({ title: "W", status: "in_progress", assignee }, "org").id;
    for (const r of revs) t.setApproval(tk, r, "pending", "org");
    return tk;
  };
  it("errors say how to fix them: lookups", () => {
    milestones(1);
    expect(() => ops.duplicate(mk({ title: "A" }), "T-9", "pm")).toThrow("no such ticket: T-9; use ticket_list to see the ids");
    expect(() => ops.accept(mk({ title: "B" }), "pm", { milestone: "M9" })).toThrow("no such milestone: M9; use milestone_list to see the ids");
    expect(() => ops.assign(mk({ title: "C" }), "zz", "user")).toThrow("zz is not a member; members: ba, sa, pm, tl, dev1, dev2");
    expect(() => ops.reorderMilestones(["M9"], "pm")).toThrow("reorder needs every milestone id exactly once; milestone_list shows them");
  });
  it("errors say how to fix them: role guards", () => {
    const a = mk({ title: "A" });
    expect(() => ops.cancel(a, "x", "dev2")).toThrow("only PM cancels; this is PM's decision, ask tl");
    expect(() => ops.cancel(a, "x", "tl")).toThrow("only PM cancels; this is PM's decision, ask pm");
    expect(() => ops.link(a, mk({ title: "B" }), "blocks", "dev1")).toThrow("only PM or SA manages blocking links; this is PM's or SA's decision, ask tl");
    expect(() => ops.closeTicket(a, "pm")).toThrow("only the system closes tickets; this happens automatically, do not call it");
    const w = working("dev1", ["tl"]);
    expect(() => ops.submit(w, "dev2", S)).toThrow(`only ${w}'s assignee submits; work only on this session's ticket, then end the session`);
    expect(() => ops.create({ title: "C", parent: w }, "dev2")).toThrow(`only PM or ${w}'s assignee creates its sub-tickets; create a Triage ticket with ticket_create instead`);
    ops.submit(w, "dev1", S);
    expect(() => ops.approve(w, "dev2")).toThrow(`dev2 has no pending review on ${w}; work only on this session's ticket, then end the session`);
  });
  it("errors say how to fix them: submit blockers", () => {
    const x = mk({ title: "X", status: "todo" }), a = working("dev1", ["tl"]);
    t.addRelation(x, a, "blocks", "sa");
    expect(() => ops.submit(a, "dev1", S)).toThrow(`${a} is blocked by ${x}; wait until they are done and end the session`);
    const c = working("dev1", ["tl"]);
    mk({ title: "child", parent: c });
    expect(() => ops.submit(c, "dev1", S)).toThrow(`${c} has open sub-tickets; wait until they are done and end the session`);
    const d = working("ba");
    expect(() => ops.submit(d, "ba", S)).toThrow(`${d} has no reviewer; ask who reviews it with ask`);
  });
  it("errors say how to fix them: missing fields", () => {
    const a = mk({ title: "A" });
    expect(() => ops.reject(a, " ", "pm")).toThrow("a reason is required; write in the reason field why");
    const w = working("dev1", ["tl"]);
    ops.submit(w, "dev1", S);
    expect(() => ops.requestChanges(w, [" "], "tl")).toThrow("findings must not be empty; write one problem per item in findings, or approve");
    expect(() => ops.assign(w, "tl", "user")).toThrow("tl cannot review its own ticket; choose another reviewer");
  });
  it("errors say how to fix them: links", () => {
    milestones(2);
    const [a, b] = [mk({ title: "A", status: "todo", milestone: "M1" }), mk({ title: "B", status: "todo", milestone: "M0" })];
    expect(() => ops.link(a, b, "blocks", "sa")).toThrow(`${a} is in a later milestone (M1) than ${b} (M0). A ticket cannot wait for a later milestone; drop the link or ask PM to move a ticket`);
    ops.link(b, a, "blocks", "sa");
    const c = mk({ title: "C", status: "todo", milestone: "M1" });
    ops.link(a, c, "blocks", "sa");
    expect(() => ops.link(c, b, "blocks", "sa")).toThrow(`${c} blocks ${b} would make a cycle; drop one of the links`);
    const plan = mk({ title: "Plan", kind: "breakdown", status: "in_progress", milestone: "M1", assignee: "tl" });
    expect(() => ops.setDependencies({ [a]: [c], [c]: [a] }, "tl", plan)).toThrow("the dependencies make a cycle; drop one of the links");
    expect(() => ops.setDependencies({ [a]: [b] }, "tl", plan)).toThrow(`${b} is not a ticket of M1; use only tickets of M1 (ticket_list milestone M1)`);
    expect(() => ops.setDependencies({}, "tl", a)).toThrow(`${a} is not a breakdown ticket; this works only in a breakdown session`);
    const p = working("dev1"), s = mk({ title: "S", parent: p }, "dev1");
    expect(() => ops.create({ title: "T", parent: s }, "dev1")).toThrow(`${s} is a sub-ticket; a sub-ticket has no sub-tickets. Create a Triage ticket with ticket_create instead`);
  });
  it("errors say how to fix them: status guards", () => {
    const w = working("dev1", ["tl"]);
    expect(() => ops.approve(w, "tl")).toThrow(`${w} is in_progress; only a in_review ticket can be approved. Its assignee works on it; end the session.`);
    ops.submit(w, "dev1", S);
    expect(() => ops.submit(w, "dev1", S)).toThrow(`${w} is in_review; only a in_progress ticket can be submitted. It waits for its reviewers; end the session.`);
    const a = mk({ title: "A" }), b = mk({ title: "B", status: "todo" });
    expect(() => ops.start(a, "org")).toThrow(`${a} is triage; only a todo ticket can be started. PM decides on it first.`);
    expect(() => ops.accept(b, "pm", ACC)).toThrow(`${b} is todo; only a triage ticket can be accepted. It waits until the system starts it.`);
    ops.cancel(b, "no", "pm");
    expect(() => ops.reject(b, "no", "pm")).toThrow(`${b} is canceled; only a triage ticket can be rejected. It is closed; create a new ticket with ticket_create.`);
    const q = mk({ title: "Q", status: "needs_reply", assignee: "tl" });
    expect(() => ops.submit(q, "tl", S)).toThrow(`${q} is needs_reply; only a in_progress ticket can be submitted. It waits for an answer; end the session.`);
  });
});
