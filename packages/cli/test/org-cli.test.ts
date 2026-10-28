import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { main } from "../src/main.ts";
import { deps } from "../src/run.ts";
import { saveOrg } from "../src/org/store.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import { dbFile, orgDir, pidFile } from "../src/org/daemon.ts";
import { boardData, EVENT_KINDS, formatEvent } from "../src/org/cli.ts";
import type { OrgEvent } from "../src/org/types.ts";
import { validateOrg } from "../src/org/config.ts";
import { saveDefinition } from "../src/registry.ts";

const unmount = vi.fn();
vi.mock("ink", async (orig) => ({
  ...(await orig<typeof import("ink")>()),
  // ponytail: fake mount that leaves at once; the Board itself is covered by ui-board.test.ts
  render: vi.fn((el: { props: { read: () => unknown; onExit: () => void } }) => { el.props.read(); setTimeout(el.props.onExit, 0); return { unmount }; }),
}));

let home: string, log: ReturnType<typeof vi.spyOn>, err: ReturnType<typeof vi.spyOn>;
const out = () => log.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
const errs = () => err.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 8);
const ev = (kind: string, actor: string, data: Record<string, unknown> = {}, ticket?: string): OrgEvent => ({ id: 1, at: 0, kind, actor, ticket, data });
const m = (role: string, reports_to?: string) => ({ role, definition: "d1", ...(reports_to ? { reports_to } : {}) });
const MEMBERS = { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev") };
const org = (repo: string) => saveOrg(validateOrg({ name: "acme", repo, members: MEMBERS }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-")); process.env.MAIHEM_HOME = home;
  org("~/r");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); deps.pollMs = 100; });

// an org db with the org running (the pid file names this process)
const seed = (now?: () => number): Tracker => {
  fs.mkdirSync(orgDir("acme"), { recursive: true });
  fs.writeFileSync(pidFile("acme"), String(process.pid));
  return openTracker(dbFile("acme"), now);
};
const stopped = () => fs.rmSync(pidFile("acme"));
let repo = "";
const startable = () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "oc-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  saveDefinition({ name: "d1", provider: "p", model: "m", tools: [], sandbox: false, max_steps: 5 } as never);
  org(repo);
};

describe("org cli: run", () => {
  it("org start spawns the org daemon and refuses a running org", async () => {
    startable();
    const spawn = vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref() {} } as never);
    expect(await main(["org", "start", "acme", "build it"])).toBe(0);
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/bin[\\/]maihem\.js$/), "__org", "acme"]);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(JSON.parse(fs.readFileSync(path.join(orgDir("acme"), "start.json"), "utf8"))).toEqual({ goal: "build it" });
    expect(fs.readFileSync(pidFile("acme"), "utf8")).toBe("4242");
    expect(out()).toBe(`created an initial commit in ${repo}\nstarted org acme; watch: maihem org board acme`);
    fs.writeFileSync(pidFile("acme"), String(process.pid));
    expect(await main(["org", "start", "acme", "again"])).toBe(1);
    expect(errs()).toContain("org acme is already running");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await main(["org", "start", "nope", "g"])).toBe(1);
    expect(await main(["org", "start", "acme"])).toBe(1);
  });

  it("org resume spawns the daemon with --resume and refuses a running org", async () => {
    startable();
    const t = seed(); t.setMeta("state", { status: "stopped" }); t.close(); stopped();
    fs.writeFileSync(path.join(orgDir("acme"), "start.json"), JSON.stringify({ goal: "first" }));
    const spawn = vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref() {} } as never);
    expect(await main(["org", "resume", "acme"])).toBe(0);
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/bin[\\/]maihem\.js$/), "__org", "acme", "--resume"]);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(JSON.parse(fs.readFileSync(path.join(orgDir("acme"), "start.json"), "utf8"))).toEqual({ goal: "first" });
    expect(fs.readFileSync(pidFile("acme"), "utf8")).toBe("4242");
    fs.writeFileSync(pidFile("acme"), String(process.pid));
    expect(await main(["org", "resume", "acme"])).toBe(1);
    expect(errs()).toContain("org acme is already running");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("org resume refuses an org with no tracker or a done org", async () => {
    startable();
    const spawn = vi.spyOn(deps, "spawn").mockReturnValue({ pid: 4242, unref() {} } as never);
    expect(await main(["org", "resume", "acme"])).toBe(1);
    expect(errs()).toContain("maihem org start acme");
    const t = seed(); t.setMeta("state", { status: "done" }); t.close(); stopped();
    expect(await main(["org", "resume", "acme"])).toBe(1);
    expect(errs()).toContain("org acme is done");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("org start refuses a repo dir that does not exist", async () => {
    const spawn = vi.spyOn(deps, "spawn");
    saveDefinition({ name: "d1", provider: "p", model: "m", tools: [], sandbox: false, max_steps: 5 } as never);
    expect(await main(["org", "start", "acme", "g"])).toBe(1);
    expect(errs()).toContain(`org "acme": repo ${path.join(os.homedir(), "r")} does not exist`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("org stop signals the daemon", async () => {
    expect(await main(["org", "stop", "acme"])).toBe(1);
    expect(errs()).toContain("org acme is not running");
    fs.mkdirSync(orgDir("acme"), { recursive: true });
    fs.writeFileSync(pidFile("acme"), "4242");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await main(["org", "stop", "acme"])).toBe(0);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(out()).toBe("stopped org acme");
  });

  it("commands on an org that never ran show the start hint", async () => {
    for (const c of [["inbox"], ["log"], ["board"], ["ticket", "T-1"], ["tickets"], ["milestones"], ["answer", "T-1", "x"], ["cancel", "T-1", "x"], ["assign", "T-1", "dev1"], ["approve", "Q-1"], ["reject", "Q-1", "-m", "x"]]) {
      err.mockClear();
      expect(await main(["org", c[0], "acme", ...c.slice(1)])).toBe(1);
      expect(errs()).toContain('org acme has not run yet; start it: maihem org start acme "GOAL"');
    }
  });
});

describe("org cli: log", () => {
  it("org log prints formatted events", async () => {
    const t = seed();
    t.createTicket({ title: "Login", assignee: "dev1" }, "pm");
    t.setMeta("state", { status: "done" });
    const [first] = t.events();
    t.close();
    expect(await main(["org", "log", "acme"])).toBe(0);
    expect(out()).toBe(`${hhmm(first.at)} pm ticket.created T-1 "Login" @dev1`);
    log.mockClear();
    deps.pollMs = 1;
    expect(await main(["org", "log", "acme", "-f"])).toBe(0);
    expect(out()).toContain("ticket.created");
  });

  it("org log -f follows new events until the org stops", async () => {
    const t = seed();
    t.setMeta("state", { status: "running" });
    deps.pollMs = 1;
    const p = main(["org", "log", "acme", "-f"]);
    setTimeout(() => { t.log("org.paused", "org", { reason: "tokens" }); t.setMeta("state", { status: "stopped" }); }, 20);
    expect(await p).toBe(0);
    expect(out()).toContain("org org.paused tokens");
    t.close();
  });

  it("formatEvent shows the first line of multi-line text", () => {
    const f = (e: OrgEvent) => formatEvent(e).replace(/^\d\d:\d\d:\d\d /, "");
    expect(f(ev("ticket.comment", "pm", { comment: 1, text: "one\ntwo" }, "T-1"))).toBe("pm ticket.comment T-1 one …");
    expect(f(ev("git.error", "org", { op: "merge", message: "bad\nworse" }, "T-1"))).toBe("org git.error T-1 merge: bad …");
    expect(f(ev("org.paused", "org", { reason: "why\nnot" }))).toBe("org org.paused why …");
  });

  it("log --ticket shows one ticket's history", async () => {
    const t = seed();
    t.createTicket({ title: "A" }, "pm");
    t.createTicket({ title: "B" }, "pm");
    t.addComment("T-2", "hi", "tl");
    t.setMeta("state", { status: "done" });
    t.close();
    expect(await main(["org", "log", "acme", "--ticket", "T-2"])).toBe(0);
    expect(out()).toMatch(/^\S+ pm ticket.created T-2 "B"\n\S+ tl ticket.comment T-2 hi$/);
    log.mockClear();
    deps.pollMs = 1;
    expect(await main(["org", "log", "acme", "-f", "--ticket", "T-1"])).toBe(0);
    expect(out()).toMatch(/^\S+ pm ticket.created T-1 "A"$/);
  });

  it("formatEvent shows a ticket summary as its first line", () => {
    const f = (e: OrgEvent) => formatEvent(e).replace(/^\d\d:\d\d:\d\d /, "");
    expect(f(ev("ticket.summary", "ba", { summary: "Wrote docs/business-requirements.md (goal,\nscope)" }, "T-2"))).toBe("ba ticket.summary T-2 Wrote docs/business-requirements.md (goal, …");
  });

  it("formatEvent covers every event kind", () => {
    const f = (e: OrgEvent, t?: string) => formatEvent(e, t).replace(/^\d\d:\d\d:\d\d /, "");
    expect(formatEvent(ev("x", "a"))).toMatch(/^\d\d:\d\d:\d\d a x$/);
    const table: [OrgEvent, string, string?][] = [
      [ev("ticket.created", "pm", { kind: "normal", assignee: "dev1", parent: "T-1", milestone: "M1" }, "T-2"), 'pm ticket.created T-2 "Hi" @dev1 under T-1 in M1', "Hi"],
      [ev("ticket.created", "pm", {}, "T-2"), "pm ticket.created T-2"],
      [ev("ticket.status", "dev1", { from: "todo", to: "in_progress" }, "T-1"), "dev1 ticket.status T-1 todo → in_progress"],
      [ev("ticket.assigned", "pm", { from: null, to: "dev1" }, "T-1"), "pm ticket.assigned T-1 unassigned → @dev1"],
      [ev("ticket.assigned", "pm", { from: "dev1", to: null }, "T-1"), "pm ticket.assigned T-1 @dev1 → unassigned"],
      [ev("ticket.priority", "pm", { priority: 3, ord: 2 }, "T-1"), "pm ticket.priority T-1 P3"],
      [ev("ticket.milestone", "pm", { from: null, to: "M1" }, "T-1"), "pm ticket.milestone T-1 - → M1"],
      [ev("ticket.description", "ba", { by: "ba" }, "T-1"), "ba ticket.description T-1 edited"],
      [ev("ticket.gate", "org", { gate: "pending" }, "T-1"), "org ticket.gate T-1 gate pending"],
      [ev("ticket.gate", "org", { gate: null }, "T-1"), "org ticket.gate T-1 gate cleared"],
      [ev("ticket.branch", "org", { branch: "t-1-a" }, "T-1"), "org ticket.branch T-1 ⎇ t-1-a"],
      [ev("ticket.merged", "org", { commit: "abcdef0123" }, "T-1"), "org ticket.merged T-1 abcdef0"],
      [ev("approval.set", "tl", { reviewer: "tl", state: "approved" }, "T-1"), "tl approval.set T-1 tl approved"],
      [ev("approval.removed", "org", { reviewer: "tl" }, "T-1"), "org approval.removed T-1 tl removed"],
      [ev("relation.added", "sa", { from: "T-1", to: "T-2", kind: "blocks" }, "T-1"), "sa relation.added T-1 blocks T-2"],
      [ev("relation.removed", "sa", { from: "T-1", to: "T-2", kind: "blocks" }, "T-1"), "sa relation.removed T-1 blocks T-2"],
      [ev("milestone.created", "ba", { id: "M1", name: "Core" }), "ba milestone.created M1 Core"],
      [ev("milestone.renamed", "ba", { id: "M1", name: "Base" }), "ba milestone.renamed M1 Base"],
      [ev("milestone.updated", "pm", { id: "M1", description: "BR-6" }), "pm milestone.updated M1 BR-6"],
      [ev("milestone.reordered", "ba", { order: ["M0", "M2", "M1"] }), "ba milestone.reordered M0, M2, M1"],
      [ev("milestone.deleted", "ba", { id: "M3" }), "ba milestone.deleted M3"],
      [ev("milestone.completed", "org", { id: "M0" }), "org milestone.completed M0"],
      [ev("inbox.opened", "org", { id: "Q-1", kind: "approval" }), "org inbox.opened Q-1 approval"],
      [ev("inbox.answered", "user", { id: "Q-1", kind: "approval", approved: true }), "user inbox.answered Q-1 approved"],
      [ev("inbox.answered", "user", { id: "Q-1", kind: "approval", approved: false }), "user inbox.answered Q-1 rejected"],
      [ev("review.done", "org", {}, "T-1"), "org review.done T-1 all reviewers approved"],
      [ev("review.undecided", "org", { member: "tl" }, "T-1"), "org review.undecided T-1 tl ended without a decision"],
      [ev("git.init", "org", { repo: "/r" }), "org git.init /r"],
      [ev("git.merged", "org", { branch: "t-3-a", commit: "abcdef0123" }, "T-3"), "org git.merged T-3 merged abcdef0"],
      [ev("git.merged", "org", { branch: "t-5-a", commit: null }, "T-5"), "org git.merged T-5 merged (no changes)"],
      [ev("git.conflict", "org", { files: ["a", "b"] }, "T-3"), "org git.conflict T-3 conflict: a, b"],
      [ev("git.discarded", "org", { member: "ba", files: ["a", "b"] }, "T-3"), "org git.discarded T-3 discarded a, b (ba)"],
      [ev("session.started", "dev1", { member: "dev1", id: "s1", kind: "work" }, "T-1"), "dev1 session.started T-1 work"],
      [ev("session.ended", "ba", { member: "ba", tokens: 7 }), "ba session.ended 7 tokens"],
      [ev("session.ended", "ba", { member: "ba", tokens: 13534, input: 12345, output: 1189 }, "T-3"), "ba session.ended T-3 12.3k in / 1.2k out"],
      [ev("session.failed", "dev1", { error: "boom\nstack", status: 429 }, "T-3"), "dev1 session.failed T-3 HTTP 429 boom …"],
      [ev("session.failed", "dev1", { error: "boom" }, "T-3"), "dev1 session.failed T-3 boom"],
      [ev("session.capped", "dev1", { steps: 50 }, "T-3"), "dev1 session.capped T-3 step cap 50"],
      [ev("org.started", "org"), "org org.started"],
      [ev("org.paused", "org", { reason: "tokens 5 > 4" }), "org org.paused tokens 5 > 4"],
      [ev("org.resumed", "org"), "org org.resumed"],
      [ev("org.done", "org"), "org org.done"],
      [ev("org.stopped", "org"), "org org.stopped"],
      [ev("weird", "x", { a: 1 }), 'x weird {"a":1}'],
    ];
    for (const [e, want, title] of table) expect(f(e, title)).toBe(want);
  });

  it("formatEvent shows git.tagged and git.push_failed readably", () => {
    const f = (e: OrgEvent) => formatEvent(e).replace(/^\d\d:\d\d:\d\d /, "");
    expect(f(ev("git.tagged", "org", { milestone: "M0", tag: "M0" }))).toBe("org git.tagged M0 tagged M0");
    expect(f(ev("git.push_failed", "org", { milestone: "M1", tag: "M1", message: "no remote\nhint" }))).toBe("org git.push_failed push of M1 failed: no remote …");
    expect(f(ev("org.started", "org", { goal: "build it\nwell" }))).toBe("org org.started build it …");
    expect(f(ev("org.stopped", "org", { reason: "M1 rejected" }))).toBe("org org.stopped M1 rejected");
  });

  it("every logged event kind has a formatter", () => {
    const dir = path.join(import.meta.dirname, "../src");
    const files = [...fs.readdirSync(path.join(dir, "org")).map((f) => path.join(dir, "org", f)), path.join(dir, "daemon.ts")].filter((f) => f.endsWith(".ts"));
    const kinds = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // log("k" / tracker.log("k", change(..., "k", comment(..., "k", flow { event: "k" }, and finish("x") → org.x
      for (const [, k] of src.matchAll(/\b(?:log|change|comment)\([^;]*?"([a-z]+\.[a-z_]+)"/g)) kinds.add(k);
      for (const [, k] of src.matchAll(/event: "([a-z]+\.[a-z_]+)"/g)) kinds.add(k);
      for (const [, k] of src.matchAll(/\bfinish\("([a-z]+)"/g)) kinds.add(`org.${k}`);
    }
    expect(kinds.size).toBeGreaterThan(40);
    expect([...kinds].filter((k) => !EVENT_KINDS.includes(k))).toEqual([]);
  });

  it("formatEvent shows comments, questions, titles and assignee changes", () => {
    const f = (e: OrgEvent) => formatEvent(e).replace(/^\d\d:\d\d:\d\d /, "");
    expect(f(ev("ticket.comment", "tl", { comment: 3, text: "why?" }, "T-1"))).toBe("tl ticket.comment T-1 why?");
    expect(f(ev("ticket.question", "dev1", { asker: "dev1", status: "in_progress", assignee: "dev1" }, "T-1"))).toBe("dev1 ticket.question T-1 dev1 asks, back to @dev1 in_progress");
    expect(f(ev("ticket.question", "tl", { cleared: true }, "T-1"))).toBe("tl ticket.question T-1 answered");
    expect(f(ev("ticket.title", "pm", { from: "Old", to: "New" }, "T-1"))).toBe('pm ticket.title T-1 "Old" → "New"');
    expect(f(ev("ticket.assigned", "dev1", { from: "dev1", to: "tl" }, "T-1"))).toBe("dev1 ticket.assigned T-1 @dev1 → @tl");
    for (const k of ["thread.opened", "thread.comment", "org.reconciled", "org.stalled"]) expect(EVENT_KINDS).not.toContain(k);
  });

  it("a triage session shows as triage in the log", () => {
    const f = (e: OrgEvent) => formatEvent(e).replace(/^\d\d:\d\d:\d\d /, "");
    expect(f(ev("session.started", "pm", { member: "pm", id: "s1", kind: "triage" }, ""))).toBe("pm session.started triage");
    expect(f(ev("session.started", "pm", { member: "pm", id: "s1" }))).toBe("pm session.started triage");
    expect(f(ev("session.ended", "pm", { member: "pm", tokens: 3, input: 2000, output: 1000, text: "ok" }, ""))).toBe("pm session.ended triage 2k in / 1k out");
    expect(f(ev("session.failed", "pm", { error: "boom" }, ""))).toBe("pm session.failed triage boom");
  });
});

describe("org cli: board", () => {
  it("org board mounts the board, reads the run and closes on exit", async () => {
    seed().close();
    expect(await main(["org", "board", "acme"])).toBe(0);
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it("board data collects usage, milestones, tickets, members, sessions, queue, inbox and recent events", () => {
    const t = seed();
    t.setMeta("goal", "g1"); t.setMeta("state", { status: "running" });
    t.setMeta("sessions", { ba: { id: "s", ticket: "T-1", kind: "work" } }); t.setMeta("queue", [{ member: "sa", ticket: "T-2", kind: "review" }]);
    t.createMilestone("Requirements", "", "org"); t.createMilestone("Core", "", "org");
    t.createTicket({ title: "One", status: "done", milestone: "M0" }, "org");
    t.createTicket({ title: "Two", status: "in_review", milestone: "M1" }, "org");
    t.createTicket({ title: "Three", status: "todo", milestone: "M1" }, "org");
    t.addRelation("T-2", "T-3", "blocks", "sa");
    t.setApproval("T-2", "tl", "approved", "dev1");
    t.ask("ship?", "org");
    t.createTicket({ title: "Four", status: "needs_reply", assignee: "human" }, "org");
    t.addComment("T-4", "dev1 asks human: which db?", "dev1");
    t.setMeta("waiting", true);
    t.log("session.ended", "ba", { tokens: 7, input: 5, output: 2 });
    t.log("session.ended", "ba", { tokens: 30, input: 20, output: 10 });
    t.log("session.ended", "pm", { tokens: 4, input: 3, output: 1 });
    t.log("session.ended", "pm", { tokens: 4 });
    const d = boardData("acme", t);
    t.close();
    expect(d.usage).toEqual({ input: 28, output: 13 });
    expect(d.memberUsage).toEqual({ ba: { input: 25, output: 12 }, pm: { input: 3, output: 1 } });
    expect(d).toMatchObject({ org: "acme", goal: "g1", state: { status: "running" }, sessions: { ba: { ticket: "T-1" } }, queue: [{ member: "sa" }] });
    expect(d.members).toEqual([{ name: "ba", role: "ba" }, { name: "sa", role: "sa" }, { name: "pm", role: "pm" }, { name: "tl", role: "tl" }, { name: "dev1", role: "dev" }]);
    expect(d.milestones).toEqual([{ id: "M0", name: "Requirements", completion: 100, active: false }, { id: "M1", name: "Core", completion: 25, active: true }]);
    expect(d.tickets.map((x) => [x.id, x.blocked, x.approvals.map((a) => a.reviewer)])).toEqual([["T-1", false, []], ["T-2", false, ["tl"]], ["T-3", true, []], ["T-4", false, []]]);
    expect(d.inbox.map((i) => i.id)).toEqual(["Q-1"]);
    expect(d.human).toEqual([{ id: "T-4", title: "Four", question: "dev1 asks human: which db?" }]);
    expect(d.waiting).toBe(true);
    expect(d.recent.find((l) => l.includes("ticket.created T-1"))).toContain('"One"');
    expect(d.recent.length).toBeLessThanOrEqual(20);
  });

  it("board data has the running time without pauses", () => {
    let clock = 0;
    const t = seed(() => clock), at = (n: number) => { clock = n; };
    t.setMeta("state", { status: "running" });
    at(1000); t.log("org.started", "org");
    at(2000); t.log("org.paused", "org");
    at(5000); t.log("org.resumed", "org");
    at(6000); t.log("org.stopped", "org");
    at(8000); t.log("org.started", "org");
    expect(boardData("acme", t, 10000).time).toEqual({ running: 4000 });
    t.setMeta("state", { status: "stopped" }); at(11000); t.log("org.stopped", "org");
    expect(boardData("acme", t, 20000).time).toEqual({ running: 5000 });
    t.close();
  });

  it("a member with a running session shows how long the session has run", () => {
    const t = seed(() => 1234);
    t.log("session.started", "ba", { member: "ba", id: "s" });
    t.setMeta("sessions", { ba: { id: "s", ticket: "T-1", kind: "work" } }); t.setMeta("tokenLimit", 50);
    const d = boardData("acme", t);
    t.close();
    expect(d.sessions.ba.started).toBe(1234);
    expect(d.tokenLimit).toBe(50);
  });

  it("board data has defaults before the runner writes meta", () => {
    const t = seed();
    const d = boardData("acme", t);
    t.close();
    expect(d).toMatchObject({ goal: "", state: { status: "-" }, time: { running: 0 }, sessions: {}, queue: [], milestones: [], tickets: [], human: [], waiting: false });
  });
});

describe("org cli: inbox and answers", () => {
  it("inbox lists approvals and tickets that wait for the human", async () => {
    const t = seed();
    expect(await main(["org", "inbox", "acme"])).toBe(0);
    expect(out()).toBe("inbox empty");
    t.createTicket({ title: "A", status: "needs_reply", assignee: "human" }, "org");
    t.addComment("T-1", "old", "org");
    t.addComment("T-1", "ba asks human: which db?\nmore", "ba");
    t.createTicket({ title: "B", status: "needs_reply", assignee: "tl" }, "org");
    t.ask("Approve the requirements", "org", { files: ["docs/a.md", "docs/b.md"] });
    t.close();
    log.mockClear();
    expect(await main(["org", "inbox", "acme"])).toBe(0);
    expect(out()).toBe([
      "Q-1  approval  org  -  Approve the requirements  docs/a.md, docs/b.md",
      "  maihem org approve acme Q-1 | maihem org reject acme Q-1 -m TEXT",
      "T-1  A  ba asks human: which db? …",
      "  maihem org answer acme T-1 TEXT",
    ].join("\n"));
  });

  it("org inbox prints the tickets waiting for the human when no approval is open", async () => {
    const t = seed();
    t.createTicket({ title: "A", status: "needs_reply", assignee: "human" }, "org");
    t.addComment("T-1", "ba asks human: which db?", "ba");
    t.close();
    expect(await main(["org", "inbox", "acme"])).toBe(0);
    expect(out()).toBe(["T-1  A  ba asks human: which db?", "  maihem org answer acme T-1 TEXT"].join("\n"));
  });

  it("org inbox prints the approvals when no ticket waits for the human", async () => {
    const t = seed();
    t.ask("Approve the requirements", "org");
    t.close();
    expect(await main(["org", "inbox", "acme"])).toBe(0);
    expect(out()).toBe(["Q-1  approval  org  -  Approve the requirements", "  maihem org approve acme Q-1 | maihem org reject acme Q-1 -m TEXT"].join("\n"));
  });

  it("answer gives the human's answer to a ticket that waits for the human", async () => {
    const t = seed();
    t.createTicket({ title: "A", status: "in_progress", assignee: "dev1" }, "org");
    t.createTicket({ title: "B", status: "in_progress", assignee: "dev1" }, "org");
    const o = await import("../src/org/ops.ts").then((x) => x.createOps(t, { name: "acme", repo: "~/r", members: MEMBERS } as never));
    o.parkForHuman("T-1", "stuck");
    o.parkForHuman("T-2", "stuck");
    expect(await main(["org", "answer", "acme", "T-1", "use postgres"])).toBe(0);
    expect(t.getTicket("T-1")).toMatchObject({ status: "in_progress", assignee: "dev1" });
    expect(t.getTicket("T-1").comments.at(-1)).toMatchObject({ author: "user", text: "user answers: use postgres" });
    expect(await main(["org", "answer", "acme", "T-2", ""])).toBe(0);
    expect(t.getTicket("T-2").comments.at(-1)?.text).toBe("user answers: try again");
    expect(out()).toBe("answered T-1; it is in_progress again\nanswered T-2; it is in_progress again");
    expect(await main(["org", "answer", "acme", "T-1", "x"])).toBe(1);
    expect(errs()).toContain("T-1 is in_progress");
    expect(await main(["org", "answer", "acme", "T-1"])).toBe(1);
    t.close();
  });

  it("cancel and assign act as the human", async () => {
    const t = seed();
    t.createTicket({ title: "A", status: "todo", assignee: "dev1" }, "org");
    t.createTicket({ title: "B", status: "todo" }, "org");
    expect(await main(["org", "assign", "acme", "T-2", "tl"])).toBe(0);
    expect(t.getTicket("T-2").assignee).toBe("tl");
    expect(await main(["org", "cancel", "acme", "T-1", "not needed"])).toBe(0);
    expect(t.getTicket("T-1").status).toBe("canceled");
    expect(t.events().filter((e) => e.actor === "user").length).toBeGreaterThan(1);
    expect(out()).toBe("assigned T-2 to tl\ncanceled T-1");
    expect(await main(["org", "assign", "acme", "T-2", "nobody"])).toBe(1);
    expect(await main(["org", "cancel", "acme", "T-2"])).toBe(1);
    t.close();
  });

  it("org approve and reject answer approvals", async () => {
    const t = seed();
    for (const q of ["ship?", "again?", "third?"]) t.ask(q, "org");
    expect(await main(["org", "approve", "acme", "Q-1"])).toBe(0);
    expect(await main(["org", "approve", "acme", "Q-2", "-m", "fine"])).toBe(0);
    expect(await main(["org", "reject", "acme", "Q-3"])).toBe(1);
    expect(await main(["org", "reject", "acme", "Q-3", "-m", "no"])).toBe(0);
    expect(t.inbox().map((i) => [i.answer, i.approved])).toEqual([["approved", true], ["fine", true], ["no", false]]);
    t.close();
  });

  it("answering an item of a stopped org fails", async () => {
    const t = seed();
    t.ask("ship it?", "org");
    t.close();
    stopped();
    for (const c of [["approve", "Q-1"], ["answer", "T-1", "x"], ["cancel", "T-1", "x"], ["assign", "T-1", "dev1"]]) {
      err.mockClear();
      expect(await main(["org", c[0], "acme", ...c.slice(1)])).toBe(1);
      expect(errs()).toContain('org acme is not running; start it: maihem org start acme "GOAL"');
    }
  });
});

describe("org cli: tickets and milestones", () => {
  it("the ticket view lists comments and history", async () => {
    const t = seed();
    t.createMilestone("Requirements", "", "org"); t.createMilestone("Core", "", "org");
    t.createTicket({ title: "Parent", status: "in_progress", milestone: "M1" }, "org");
    t.createTicket({ title: "Login form", description: "Build the form.\nWith tests.", status: "in_review", label: "bug", priority: 3, milestone: "M1", assignee: "dev1", parent: "T-1" }, "pm");
    t.createTicket({ title: "Child", status: "todo", milestone: "M1", parent: "T-2" }, "org");
    for (const x of ["Blocker", "Blocked", "Related", "Twin"]) t.createTicket({ title: x }, "org");
    t.addRelation("T-4", "T-2", "blocks", "sa"); t.addRelation("T-2", "T-5", "blocks", "sa");
    t.addRelation("T-2", "T-6", "related", "pm"); t.addRelation("T-7", "T-2", "duplicate", "pm");
    t.setApproval("T-2", "tl", "approved", "dev1"); t.setApproval("T-2", "sa", "pending", "dev1");
    t.setBranch("T-2", "t-2-login-form", "org"); t.setMerged("T-2", "abcdef0123", "org");
    t.addComment("T-2", "use a grid?", "tl");
    t.addComment("T-2", "done\nwith tests", "dev1");
    t.close();
    expect(await main(["org", "ticket", "acme", "T-2"])).toBe(0);
    const s = out();
    expect(s).toContain("T-2 Login form");
    for (const l of ["status       in_review", "kind         normal", "label        bug", "priority     high", "milestone    M1", "owner        pm", "assignee     dev1",
      "reviewers    tl approved, sa pending", "parent       T-1", "sub-tickets  T-3", "blocked by   T-4", "blocks       T-5", "related      T-6", "duplicates   T-7",
      "branch       t-2-login-form", "merged       abcdef0"]) expect(s).toContain(l);
    expect(s).toContain("Build the form.\nWith tests.");
    expect(s).toContain("comments\n  tl: use a grid?\n  dev1: done\n    with tests");
    expect(s).toMatch(/history\n\d\d:\d\d:\d\d pm ticket.created T-2 "Login form" @dev1 under T-1 in M1/);
    expect(s).toContain("dev1 ticket.comment T-2 done …");
    expect(s).not.toContain("ticket.created T-1");
    log.mockClear();
    expect(await main(["org", "ticket", "acme", "T-4"])).toBe(0);
    expect(out()).toContain("assignee     -");
    expect(out()).toContain("(no description)");
    expect(await main(["org", "ticket", "acme", "T-99"])).toBe(1);
    expect(errs()).toContain("no such ticket: T-99");
  });

  it("org tickets prints one line per ticket, filtered by milestone and status", async () => {
    const t = seed();
    expect(await main(["org", "tickets", "acme"])).toBe(0);
    expect(out()).toBe("no tickets");
    t.createMilestone("Requirements", "", "org");
    t.createTicket({ title: "One", status: "todo", milestone: "M0", assignee: "ba", priority: 2 }, "org");
    t.createTicket({ title: "Two" }, "pm");
    t.close();
    log.mockClear();
    expect(await main(["org", "tickets", "acme"])).toBe(0);
    expect(out()).toBe("T-1  todo    P2  M0  @ba  One\nT-2  triage  P0  -   -    Two");
    log.mockClear();
    expect(await main(["org", "tickets", "acme", "--milestone", "M0"])).toBe(0);
    expect(out()).toBe("T-1  todo  P2  M0  @ba  One");
    log.mockClear();
    expect(await main(["org", "tickets", "acme", "--status", "triage"])).toBe(0);
    expect(out()).toBe("T-2  triage  P0  -  -  Two");
  });

  it("org tickets refuses an unknown status and names the statuses", async () => {
    seed().close();
    expect(await main(["org", "tickets", "acme", "--status", "backlog"])).toBe(1);
    expect(errs()).toContain("unknown status backlog; use one of triage, needs_reply, todo, in_progress, in_review, done, canceled, duplicate");
  });

  it("org milestones shows completion and ticket counts and marks the active one", async () => {
    const t = seed();
    expect(await main(["org", "milestones", "acme"])).toBe(0);
    expect(out()).toBe("no milestones");
    t.createMilestone("Requirements", "", "org"); t.createMilestone("Core", "", "org"); t.createMilestone("Polish", "", "org");
    t.createTicket({ title: "A", status: "done", milestone: "M0" }, "org");
    t.createTicket({ title: "B", status: "done", milestone: "M1" }, "org");
    t.createTicket({ title: "C", status: "in_progress", milestone: "M1" }, "org");
    t.createTicket({ title: "D", status: "canceled", milestone: "M1" }, "org");
    t.close();
    log.mockClear();
    expect(await main(["org", "milestones", "acme"])).toBe(0);
    expect(out()).toBe("M0  Requirements  100%  1/1 done\nM1  Core          75%   1/2 done  ◀ active\nM2  Polish        0%    0/0 done");
  });
});
