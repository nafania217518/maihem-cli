import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrgTools, fileToolsFor, STOP_TOOLS, stopTools } from "../src/org/tools.ts";
import { validateOrg } from "../src/org/config.ts";
import { milestoneDiff, tag } from "../src/org/git.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import type { Role, TicketKind } from "../src/org/types.ts";

const m = (role: string, reports_to?: string) => ({ role, definition: "d", ...(reports_to ? { reports_to } : {}) });
const org = validateOrg({ name: "x", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev") } });
const opts = { toolCallId: "1", messages: [] } as never;
type Tools = Record<string, unknown>;
const call = async (tools: Tools, name: string, input: unknown = {}) => {
  if (!tools[name]) throw new Error(`no tool ${name}`);
  return String(await (tools[name] as { execute: (i: unknown, o: unknown) => unknown }).execute(input, opts));
};

let dir: string, t: Tracker;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "otools-")); t = openTracker(join(dir, "org.db")); });
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const as = (member: string, kind: "work" | "review" | "reply" | "triage" = "work", ticket = "T-1", files?: () => string[], batch?: string[]): Tools =>
  createOrgTools(t, member, org, { ticket, kind, diff: (id) => `+diff of ${id}`, files, batch });
// T-1 in M0, in progress, assigned to `assignee`
const working = (assignee = "dev", reviewers: string[] = []) => {
  if (!t.listMilestones().length) t.createMilestone("Start", "", "org");
  const tk = t.createTicket({ title: "Build A", description: "do A", status: "in_progress", assignee, milestone: "M0" }, "org");
  for (const r of reviewers) t.setApproval(tk.id, r, "pending", "org");
  return tk.id;
};
// a system ticket of a kind in M0, in progress, assigned to `assignee`
const sys = (kind: TicketKind, assignee: string) => {
  if (!t.listMilestones().length) t.createMilestone("Start", "", "org");
  return t.createTicket({ title: kind, status: "in_progress", assignee, milestone: "M0", kind }, "org").id;
};
const MS = ["milestone_create", "milestone_update", "milestone_reorder", "milestone_delete"];
const SUM = { summary: "did it" };

const COMMON = ["ticket_get", "ticket_list", "milestone_list"];
const WORK = [...COMMON, "ticket_create", "subticket_create", "submit_review", "ask"];
const EXTRA: Record<Role, string[]> = { ba: [], sa: [], pm: [], tl: [], dev: [] }; // an SA work session has only its file tools

describe("org tools: sets", () => {
  it("the SA summary work can file a ticket", async () => {
    const s = sys("summary", "sa");
    const sa = createOrgTools(t, "sa", org, { ticket: s, kind: "work" });
    expect(await call(sa, "ticket_create", { title: "Untrack todo.db", description: "remove it from git" })).toBe("created T-2 in triage");
  });
  it.each(Object.entries(EXTRA))("a work session of each role gets exactly its tools (%s)", (role, extra) => {
    working(role);
    const work = role === "pm" ? WORK.filter((x) => !["ticket_create", "subticket_create"].includes(x)) : WORK;
    expect(Object.keys(as(role)).sort()).toEqual([...work, ...extra].sort());
  });
  it("a triage ask does not end the session", async () => {
    expect(stopTools("triage")).not.toContain("ask");
    expect(stopTools("work")).toEqual(STOP_TOOLS);
    t.createTicket({ title: "Idea", status: "triage" }, "tl"); // T-1
    t.createTicket({ title: "Other", status: "triage" }, "tl"); // T-2
    const pm = as("pm", "triage", "", undefined, ["T-1"]);
    expect(await call(pm, "ask", { id: "T-2", to: "tl", question: "q" })).toBe("error: T-2 is not in this triage batch");
    expect(await call(pm, "ask", { id: "T-1", to: "tl", question: "how big?" })).toContain("asked tl on T-1");
  });
  it("a triage session's tools accept only the batch's tickets", async () => {
    working("dev");
    for (const title of ["A", "B", "C", "D"]) t.createTicket({ title }, "dev");
    const pm = as("pm", "triage", "", undefined, ["T-2", "T-3", "T-4"]);
    expect(Object.keys(pm).sort()).toEqual([...COMMON, "accept", "reject", "duplicate", "ask"].sort());
    expect(fileToolsFor("pm", "triage", ["read", "write", "edit", "list", "exec"])).toEqual([]);
    expect(await call(pm, "accept", { id: "T-5", milestone: "M0", assignee: "dev" })).toBe("error: T-5 is not in this triage batch");
    expect(await call(pm, "reject", { id: "T-5", reason: "no" })).toBe("error: T-5 is not in this triage batch");
    expect(await call(pm, "duplicate", { id: "T-5", of: "T-2" })).toBe("error: T-5 is not in this triage batch");
    expect(await call(pm, "accept", { id: "T-2", milestone: "M0", assignee: "dev" })).toBe("accepted T-2: todo in M0 for dev, reviewed by tl");
    expect(await call(pm, "reject", { id: "T-3", reason: "no" })).toBe("rejected T-3");
    expect(await call(pm, "duplicate", { id: "T-4", of: "T-2" })).toBe("marked T-4 as a duplicate of T-2");
    expect(t.getTicket("T-5").status).toBe("triage");
  });
  it("milestone tools exist only in a PM session on a roadmap ticket", async () => {
    const road = sys("roadmap", "pm"), normal = working("pm"), ba = sys("roadmap", "ba"), reqs = sys("requirements", "ba");
    for (const x of MS) expect(as("pm", "work", road)).toHaveProperty(x);
    for (const [m, tk, kind] of [["pm", normal, "work"], ["pm", road, "review"], ["pm", road, "reply"], ["ba", ba, "work"], ["ba", reqs, "work"], ["pm", "", "triage"]] as const) for (const x of MS) expect(as(m, kind, tk)).not.toHaveProperty(x);
    const pm = as("pm", "work", road);
    expect(await call(pm, "milestone_create", { name: "MVP", description: "first" })).toBe("created milestone M1");
    expect(await call(pm, "milestone_update", { id: "M1", name: "Beta" })).toBe("updated M1");
    expect(await call(pm, "milestone_update", { id: "M1", description: "BR-6" })).toBe("updated M1");
    expect(await call(pm, "milestone_reorder", { ids: ["M1", "M0"] })).toBe("milestones: M1, M0");
    expect(await call(pm, "milestone_delete", { id: "M1" })).toBe("deleted milestone M1");
  });
  it("the ask tool says an answer cannot run commands", () => {
    const line = "An answer cannot run commands. Do not ask others to run anything; run it yourself, or ask for a decision.";
    expect((as("dev", "work", working()).ask as { description: string }).description).toContain(line);
    expect((as("pm", "triage", "T-1", undefined, ["T-1"]).ask as { description: string }).description).toContain(line);
  });
  it("the breakdown ticket_create description names no reviewers", () => {
    const tl = as("tl", "work", sys("breakdown", "tl"));
    expect((tl.ticket_create as { description: string }).description).not.toContain("reviewers");
  });
  it("TL creates, edits, drops tickets and sets dependencies only on a breakdown ticket", async () => {
    const bd = sys("breakdown", "tl"), normal = working("tl"), pmRoad = sys("roadmap", "pm");
    const tl = as("tl", "work", bd);
    const shape = (tools: Tools) => Object.keys((tools.ticket_create as { inputSchema: { shape: object } }).inputSchema.shape);
    expect(shape(tl)).not.toContain("reviewers");
    expect(shape(tl)).not.toContain("assignee");
    expect(await call(tl, "ticket_create", { title: "Login", description: "AC: works" })).toBe("created T-4 in triage");
    expect(t.getTicket("T-4")).toMatchObject({ milestone: "M0", approvals: [] });
    expect(t.blockers("T-4").map((x) => x.id)).toEqual([bd]);
    await call(tl, "ticket_create", { title: "Api", description: "AC" });
    expect(await call(tl, "set_dependencies", { dependencies: { "T-5": ["T-4"] } })).toBe("dependencies set: T-5 after T-4");
    expect(await call(tl, "set_dependencies", { dependencies: { "T-4": ["T-5"], "T-5": ["T-4"] } })).toMatch(/^error: the dependencies make a cycle; drop one of the links/);
    expect(await call(tl, "ticket_edit", { id: "T-4", description: "AC: works fast" })).toBe("edited T-4");
    expect(await call(tl, "ticket_drop", { id: "T-5" })).toBe("dropped T-5");
    expect(await call(tl, "ticket_drop", { id: normal })).toMatch(/^error: T-2 is not a Triage ticket of T-1/);
    for (const [m, tk] of [["tl", normal], ["pm", pmRoad]] as const) for (const x of ["set_dependencies", "ticket_edit", "ticket_drop"]) expect(as(m, "work", tk)).not.toHaveProperty(x);
    expect(as("tl", "review", bd)).not.toHaveProperty("set_dependencies");
  });
  it("PM creates no tickets, except defects when it reviews an acceptance ticket", async () => {
    const road = sys("roadmap", "pm"), normal = working("pm"), acc = sys("acceptance", "tl");
    for (const tk of [road, normal]) for (const x of ["ticket_create", "subticket_create"]) expect(as("pm", "work", tk)).not.toHaveProperty(x);
    const review = as("pm", "review", acc);
    expect(review).not.toHaveProperty("subticket_create");
    expect(await call(review, "ticket_create", { title: "Login fails", description: "steps: log in" })).toBe("created T-4 in triage");
    for (const [m, tk] of [["pm", normal], ["tl", acc]] as const) expect(as(m, "review", tk)).not.toHaveProperty("ticket_create");
  });
  it("the SA final review files defects with ticket_create", async () => {
    const fin = sys("final", "ba"), normal = working("dev"), sum = sys("summary", "sa");
    const review = as("sa", "review", fin);
    expect((review.ticket_create as { description: string }).description).toBe("Create a defect ticket (label bug) with the steps to reproduce. It goes to Triage.");
    expect(await call(review, "ticket_create", { title: "Login fails", description: "steps: log in" })).toMatch(/^created T-\d+ in triage$/);
    for (const [m, tk] of [["tl", normal], ["ba", sum]] as const) expect(as(m, "review", tk)).not.toHaveProperty("ticket_create");
  });
  it("a defect ticket is always labeled bug", async () => {
    const r = await call(as("sa", "review", sys("final", "ba")), "ticket_create", { title: "Crash", description: "steps", label: "other" });
    expect(t.getTicket(r.match(/T-\d+/)![0]).label).toBe("bug");
  });
  it("a PM work session has no edit_description or link_related", () => {
    const road = sys("roadmap", "pm");
    for (const x of ["edit_description", "link_related"]) { expect(as("pm", "work", road)).not.toHaveProperty(x); }
  });
  it("a BA work session has no edit_description or link_related", () => {
    for (const x of ["edit_description", "link_related"]) expect(as("ba", "work", working("ba"))).not.toHaveProperty(x);
  });
  it("DEV and TL work sessions have no edit_description and no link_related", () => {
    for (const r of ["dev", "tl"]) for (const x of ["edit_description", "link_related"]) expect(as(r, "work", working(r))).not.toHaveProperty(x);
    for (const x of ["edit_description", "link_related"]) expect(as("tl", "work", sys("breakdown", "tl"))).not.toHaveProperty(x);
  });
  it("milestone names are short and carry no id", () => {
    const pm = as("pm", "work", sys("roadmap", "pm")) as Record<string, { description: string }>;
    for (const x of ["milestone_create", "milestone_update"]) expect(pm[x].description).toContain("a short name (two to four words) without the milestone id");
  });
  it("a ticket with a parent gets no subticket_create", () => {
    const p = working("dev"), kid = t.createTicket({ title: "Part", status: "in_progress", assignee: "dev", milestone: "M0", parent: p }, "org").id;
    expect(as("dev", "work", kid)).not.toHaveProperty("subticket_create");
    expect(as("dev", "work", p)).toHaveProperty("subticket_create");
  });
  it("milestone_diff exists only on acceptance and summary tickets for TL and SA", () => {
    const acc = sys("acceptance", "tl"), sum = sys("summary", "sa"), fin = sys("final", "ba"), normal = working("tl");
    for (const [mem, tk, kind] of [["tl", acc, "work"], ["sa", sum, "work"], ["tl", sum, "review"], ["sa", acc, "review"]] as const) expect(as(mem, kind, tk)).toHaveProperty("milestone_diff");
    for (const [mem, tk, kind] of [["pm", acc, "review"], ["ba", sum, "review"], ["dev", acc, "work"], ["tl", normal, "work"], ["tl", normal, "review"], ["sa", fin, "review"], ["tl", acc, "reply"], ["pm", "", "triage"]] as const)
      expect(as(mem, kind, tk)).not.toHaveProperty("milestone_diff");
  });
  it("milestone_diff shows the diff from the previous milestone tag, capped, optionally for one path", async () => {
    const r = join(dir, "repo"), fw = (f: string, body: string) => { mkdirSync(join(r, f, ".."), { recursive: true }); writeFileSync(join(r, f), body); };
    mkdirSync(r);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", ...a], { cwd: r, encoding: "utf8" });
    const commit = (m: string) => { g("add", "-A"); g("commit", "-qm", m); };
    g("init", "-q", "-b", "main");
    fw("old.txt", "old"); commit("old");
    tag(r, "main", "M0", "M0 Start");
    fw("a.txt", "x\n".repeat(25_000)); fw("src/b.txt", "b\n"); commit("a and b");
    const first = sys("acceptance", "tl");
    t.createMilestone("Core", "", "org"); t.createMilestone("Polish", "", "org");
    const acc = t.createTicket({ title: "Accept Polish", status: "in_progress", assignee: "tl", milestone: "M2", kind: "acceptance" }, "org").id;
    const md = (tk: string, input = {}) => call(createOrgTools(t, "tl", org, { ticket: tk, kind: "work", milestoneDiff: (tags, p) => milestoneDiff(r, "main", tags, p) }), "milestone_diff", input);
    const all = await md(acc); // M1 has no tag: the diff starts at M0
    expect(all).toMatch(/a\.txt[^]*src\/b\.txt/);
    expect(all).not.toContain("old.txt");
    expect(all.endsWith("\n… truncated; read the files you need")).toBe(true);
    expect(all.length).toBeLessThanOrEqual(40_000 + "\n… truncated; read the files you need".length);
    const one = await md(acc, { path: "src" });
    expect(one).toContain("+b");
    expect(one).not.toContain("a.txt");
    tag(r, "main", "M1", "M1 Core");
    fw("c.txt", "c\n"); commit("c");
    expect(await md(acc)).toMatch(/c\.txt/);
    expect(await md(acc)).not.toContain("a.txt");
    expect(await md(first)).toMatch(/^No earlier milestone tag/);
  });
  it("each session kind gets only its transition tools", () => {
    working();
    for (const r of ["ba", "sa", "pm", "tl", "dev"]) {
      expect(Object.keys(as(r, "review")).sort()).toEqual([...COMMON, "review_diff", "approve", "request_changes", "ask"].sort());
      expect(Object.keys(as(r, "reply")).sort()).toEqual([...COMMON, "answer", ...(r === "dev" ? [] : ["forward"])].sort());
    }
  });
  it("a DEV reply has no forward", () => {
    working();
    expect(Object.keys(as("dev", "reply"))).toContain("answer");
    expect(Object.keys(as("dev", "reply"))).not.toContain("forward");
    for (const r of ["ba", "sa", "pm", "tl"]) expect(Object.keys(as(r, "reply"))).toContain("forward");
  });
  it("review_diff exists only in reviews of tickets with a diff", () => {
    t.createMilestone("Start", "", "org");
    const kinds = ["normal", "requirements", "roadmap", "breakdown", "acceptance", "summary", "final"] as const;
    for (const kind of kinds) {
      const tk = t.createTicket({ title: kind, kind, status: "in_review", assignee: "tl", milestone: "M0" }, "org");
      expect("review_diff" in as("sa", "review", tk.id), kind).toBe(["normal", "requirements", "summary"].includes(kind));
    }
  });
  it("the stop tools end the session", () => {
    expect(STOP_TOOLS).toEqual(["submit_review", "ask", "answer", "forward", "approve", "request_changes"]);
  });
  it("an SA work session has only its file tools", () => {
    const all = ["read", "write", "edit", "list", "exec"];
    expect(fileToolsFor("sa", "work", all, "normal", true)).toEqual(["read", "write", "edit", "list"]);
    expect(fileToolsFor("sa", "work", all, "breakdown", false)).toEqual(all);
  });
  it("an SA summary session keeps exec", () => {
    expect(fileToolsFor("sa", "work", ["read", "write", "edit", "list", "exec"], "summary")).toEqual(["read", "write", "edit", "list", "exec"]);
  });
  it("a review of a requirements ticket has no exec", () => {
    for (const r of ["sa", "tl", "dev"] as const) expect(fileToolsFor(r, "review", ["read", "list", "exec"], "normal", true)).toEqual(["read", "list"]);
    expect(fileToolsFor("tl", "review", ["read", "list", "exec"], "normal", false)).toEqual(["read", "list", "exec"]);
  });
  it("a review of a summary ticket has no exec", () => {
    for (const r of ["tl", "sa"] as const) expect(fileToolsFor(r, "review", ["read", "list", "exec"], "summary")).toEqual(["read", "list"]);
  });
  it("a review of a breakdown ticket has no exec", () => {
    for (const r of ["sa", "tl"] as const) expect(fileToolsFor(r, "review", ["read", "list", "exec"], "breakdown")).toEqual(["read", "list"]);
  });
  it("a breakdown work session has no exec", () => {
    expect(fileToolsFor("tl", "work", ["read", "write", "edit", "list", "exec"], "breakdown")).toEqual(["read", "list"]);
  });
  it("a review of a roadmap ticket has no file tools", () => {
    for (const r of ["ba", "tl"] as const) expect(fileToolsFor(r, "review", ["read", "write", "edit", "list", "exec"], "roadmap")).toEqual([]);
  });
  it("file tools follow the role: PM none, TL read-only, BA and SA write documents", () => {
    const all = ["read", "write", "edit", "list", "exec"];
    expect(fileToolsFor("pm", "work", all, "roadmap")).toEqual([]);
    expect(fileToolsFor("tl", "work", all, "breakdown")).toEqual(["read", "list"]);
    expect(fileToolsFor("tl", "work", all, "acceptance")).toEqual(["read", "list", "exec"]);
    expect(fileToolsFor("ba", "work", all)).toEqual(["read", "write", "edit", "list"]);
    expect(fileToolsFor("sa", "work", all)).toEqual(all);
    expect(fileToolsFor("dev", "work", all)).toEqual(all);
    expect(fileToolsFor("dev", "work", ["read"])).toEqual(["read"]);
    for (const k of ["review", "reply", "triage"] as const) {
      expect(fileToolsFor("dev", k, all)).toEqual(k === "reply" ? ["read", "list"] : ["read", "list", "exec"]);
      expect(fileToolsFor("sa", k, all)).toEqual(k === "reply" ? ["read", "list"] : ["read", "list", "exec"]);
      expect(fileToolsFor("ba", k, all)).toEqual(["read", "list"]);
      expect(fileToolsFor("pm", k, all)).toEqual([]);
    }
  });
  it("a reply session has no exec", () => {
    const all = ["read", "write", "edit", "list", "exec"];
    for (const r of ["dev", "sa", "tl", "ba"] as const) expect(fileToolsFor(r, "reply", all)).toEqual(["read", "list"]);
    expect(fileToolsFor("pm", "reply", all)).toEqual([]);
  });
});

describe("org tools: calls", () => {
  it("a tool returns the op's error text instead of throwing", async () => {
    working();
    expect(await call(as("tl", "review"), "approve")).toMatch(/^error: T-1 is in_progress; only a in_review ticket can be approved\. .*end the session/);
    expect(await call(as("dev"), "ticket_get", { id: "T-9" })).toMatch(/^error: no such ticket: T-9; use ticket_list/);
  });
  it("submit_review passes the changed files", async () => {
    working("dev", ["tl"]);
    expect(await call(as("dev", "work", "T-1", () => ["docs/business-requirements.md", "src/a.ts"]), "submit_review", SUM)).toBe("error: docs/business-requirements.md belongs to BA; revert your change to it");
    expect(await call(as("dev", "work", "T-1", () => ["docs/notes.md", "src/a.ts"]), "submit_review", SUM)).toBe("submitted T-1 for review by tl");
    expect(t.getTicket("T-1").status).toBe("in_review");
  });
  it("submit_review passes the summary sizes", async () => {
    working("ba", ["sa"]);
    const ba = createOrgTools(t, "ba", org, { ticket: "T-1", kind: "work", files: () => ["docs/business-summary.txt"], size: () => 4001 });
    expect(await call(ba, "submit_review", SUM)).toBe("error: docs/business-summary.txt has 4001 characters; the cap is 4000. Shorten it.");
  });
  it("submit takes a work summary of any length", async () => {
    working("dev", ["tl"]);
    const dev = as("dev");
    expect((dev.submit_review as { inputSchema: { shape: { summary: { description: string } } } }).inputSchema.shape.summary.description).toBe("One or two sentences on what changed; not the whole work. Acceptance and final reviews keep the compact verdict per BR.");
    expect(await call(dev, "submit_review", { summary: "" })).toBe("error: summary is required: what you did, what you used, what you decided");
    expect(await call(dev, "submit_review", { summary: "Added src/a.ts with parse(); used node:fs." + "x".repeat(1500) })).toBe("submitted T-1 for review by tl");
    t.setSummary("T-1", "Added src/a.ts with parse(); used node:fs.", "org");
    expect(await call(dev, "ticket_get", { id: "T-1" })).toContain("Summary of the work:\nAdded src/a.ts with parse(); used node:fs.");
  });
  it("submit_review refuses an empty directory", async () => {
    working("dev", ["tl"]);
    let merges = 0, dirs = ["tests/"];
    const dev = createOrgTools(t, "dev", org, { ticket: "T-1", kind: "work", emptyDirs: () => dirs, merge: () => { merges++; return { ok: true as const }; } });
    expect(await call(dev, "submit_review", SUM)).toBe("error: tests/ is empty, and git does not store empty directories. Add a file, for example tests/__init__.py.");
    dirs = ["src/x/", "tests/"];
    expect(await call(dev, "submit_review", SUM)).toBe("error: src/x/, tests/ are empty, and git does not store empty directories. Add a file to each, for example src/x/__init__.py.");
    expect(merges).toBe(0);
    expect(t.getTicket("T-1").status).toBe("in_progress");
    dirs = [];
    expect(await call(dev, "submit_review", SUM)).toBe("submitted T-1 for review by tl");
  });
  it("submit_review works without a files callback", async () => {
    working("dev", ["tl"]);
    expect(await call(as("dev"), "submit_review", SUM)).toBe("submitted T-1 for review by tl");
  });
  it("submit_review merges main first and on a conflict leaves a note", async () => {
    working("dev", ["tl"]);
    let merges = 0;
    const merge = () => { merges++; return { ok: false as const, conflicts: ["a.ts", "b.ts"], commits: ["abc123 T-2: x"] }; };
    const dev = createOrgTools(t, "dev", org, { ticket: "T-1", kind: "work", merge });
    expect(await call(dev, "submit_review", SUM)).toBe("error: merge from main conflicts in a.ts, b.ts; resolve the markers first");
    expect(merges).toBe(1);
    expect(t.getTicket("T-1")).toMatchObject({ status: "in_progress", comments: [{ author: "org", text: "main changed a.ts, b.ts since your branch; MAIHEM merges main into your branch at your next session" }] });
    const clean = createOrgTools(t, "dev", org, { ticket: "T-1", kind: "work", merge: () => ({ ok: true as const }) });
    expect(await call(clean, "submit_review", SUM)).toBe("submitted T-1 for review by tl");
  });
  it("ticket_get shows the ticket view", async () => {
    working();
    const g = await call(as("dev"), "ticket_get", { id: "T-1" });
    expect(g).toContain("T-1 [in_progress] Build A");
    expect(g).toContain("do A");
  });
  it("ticket_list filters by status, milestone and mine", async () => {
    working();
    t.createTicket({ title: "Idea" }, "tl");
    const tools = as("dev");
    expect(await call(tools, "ticket_list")).toBe("T-1 [in_progress] Build A (assignee: dev, M0)\nT-2 [triage] Idea");
    expect(await call(tools, "ticket_list", { status: "triage" })).toBe("T-2 [triage] Idea");
    expect(await call(tools, "ticket_list", { milestone: "M0" })).toContain("T-1");
    expect(await call(tools, "ticket_list", { mine: true })).not.toContain("T-2");
    expect(await call(as("ba"), "ticket_list", { mine: true })).toBe("no tickets");
  });
  it("milestone_list shows completion and the active milestone", async () => {
    working();
    t.createMilestone("Next", "the rest", "org");
    expect(await call(as("dev"), "milestone_list")).toBe("M0 Start: 50% (active)\nM1 Next: 0% - the rest");
    t.deleteMilestone("M0", "org"); t.deleteMilestone("M1", "org");
    expect(await call(as("dev"), "milestone_list")).toBe("no milestones");
  });
  it("ask, forward and answer move the question with the member as actor", async () => {
    working();
    expect(await call(as("dev"), "ask", { to: "sa", question: "which db?" })).toBe("error: dev cannot ask sa; ask tl");
    expect(await call(as("dev"), "ask", { to: "tl", question: "which db?" })).toMatch(/^asked tl on T-1/);
    expect(await call(as("tl", "reply"), "forward", { to: "sa" })).toBe("forwarded T-1 to sa");
    expect(await call(as("sa", "reply"), "answer", { text: "postgres" })).toBe("answered T-1; it is in_progress again");
    expect(t.getTicket("T-1")).toMatchObject({ status: "in_progress", assignee: "dev" });
    expect(await call(as("dev"), "ticket_get", { id: "T-1" })).toContain("Comments:\ndev asks tl: which db?\ntl forwards to sa\nsa answers: postgres");
  });
  it("work tools create tickets and sub-tickets", async () => {
    working();
    const dev = as("dev");
    expect(await call(dev, "ticket_create", { title: "Bug", description: "it breaks", label: "bug", priority: 2 })).toBe("created T-2 in triage");
    expect(t.getTicket("T-2")).toMatchObject({ owner: "dev", label: "bug", priority: 2, description: "it breaks" });
    expect(await call(dev, "subticket_create", { title: "Part", description: "half" })).toBe("created T-3 in todo");
    expect(t.getTicket("T-3")).toMatchObject({ parent: "T-1", assignee: "dev", milestone: "M0" });
  });
  it("review_diff shows the ticket and the diff; approve and request_changes decide", async () => {
    working("dev", ["tl", "sa"]);
    t.setStatus("T-1", "in_review", "dev");
    const diff = await call(as("tl", "review"), "review_diff");
    expect(diff).toContain("do A");
    expect(diff).toContain("+diff of T-1");
    expect(await call(as("sa", "review"), "approve")).toBe("approved T-1");
    expect(await call(as("tl", "review"), "request_changes", { findings: ["add a test", "rename x"] })).toBe("requested changes on T-1: 2 findings");
    expect(t.getTicket("T-1").status).toBe("in_progress");
  });
  it("the review shows the summary next to the diff and the rules say to check it", async () => {
    working("dev", ["tl"]);
    await call(as("dev"), "submit_review", { summary: "Added src/a.ts; chose argparse." });
    expect(await call(as("tl", "review"), "review_diff")).toMatch(/Summary of the work:\nAdded src\/a.ts; chose argparse.\n[^]*\+diff of T-1/);
  });
  it("review_diff says when there is no diff function", async () => {
    working("dev", ["tl"]);
    expect(await call(createOrgTools(t, "tl", org, { ticket: "T-1", kind: "review" }), "review_diff")).toContain("(no diff)");
  });
});

describe("org tools: dirty worktree guard", () => {
  const guarded = (member: string, kind: "work" | "review" | "reply" | "triage", changes: string[]) => {
    const log: string[] = [];
    const tools = createOrgTools(t, member, org, { ticket: kind === "triage" ? "" : "T-1", kind, batch: [], dirty: async () => changes, discard: async () => { log.push("discard"); changes.length = 0; } });
    return { tools, log };
  };
  it("a stop tool in a session without write tools refuses once when the worktree has changes", async () => {
    working("dev", ["tl"]);
    t.setStatus("T-1", "in_review", "org");
    const { tools, log } = guarded("tl", "review", ["src/a.ts", "x.db"]);
    expect(await call(tools, "approve")).toBe("error: your worktree has changes (src/a.ts, x.db); your role does not change files. Call again to discard them and go on.");
    expect(log).toEqual([]);
    expect(t.getTicket("T-1").status).toBe("in_review");
    // a DEV work session writes files: no guard
    const w = sys("normal", "dev");
    const dev = createOrgTools(t, "dev", org, { ticket: w, kind: "work", dirty: async () => ["src/b.ts"], discard: async () => { throw new Error("no"); } });
    t.setApproval(w, "tl", "pending", "org");
    expect(await call(dev, "submit_review", SUM)).toBe(`submitted ${w} for review by tl`);
    // a clean worktree: no guard
    const clean = guarded("tl", "review", []);
    expect(await call(clean.tools, "approve")).toBe("approved T-1");
  });
  it("the second stop call discards the changes and goes on", async () => {
    working("dev", ["tl"]);
    t.setStatus("T-1", "in_review", "org");
    const { tools, log } = guarded("tl", "review", ["src/a.ts"]);
    await call(tools, "request_changes", { findings: ["f"] });
    expect(await call(tools, "request_changes", { findings: ["f"] })).toBe("requested changes on T-1: 1 findings");
    expect(log).toEqual(["discard"]);
  });
});

describe("org tools: final acceptance", () => {
  it("a final acceptance session has no write or edit tools and no file rules", () => {
    const all = ["read", "write", "edit", "list", "exec"];
    expect(fileToolsFor("ba", "work", all, "final")).toEqual(["read", "list"]);
    expect(fileToolsFor("ba", "work", all, "normal")).toEqual(["read", "write", "edit", "list"]);
  });
  it("sub-tickets only for normal tickets", () => {
    for (const k of ["final", "acceptance", "summary", "roadmap", "breakdown", "requirements"] as const) expect(as(k === "roadmap" ? "pm" : "ba", "work", sys(k, k === "roadmap" ? "pm" : "ba"))).not.toHaveProperty("subticket_create");
    expect(as("dev", "work", working("dev"))).toHaveProperty("subticket_create");
  });
});
