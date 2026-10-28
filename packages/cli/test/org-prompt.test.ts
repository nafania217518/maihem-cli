import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { systemFor, taskFor, ticketText } from "../src/org/prompt.ts";
import { FINAL } from "../src/org/flow.ts";
import { validateOrg } from "../src/org/config.ts";
import { commitAll, prepareRepo } from "../src/org/git.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import type { Definition } from "../src/definition.ts";
import type { Wake } from "../src/org/types.ts";

const m = (role: string, reports_to?: string, definition = "d") => ({ role, definition, ...(reports_to ? { reports_to } : {}) });
const org = validateOrg({ name: "acme", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev", undefined, "coder"), dev2: m("dev") } });
const defs = { d: { name: "d", system: "Be terse." }, coder: { name: "coder", system: "You write TypeScript.", description: "a TypeScript developer", tools: ["read", "write", "edit"] } } as unknown as Record<string, Definition>;
const sys = (member: string, kind: Wake["kind"] = "work") => systemFor({ org, member, goal: "Build a todo app", defs, kind });
const DOCS = {
  "docs/business-requirements.md": "BR-1 users import CSV",
  "docs/business-summary.txt": "BUSINESS SUMMARY",
  "docs/technical-requirements.md": "TR-1 python 3.12",
  "docs/tech-summary.txt": "TECH SUMMARY",
  "src/app.py": "print(1)",
};
const me = { name: "dev", email: "dev@acme" };

let dir: string, repo: string, main: string, t: Tracker;
const write = (files: Record<string, string>) => {
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), s); }
  commitAll(repo, "files", me);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
};
const task = (ticket: string, kind: Wake["kind"], member: string, batch?: string[]) => taskFor({ t, ticket, kind, member, org, repo, main, batch });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oprompt-"));
  repo = join(dir, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  main = prepareRepo(repo).main;
  t = openTracker(join(dir, "org.db"));
  t.createMilestone("Start", "", "org");
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

describe("org prompt: system", () => {
  it("a triage system prompt keeps the Questions line", () => {
    expect(sys("pm", "triage")).toContain("Questions:");
  });
  it("the role card is the same in every session kind", () => {
    const card = (s: string) => { const i = s.indexOf("# Your role"); return s.slice(i, s.indexOf("\n\n# ", i)); };
    for (const mb of ["ba", "sa", "pm", "tl", "dev", "dev2"]) {
      const w = card(sys(mb, "work"));
      for (const kind of ["review", "reply", "triage"] as const) expect(card(sys(mb, kind))).toBe(w);
    }
  });
  it("the members list leaves out the session member's own description", () => {
    expect(sys("dev")).toContain("- dev (DEV, reports to tl)\n");
    expect(sys("dev", "triage")).toContain("- dev (DEV, reports to tl)\n");
    expect(sys("tl")).toContain("- dev (DEV, reports to tl): a TypeScript developer");
  });
  it("the system prompt starts with the definition prompt and names the member, role and goal", () => {
    const s = sys("dev");
    expect(s).toContain("\n\n# Style\nYou write TypeScript.\n\n# Work");
    expect(s).toContain("You are dev, the DEV of the org \"acme\"");
    expect(s).toContain("Goal: Build a todo app");
    expect(sys("tl")).toContain("- dev (DEV, reports to tl): a TypeScript developer");
    expect(s).toContain("- ba (BA, reports to the human)");
    expect(systemFor({ org, member: "ba", goal: "g", defs: {}, kind: "work" }).split("\n\n")[1].startsWith("# Org")).toBe(true);
  });
  it("the system prompt starts with the writing rule", () => {
    const w = "# Writing\nWrite replies and documentation \"80% of the way to ASD-STE100\" (Simplified Technical English): short sentences (about 20 words max), one idea per sentence, active voice, present tense, one approved meaning per word, no idioms, no filler. Do not go full STE: keep natural phrasing and domain terms where strict STE would read awkwardly.\n\n";
    for (const m of ["ba", "sa", "pm", "tl", "dev"]) for (const kind of ["work", "review", "reply", "triage"] as const) {
      expect(systemFor({ org, member: m, goal: "g", defs, kind }).startsWith(w)).toBe(true);
      expect(systemFor({ org, member: m, goal: "g", defs: {}, kind }).startsWith(w)).toBe(true);
    }
  });
  it("the system prompt explains how MAIHEM works", () => {
    for (const m of ["ba", "sa", "pm", "tl", "dev"]) for (const kind of ["work", "review", "reply", "triage"] as const) {
      const s = systemFor({ org, member: m, goal: "g", defs, kind });
      const h = s.indexOf("\n\n# How MAIHEM works\n- MAIHEM runs this org.");
      expect(h).toBeGreaterThan(s.indexOf("# Org"));
      expect(s.indexOf("# Org")).toBeGreaterThan(-1);
      expect(s.indexOf("\n\n# Your role")).toBeGreaterThan(h);
      expect(s.slice(s.indexOf("# Org"), h)).not.toContain("\n\n");
      expect(s).toContain("- MAIHEM does these itself; never ask for them: branches, commits, merges, milestone tags, the system tickets (breakdown, acceptance, summary, final), and the blocker from a breakdown to each of its tickets.\n- The human sits above BA and SA. The human approves the requirements and the final result, and answers what the grid cannot.\n\n# Your role");
    }
  });
  it("the system prompt names the active milestone when given", () => {
    expect(systemFor({ org, member: "ba", goal: "g", defs, kind: "work", milestone: { id: "M1", name: "MVP", description: "", ord: 1 } })).toContain("Active milestone: M1 MVP");
  });
  it("the system prompt shows the grid and the document owners, but not to a DEV", () => {
    const s = sys("tl");
    expect(s).toContain("- Strategic level (the whole product): BA (business track), SA (technical track)");
    expect(s).toContain("- Project level (all milestones): PM (business track), TL (technical track)");
    expect(s).toContain("- Cycle level (one task inside a milestone): DEV (technical track)");
    expect(s).toContain("Documents: docs/business-requirements.md (BA), docs/business-summary.txt (BA), docs/technical-requirements.md (SA), docs/tech-summary.txt (SA).");
    expect(sys("dev")).not.toContain("docs/business-requirements.md");
  });
  it("the escalation line names ask and forward along the grid", () => {
    const card = (member: string) => sys(member).split("# Your role")[1];
    expect(card("ba")).toContain("BA: strategic level, business track");
    expect(card("ba")).toContain("Talks to: sa (SA), pm (PM).");
    expect(card("ba")).toContain("Questions: ask the human.\n");
    expect(card("ba")).not.toContain("Path:");
    expect(card("sa")).toContain("SA: strategic level, technical track");
    expect(card("sa")).toContain("Talks to: ba (BA), tl (TL).");
    expect(card("sa")).toContain("Questions: ask the human.\n");
    expect(card("sa")).not.toContain("Path:");
    expect(card("pm")).toContain("PM: project level, business track");
    expect(card("pm")).toContain("Talks to: ba (BA), tl (TL).");
    expect(card("pm")).toContain("Questions: business to ba (it forwards to the human); technical to tl.");
    expect(card("tl")).toContain("TL: project level, technical track");
    expect(card("tl")).toContain("Talks to: sa (SA), pm (PM), dev (DEV), dev2 (DEV).");
    expect(card("tl")).toContain("Questions: technical to sa (it forwards to the human); business to pm.");
    expect(card("dev")).toContain("DEV: cycle level, technical track");
    expect(card("dev")).toContain("Talks to: tl (TL).");
    expect(card("dev")).toContain("Questions: ask tl; it forwards along the grid: DEV → TL → SA → human.");
  });
  it("the SA card keeps only role-wide rules", () => {
    for (const x of ["Number the requirements", "Summary: ", "Write each answer of the human"]) expect(sys("sa")).not.toContain(x);
    expect(sys("sa")).toContain("Keep the summary in step with the full document. Other roles know the design only from your documents.");
    expect(sys("sa")).toContain("Ask the human before a change of the stack or of a key decision.");
    expect(sys("ba")).toContain("Owns: docs/business-requirements.md, docs/business-summary.txt and the final acceptance (the business verdict).");
    expect(sys("sa")).toContain("Owns: docs/technical-requirements.md, docs/tech-summary.txt and the repo check after each milestone (.gitignore, no runtime data).");
  });
  it("the DEV card forbids the business documents", () => {
    const s = sys("dev");
    expect(s).toContain("Never read or look for the business documents.");
  });
  it("a DEV work session says never run git once", () => {
    expect(sys("dev").split("Never run git").length - 1).toBe(1);
  });
  it("the DEV card has one question rule", () => {
    const s = sys("dev");
    expect(s).not.toContain("Ask every question to");
    expect(s).toContain("Questions: ask tl; it forwards along the grid");
  });
  it("a member with one neighbour routes the rest through it", () => {
    expect(sys("dev")).toContain("Talks to: tl (TL). Anything else goes through tl.");
    expect(sys("tl")).toContain("Anything else goes through one of them.");
  });
  it("the PM card decides Triage and never creates tickets in Triage", () => {
    const s = sys("pm");
    expect(s).toContain("Decides: Triage (accept into a milestone with an assignee, reject, duplicate) and priority.");
    expect(s).toContain("Create tickets only for defects you find in an acceptance review.");
    expect(s).toContain("technical to tl.");
  });
  it("the TL card reviews DEV tickets and never writes code", () => {
    const s = sys("tl");
    expect(s).toContain("Reviews: every DEV ticket");
    expect(s).toContain("Never write code.");
  });
  it("a work session gets the work rules", () => {
    const s = sys("dev");
    expect(s).toContain("Never run git");
    expect(s).toContain("submit_review");
    expect(s).not.toContain("escalate");
  });
  it("the work rules ask instead of threads", () => {
    const s = sys("dev");
    expect(s).toContain("When a reviewer requested changes: fix each finding from the comments, then submit.");
    expect(s).toContain("When you need an answer, ask one grid neighbour with ask; your session ends; you get the answer in the comments when the ticket comes back.");
    for (const w of ["thread", "@mention", "announce"]) expect(s).not.toContain(w);
  });
  it("the work rules say what goes in the submit summary", () => {
    expect(sys("dev")).toContain("- submit_review takes a summary: one or two sentences on the ticket's whole change on the branch and the decisions you made.");
    expect(sys("dev")).not.toContain("at most 1000 characters");
    expect(sys("dev")).toContain("- In the summary also name what you used (files, modules, commands).");
  });
  it("every work session gets the core work rules", () => {
    for (const r of ["ba", "sa", "pm", "tl", "dev", "dev2"]) {
      const s = sys(r);
      for (const l of ["- Work only on this ticket.", "- When the work is done, call submit_review.", "- submit_review takes a summary", "- When a reviewer requested changes:", "ask one grid neighbour with ask", "- Never put a question in your final text; a question goes through ask."]) expect(s).toContain(l);
    }
    expect(sys("dev2")).toContain("- A new idea or a bug: ticket_create. It goes to Triage.");
    expect(sys("pm")).not.toContain("ticket_create");
  });
  it("the file rules go only to members that can write files", () => {
    const file = ["MAIHEM creates the branch", "In the summary also name what you used", "Delete scratch files", "conflict markers"];
    for (const l of file) { expect(sys("dev")).toContain(l); expect(sys("dev2")).not.toContain(l); expect(sys("ba")).not.toContain(l); }
  });
  it("the BA card keeps only role-wide rules", () => {
    const c = sys("ba").split("# Your role")[1].split("# Work")[0];
    for (const x of ["Number the requirements", "Summary:", "Write each answer"]) expect(c).not.toContain(x);
    expect(c).toContain("Never write code, technical requirements or the tech summary. Never create milestones or assign tickets.\nKeep the summary in step with the full document. Other roles know the business only from your documents.");
  });
  it("the sub-ticket rule goes only to tickets that can have sub-tickets", () => {
    for (const r of ["ba", "sa", "tl", "dev", "pm"]) expect(sys(r)).not.toContain("subticket_create");
    t.createTicket({ title: "Login", status: "in_progress", assignee: "dev", milestone: "M0" }, "org");
    t.createTicket({ title: "Part", status: "in_progress", assignee: "dev", milestone: "M0", parent: "T-1" }, "org");
    t.createTicket({ title: "Plan", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    const rule = "Split big work into sub-tickets with subticket_create.";
    expect(task("T-1", "work", "dev")).toContain(rule);
    expect(task("T-2", "work", "dev")).not.toContain(rule);
    expect(task("T-3", "work", "pm")).not.toContain(rule);
    expect(task("T-1", "review", "tl")).not.toContain(rule);
  });
  it("the conflict rule asks for checks only with exec", () => {
    const d = { ...defs, ex: { name: "ex", tools: ["read", "write", "exec"] } } as unknown as Record<string, Definition>;
    const o = validateOrg({ name: "acme", repo: "r", members: { ba: m("ba", undefined, "ex"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev", undefined, "ex") } });
    const f = (member: string) => systemFor({ org: o, member, goal: "g", defs: d, kind: "work" });
    expect(f("dev")).toContain("- When a comment lists files with conflict markers: resolve the markers in those files, run the checks, then submit.");
    expect(f("ba")).toContain("- When a comment lists files with conflict markers: resolve the markers in those files, then submit. MAIHEM merges main for you.");
  });
  it("a session that writes and runs gets the run-the-checks rule", () => {
    const d = { ...defs, ex: { name: "ex", tools: ["read", "write", "exec"] } } as unknown as Record<string, Definition>;
    const o = validateOrg({ name: "acme", repo: "r", members: { ba: m("ba", undefined, "ex"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev", undefined, "ex") } });
    const f = (member: string) => systemFor({ org: o, member, goal: "g", defs: d, kind: "work" });
    expect(f("dev")).toContain("- Run the checks that the tech summary names (tests and others) before you submit.");
    expect(f("ba")).not.toContain("- Run the checks that the tech summary names (tests and others) before you submit.");
  });
  it("a review session gets the review instructions", () => {
    const s = sys("tl", "review");
    expect(s).toContain("# Review");
    expect(s).toContain("request_changes");
    expect(s).not.toContain("# Work");
  });
  it("work instructions say no stray files", () => {
    const s = sys("dev");
    expect(s).toContain("Delete scratch files (test inputs, outputs, temporary scripts) before you submit; the review rejects stray files.");
  });
  it("work instructions explain conflict markers", () => {
    expect(sys("dev")).toContain("When a comment lists files with conflict markers: resolve the markers in those files, then submit. MAIHEM merges main for you.");
  });
  it("the review instructions reject stray files", () => {
    t.createTicket({ title: "Login", status: "in_review", assignee: "dev" }, "org");
    expect(task("T-1", "review", "tl")).toContain("Request changes for stray files in the diff: test inputs, outputs, scratch scripts.");
    expect(sys("dev")).not.toContain("Request changes for stray files");
  });
  it("the review rules put findings in request_changes", () => {
    const s = sys("tl", "review");
    expect(s).toContain("- Otherwise request_changes with the findings as a numbered list, one finding per item.");
    expect(s).toContain("- Ask when you need an answer before you decide.");
  });
  it("the file work rules follow the session's real file tools", () => {
    const o = validateOrg({ name: "acme", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm", undefined, "coder"), tl: m("tl", undefined, "coder"), dev: m("dev", undefined, "coder") } });
    const f = (member: string) => systemFor({ org: o, member, goal: "g", defs, kind: "work" });
    expect(f("dev")).toContain("MAIHEM creates the branch");
    expect(f("tl")).not.toContain("MAIHEM creates the branch");
    expect(f("pm")).not.toContain("MAIHEM creates the branch");
  });
  it("every review gets the core review rules", () => {
    for (const r of ["ba", "sa", "pm", "tl", "dev"]) {
      const s = sys(r, "review");
      for (const l of ["- Check the change against the ticket and the context in your task.", "- Approve when the change does what the ticket asks.",
        "- Otherwise request_changes with the findings as a numbered list, one finding per item.", "- Ask when you need an answer before you decide."]) expect(s).toContain(l);
      expect(s).not.toContain("review_diff");
    }
  });
  it("the reply rules answer with the fewest tool calls and forward when not yours", () => {
    const s = sys("dev", "reply");
    expect(s).toContain("# Reply");
    expect(s).toContain("- Answer the question in the comments with answer.");
    expect(s).toContain("- Use the fewest tool calls. Never run git. Never look into another member's worktree.");
    expect(s).toContain("- When you cannot answer, say so with answer.");
    expect(s).not.toContain("not yours to answer");
    expect(s).not.toContain("# Review");
  });
  it("a DEV reply says to answer when it cannot", () => {
    expect(sys("dev", "reply")).toContain("- When you cannot answer, say so with answer.");
    expect(sys("dev", "reply")).not.toMatch(/\bforward\b/); // the card keeps "TL forwards along the grid"
  });
  it("the reply rules have one forward line", () => {
    for (const x of ["ba", "sa"]) expect(sys(x, "reply").match(/forward/gi)).toHaveLength(1);
    for (const x of ["ba", "sa"]) expect(sys(x, "reply")).toContain("- When you cannot answer, forward the question to the neighbour who can, or to the human.");
    for (const [x, b] of [["pm", "ba"], ["tl", "sa"]]) {
      expect(sys(x, "reply")).toContain(`- When you cannot answer, forward the question to the neighbour who can; ${b} when unsure.`);
      expect(sys(x, "reply")).not.toContain("the human.");
    }
  });
  it("the git and worktree reply rule goes only to members with file tools", () => {
    expect(sys("dev", "reply")).toContain("Never run git. Never look into another member's worktree.");
    for (const x of ["pm", "ba"]) {
      expect(sys(x, "reply")).toContain("- Use the fewest tool calls.\n");
      expect(sys(x, "reply")).not.toContain("Never run git");
    }
  });
  it("the PM card names the triage decisions", () => {
    expect(sys("pm")).toContain("Decides: Triage (accept into a milestone with an assignee, reject, duplicate) and priority.");
  });
  it("a triage system prompt has the members but not the grid or the documents", () => {
    const s = sys("pm", "triage");
    expect(s).toContain('You are pm, the PM of the org "acme".');
    expect(s).toContain("Goal: Build a todo app");
    expect(s).toContain("- tl (TL, reports to");
    expect(s).not.toContain("The grid:");
    expect(s).not.toContain("level (");
    expect(s).not.toContain("Documents:");
    expect(sys("tl", "review")).toContain("The grid:");
  });
  it("a triage system prompt has no active milestone line", () => {
    const ms = { id: "M0", name: "Start" } as never;
    expect(systemFor({ org, member: "pm", goal: "g", defs, kind: "triage", milestone: ms })).not.toContain("Active milestone:");
    expect(systemFor({ org, member: "tl", goal: "g", defs, kind: "work", milestone: ms })).toContain("Active milestone: M0 Start");
  });
  it("the triage rules accept, reject or mark duplicates and assign", () => {
    const s = sys("pm", "triage");
    expect(s).toContain("# Triage\nOne session triages the whole batch in the task.");
    expect(s).toContain("- accept with a milestone (the active one when it must be done now, else a later one), a priority and an assignee (a DEV, BA or SA). The system sets the reviewer by the grid.");
    expect(s).toContain("- reject with a reason, or duplicate when another ticket covers it.");
    expect(s).toContain("- Give a chain of dependent tickets to one member. Give DEV tickets to devs. Prefer the member with fewer open tickets.");
    expect(s).not.toContain("A DEV ticket's reviewer is its TL (the default).");
    expect(s).toContain("Do not create tickets.");
    expect(s).not.toContain("# Work");
  });
});

describe("org prompt: context per role", () => {
  it("a DEV task loads the tech summary and the task, not the business documents", () => {
    write(DOCS);
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Parse CSV", description: "AC: BR-1", status: "in_progress", assignee: "dev", milestone: "M1" }, "org");
    const s = task("T-1", "work", "dev");
    expect(s.startsWith("Work on T-1.")).toBe(true);
    expect(s).toContain("# Tech summary (docs/tech-summary.txt)\nTECH SUMMARY");
    expect(s).toContain("# Ticket\nT-1 [in_progress] Parse CSV");
    expect(s).toContain("# Files on main\n");
    expect(s).toContain("src/app.py");
    for (const x of ["BUSINESS SUMMARY", "BR-1 users", "TR-1 python", "business-requirements"]) expect(s).not.toContain(x);
  });
  it("a DEV task lists the unfinished tickets and its blocker outcomes", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Structure", status: "in_review", assignee: "dev", milestone: "M1" }, "org");
    t.createTicket({ title: "Parse", status: "in_progress", assignee: "dev", milestone: "M1" }, "org");
    t.createTicket({ title: "Print", status: "todo", milestone: "M1" }, "org");
    t.createTicket({ title: "Old", status: "done", assignee: "dev2", milestone: "M1" }, "org");
    t.addRelation("T-1", "T-2", "blocks", "org"); t.addRelation("T-4", "T-2", "blocks", "org");
    const sha = write({ "a.py": "a", "b.py": "b" });
    t.setMerged("T-1", sha, "org"); t.setStatus("T-1", "done", "org");
    t.setMerged("T-4", sha, "org");
    const s = task("T-2", "work", "dev");
    expect(s).toContain("# Unfinished tickets of M1\nT-3 Print [todo] @nobody");
    expect(s).not.toContain("T-4 Old [");
    expect(s).toContain("# Finished blockers\nT-1: files (a.py, b.py)\nT-4: files (a.py, b.py)");
  });
  it("the PM acceptance review does not hold the acceptance for an open defect", () => {
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "review", "pm")).toContain("An open defect does not hold the acceptance. The milestone completes only when every ticket is closed, and each defect gets its own review. Do not request changes to wait for a defect.");
  });
  it("PM loads the business requirements for roadmap, acceptance and reply", () => {
    write(DOCS);
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Login", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    const br = "# Business requirements (docs/business-requirements.md)\nBR-1 users import CSV";
    expect(task("T-1", "work", "pm")).toContain(br);
    expect(task("T-2", "review", "pm")).toContain(br);
    expect(task("", "triage", "pm", [])).not.toContain(br);
    for (const s of [task("T-3", "work", "pm"), task("", "triage", "pm", [])]) {
      expect(s).toContain("# Business summary (docs/business-summary.txt)\nBUSINESS SUMMARY");
      expect(s).not.toContain("TECH SUMMARY");
    }
  });
  it("a PM reply loads the business requirements", () => {
    write(DOCS);
    t.createTicket({ title: "Login", status: "needs_reply", assignee: "pm", milestone: "M0" }, "org");
    const s = task("T-1", "reply", "pm");
    expect(s).toContain("# Business requirements (docs/business-requirements.md)\nBR-1 users import CSV");
    expect(s).not.toContain("BUSINESS SUMMARY");
    expect(s.startsWith("Question on T-1:")).toBe(true);
  });
  it("a PM reply has no board", () => {
    t.createTicket({ title: "Login", status: "needs_reply", assignee: "pm", milestone: "M0" }, "org");
    const s = task("T-1", "reply", "pm");
    expect(s).not.toContain("# Board");
    expect(s).toContain("# Roadmap");
  });
  it("TL loads the technical requirements only for the breakdown, the acceptance and the roadmap review", () => {
    write(DOCS);
    t.createTicket({ title: "Breakdown M0", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Login", status: "in_review", assignee: "dev", milestone: "M0" }, "org");
    const tr = "# Technical requirements (docs/technical-requirements.md)\nTR-1 python 3.12";
    expect(task("T-1", "work", "tl")).toContain(tr);
    expect(task("T-2", "work", "tl")).toContain(tr);
    const s = task("T-3", "review", "tl");
    expect(s).not.toContain(tr);
    expect(s).toContain("TECH SUMMARY");
    expect(s).not.toContain("BUSINESS SUMMARY");
  });
  it("BA loads SA's documents only when it reviews SA's ticket", () => {
    write(DOCS);
    t.createTicket({ title: "Technical requirements", status: "in_review", assignee: "sa", milestone: "M0" }, "org");
    t.createTicket({ title: "Business requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Final acceptance", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    expect(task("T-1", "review", "ba")).toContain("TR-1 python");
    expect(task("T-1", "review", "ba")).toContain("TECH SUMMARY");
    const own = task("T-2", "work", "ba");
    expect(own).toContain("BR-1 users");
    expect(own).toContain("BUSINESS SUMMARY");
    expect(own).not.toContain("TR-1 python");
    expect(own).not.toContain("TECH SUMMARY");
    expect(task("T-3", "work", "ba")).not.toContain("TECH SUMMARY");
    expect(task("T-3", "work", "ba")).not.toContain("BUSINESS SUMMARY");
    expect(task("T-3", "work", "ba")).not.toContain("TR-1 python");
  });
  it("SA loads the file tree and BA's documents only when it reviews BA's ticket", () => {
    write(DOCS);
    t.createTicket({ title: "Business requirements", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Technical requirements", kind: "requirements", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain("BR-1 users");
    const own = task("T-2", "work", "sa");
    for (const x of ["BR-1 users", "TR-1 python", "TECH SUMMARY", "# Files on main", "src/app.py"]) expect(own).toContain(x);
    expect(own).not.toContain("BUSINESS SUMMARY");
  });
  it("the SA requirements task loads the business requirements", () => {
    write(DOCS);
    t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Technical requirements", parent: "T-1", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    const own = task("T-2", "work", "sa");
    expect(own).toContain("BR-1 users");
    expect(own).not.toContain("BUSINESS SUMMARY");
    expect(own).not.toContain("tools only when a detail is missing");
  });
  it("the SA writes first and asks only about blocking points", () => {
    t.createTicket({ title: "Technical requirements", kind: "requirements", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    expect(task("T-1", "work", "sa")).toContain("- Write what you can first. Ask the human only about open points that block the documents; your session ends until the answer comes. Write each answer into both files.");
  });
  it("a missing document shows as not written yet", () => {
    t.createTicket({ title: "Business requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-1", "work", "ba");
    expect(s).toContain("# Business requirements (docs/business-requirements.md)\n(not written yet)");
    expect(s).toContain("# Business summary (docs/business-summary.txt)\n(not written yet)");
  });
});

describe("org prompt: triage", () => {
  it("the triage task lists the batch with descriptions cut at 300 characters", () => {
    t.createTicket({ title: "Base", status: "triage", milestone: "M0" }, "tl"); // T-1
    t.createTicket({ title: "Crash", description: "x".repeat(299) + "yz", label: "bug", status: "triage" }, "dev"); // T-2
    t.addRelation("T-1", "T-2", "blocks", "org");
    const s = task("", "triage", "pm", ["T-1", "T-2"]);
    expect(s.startsWith("Triage batch.")).toBe(true);
    expect(s).toContain("# Batch\n- T-1 Base (label other, from tl, milestone M0): \n- T-2 Crash (label bug, from dev, blocked by T-1): " + "x".repeat(299) + "y\n");
  });
  it("the triage task shows the roadmap with the active milestone and the team load", () => {
    t.createMilestone("Core", "MVP", "org");
    t.createTicket({ title: "Parse", status: "todo", assignee: "dev", milestone: "M0" }, "org"); // T-1
    t.createTicket({ title: "Later", status: "todo", assignee: "dev", milestone: "M1" }, "org"); // T-2
    t.createTicket({ title: "New", status: "triage", milestone: "M0" }, "tl"); // T-3
    const s = task("", "triage", "pm", ["T-3"]);
    expect(s).toContain("# Roadmap\n(active) M0 Start\nM1 Core: MVP");
    expect(s).toContain("# Open tickets of the batch's milestones\n- T-1 Parse [todo] @dev\n\n");
    expect(s).toContain("# Team load\n- dev (DEV): 2 open\n- dev2 (DEV): 0 open");
  });
  it("a triage batch line shows the ticket's comments", () => {
    t.createTicket({ title: "New", description: "d", status: "triage" }, "tl");
    t.addComment("T-1", "pm asks ba: why?", "pm");
    t.addComment("T-1", "ba answers: users want it", "ba");
    expect(task("", "triage", "pm", ["T-1"])).toContain(": d\n  - pm asks ba: why?\n  - ba answers: users want it");
  });
  it("the triage task has no events", () => {
    t.createTicket({ title: "New", status: "triage" }, "tl");
    t.log("session.failed", "dev", { error: "HTTP 500" }, "T-1");
    const s = task("", "triage", "pm", ["T-1"]);
    for (const w of ["Events", "Failures", "HTTP 500", "# Board"]) expect(s).not.toContain(w);
  });
});

describe("org prompt: process per ticket kind", () => {
  it("the plan-change update task says a changed requirement gets a new id", () => {
    t.createTicket({ title: "Requirements", kind: "requirements", status: "todo", assignee: "ba", milestone: "M0" }, "org"); // T-1: the M0 gate
    t.createTicket({ title: "Business requirements", status: "in_progress", assignee: "ba", milestone: "M0", parent: "T-1" }, "org");
    t.createMilestone("Plan change 1", "", "org");
    t.createTicket({ title: "Update business requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M1" }, "org");
    t.createTicket({ title: "Update technical requirements", kind: "requirements", status: "in_progress", assignee: "sa", milestone: "M1" }, "org");
    const ba = task("T-3", "work", "ba"), sa = task("T-4", "work", "sa");
    expect(ba).toContain("Never rewrite or renumber an id. A changed requirement gets a new id; mark the old one '(replaced by BR-n)'. A defect in built code also gets a new id that states the correct behavior.");
    expect(sa).toContain("mark the old one '(replaced by TR-n)'.");
    expect(task("T-2", "work", "ba")).not.toContain("Never rewrite or renumber an id.");
  });
  it("the plan-change roadmap task plans new ids in a new milestone", () => {
    const line = "Plan every id this plan change adds in a new milestone. Never add ids to a done milestone: it gets no tickets.";
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    t.createMilestone("Plan change 1", "", "org");
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M1" }, "org");
    expect(task("T-2", "work", "pm")).toContain(line);
    expect(task("T-1", "work", "pm")).not.toContain(line);
  });
  it("the SA review of a business requirements ticket judges only the business documents", () => {
    const line = "Judge only docs/business-requirements.md and docs/business-summary.txt. Findings on the TRs go to your own technical requirements ticket, which comes next.";
    t.createTicket({ title: "Business requirements", kind: "requirements", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Technical requirements", kind: "requirements", status: "in_review", assignee: "sa", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain(line);
    expect(task("T-2", "review", "ba")).not.toContain(line);
  });
  it("the breakdown review checks cited TRs on main for an empty breakdown", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain("If the breakdown creates no tickets, check on main that the code serves each TR the milestone cites. Request changes for each one it does not serve.");
  });
  it("a requirements sub-ticket tells BA and SA what to write and to number the requirements", () => {
    t.createTicket({ title: "Requirements", kind: "requirements", status: "todo", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Business requirements", status: "in_progress", assignee: "ba", milestone: "M0", parent: "T-1" }, "org");
    t.createTicket({ title: "Technical requirements", status: "in_progress", assignee: "sa", milestone: "M0", parent: "T-1" }, "org");
    const ba = task("T-2", "work", "ba"), sa = task("T-3", "work", "sa");
    expect(ba).toContain("# Business requirements and summary");
    expect(ba).toContain("Number every feature as a BR (BR-1, BR-2, …): one testable sentence each.");
    expect(ba).toContain("docs/business-summary.txt");
    expect(sa).toContain("# Technical requirements and summary");
    expect(sa).toContain("Number each requirement: TR-1, TR-2, …");
    expect(sa).toContain("docs/tech-summary.txt");
  });
  it("the BA writes first and asks only about blocking points", () => {
    t.createTicket({ title: "Requirements", kind: "requirements", status: "todo", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Business requirements", status: "in_progress", assignee: "ba", milestone: "M0", parent: "T-1" }, "org");
    expect(task("T-2", "work", "ba")).toContain("- Write what you can first. Ask the human only about open points that block the documents; your session ends until the answer comes. Write each answer into both files.");
    expect(sys("ba")).not.toContain("Write each answer");
  });
  it("a roadmap ticket tells PM to create the milestones in order and submit", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    const s = task("T-1", "work", "pm");
    expect(s).toContain("# Roadmap work");
    expect(s).toContain("Create the milestones in order with milestone_create: a short name (two to four words) without the milestone id, the business scope and the requirement ids it covers (BR-1, BR-2, …).");
    expect(s).toContain("Then call submit_review.");
  });
  it("a roadmap review tells BA to check coverage and TL to check feasibility", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    t.createMilestone("Core", "BR-1", "pm");
    expect(task("T-1", "review", "ba")).toContain("Check that the milestones cover every in-scope requirement id");
    expect(task("T-1", "review", "tl")).toContain("Check feasibility and order");
    expect(task("T-1", "review", "tl")).toContain("# Roadmap\n(active) M0 Start\nM1 Core: BR-1");
  });
  it("the TL roadmap review loads the technical requirements", () => {
    write(DOCS);
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    const s = task("T-1", "review", "tl");
    expect(s).toContain("# Technical requirements (docs/technical-requirements.md)\nTR-1 python 3.12");
    expect(s).toContain("TECH SUMMARY");
    expect(s).toContain("# Roadmap");
  });
  it("the TL roadmap review checks that the first code milestone sets up the structure", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "review", "tl")).toContain("Check feasibility and order: each milestone builds on the ones before, and the first milestone that builds code sets up the structure.");
  });
  it("the BA roadmap review loads the business requirements without the summary", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    const s = task("T-1", "review", "ba");
    expect(s).toContain("docs/business-requirements.md");
    expect(s).toContain("# Roadmap");
    expect(s).not.toContain("docs/business-summary.txt");
  });
  it("the BA roadmap review checks each id once and no extra scope", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "review", "ba")).toContain("Check that the milestones cover every in-scope requirement id exactly once (not the out-of-scope ones). Request changes for a missing or repeated id, or for a milestone with scope outside the business requirements.");
  });
  it("a breakdown ticket tells TL the two steps and no assignment", () => {
    t.createMilestone("Core", "parse and print", "pm");
    t.createTicket({ title: "Breakdown Core", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("# Breakdown of M1 Core\nScope: parse and print");
    expect(s).toContain("Step 1: create every ticket of the milestone with ticket_create.");
    expect(s).toContain("acceptance criteria that state each requirement in words and cite its TR id");
    expect(s).toContain("Step 2: call set_dependencies once");
    expect(s).toContain("The tickets go to Triage; PM accepts and assigns them after the review.");
  });
  it("the breakdown task has the done-so-far digest and the file tree", () => {
    write(DOCS);
    t.createMilestone("Core", "parse", "pm");
    t.createMilestone("Json", "convert to JSON", "pm");
    t.createTicket({ title: "Parse", status: "done", milestone: "M1" }, "org");
    t.setSummary("T-1", "Added src/app.py with parse().\nUsed csv.", "dev");
    t.createTicket({ title: "Print", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "Dropped", status: "canceled", milestone: "M1" }, "org");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "Break down Json", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M2" }, "org");
    t.createTicket({ title: "Json out", status: "done", milestone: "M2" }, "org"); // not an earlier milestone
    const done = "# Done so far\nT-1 Parse: Added src/app.py with parse(). Used csv.\nT-2 Print: (no summary)";
    const s = task("T-5", "work", "tl");
    expect(s).toContain(`${done}\n\n# Files on main`);
    expect(s).toContain("src/app.py");
    expect(s).not.toContain("Dropped");
    expect(s).not.toContain("Accept Core:");
    expect(s).not.toContain("Json out:");
    t.setStatus("T-5", "in_review", "tl");
    const r = task("T-5", "review", "sa");
    expect(r).toContain(done);
    expect(r).toContain("# Files on main");
  });
  it("the done-so-far digest keeps the last 60 tickets", () => {
    t.createMilestone("Core", "", "pm");
    for (let i = 1; i <= 61; i++) t.createTicket({ title: `W${i}`, status: "done", milestone: "M0" }, "org");
    t.createTicket({ title: "Break down Core", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    const s = task("T-62", "work", "tl");
    expect(s).toContain("# Done so far\n(1 earlier tickets left out)\nT-2 W2: (no summary)");
    expect(s).not.toContain("T-1 W1:");
  });
  it("the breakdown rules plan only missing work of the milestone scope", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("Plan only this milestone's scope. Check the done work and the file tree; create tickets only for what is missing. Add a structure ticket (the ticket that creates the project layout: the package, its entry point and the test setup) only when no structure exists.");
    expect(s).toContain("When a structure ticket exists, it blocks every ticket that adds to it.");
    expect(s).not.toContain("Create the structure ticket first");
  });
  it("the breakdown rules plan tests with their code", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- A ticket includes the tests for its code. Plan no separate test ticket for new code.");
  });
  it("the breakdown rules keep existing milestone tickets", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- Tickets already in this milestone (accepted defects) are part of the plan. Do not create a ticket that repeats them.");
  });
  it("the breakdown rules plan no verify-only tickets", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- Plan no ticket only to verify existing behaviour; the acceptance verifies it. A breakdown with no new ticket is allowed when the work is done.");
  });
  it("the SA breakdown review rejects repeated work", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain("Request changes for tickets that repeat done work, repeat a ticket already in the milestone, only verify existing behaviour, or go past the milestone scope.");
  });
  it("the acceptance task loads the ticket summaries and the technical requirements", () => {
    write(DOCS);
    t.createMilestone("Core", "", "pm");
    t.createTicket({ title: "Break down Core", kind: "breakdown", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "Parse", status: "done", milestone: "M1" }, "org");
    t.setSummary("T-2", "Added parse().", "dev");
    t.createTicket({ title: "Print", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "Dropped", status: "canceled", milestone: "M1" }, "org");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    const s = task("T-5", "work", "tl");
    expect(s).toContain("TECH SUMMARY");
    expect(s).toContain("Added parse()");
    expect(s).not.toContain("# Ticket summaries");
    expect(s).toContain("TR-1 python 3.12");
    expect(s).not.toContain("Dropped:");
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M1" }, "org");
    const sa = task("T-6", "work", "sa");
    expect(sa).not.toContain("# Ticket summaries");
    expect(sa).toContain("Added parse()");
  });
  it("the SA summary task shows each ticket summary once", () => {
    t.createMilestone("Core", "", "pm");
    t.createTicket({ title: "Parse", status: "done", milestone: "M1" }, "org");
    t.setSummary("T-1", "Added parse().", "dev");
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M1" }, "org");
    expect(task("T-2", "work", "sa").split("Added parse()").length).toBe(2);
  });
  it("the SA summary task has no business summary", () => {
    write(DOCS);
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    expect(task("T-1", "work", "sa")).not.toContain("BUSINESS SUMMARY");
  });
  it("the SA summary task loads the tech summary without the technical requirements", () => {
    write(DOCS);
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    const s = task("T-1", "work", "sa");
    expect(s).toContain("TECH SUMMARY");
    expect(s).not.toContain("TR-1 python");
    expect(s).toContain("- When a decision changed, also update docs/technical-requirements.md (read it with read).");
  });
  it("a breakdown review tells SA to check the dependencies", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "review", "sa");
    expect(s).toContain("Check the tickets of the milestone and their dependencies: the order, what runs in parallel, and that no two parallel tickets change the same file.");
    expect(s).toContain("When a structure ticket (the ticket that creates the project layout) exists, check that it blocks the tickets that add to it.");
  });
  it("ticketText of a breakdown ticket lists the milestone's tickets with their descriptions and dependencies", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Breakdown Core", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Parse", description: "parse csv\nAC: TR-1", status: "todo", assignee: "dev", milestone: "M1" }, "org");
    t.createTicket({ title: "Print", status: "todo", assignee: "dev", milestone: "M1" }, "org");
    t.createTicket({ title: "Docs", description: "write docs", status: "todo", milestone: "M1" }, "org");
    t.setApproval("T-2", "tl", "pending", "org");
    t.addRelation("T-1", "T-4", "blocks", "org"); t.addRelation("T-2", "T-4", "blocks", "org"); t.addRelation("T-3", "T-4", "blocks", "org");
    const s = ticketText(t.getTicket("T-1"), t);
    expect(s).toContain("Tickets of M1:\nMAIHEM blocks every ticket below by this breakdown until it is approved; 'blocked by' shows only the other blockers.\nT-2 [todo] Parse\n  parse csv\n  AC: TR-1\nT-3 [todo] Print\nT-4 [todo] Docs; blocked by: T-2, T-3\n  write docs");
    expect(s).not.toContain("@");
    expect(s).not.toContain("reviewers:");
    expect(ticketText(t.getTicket("T-2"), t)).not.toContain("Tickets of M1");
  });
  it("ticketText of a breakdown ticket skips canceled and duplicate tickets", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Breakdown Core", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Dropped", status: "canceled", milestone: "M1" }, "org");
    t.createTicket({ title: "Dup", status: "duplicate", milestone: "M1" }, "org");
    t.createTicket({ title: "Finished", status: "done", milestone: "M1" }, "org");
    const s = ticketText(t.getTicket("T-1"), t);
    expect(s).not.toContain("Dropped");
    expect(s).not.toContain("Dup");
    expect(s).toContain("T-4 [done] Finished");
  });
  it("the SA breakdown review shows the milestone scope", () => {
    t.createMilestone("Core", "CSV import", "org");
    t.createMilestone("Out", "", "org");
    t.createTicket({ title: "Breakdown Core", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Breakdown Out", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M2" }, "org");
    expect(task("T-1", "review", "sa")).toContain("# Milestone M1 Core\nScope: CSV import");
    expect(task("T-2", "review", "sa")).toContain("# Milestone M2 Out\n");
    expect(task("T-2", "review", "sa")).not.toContain("# Milestone M2 Out\nScope:");
  });
  it("the SA breakdown review has no business summary", () => {
    write(DOCS);
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Old", status: "done", milestone: "M0" }, "org");
    t.setSummary("T-1", "Did old.", "dev");
    t.createTicket({ title: "Breakdown Core", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M1" }, "org");
    const s = task("T-2", "review", "sa");
    expect(s).not.toContain("BUSINESS SUMMARY");
    expect(s).toContain("TR-1 python 3.12");
    expect(s).toContain("TECH SUMMARY");
    expect(s).toContain("# Done so far\nT-1 Old: Did old.");
    expect(s).toContain("# Files on main");
    expect(s).toContain("src/app.py");
  });
  it("an acceptance ticket tells TL to run the checks, create defects and write the verdict", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Parse", status: "done", assignee: "dev", milestone: "M1" }, "org");
    t.setSummary("T-2", "snake_case", "dev");
    t.setMerged("T-2", write({ "p.py": "p" }), "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("# Acceptance of M1 (technical)");
    expect(s).toContain("Run the checks that the tech summary names, and the program itself.");
    expect(s).toContain("- Compare the result with the tech summary and each ticket's acceptance criteria.");
    expect(s).toContain("For each defect: ticket_create");
    expect(s).toContain("Write the verdict in the submit summary: each ticket, met or not met against its acceptance criteria; a reason only for not met; the defect tickets.");
    expect(s).toContain("# Milestone M1 Core\nT-2 [done] Parse: files (p.py)\n  Summary: snake_case");
  });
  it("an acceptance review tells PM to compare with the business requirements", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "review", "pm");
    expect(s).toContain("approve");
    expect(s).not.toContain("Call review_diff");
  });
  it("the acceptance review names the verdict in the ticket summary", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "review", "pm");
    expect(s).toContain("Compare the milestone result and TL's verdict (the summary of the work in the ticket) with the business requirements. Approve when the milestone delivers its business scope.");
    expect(s).not.toContain("Otherwise request_changes with one finding per item.");
  });
  it("the PM acceptance review shows the Triage list, not the board", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "review", "pm")).toContain("# Triage\n(empty)");
    t.createTicket({ title: "Crash", description: "x".repeat(400), label: "bug", status: "triage" }, "tl");
    t.createTicket({ title: "Busy", status: "in_progress", assignee: "dev", milestone: "M0" }, "org");
    const s = task("T-1", "review", "pm");
    expect(s).toContain(`# Triage\n- T-2 Crash (label bug, from tl): ${"x".repeat(300)}\n`);
    expect(s).not.toContain("# Board");
    expect(s).not.toContain("## in_progress");
  });
  it("the PM acceptance review shows ticket summaries, not commits and files", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Parse", status: "done", assignee: "dev", milestone: "M0" }, "org");
    t.setSummary("T-2", "snake_case", "dev");
    t.setMerged("T-2", write({ "p.py": "p" }), "org");
    const s = task("T-1", "review", "pm");
    expect(s).toContain("# Ticket summaries of M0\nT-2 Parse: snake_case");
    expect(s).not.toContain("p.py");
    expect(s).not.toContain("# Milestone M0");
  });
  it("an acceptance review tells PM, and only PM, to file each defect with ticket_create", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "review", "pm")).toContain("For each defect: ticket_create with the steps to reproduce. It goes to Triage.");
    expect(task("T-1", "review", "sa")).not.toContain("ticket_create");
  });
  it("the PM roadmap task has no board", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    t.createTicket({ title: "Login", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).not.toContain("# Board");
    expect(task("T-2", "work", "pm")).toContain("# Board");
  });
  it("the PM roadmap task loads the business requirements without the business summary", () => {
    write(DOCS);
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    for (const s of [task("T-1", "work", "pm"), task("T-2", "review", "pm")]) {
      expect(s).toContain("BR-1 users import CSV");
      expect(s).not.toContain("BUSINESS SUMMARY");
    }
  });
  it("a PM system prompt has no active milestone line", () => {
    const ms = { id: "M0", name: "Start", description: "" } as never;
    for (const kind of ["work", "review", "reply", "triage"] as const) expect(systemFor({ org, member: "pm", goal: "g", defs, kind, milestone: ms })).not.toContain("Active milestone:");
    expect(systemFor({ org, member: "tl", goal: "g", defs, kind: "work", milestone: ms })).toContain("Active milestone: M0 Start");
  });
  it("a PM system prompt has no grid or documents lines", () => {
    for (const x of ["The grid:", "Documents:"]) { for (const k of ["work", "review", "reply", "triage"] as const) expect(sys("pm", k)).not.toContain(x); expect(sys("tl")).toContain(x); }
  });
  it("a PM work session is not told to create tickets or sub-tickets", () => {
    expect(sys("pm")).not.toContain("ticket_create");
    expect(sys("dev")).toContain("A new idea or a bug: ticket_create.");
  });
  it("a summary ticket tells SA to update the tech summary under 4000 characters", () => {
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    const s = task("T-1", "work", "sa");
    expect(s).toContain("# Tech summary and repo cleanup after M0");
    expect(s).toContain("Update docs/tech-summary.txt");
    expect(s).toContain("Keep it under 4000 characters.");
    expect(s).toContain("# Milestone M0");
  });
  it("the acceptance and summary rules mention milestone_diff", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org");
    const line = "milestone_diff shows what the milestone changed; use it with path for a single file.";
    for (const s of [task("T-1", "work", "tl"), task("T-2", "work", "sa"), task("T-2", "review", "tl")]) expect(s).toContain(line);
    expect(task("T-1", "review", "pm")).not.toContain("milestone_diff");
  });
  it("the acceptance verdict goes into the submit summary", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("- Write the verdict in the submit summary: each ticket, met or not met against its acceptance criteria; a reason only for not met; the defect tickets.");
    expect(s).not.toContain("verdict tool");
  });
  it("the TL acceptance shows the ticket summaries once", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Parse", status: "done", milestone: "M1" }, "org");
    t.setSummary("T-1", "Added parse().", "dev");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    const s = task("T-2", "work", "tl");
    expect(s).not.toContain("# Ticket summaries of");
    expect(s.split("Added parse().").length - 1).toBe(1);
  });
  it("the TL acceptance verdict is per ticket", () => {
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- Write the verdict in the submit summary: each ticket, met or not met against its acceptance criteria; a reason only for not met; the defect tickets.");
  });
  it("the TL acceptance digest shows each ticket's description", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Parse", description: "Parse files.\nKeep order.", status: "done", milestone: "M1" }, "org");
    t.setSummary("T-1", "Added parse().", "dev");
    t.createTicket({ title: "Print", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    expect(task("T-3", "work", "tl")).toContain("T-1 [done] Parse\n  Parse files.\n  Keep order.\n  Summary: Added parse().\nT-2 [done] Print\n");
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M1" }, "org");
    const sa = task("T-4", "work", "sa");
    expect(sa).toContain("T-1 [done] Parse\n  Summary: Added parse().");
    expect(sa).not.toContain("Keep order.");
  });
  it("the milestone digest names the milestone", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M1" }, "org");
    for (const s of [task("T-1", "work", "tl"), task("T-2", "work", "sa"), task("T-2", "review", "tl")]) expect(s).toContain("# Milestone M1 Core\n");
  });
  it("the breakdown rework line comes before the submit line", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s.indexOf("- Rework tickets with ticket_edit and ticket_drop.")).toBeLessThan(s.indexOf("- Then call submit_review. SA reviews the breakdown."));
  });
  it("the breakdown tickets go to Triage and are reworked with ticket_edit and ticket_drop", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("- The tickets go to Triage; PM accepts and assigns them after the review.");
    expect(s).toContain("- Rework tickets with ticket_edit and ticket_drop.");
  });
  it("the breakdown acceptance criteria state each requirement in words and cite its TR id", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("acceptance criteria that state each requirement in words and cite its TR id. Keep tickets small");
    t.setStatus("T-1", "in_review", "tl");
    expect(task("T-1", "review", "sa")).toContain("Check that the acceptance criteria state each requirement in words and cite its TR id.");
  });
  it("the TL card has no breakdown rules", () => {
    const s = sys("tl");
    expect(s).not.toContain("The ticket that creates a structure blocks the tickets that add to it.");
    expect(s).not.toContain("Two tickets that change the same file depend on each other.");
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("When a structure ticket exists, it blocks every ticket that adds to it.");
  });
  it("the breakdown task has no filler and no repeated rules", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    for (const x of ["Read the scope and the technical requirements in this task.", "Do not assign tickets.", "When SA requests changes: rework"]) expect(s).not.toContain(x);
    expect(s).toContain("- The tickets go to Triage; PM accepts and assigns them after the review.");
    expect(s).toContain("- Rework tickets with ticket_edit and ticket_drop.");
  });
  it("a final ticket tells BA to compare the product with the business requirements and write the verdict", () => {
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "done", assignee: "tl", milestone: "M0" }, "org");
    t.setSummary("T-1", "M0 works", "tl");
    t.createTicket({ title: "Final", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-2", "work", "ba");
    expect(s).toContain("# Final acceptance");
    expect(s).toContain("Compare the product with the business requirements, requirement by requirement.");
    expect(s).toContain("Write the verdict in the submit summary: each requirement id, met or not met; a reason only for not met; the defect tickets.");
    expect(s).toContain("# Milestone verdicts\n- T-1 (M0): M0 works");
  });
  it("a final review tells SA to do the technical check", () => {
    t.createTicket({ title: "Final", kind: "final", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain("Technical check: run the checks on main. Go through the TRs one by one; for each interface TR, run the program on main, not only the tests.");
  });
  it("the SA final review shows the defects and how to file one", () => {
    t.createTicket({ title: "Login fails", label: "bug", status: "triage" }, "org");
    t.createTicket({ title: "Final", kind: "final", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-2", "review", "sa");
    expect(s).toContain("# Defects\n- T-1 [triage] Login fails (no milestone)");
    expect(s).toContain("For each defect: ticket_create with the steps to reproduce. It goes to Triage; the final acceptance waits until it is closed.");
    expect(s).toContain("Request changes only when the BA's verdict is wrong.");
  });
  it("the BA final work turns findings into gap tickets", () => {
    t.createTicket({ title: "Final", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-1", "work", "ba");
    expect(s).toContain("- A gap, or a reviewer's finding about the product: ticket_create for it. It goes to Triage; the final acceptance waits until it is closed.");
    expect(s).not.toContain("- A gap: ticket_create for it. It goes to Triage.\n");
  });
  it("the SA final review loads only the technical documents, the file tree and the milestone verdicts", () => {
    write(DOCS);
    t.createTicket({ title: "Accept M0", kind: "acceptance", status: "done", milestone: "M0" }, "org");
    t.setSummary("T-1", "M0 accepted.", "pm");
    t.createTicket({ title: "Final", kind: "final", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-2", "review", "sa");
    for (const x of ["TECH SUMMARY", "TR-1 python 3.12", "# Files on main", "# Milestone verdicts"]) expect(s).toContain(x);
    expect(s).not.toContain("BUSINESS SUMMARY");
    expect(s).not.toContain("BR-1 users import CSV");
  });
});

describe("org prompt: ticket, review and reply", () => {
  it("ticketText shows the fields, the sub-tickets and the comments", () => {
    t.createTicket({ title: "Parent", status: "in_progress", assignee: "dev", milestone: "M0" }, "org");
    t.createTicket({ title: "Blocker", status: "todo", milestone: "M0" }, "org");
    t.createTicket({ title: "Login", description: "users log in", status: "in_progress", label: "bug", priority: 3, assignee: "dev", milestone: "M0" }, "org");
    t.createTicket({ title: "Child", status: "todo", parent: "T-3" }, "org");
    t.addRelation("T-2", "T-3", "blocks", "org");
    t.setApproval("T-3", "tl", "pending", "org");
    t.addComment("T-3", "dev asks tl: which db?", "dev");
    t.addComment("T-3", "postgres", "tl");
    const s = ticketText(t.getTicket("T-3"), t);
    expect(s).toContain("T-3 [in_progress] Login");
    expect(s).toContain("kind normal · label bug · priority high · milestone M0 · assignee dev · reviewers tl (pending) · blocked by T-2");
    expect(s).toContain("sub-tickets: T-4 [todo] Child");
    expect(s).toContain("users log in");
    expect(s).toContain("Comments:\ndev asks tl: which db?\ntl: postgres");
    t.setStatus("T-2", "done", "org");
    expect(ticketText(t.getTicket("T-4"), t)).toContain("parent T-3");
    expect(ticketText(t.getTicket("T-2"), t)).toContain("blocks T-3");
  });
  it("taskFor a review session asks for review_diff and a decision", () => {
    t.createTicket({ title: "Login", status: "in_review", assignee: "dev" }, "org");
    const s = task("T-1", "review", "tl");
    expect(s.startsWith("Review T-1.")).toBe(true);
    expect(s).toContain("- Call review_diff.");
    expect(s).toContain("Then approve or request_changes.");
  });
  it("the code-review rules go only to reviews of tickets with a diff", () => {
    const kinds = ["normal", "requirements", "summary", "roadmap", "breakdown", "acceptance", "final"] as const;
    for (const kind of kinds) {
      const tk = t.createTicket({ title: kind, kind, status: "in_review", assignee: "dev", milestone: "M0" }, "org");
      const s = task(tk.id, "review", "tl"), has = ["normal", "requirements", "summary"].includes(kind);
      for (const l of ["Call review_diff", "Request changes for stray files", "The diff is the truth."]) expect(s.includes(l), `${kind}: ${l}`).toBe(has);
    }
  });
  it("the reply task states the question first", () => {
    t.createTicket({ title: "Login", status: "in_progress", assignee: "dev" }, "org");
    t.addComment("T-1", "dev asks tl: old?", "dev");
    t.addComment("T-1", "fine", "tl");
    t.addComment("T-1", "dev asks tl: which db?", "dev");
    t.setQuestion("T-1", { asker: "dev", status: "in_progress", assignee: "dev" }, "dev");
    t.setStatus("T-1", "needs_reply", "dev"); t.setAssignee("T-1", "tl", "dev");
    const s = task("T-1", "reply", "tl");
    expect(s.startsWith("Question on T-1: dev asks tl: which db?\n\n")).toBe(true);
    expect(s).toContain("Comments:\ndev asks tl: old?\ntl: fine");
  });
  it("an SA reply loads only the technical documents and the file tree", () => {
    write(DOCS);
    t.createTicket({ title: "Plan", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.addComment("T-1", "tl asks sa: which db?", "tl");
    t.setQuestion("T-1", { asker: "tl", status: "in_progress", assignee: "tl" }, "tl");
    t.setStatus("T-1", "needs_reply", "tl"); t.setAssignee("T-1", "sa", "tl");
    const s = task("T-1", "reply", "sa");
    for (const x of ["TR-1 python 3.12", "TECH SUMMARY", "# Files on main"]) expect(s).toContain(x);
    for (const x of ["BUSINESS SUMMARY", "# Done so far", "# Milestone verdicts"]) expect(s).not.toContain(x);
  });
  it("a comment that starts with its author's name shows without the author prefix", () => {
    t.createTicket({ title: "Login", status: "in_progress", assignee: "dev" }, "org");
    t.addComment("T-1", "tl answers: postgres", "tl");
    t.addComment("T-1", "postgres", "tl");
    expect(task("T-1", "work", "dev")).toContain("Comments:\ntl answers: postgres\ntl: postgres");
  });
});

describe("org prompt: BA review of technical requirements", () => {
  const reqTicket = () => {
    write(DOCS);
    const p = t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const c = t.createTicket({ title: "Technical requirements", parent: p.id, status: "in_review", assignee: "sa", milestone: "M0" }, "org");
    return c.id;
  };
  it("a review loads the documents from the ticket branch", () => {
    const id = reqTicket();
    execFileSync("git", ["checkout", "-q", "-b", "tb"], { cwd: repo });
    write({ "docs/technical-requirements.md": "TR-9 on the branch" });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    t.setBranch(id, "tb", "org");
    expect(task(id, "review", "ba")).toContain("TR-9 on the branch");
  });
  it("the BA checks that the technical requirements cover every BR id", () => {
    expect(task(reqTicket(), "review", "ba")).toContain("Check that every BR id is covered by a TR that cites it. Request changes for a missing id or for a change of the business scope.");
  });
  it("the review asks for checks only when the reviewer has exec", () => {
    write(DOCS);
    const id = t.createTicket({ title: "Feature", status: "in_review", assignee: "dev", milestone: "M0" }, "org").id;
    expect(task(id, "review", "ba")).not.toContain("Run the checks");
    expect(task(id, "review", "ba")).not.toContain("Still run the checks");
    const s = taskFor({ t, ticket: id, kind: "review", member: "tl", org, repo, main, tools: ["read", "exec"] });
    expect(s.split("- Run the checks that the tech summary names (tests and others).\n").length).toBe(2);
    expect(s).not.toContain("when you have exec");
    expect(s).not.toContain("Still run the checks");
  });
  it("the document check goes only to reviews of document tickets", () => {
    const doc = "- The documents and their summary files exist, match each other, and each summary file stays";
    const id = t.createTicket({ title: "Feature", status: "in_review", assignee: "dev", milestone: "M0" }, "org").id;
    const dev = task(id, "review", "tl");
    expect(dev).toContain("# Change review\n- Call review_diff.\n");
    expect(dev).not.toContain("document ticket");
    expect(dev).not.toContain(doc);
    expect(task(reqTicket(), "review", "ba")).toContain(doc);
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    expect(task(sum, "review", "tl")).toContain(doc);
  });
  it("the summary review states the cap once", () => {
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    const s = task(sum, "review", "tl");
    expect(s).toContain("Check that docs/tech-summary.txt does not contradict the code on main.");
    expect(s.split("4000 characters").length).toBe(2);
  });
  it("the summary review has no run line", () => {
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    expect(taskFor({ t, ticket: sum, kind: "review", member: "tl", org, repo, main, tools: ["read", "list", "exec"] })).not.toContain("Run the checks");
  });
  it("the change review names the summary of the work", () => {
    const s = task(reqTicket(), "review", "ba");
    expect(s).toContain("- Check the summary of the work against the diff. The diff is the truth. Request changes when the summary of the work is wrong or misses a change.");
    expect(s).not.toContain("Check the summary against the real changes");
  });
  it("a reviewer checks its earlier findings", () => {
    for (const m of ["tl", "ba", "sa", "pm"]) expect(systemFor({ org, member: m, goal: "g", defs: {}, kind: "review" })).toContain("- Before you repeat a finding, check it against the current ticket text and diff. Drop it when it is fixed.");
  });
  it("the change review block is named Change review", () => {
    const s = task(reqTicket(), "review", "ba");
    expect(s).toContain("# Change review");
    expect(s).not.toContain("# Code review");
  });
});

describe("org prompt: SA review of business requirements", () => {
  const brTicket = () => {
    write(DOCS);
    const p = t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    return t.createTicket({ title: "Business requirements", parent: p.id, status: "in_review", assignee: "ba", milestone: "M0" }, "org").id;
  };
  it("the SA review of the business requirements loads only the business documents", () => {
    const s = task(brTicket(), "review", "sa");
    expect(s).toContain("(docs/business-requirements.md)");
    expect(s).toContain("(docs/business-summary.txt)");
    expect(s).not.toContain("(docs/technical-requirements.md)");
    expect(s).not.toContain("(docs/tech-summary.txt)");
    expect(s).not.toContain("# Files on main");
  });
  it("the BA requirements process keeps technical items out of the BRs", () => {
    const s = task(brTicket(), "work", "ba");
    const l = "- Put technical items (paths, commands, modules, test setup) in the TRs: they are the SA's. The BRs stay at business level.";
    expect(s).toContain(l + "\n- Then call submit_review. SA reviews.");
  });
  it("the SA review of the BRs rejects technical items", () => {
    expect(task(brTicket(), "review", "sa")).toContain("no tech stack and no design. Request changes for a BR that names a path, a command, a module or a test setup. Request changes for a requirement that cannot be tested or built.");
  });
  it("the tech summary review allows planned scope of later milestones", () => {
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    const s = task(sum, "review", "tl");
    expect(s).toContain("Check that docs/tech-summary.txt does not contradict the code on main. Planned parts of later milestones are allowed.");
  });
  it("the SA requirements process leaves the command check to the summary ticket", () => {
    write(DOCS);
    const p = t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    const id = t.createTicket({ title: "Technical requirements", parent: p.id, status: "in_progress", assignee: "sa", milestone: "M0" }, "org").id;
    expect(task(id, "work", "sa")).toContain("- Name each command as it runs on this host; you cannot run it yet. The summary ticket checks it.\n- Then call submit_review. BA reviews.");
  });
  it("the SA checks that the business requirements are testable and buildable", () => {
    expect(task(brTicket(), "review", "sa")).toContain("Check that each BR is testable and can be built, and that the requirements stay at business level: no tech stack and no design.");
  });
});

describe("org prompt: final acceptance", () => {
  it("a final acceptance session has no write or edit tools and no file rules", () => {
    const fin = systemFor({ org, member: "dev", goal: "g", defs, kind: "work", ticketKind: "final" });
    expect(fin).not.toContain("Delete scratch files");
    expect(sys("dev")).toContain("Delete scratch files");
  });
  it("sub-tickets only for normal tickets", () => {
    t.createTicket({ title: "Final acceptance", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    t.createTicket({ title: "Acc", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Business requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    for (const [id, m] of [["T-1", "ba"], ["T-2", "tl"], ["T-3", "ba"]]) expect(task(id, "work", m)).not.toContain("subticket_create");
  });
  it("the final ticket asks the BA for the business check only", () => {
    expect(FINAL).toBe("Final acceptance: check the product against the business requirements.");
  });
  it("the BA final task loads the business requirements without the summaries", () => {
    write(DOCS);
    t.createTicket({ title: "Final acceptance", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const s = task("T-1", "work", "ba");
    expect(s).toContain("BR-1 users");
    for (const x of ["BUSINESS SUMMARY", "TECH SUMMARY", "tech summary"]) expect(s).not.toContain(x);
    expect(s).toContain("- Use the milestone verdicts and the defect list in this task.");
  });
  it("the BA final task lists the defect tickets with their status", () => {
    t.createTicket({ title: "Final acceptance", kind: "final", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    expect(task("T-1", "work", "ba")).toContain("# Defects\n(none)");
    t.createTicket({ title: "Crash", label: "bug", status: "todo", milestone: "M0" }, "dev");
    t.createTicket({ title: "Other", status: "todo", milestone: "M0" }, "dev");
    const s = task("T-1", "work", "ba");
    expect(s).toContain("# Defects\n- T-2 [todo] Crash (M0)");
    expect(s).not.toContain("Other (M0)");
  });
});

describe("org prompt: run 18 fixes", () => {
  const commit = (files: Record<string, string>, subject: string) => {
    for (const [f, s] of Object.entries(files)) writeFileSync(join(repo, f), s);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=d", "-c", "user.email=d@x", "commit", "-q", "--allow-empty", "-m", subject], { cwd: repo });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  };
  const exec = { ...defs, ex: { name: "ex", tools: ["read", "write", "exec"] } } as unknown as Record<string, Definition>;
  it("an outcome line shows the changed files without the commit subject", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Parse", status: "done", assignee: "dev", milestone: "M1" }, "org"); // T-1
    t.createTicket({ title: "Next", status: "in_progress", assignee: "dev", milestone: "M1" }, "org"); // T-2
    t.createTicket({ title: "Empty", status: "done", assignee: "dev", milestone: "M1" }, "org"); // T-3
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M1" }, "org"); // T-4
    t.addRelation("T-1", "T-2", "blocks", "org");
    t.setMerged("T-1", commit({ "a.py": "a", "b.py": "b" }, "T-1: Parse"), "org");
    t.setMerged("T-3", commit({}, "T-3: Empty"), "org");
    expect(task("T-2", "work", "dev")).toContain("# Finished blockers\nT-1: files (a.py, b.py)");
    const acc = task("T-4", "work", "tl");
    expect(acc).toContain("T-1 [done] Parse: files (a.py, b.py)");
    expect(acc).toContain("T-3 [done] Empty: (no changes)");
    expect(acc).not.toContain("T-1: Parse");
  });
  it("the digest marks the work summary", () => {
    t.createTicket({ title: "Parse", status: "done", milestone: "M0" }, "org");
    t.setSummary("T-1", "Added parse().", "dev");
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-2", "work", "tl");
    expect(s).toContain("T-1 [done] Parse\n  Summary: Added parse().");
    expect(s).not.toContain("  - Added parse().");
  });
  it("a breakdown ticket shows its description before the plan", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", description: "Break it down.", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Parse", status: "triage", milestone: "M0" }, "tl");
    const s = ticketText(t.getTicket("T-1"), t);
    expect(s.indexOf("Break it down.")).toBeGreaterThan(-1);
    expect(s.indexOf("Break it down.")).toBeLessThan(s.indexOf("Tickets of M0"));
  });
  it("triage batch descriptions indent their continuation lines", () => {
    t.createTicket({ title: "New", description: "first\n- AC 1\n- AC 2", status: "triage" }, "tl");
    expect(task("", "triage", "pm", ["T-1"])).toContain(": first\n    - AC 1\n    - AC 2");
  });
  it("work tasks have no read-in-this-task filler", () => {
    write(DOCS);
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org"); // T-1
    t.createTicket({ title: "Technical requirements", kind: "requirements", status: "in_progress", assignee: "sa", milestone: "M0" }, "org"); // T-2
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org"); // T-3
    for (const [id, mem] of [["T-1", "pm"], ["T-2", "sa"], ["T-3", "sa"]]) {
      const s = task(id, "work", mem);
      expect(s).not.toContain("- Read the business requirements in this task.");
      expect(s).not.toContain("- Read what");
    }
  });
  it("the milestone digest lists only work tickets", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Break down Core", kind: "breakdown", description: "Break it down.", status: "done", assignee: "tl", milestone: "M1" }, "org"); // T-1
    t.createTicket({ title: "Parse", status: "done", milestone: "M1" }, "org"); // T-2
    t.createTicket({ title: "Accept Core", kind: "acceptance", status: "done", assignee: "tl", milestone: "M1" }, "org"); // T-3
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M1" }, "org"); // T-4
    t.createTicket({ title: "Final acceptance", kind: "final", status: "todo", assignee: "ba", milestone: "M1" }, "org"); // T-5
    const s = task("T-4", "work", "sa");
    expect(s).toContain("# Milestone M1 Core\nT-2 [done] Parse");
    for (const x of ["Break down Core", "Break it down.", "Accept Core", "Final acceptance"]) expect(s).not.toContain(x);
  });
  it("the definition system text is trimmed", () => {
    const d = { d: { name: "d", system: "\nBe terse.\n" } } as unknown as Record<string, Definition>;
    const s = systemFor({ org, member: "ba", goal: "g", defs: d, kind: "work" });
    expect(s).toContain("filler. Do not go full STE: keep natural phrasing and domain terms where strict STE would read awkwardly.\n\n# Org");
    expect(s).toContain("\n\n# Style\nBe terse.\n\n# Work");
    expect(s).not.toContain("\n\n\n");
  });
  it("the run-the-checks rules name the tech summary", () => {
    const o = validateOrg({ name: "acme", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev", undefined, "ex") } });
    const dev = systemFor({ org: o, member: "dev", goal: "g", defs: exec, kind: "work" });
    expect(dev).toContain("- Run the checks that the tech summary names (tests and others) before you submit.");
    const id = t.createTicket({ title: "Feature", status: "in_review", assignee: "dev", milestone: "M0" }, "org").id;
    const rev = taskFor({ t, ticket: id, kind: "review", member: "tl", org, repo, main, tools: ["read", "exec"] });
    expect(rev).toContain("- Run the checks that the tech summary names (tests and others).\n");
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const acc = task("T-2", "work", "tl");
    expect(acc).toContain("- Run the checks that the tech summary names, and the program itself.");
    for (const s of [dev, rev, acc]) expect(s).not.toContain("typecheck");
  });
  it("the SA and TL cards do not mention assigning", () => {
    for (const x of ["sa", "tl"]) expect(sys(x).split("# Your role")[1]).not.toMatch(/assign/i);
  });
  it("the triage team load lists only devs", () => {
    t.createTicket({ title: "Parse", status: "todo", assignee: "dev", milestone: "M0" }, "org");
    t.createTicket({ title: "New", status: "triage", milestone: "M0" }, "tl");
    expect(task("", "triage", "pm", ["T-2"])).toMatch(/# Team load\n- dev \(DEV\): 1 open\n- dev2 \(DEV\): 0 open$/);
  });
  it("the breakdown fences tickets to the milestone's requirements", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- Each ticket builds only the milestone's BR ids. A cited TR may also serve BR ids of other milestones. Plan only what the milestone's requirements ask: no ticket for a later milestone's scope, no extra features.");
    t.setStatus("T-1", "in_review", "tl");
    expect(task("T-1", "review", "sa")).toContain("Request changes for a ticket that builds work outside the milestone's BR ids.");
  });
  it("the DEV work rules say YAGNI", () => {
    const y = "Build only what the acceptance criteria ask. Other requirements have their own tickets; do not build them ahead.";
    expect(sys("dev")).toContain(y);
    expect(sys("tl")).not.toContain(y);
  });
  it("the roadmap rules say YAGNI", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).toContain("- Plan only what the business requirements ask. No milestone for work that another milestone already covers, and no extra scope.");
  });
  it("milestone names are short and carry no id", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).toContain("a short name (two to four words) without the milestone id");
  });
});
describe("org prompt: run 19 fixes", () => {
  const TRUST = "- Your task text holds your context. Trust it: do not read a document, ticket or list again with tools when the task shows it.";
  const IDS = "Milestone ids are fixed tracker ids, not positions; the order of the list is the roadmap order. Do not request id changes.";
  it("every session kind tells the member to trust its task context", () => {
    for (const kind of ["work", "review", "reply", "triage"] as const) {
      const s = systemFor({ org, member: kind === "triage" ? "pm" : "tl", goal: "g", defs, kind });
      expect(s).toContain(TRUST);
      expect(s).not.toContain("already holds your context");
    }
  });
  it("roadmap rules say milestone ids are not positions", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).toContain(IDS);
  });
  it("roadmap reviews say milestone ids are not positions", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "review", "ba")).toContain(IDS);
    expect(task("T-1", "review", "tl")).toContain(IDS);
  });
  it("roadmap work rules name milestone_update for a coverage fix", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).toContain("milestone_update");
  });
});

describe("org prompt: run 20 rules", () => {
  const req = (title: string, who: string) => {
    t.createTicket({ title: "Requirements", kind: "requirements", status: "todo", assignee: "ba", milestone: "M0" }, "org");
    return t.createTicket({ title, status: "in_progress", assignee: who, milestone: "M0", parent: "T-1" }, "org").id;
  };
  it("the requirements blocks say write or update and keep the ids", () => {
    const k = "; keep the existing ids and add new ones after the last.";
    expect(task(req("Business requirements", "ba"), "work", "ba")).toContain(`- Write or update docs/business-requirements.md: goal, users, features, business rules, out of scope${k}`);
    expect(task(t.createTicket({ title: "Technical requirements", status: "in_progress", assignee: "sa", milestone: "M0", parent: "T-1" }, "org").id, "work", "sa"))
      .toContain(`- Write or update docs/technical-requirements.md: tech stack, architecture, data, interfaces, constraints, how to test${k}`);
  });
  it("the TR review checks that every BR verb has a command, the roadmap reviews do not", () => {
    const V = "Every BR verb has a command or interface that performs it.";
    const p = t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const c = t.createTicket({ title: "Technical requirements", parent: p.id, status: "in_review", assignee: "sa", milestone: "M0" }, "org");
    const r = t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org");
    expect(task(c.id, "review", "ba")).toContain(V);
    expect(task(r.id, "review", "tl")).not.toContain(V);
    expect(task(r.id, "review", "ba")).not.toContain(V);
  });
  it("the SA requirements block says how, cites BR ids and allows one way per need", () => {
    const s = task(req("Technical requirements", "sa"), "work", "sa");
    for (const l of ["A TR states how: the module, command, table or check.", "Cite the BR ids each TR serves.", "One way per need: no fallbacks or options the BRs do not ask for."]) expect(s).toContain(l);
  });
  it("the BA requirements block numbers every feature as a BR", () => {
    expect(task(req("Business requirements", "ba"), "work", "ba")).toContain("Number every feature as a BR (BR-1, BR-2, …): one testable sentence each.");
  });
  it("the roadmap work keeps milestone descriptions to their BR ids and keeps done milestones on a plan change", () => {
    const s = task(t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org").id, "work", "pm");
    expect(s).toContain("A milestone's description covers only the scope of its BR ids.");
    expect(s).toContain("On a plan change, add milestones only for new or changed requirements; the done milestones stay.");
  });
  it("the SA summary block checks the repo for runtime data", () => {
    const s = task(t.createTicket({ title: "Sum", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org").id, "work", "sa");
    expect(s).toContain("Check .gitignore and the tracked files for runtime data (databases, logs, backups, caches). If one .gitignore change fixes it, make it. If more work is needed, file a ticket with ticket_create.");
  });
  it("DEV work, TL reviews and the TL breakdown keep the repo clean", () => {
    const C = "Keep the repo clean: no runtime data (databases, logs, backups, caches) in git. Manage .gitignore.";
    const s = (member: string, kind: Wake["kind"], ticketKind?: "breakdown") => systemFor({ org, member, goal: "g", defs, kind, ticketKind });
    expect(s("dev", "work")).toContain(C);
    expect(s("tl", "review")).toContain("Request changes when runtime data (databases, logs, backups, caches) is in git or .gitignore misses it.");
    expect(s("tl", "work", "breakdown")).toContain("Plan .gitignore in the structure ticket: no runtime data (databases, logs, backups, caches) in git.");
    expect(s("tl", "work")).not.toContain(C);
    expect(s("sa", "review")).not.toContain(C);
  });
  it("every review asks only for changes the author can make", () => {
    for (const r of ["ba", "sa", "pm", "tl", "dev"]) expect(sys(r, "review")).toContain("- Request only changes the author can make with its tools. The context the system shows is not editable.");
    expect(sys("dev")).not.toContain("Request only changes the author can make");
  });
  it("the work context shows the changes on the branch so far", () => {
    const id = t.createTicket({ title: "Parse", status: "in_progress", assignee: "dev", milestone: "M0" }, "org").id;
    const s = taskFor({ t, ticket: id, kind: "work", member: "dev", org, repo, main, branchStat: " a.py | 2 +-\n" });
    expect(s).toContain("# Changes on your branch so far\na.py | 2 +-");
    expect(task(id, "work", "dev")).not.toContain("# Changes on your branch so far");
    expect(taskFor({ t, ticket: id, kind: "work", member: "dev", org, repo, main, branchStat: "  " })).not.toContain("# Changes on your branch");
    expect(sys("dev")).toContain("one or two sentences on the ticket's whole change on the branch");
  });
  it("the work summary is one or two sentences, except the verdict", () => {
    expect(sys("dev")).toContain("A verdict (acceptance, final) follows the format in your task.");
  });
  it("every session kind calls independent tools in one step", () => {
    for (const k of ["work", "review", "reply", "triage"] as const) expect(sys(k === "triage" ? "pm" : "tl", k)).toContain("Call independent tools in one step.");
  });
  it("finished blockers leave out the breakdown ticket", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Break down Core", kind: "breakdown", status: "done", assignee: "tl", milestone: "M1" }, "org"); // T-1
    t.createTicket({ title: "Parse", status: "in_progress", assignee: "dev", milestone: "M1" }, "org"); // T-2
    t.createTicket({ title: "Base", status: "done", assignee: "dev", milestone: "M1" }, "org"); // T-3
    t.addRelation("T-1", "T-2", "blocks", "org"); t.addRelation("T-3", "T-2", "blocks", "org");
    const sha = write({ "a.py": "a" });
    t.setMerged("T-1", sha, "org"); t.setMerged("T-3", sha, "org");
    const s = task("T-2", "work", "dev");
    expect(s).toContain("# Finished blockers\nT-3:");
    expect(s).not.toContain("T-1:");
  });
  it("the breakdown context leaves out canceled and duplicate tickets", () => {
    t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Break down Core", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M1" }, "org");
    t.createTicket({ title: "Keep", status: "triage", milestone: "M1" }, "org");
    t.createTicket({ title: "Gone", status: "canceled", milestone: "M1" }, "org");
    t.createTicket({ title: "Twin", status: "duplicate", milestone: "M1" }, "org");
    for (const [k, mem] of [["work", "tl"], ["review", "sa"]] as const) {
      const s = task("T-1", k, mem);
      expect(s).toContain("Tickets of M1:\nMAIHEM blocks every ticket below by this breakdown until it is approved; 'blocked by' shows only the other blockers.\nT-2 [triage] Keep");
      expect(s).not.toContain("Gone");
      expect(s).not.toContain("Twin");
    }
  });
  it("the triage cut follows the configured length", () => {
    t.createTicket({ title: "Crash", description: "x".repeat(50), status: "triage" }, "dev");
    const s = taskFor({ t, ticket: "", kind: "triage", member: "pm", org, repo, main, batch: ["T-1"], triageChars: 10 });
    expect(s).toContain(`(label other, from dev): ${"x".repeat(10)}\n`);
    expect(task("", "triage", "pm", ["T-1"])).toContain("x".repeat(50));
  });
});

describe("org prompt: system prompt rework", () => {
  const card = (r: string) => { const s = sys(r); const i = s.indexOf("# Your role"); return s.slice(i, s.indexOf("\n\n# ", i)); };
  it("the definition text comes after the role card under a Style heading", () => {
    const s = sys("dev");
    const order = ["# Writing", "# Org", "# How MAIHEM works", "# Your role", "# Style\nYou write TypeScript.", "# Work"].map((h) => s.indexOf(`${h}`));
    expect(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect(systemFor({ org, member: "ba", goal: "g", defs: {}, kind: "work" })).not.toContain("# Style");
  });
  it("HOW says the ticket tools are the moves that the status allows", () => {
    expect(sys("dev")).toContain("- Your ticket tools are the moves that the ticket's status allows. A ticket tool you do not have is not your move.");
  });
  it("HOW ends with the human above BA and SA", () => {
    expect(sys("dev")).toContain("- The human sits above BA and SA. The human approves the requirements and the final result, and answers what the grid cannot.\n\n# Your role");
  });
  it("the BA card owns the final acceptance and reviews SA's documents and the roadmap coverage", () => {
    expect(card("ba")).toContain("Owns: docs/business-requirements.md, docs/business-summary.txt and the final acceptance (the business verdict).");
    expect(card("ba")).toContain("Reviews: SA's documents and the roadmap coverage.");
  });
  it("BA and SA cards say other roles know their side only from their documents", () => {
    expect(card("ba")).toContain("Other roles know the business only from your documents.");
    expect(card("sa")).toContain("Other roles know the design only from your documents.");
    expect(sys("ba") + sys("sa")).not.toContain("The other roles see only your documents.");
  });
  it("the SA card owns the repo check after each milestone", () => {
    expect(card("sa")).toContain("Owns: docs/technical-requirements.md, docs/tech-summary.txt and the repo check after each milestone (.gitignore, no runtime data).");
  });
  it("the SA card asks for a test data setting", () => {
    expect(card("sa")).toContain("Name the setting that moves the app's data for tests (an env var or a flag). Every check runs the app with it.");
  });
  it("the work rules say an answer cannot run commands", () => {
    expect(sys("dev")).toContain("An answer cannot run commands. Do not ask others to run anything; run it yourself, or ask for a decision.");
  });
  it("the SA card leaves the command check to the summary ticket", () => {
    expect(card("sa")).toContain("Name commands that run on this host. The summary ticket after each milestone runs them with exec.");
  });
  it("the PM card creates tickets only for defects from an acceptance review", () => {
    expect(card("pm")).toContain("Create tickets only for defects you find in an acceptance review. Never write files or code.");
    expect(card("pm")).not.toContain("Never create tickets in Triage.");
  });
  it("the PM card routes business questions to BA and technical ones to TL", () => {
    expect(card("pm")).toContain("Questions: business to ba (it forwards to the human); technical to tl.");
    expect(card("pm")).not.toContain("every technical question");
  });
  it("the TL card reviews DEV tickets, the roadmap and the tech summary", () => {
    expect(card("tl")).toContain("Reviews: every DEV ticket (run the checks, read the diff), the roadmap feasibility and order, the tech summary after each milestone.");
  });
  it("the TL card routes technical questions to its manager and business ones to PM", () => {
    expect(card("tl")).toContain("Questions: technical to sa (it forwards to the human); business to pm.");
    expect(card("tl")).not.toContain("every business question");
    expect(card("dev")).toContain("Questions: ask tl; it forwards along the grid: DEV → TL → SA → human.");
  });
  it("the PM card decides Triage with an assignee and priority", () => {
    expect(card("pm")).toContain("Decides: Triage (accept into a milestone with an assignee, reject, duplicate) and priority.");
  });
  it("the work rules have one submit summary line", () => {
    const s = sys("dev");
    expect(s).toContain("- submit_review takes a summary: one or two sentences on the ticket's whole change on the branch and the decisions you made. A verdict (acceptance, final) follows the format in your task.");
    for (const x of ["submit_review needs a summary", "The summary is one or two sentences", "Your summary describes"]) expect(s).not.toContain(x);
  });
  it("the work rules let the author push back on a fixed or wrong finding", () => {
    expect(sys("dev")).toContain("- When a reviewer requested changes: fix each finding from the comments, then submit. When a finding is already fixed or wrong, say so in the summary and change nothing for it.");
  });
  it("the clean-repo rule fits DEV work, TL review and TL breakdown", () => {
    const s = (member: string, kind: Wake["kind"], ticketKind?: "breakdown") => systemFor({ org, member, goal: "g", defs, kind, ticketKind });
    expect(s("dev", "work")).toContain("- Keep the repo clean: no runtime data (databases, logs, backups, caches) in git. Manage .gitignore.");
    expect(s("tl", "review")).toContain("- Request changes when runtime data (databases, logs, backups, caches) is in git or .gitignore misses it.");
    expect(s("tl", "work", "breakdown")).toContain("- Plan .gitignore in the structure ticket: no runtime data (databases, logs, backups, caches) in git.");
    expect(s("tl", "review") + s("tl", "work", "breakdown")).not.toContain("Keep the repo clean");
  });
  it("a reviewer checks a finding against the current ticket and diff before repeating it", () => {
    expect(sys("tl", "review")).toContain("- Before you repeat a finding, check it against the current ticket text and diff. Drop it when it is fixed.");
    expect(sys("tl", "review")).not.toContain("check that each finding is fixed");
  });
  it("a reviewer requests changes only for defects", () => {
    expect(sys("tl", "review")).toContain("- Request changes only for a defect against the ticket or the requirements. Wording, format and citation style are not defects.");
  });
  it("triage accepts with an assignee and the system sets the reviewer", () => {
    const s = sys("pm", "triage");
    expect(s).toContain("- accept with a milestone (the active one when it must be done now, else a later one), a priority and an assignee (a DEV, BA or SA). The system sets the reviewer by the grid.");
    expect(s).not.toContain("A DEV ticket's reviewer is its TL");
  });
  it("every triage rule line is a bullet", () => {
    const s = sys("pm", "triage"), r = s.slice(s.indexOf("# Triage\n")).split("\n\n")[0].split("\n").slice(2);
    expect(r.length).toBeGreaterThan(3);
    for (const l of r) expect(l.startsWith("- ")).toBe(true);
  });
});

describe("org prompt: task prompt rework", () => {
  const reqs = () => {
    write(DOCS);
    const p = t.createTicket({ title: "Requirements", kind: "requirements", status: "in_progress", assignee: "ba", milestone: "M0" }, "org");
    const sa = t.createTicket({ title: "Technical requirements", parent: p.id, status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    const ba = t.createTicket({ title: "Business requirements", parent: p.id, status: "in_review", assignee: "ba", milestone: "M0" }, "org").id;
    return { sa, ba };
  };
  it("the BA's review of the technical requirements does not load the business summary", () => {
    const s = task(reqs().sa, "review", "ba");
    for (const x of ["BR-1 users import CSV", "TR-1 python 3.12", "TECH SUMMARY"]) expect(s).toContain(x);
    expect(s).not.toContain("BUSINESS SUMMARY");
  });
  it("a requirements review reads the documents in the task and calls review_diff only for an update", () => {
    const { sa, ba } = reqs(), l = "- The documents in this task are the branch version. Call review_diff only to see what an update changed.";
    for (const s of [task(sa, "review", "ba"), task(ba, "review", "sa")]) { expect(s).toContain(l); expect(s).not.toContain("- Call review_diff."); }
    const code = t.createTicket({ title: "Feature", status: "in_review", assignee: "dev", milestone: "M0" }, "org").id;
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    for (const s of [task(code, "review", "tl"), task(sum, "review", "tl")]) { expect(s).toContain("- Call review_diff."); expect(s).not.toContain(l); }
  });
  it("the roadmap asks to cover every in-scope requirement id", () => {
    t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_progress", assignee: "pm", milestone: "M0" }, "org");
    expect(task("T-1", "work", "pm")).toContain("Cover every in-scope requirement id once (not the out-of-scope ones).");
    t.setStatus("T-1", "in_review", "pm");
    expect(task("T-1", "review", "ba")).toContain("Check that the milestones cover every in-scope requirement id exactly once (not the out-of-scope ones).");
  });
  it("the TL roadmap review has no BR verb check", () => {
    const V = "Every BR verb has a command or interface that performs it.";
    const { sa } = reqs();
    const r = t.createTicket({ title: "Roadmap", kind: "roadmap", status: "in_review", assignee: "pm", milestone: "M0" }, "org").id;
    expect(task(r, "review", "tl")).not.toContain(V);
    expect(task(sa, "review", "ba")).toContain(V);
  });
  it("a breakdown ticket builds only the milestone's BR ids and may cite TRs of other milestones", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("- Each ticket builds only the milestone's BR ids. A cited TR may also serve BR ids of other milestones.");
    t.setStatus("T-1", "in_review", "tl");
    expect(task("T-1", "review", "sa")).toContain("Request changes for a ticket that builds work outside the milestone's BR ids.");
  });
  it("the breakdown plan says that the breakdown blocks every ticket", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_review", assignee: "tl", milestone: "M0" }, "org");
    t.createTicket({ title: "Parse", status: "triage", milestone: "M0" }, "org");
    expect(ticketText(t.getTicket("T-1"), t)).toContain("Tickets of M0:\nMAIHEM blocks every ticket below by this breakdown until it is approved; 'blocked by' shows only the other blockers.\nT-2 [triage] Parse");
  });
  it("the breakdown process and review define the structure ticket", () => {
    t.createTicket({ title: "Breakdown", kind: "breakdown", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    expect(task("T-1", "work", "tl")).toContain("Add a structure ticket (the ticket that creates the project layout: the package, its entry point and the test setup) only when no structure exists.");
    t.setStatus("T-1", "in_review", "tl");
    expect(task("T-1", "review", "sa")).toContain("When a structure ticket (the ticket that creates the project layout) exists, check that it blocks the tickets that add to it.");
  });
  it("a ticket view shows only the latest change request in full", () => {
    t.createTicket({ title: "Login", status: "in_progress", assignee: "dev" }, "org");
    t.addComment("T-1", "tl requests changes:\n1. a\n2. b", "tl");
    t.addComment("T-1", "dev asks tl: why?", "dev");
    t.addComment("T-1", "tl requests changes:\n1. c", "tl");
    t.addComment("T-1", "tl requested changes 3 times; the review does not converge. Last findings:\n1. d\nAnswer with a decision; the ticket goes back to dev in progress.", "tl");
    t.addComment("T-1", "tl requests changes:\n1. e\n2. f\n3. g", "tl");
    const s = ticketText(t.getTicket("T-1"), t);
    expect(s).toContain("Comments:\ntl requested changes (round 1): 2 findings\ndev asks tl: why?\ntl requested changes (round 2): 1 findings\n"
      + "tl requested changes 3 times; the review does not converge.\nAnswer with a decision; the ticket goes back to dev in progress.\n"
      + "tl requests changes:\n1. e\n2. f\n3. g");
  });
  it("a code review checks each acceptance criterion", () => {
    const l = "- Check each acceptance criterion: the diff or a check must show it is met. Request changes for each one that is not.";
    const { sa } = reqs();
    const code = t.createTicket({ title: "Feature", status: "in_review", assignee: "dev", milestone: "M0" }, "org").id;
    const sum = t.createTicket({ title: "Tech summary", kind: "summary", status: "in_review", assignee: "sa", milestone: "M0" }, "org").id;
    expect(task(code, "review", "tl")).toContain(l);
    for (const s of [task(sa, "review", "ba"), task(sum, "review", "tl")]) expect(s).not.toContain(l);
  });
  it("the TL acceptance checks the milestone's TRs on main", () => {
    write(DOCS);
    t.createTicket({ title: "Accept", kind: "acceptance", status: "in_progress", assignee: "tl", milestone: "M0" }, "org");
    const s = task("T-1", "work", "tl");
    expect(s).toContain("TR-1 python 3.12");
    expect(s).toContain("- Compare the result with the tech summary and each ticket's acceptance criteria.\n- Check on main each TR that serves the milestone's BR ids, not only the tickets. A TR that is not met is a defect: ticket_create.");
  });
  it("the tech summary process runs the commands it names", () => {
    t.createTicket({ title: "Tech summary", kind: "summary", status: "in_progress", assignee: "sa", milestone: "M0" }, "org");
    expect(task("T-1", "work", "sa")).toContain("Keep it under 4000 characters.\n- Run the commands the tech summary names (exec). Fix any command that fails on this host.");
  });
  it("the final technical check goes through the TRs one by one", () => {
    t.createTicket({ title: "Final", kind: "final", status: "in_review", assignee: "ba", milestone: "M0" }, "org");
    expect(task("T-1", "review", "sa")).toContain("Technical check: run the checks on main. Go through the TRs one by one; for each interface TR, run the program on main, not only the tests.");
  });
  it("a reply loads its role's reply context whatever the ticket kind", () => {
    write(DOCS);
    t.createTicket({ title: "Accept", kind: "acceptance", status: "needs_reply", assignee: "pm", milestone: "M0" }, "org");
    const pm = task("T-1", "reply", "pm");
    expect(pm).toContain("BR-1 users import CSV");
    expect(pm).toContain("# Roadmap");
    for (const x of ["# Triage", "# Ticket summaries"]) expect(pm).not.toContain(x);
    t.createTicket({ title: "Plan", kind: "breakdown", status: "needs_reply", assignee: "tl", milestone: "M0" }, "org");
    const tl = task("T-2", "reply", "tl");
    for (const x of ["TECH SUMMARY", "TR-1 python 3.12"]) expect(tl).toContain(x);
    for (const x of ["# Done so far", "# Files on main"]) expect(tl).not.toContain(x);
  });
});
