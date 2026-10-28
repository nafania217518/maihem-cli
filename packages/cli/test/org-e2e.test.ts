// End-to-end: the org runner with fake sessions that act as the members would, through the real org tools, on a real git repo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveDefinition } from "../src/registry.ts";
import { saveOrg } from "../src/org/store.ts";
import { validateOrg } from "../src/org/config.ts";
import { createOps } from "../src/org/ops.ts";
import type { Ops } from "../src/org/ops.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import { dbFile, runOrg } from "../src/org/daemon.ts";
import type { OrgDeps, OrgState } from "../src/org/daemon.ts";
import { changedFiles, commitAll, mergeMain, milestoneDiff } from "../src/org/git.ts";
import { createOrgTools } from "../src/org/tools.ts";
import type { Org, Wake } from "../src/org/types.ts";

type Kind = Wake["kind"];

const GOAL = "a CLI that converts CSV to JSON";
const DOCS = ["docs/business-requirements.md", "docs/business-summary.txt", "docs/technical-requirements.md", "docs/tech-summary.txt"];
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", ...a], { cwd, encoding: "utf8" }).trim();
const def = (name: string) => ({ name, provider: "p", model: "m", system: `I am ${name}`, description: name, tools: ["read", "write", "edit", "list", "exec"], sandbox: false, max_steps: 5, workdir: "/x" }) as never;

// a fake session: `key` = "member kind title" ("pm triage" for a triage batch); it acts through the org tools and writes into its worktree
interface Ctx { t: Tracker; ops: Ops; org: Org; member: string; ticket: string; kind: Kind; batch: string[]; wt: string; id: string }
type Act = (c: Ctx) => void;
interface Spawn { key: string; id: string; member: string; ticket: string; kind: Kind; batch?: string[]; branch: string }

// one org run per describe: a fresh MAIHEM_HOME and repo, the runner in the background, the test polling the db
function harness(script: Record<string, Act>, limits: { parallel: number }) {
  const s = { repo: "", spawned: [] as Spawn[], unexpected: [] as string[], errors: [] as string[], live: new Set<string>(), n: 0, u: undefined as Tracker | undefined, run: undefined as Promise<OrgState> | undefined, settled: false, ac: new AbortController() };
  const deps: OrgDeps = {
    pollMs: 10, retryMs: 0,
    alive: (id) => s.live.has(id),
    stop: (id) => void s.live.delete(id),
    spawn: ({ org, member, db, def: d, ticket, kind, batch }) => {
      const id = `s${++s.n}`, wt = d.workdir!, t = openTracker(db);
      const key = ticket ? `${member} ${kind} ${t.getTicket(ticket).title}` : `${member} ${kind}`;
      s.spawned.push({ key, id, member, ticket, kind, batch, branch: git(wt, "branch", "--show-current") });
      t.log("session.started", member, { member, id, kind }, ticket);
      const act = script[key];
      if (!act) s.unexpected.push(key);
      else try { act({ t, ops: createOps(t, org), org, member, ticket, kind, batch: batch ?? [], wt, id }); } catch (e) { s.errors.push(`${key}: ${(e as Error).message}`); }
      t.log("session.ended", member, { member, id, tokens: 10, input: 7, output: 3, text: "done" }, ticket);
      t.close();
      return id;
    },
  };
  const db = () => (s.u ??= openTracker(dbFile("acme")));
  const dump = () => [
    ...db().listTickets().map((x) => `${x.id} ${x.status} ${x.title} @${x.assignee ?? "-"} ${x.milestone ?? ""}`),
    `inbox: ${db().inbox("open").map((q) => q.text).join(" | ")}`, `queue: ${JSON.stringify(db().getMeta("queue"))} waiting: ${db().getMeta("waiting")}`,
    `sessions: ${s.spawned.map((x) => x.key).join(", ")}`, `unexpected: ${s.unexpected.join(", ")}`, `errors: ${s.errors.join(", ")}`,
    `events: ${db().events().filter((e) => /^(org|git|milestone|review)\./.test(e.kind)).map((e) => `${e.kind} ${e.ticket ?? ""}`).join(", ")}`,
  ].join("\n");
  // polls until cond holds; fails at once on a session error or when the run ended
  const reach = (cond: (t: Tracker) => boolean, ms = 15_000) => new Promise<void>((res, rej) => {
    const end = Date.now() + ms;
    const i = setInterval(() => {
      let why = s.errors.length ? "a session failed" : Date.now() > end ? "timeout" : "";
      if (!why && cond(db())) { clearInterval(i); return res(); }
      if (!why && s.settled) why = "the run ended";
      if (why) { clearInterval(i); rej(new Error(`${why}; state:\n${dump()}`)); }
    }, 5);
  });
  const start = () => {
    process.env.MAIHEM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
    s.repo = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-repo-"));
    git(s.repo, "init", "-q", "-b", "main");
    for (const r of ["ba", "sa", "pm", "tl", "dev"]) saveDefinition(def(`d${r}`));
    saveOrg(validateOrg({ name: "acme", repo: s.repo, members: MEMBERS, limits }));
    s.run = runOrg("acme", GOAL, deps, s.ac.signal).finally(() => { s.settled = true; });
  };
  const stop = async () => { s.ac.abort(); await s.run; try { s.u?.close(); } catch { /* closed */ } };
  // the human's ops, as the CLI calls them
  const human = () => createOps(db(), validateOrg({ name: "acme", repo: s.repo, members: MEMBERS }));
  // a ticket of M0 for dev1 while BA's requirements session stays busy
  const task = (title: string, reviewers = ["tl"]) => human().create({ title, assignee: "dev1", reviewers, status: "todo", milestone: "M0" }, "org");
  const path_ = (id: string) => db().events().filter((e) => e.kind === "ticket.status" && e.ticket === id).map((e) => e.data.to);
  return { s, db, reach, start, stop, human, task, path: path_ };
}

const m = (role: string) => ({ role, definition: `d${role}` });
const MEMBERS = { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev"), dev2: m("dev") };
const write = (c: Ctx, f: string, body: string) => { fs.mkdirSync(path.dirname(path.join(c.wt, f)), { recursive: true }); fs.writeFileSync(path.join(c.wt, f), body); };
const read = (c: Ctx, f: string) => fs.readFileSync(path.join(c.wt, f), "utf8");

// a tool call as the session's agent makes it: the tools get the same options as in src/daemon.ts
const call = (c: Ctx, name: string, input: object = {}): string => {
  const merge = () => {
    const tk = c.t.getTicket(c.ticket);
    if (!tk.branch) return { ok: true as const };
    commitAll(c.wt, `${c.member}: ${tk.id} ${tk.title}`, { name: c.member, email: `${c.member}@acme.maihem` });
    return mergeMain(c.wt, "main");
  };
  const tools = createOrgTools(c.t, c.member, c.org, {
    ticket: c.ticket, kind: c.kind, batch: c.batch, files: () => changedFiles(c.wt, "main"),
    size: (f) => { try { return read(c, f).length; } catch { return 0; } },
    milestoneDiff: (tags, p) => milestoneDiff(c.org.repo, "main", tags, p),
    ...(c.kind === "work" && { merge }),
  });
  const tl = tools[name] as { execute?: (i: unknown, o: unknown) => unknown } | undefined;
  if (!tl?.execute) throw new Error(`${c.member} has no tool ${name}`);
  return String(tl.execute(input, {}));
};
// a tool call that must succeed
const ok = (c: Ctx, name: string, input: object = {}): string => {
  const r = call(c, name, input);
  if (r.startsWith("error:")) throw new Error(`${name}: ${r}`);
  return r;
};
const approve: Act = (c) => void ok(c, "approve");
// a document or code ticket: write the files, then submit
const files = (body: Record<string, string>): Act => (c) => { for (const [f, b] of Object.entries(body)) write(c, f, b); ok(c, "submit_review", { summary: "did it" }); };
// TL: two tickets, the second waits for the first, then submit the breakdown
const breakdown = (a: string, b: string): Act => (c) => {
  const create = (title: string) => ok(c, "ticket_create", { title, description: `${title}; acceptance: the checks pass` }).match(/T-\d+/)![0];
  const x = create(a), y = create(b);
  ok(c, "set_dependencies", { dependencies: { [y]: [x] } });
  ok(c, "submit_review", { summary: "did it" });
};
const verdict = (text: string): Act => (c) => void ok(c, "submit_review", { summary: text });
// PM triage: accept each ticket of the batch into its milestone; Write JSON goes to dev2, the rest to dev1
const triage: Act = (c) => {
  for (const id of c.batch) {
    const tk = c.t.getTicket(id);
    ok(c, "accept", { id, milestone: tk.milestone, assignee: tk.title === "Write JSON" ? "dev2" : "dev1" });
  }
};
const summaryUpdate = (line: string): Act => (c) => { write(c, "docs/tech-summary.txt", `${read(c, "docs/tech-summary.txt")}${line}\n`); ok(c, "submit_review", { summary: "did it" }); };

describe("org e2e: the full flow", () => {
  const script: Record<string, Act> = {
    "ba work Business requirements": files({ "docs/business-requirements.md": "# Business requirements\nBR-1 Convert CSV to JSON.\n", "docs/business-summary.txt": "Users convert CSV files to JSON from the shell.\n" }),
    "sa review Business requirements": approve,
    "sa work Technical requirements": files({ "docs/technical-requirements.md": "# Technical requirements\nTR-1 Python 3, stdin to stdout.\n", "docs/tech-summary.txt": "Python 3 CLI, no dependencies.\n" }),
    "ba review Technical requirements": approve,
    "pm work Roadmap": (c) => {
      ok(c, "milestone_create", { name: "Core", description: "BR-1: parse CSV and print JSON" });
      ok(c, "submit_review", { summary: "did it" });
    },
    "ba review Roadmap": approve,
    "tl review Roadmap": approve,
    "pm triage": triage,
    "tl work Break down Core": breakdown("Parse CSV", "Write JSON"),
    "sa review Break down Core": approve,
    "dev1 work Parse CSV": files({ "csv2json.py": "def parse(s):\n    return [l.split(',') for l in s.splitlines()]\n" }),
    "tl review Parse CSV": approve,
    "dev2 work Write JSON": files({ "to_json.py": "import json\n\ndef to_json(rows):\n    return json.dumps(rows)\n" }),
    "tl review Write JSON": approve,
    "tl work Accept Core": verdict("BR-1 met. Defects: none."),
    "pm review Accept Core": approve,
    "sa work Tech summary and repo cleanup after Core": summaryUpdate("Modules: csv2json.py (parse), to_json.py (output)."),
    "tl review Tech summary and repo cleanup after Core": approve,
    "ba work Final acceptance": verdict("BR-1 met."),
    "sa review Final acceptance": approve,
  };
  const { s, db, reach, start, stop } = harness(script, { parallel: 2 });
  const approvals = (t: Tracker) => t.inbox("open").filter((q) => q.kind === "approval");
  beforeAll(start);
  afterAll(stop);

  it("the full flow runs from the goal to org.done", { timeout: 60_000 }, async () => {
    await reach((t) => approvals(t).length === 1);
    const [q] = approvals(db());
    expect(q).toMatchObject({ ticket: "T-1", author: "org", files: DOCS });
    expect(db().getTicket("T-1")).toMatchObject({ status: "todo", gate: "pending" });
    expect(db().getTicket("T-2").summary).toBe("did it");
    db().answer(q.id, "approved", "user", true);

    await reach((t) => t.getMeta<string>("final") !== undefined && approvals(t).length === 1);
    const [f] = approvals(db());
    expect(f.text).toBe("Final review: all milestones are complete. Approve to finish, or reject with what is missing.");
    db().answer(f.id, "ship it", "user", true);
    expect(await s.run).toEqual({ status: "done" });

    expect(db().listTickets().map((x) => `${x.id} ${x.kind} ${x.title} ${x.milestone} @${x.assignee} ${x.status}`)).toEqual([
      "T-1 requirements Requirements M0 @ba done",
      "T-2 normal Business requirements M0 @ba done",
      "T-3 normal Technical requirements M0 @sa done",
      "T-4 roadmap Roadmap M0 @pm done",
      "T-5 breakdown Break down Core M1 @tl done",
      "T-6 normal Parse CSV M1 @dev1 done",
      "T-7 normal Write JSON M1 @dev2 done",
      "T-8 acceptance Accept Core M1 @tl done",
      "T-9 summary Tech summary and repo cleanup after Core M1 @sa done",
      "T-10 final Final acceptance M1 @ba done",
    ]);
    const revs = (id: string) => db().getTicket(id).approvals.map((a) => `${a.reviewer} ${a.state}`).join(",");
    expect(["T-4", "T-5", "T-6", "T-7", "T-8", "T-9", "T-10"].map(revs)).toEqual(["ba approved,tl approved", "sa approved", "tl approved", "tl approved", "pm approved", "tl approved", "sa approved"]);
    expect(db().getTicket("T-7").relations).toContainEqual({ from: "T-6", to: "T-7", kind: "blocks" });
    // the verdicts are the submit summaries
    expect(db().getTicket("T-8").summary).toBe("BR-1 met. Defects: none.");
    expect(db().getTicket("T-10").summary).toBe("BR-1 met.");

    // the breakdown's tickets went through Triage; the PM triaged them in batch sessions, a chain in one batch
    const ev = db().events();
    for (const id of ["T-6", "T-7"]) expect(ev.filter((e) => e.kind === "ticket.status" && e.ticket === id).map((e) => e.data.to)).toEqual(["todo", "in_progress", "in_review", "done"]);
    expect(db().getTicket("T-6").owner).toBe("tl");
    const pm = s.spawned.filter((x) => x.member === "pm").map((x) => `${x.kind}|${x.ticket}|${x.batch?.join(",") ?? ""}`);
    expect(pm).toEqual(["work|T-4|", "triage||T-6,T-7", "review|T-8|"]);
    expect(s.spawned.some((x) => (x.kind as string) === "turn")).toBe(false);
    expect(ev.filter((e) => e.kind === "ticket.assigned" && e.actor === "pm").map((e) => `${e.ticket} ${e.data.to}`)).toEqual(["T-6 dev1", "T-7 dev2"]);

    expect(git(s.repo, "log", "--format=%an|%s|%b").split("\n").filter(Boolean)).toEqual([
      "sa|T-9: Tech summary and repo cleanup after Core|Reviewed-by: tl",
      "dev2|T-7: Write JSON|Reviewed-by: tl",
      "dev1|T-6: Parse CSV|Reviewed-by: tl",
      "sa|T-3: Technical requirements|Reviewed-by: ba",
      "ba|T-2: Business requirements|Reviewed-by: sa",
      "maihem|maihem: start org|",
    ]);
    expect(git(s.repo, "tag", "--merged", "main")).toBe("M0\nM1");
    expect(git(s.repo, "branch", "--list", "t-*")).toBe("");
    expect(ev.filter((e) => e.kind === "milestone.completed").map((e) => e.data.id)).toEqual(["M0", "M1"]);
    expect(ev.filter((e) => e.kind.startsWith("org.")).map((e) => e.kind)).toEqual(["org.started", "org.done"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe("org e2e: a defect in the final acceptance", () => {
  let reviews = 0;
  const script: Record<string, Act> = {
    "ba work Business requirements": files({ "docs/business-requirements.md": "BR-1 Convert CSV to JSON.\n", "docs/business-summary.txt": "CSV to JSON.\n" }),
    "sa review Business requirements": approve,
    "sa work Technical requirements": files({ "docs/technical-requirements.md": "TR-1 Python 3.\n", "docs/tech-summary.txt": "Python 3 CLI.\n" }),
    "ba review Technical requirements": approve,
    "pm work Roadmap": (c) => { ok(c, "milestone_create", { name: "Core", description: "BR-1" }); ok(c, "submit_review", { summary: "did it" }); },
    "ba review Roadmap": approve,
    "tl review Roadmap": approve,
    // the defect has no milestone: PM accepts it into the active (last) milestone
    "pm triage": (c) => { for (const id of c.batch) ok(c, "accept", { id, milestone: c.t.getTicket(id).milestone ?? "M1", assignee: "dev1" }); },
    "tl work Break down Core": (c) => { ok(c, "ticket_create", { title: "Parse CSV", description: "AC: the checks pass" }); ok(c, "submit_review", { summary: "did it" }); },
    "sa review Break down Core": approve,
    "dev1 work Parse CSV": files({ "csv2json.py": "def parse(s): return s\n" }),
    "tl review Parse CSV": approve,
    "tl work Accept Core": verdict("BR-1 met."),
    "pm review Accept Core": approve,
    "sa work Tech summary and repo cleanup after Core": summaryUpdate("Modules: csv2json.py."),
    "tl review Tech summary and repo cleanup after Core": approve,
    "ba work Final acceptance": verdict("BR-1 met."),
    "sa review Final acceptance": (c) => {
      if (++reviews === 1) ok(c, "ticket_create", { title: "Empty input crashes", description: "steps: run with empty stdin", label: "bug" });
      ok(c, "approve");
    },
    "dev1 work Empty input crashes": files({ "csv2json.py": "def parse(s): return s or ''\n" }),
    "tl review Empty input crashes": approve,
  };
  const { s, db, reach, start, stop, path } = harness(script, { parallel: 2 });
  const approvals = (t: Tracker) => t.inbox("open").filter((q) => q.kind === "approval");
  beforeAll(start);
  afterAll(stop);

  it("the final acceptance waits for the defects the SA files", { timeout: 60_000 }, async () => {
    await reach((t) => approvals(t).length === 1);
    db().answer(approvals(db())[0].id, "approved", "user", true);
    await reach((t) => t.getMeta<string>("final") !== undefined && approvals(t).length === 1);
    const fin = db().listTickets().find((x) => x.kind === "final")!, bug = db().listTickets().find((x) => x.title === "Empty input crashes")!;
    expect(db().getTicket(bug.id)).toMatchObject({ milestone: "M1", status: "done" });
    expect(db().getTicket(fin.id).relations).toContainEqual({ from: bug.id, to: fin.id, kind: "blocks" });
    expect(path(fin.id)).toEqual(["in_progress", "in_review", "todo", "in_progress", "in_review", "done"]);
    expect(s.spawned.filter((x) => x.ticket === fin.id).map((x) => x.key)).toEqual(["ba work Final acceptance", "sa review Final acceptance", "ba work Final acceptance", "sa review Final acceptance"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

const answered = (c: Ctx) => c.t.getTicket(c.ticket).comments.some((x) => / answers: /.test(x.text));

describe("org e2e: a question to a neighbour", () => {
  const script: Record<string, Act> = {
    "ba work Business requirements": (c) => void s.live.add(c.id), // stays busy: the requirements flow does not move
    "dev1 work Parse CSV": (c) => {
      if (!answered(c)) return void ok(c, "ask", { to: "tl", question: "Should the parser accept semicolons?" });
      write(c, "src/parse.js", "export const parse = (s) => s.split(',');\n");
      ok(c, "submit_review", { summary: "commas only, as TL answered" });
    },
    "tl reply Parse CSV": (c) => void ok(c, "answer", { text: "Commas only." }),
    "tl review Parse CSV": approve,
  };
  const { s, db, reach, start, stop, task, path } = harness(script, { parallel: 3 });
  beforeAll(start);
  afterAll(stop);

  it("a question goes to a neighbour and the answer brings the ticket back", { timeout: 60_000 }, async () => {
    await reach((t) => t.listTickets().length >= 3);
    task("Parse CSV");
    await reach((t) => t.getTicket("T-4").status === "done");
    expect(db().getTicket("T-4").comments.map((x) => `${x.author}: ${x.text}`)).toEqual(["dev1: dev1 asks tl: Should the parser accept semicolons?", "tl: tl answers: Commas only."]);
    expect(path("T-4")).toEqual(["in_progress", "needs_reply", "in_progress", "in_review", "done"]);
    expect(db().getTicket("T-4").assignee).toBe("dev1");
    expect(db().getTicket("T-4").asker).toBeFalsy();
    expect(s.spawned.filter((x) => x.ticket === "T-4").map((x) => x.key)).toEqual(["dev1 work Parse CSV", "tl reply Parse CSV", "dev1 work Parse CSV", "tl review Parse CSV"]);
    expect(git(s.repo, "log", "-1", "--format=%an|%s|%b")).toBe("dev1|T-4: Parse CSV|Reviewed-by: tl");
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe("org e2e: a question to the human", () => {
  const script: Record<string, Act> = {
    "ba work Business requirements": (c) => {
      if (!answered(c)) return void ok(c, "ask", { to: "human", question: "Which CSV dialects?" });
      files({ "docs/business-requirements.md": "# BR\nBR-1 Convert RFC 4180 CSV.\n", "docs/business-summary.txt": "Convert CSV.\n" })(c);
    },
    "sa review Business requirements": approve,
    "sa work Technical requirements": (c) => void s.live.add(c.id), // stays busy
  };
  const { s, db, reach, start, stop, human, path } = harness(script, { parallel: 2 });
  beforeAll(start);
  afterAll(stop);

  it("BA forwards a question to the human and the human's answer returns the ticket", { timeout: 60_000 }, async () => {
    await reach((t) => t.getMeta("waiting") === true);
    expect(db().getTicket("T-2")).toMatchObject({ status: "needs_reply", assignee: "human", asker: "ba", return_status: "in_progress", return_assignee: "ba" });
    expect(human().answer("T-2", "RFC 4180 only", "user")).toBe("answered T-2; it is in_progress again");
    await reach((t) => t.getTicket("T-2").status === "done");
    expect(db().getTicket("T-2").comments.map((x) => x.text)).toEqual(["ba asks human: Which CSV dialects?", "user answers: RFC 4180 only"]);
    expect(path("T-2")).toEqual(["in_progress", "needs_reply", "in_progress", "in_review", "done"]);
    expect(s.spawned.filter((x) => x.ticket === "T-2").map((x) => x.key)).toEqual(["ba work Business requirements", "ba work Business requirements", "sa review Business requirements"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe("org e2e: no-op sessions", () => {
  let runs = 0;
  const script: Record<string, Act> = {
    "ba work Business requirements": (c) => void s.live.add(c.id), // stays busy
    "dev1 work Parse CSV": (c) => { if (++runs > 3) files({ "src/parse.js": "export const parse = (s) => s.split(',');\n" })(c); },
    "tl review Parse CSV": approve,
  };
  const { s, db, reach, start, stop, task, human, path } = harness(script, { parallel: 3 });
  beforeAll(start);
  afterAll(stop);

  it("three no-op sessions park the ticket for the human", { timeout: 60_000 }, async () => {
    await reach((t) => t.listTickets().length >= 3);
    task("Parse CSV");
    await reach((t) => t.getTicket("T-4").assignee === "human");
    expect(runs).toBe(3);
    expect(db().getTicket("T-4")).toMatchObject({ status: "needs_reply", asker: "org", return_status: "in_progress", return_assignee: "dev1" });
    expect(db().getTicket("T-4").comments.map((x) => `${x.author}: ${x.text}`)).toEqual(["org: dev1 ended 3 sessions on T-4 without a transition. The last session's final text: done"]);
    human().answer("T-4", "", "user");
    await reach((t) => t.getTicket("T-4").status === "done");
    expect(runs).toBe(4);
    expect(db().getTicket("T-4").comments.at(-1)?.text).toBe("user answers: try again");
    expect(path("T-4")).toEqual(["in_progress", "needs_reply", "in_progress", "in_review", "done"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe("org e2e: change requests", () => {
  let round = 0, saSession = "", pending = "";
  const script: Record<string, Act> = {
    "ba work Business requirements": (c) => void s.live.add(c.id), // stays busy
    "dev1 work Parse CSV": (c) => {
      write(c, "src/parse.js", `export const parse = (s) => s.split(','); // ${++round}\n`);
      ok(c, "submit_review", { summary: `round ${round}` });
      if (round === 2) pending = c.t.getTicket(c.ticket).approvals.map((a) => `${a.reviewer} ${a.state}`).join(",");
    },
    // round 1: SA's review stays live, TL requests changes; round 2: both approve
    "sa review Parse CSV": (c) => { if (round === 1) { s.live.add(c.id); saSession = c.id; } else approve(c); },
    "tl review Parse CSV": (c) => {
      if (round === 1) return void ok(c, "request_changes", { findings: ["handle quotes", "add a test"] });
      approve(c);
    },
  };
  const { s, db, reach, start, stop, task, path } = harness(script, { parallel: 4 });
  beforeAll(start);
  afterAll(stop);

  it("a change request stops the other reviewer", { timeout: 60_000 }, async () => {
    await reach((t) => t.listTickets().length >= 3);
    task("Parse CSV", ["sa", "tl"]);
    await reach((t) => t.getTicket("T-4").status === "done");
    expect(saSession).not.toBe("");
    expect(s.live.has(saSession)).toBe(false); // stopped
    expect(db().events().some((e) => e.kind === "ticket.status" && e.ticket === "T-4" && e.data.from === "in_review" && e.data.to === "in_progress")).toBe(true);
    expect(db().getTicket("T-4").comments.map((x) => x.text)).toEqual(["tl requests changes:\n1. handle quotes\n2. add a test"]);
    expect(pending).toBe("sa pending,tl pending");
    expect(path("T-4")).toEqual(["in_progress", "in_review", "in_progress", "in_review", "done"]);
    expect(s.spawned.filter((x) => x.ticket === "T-4").map((x) => x.key)).toEqual(["dev1 work Parse CSV", "sa review Parse CSV", "tl review Parse CSV", "dev1 work Parse CSV", "sa review Parse CSV", "tl review Parse CSV"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});

describe("org e2e: submit guards", () => {
  const results: string[] = [];
  const script: Record<string, Act> = {
    "ba work Business requirements": (c) => {
      write(c, "docs/business-requirements.md", "# BR\nBR-1 Convert.\n");
      write(c, "docs/business-summary.txt", "x".repeat(4001));
      results.push(call(c, "submit_review", { summary: "did it" }));
      write(c, "docs/business-summary.txt", "Convert CSV.\n");
      write(c, "docs/tech-summary.txt", "BA's view of the stack.\n");
      results.push(call(c, "submit_review", { summary: "did it" }));
      fs.rmSync(path.join(c.wt, "docs/tech-summary.txt"));
      results.push(call(c, "submit_review", { summary: "did it" }));
    },
    "sa review Business requirements": approve,
    "sa work Technical requirements": (c) => void s.live.add(c.id), // stays busy
  };
  const { s, db, reach, start, stop } = harness(script, { parallel: 2 });
  beforeAll(start);
  afterAll(stop);

  it("a summary over the cap and a change to another role's document are refused at submit", { timeout: 60_000 }, async () => {
    await reach((t) => t.getTicket("T-2").status === "done");
    expect(results).toEqual([
      "error: docs/business-summary.txt has 4001 characters; the cap is 4000. Shorten it.",
      "error: docs/tech-summary.txt belongs to SA; revert your change to it",
      "submitted T-2 for review by sa",
    ]);
    expect(git(s.repo, "log", "-1", "--format=%an|%s|%b")).toBe("ba|T-2: Business requirements|Reviewed-by: sa");
    expect(git(s.repo, "show", "main:docs/business-summary.txt")).toBe("Convert CSV.");
    expect(git(s.repo, "ls-tree", "-r", "--name-only", "main")).toBe("docs/business-requirements.md\ndocs/business-summary.txt");
    expect(db().events().filter((e) => e.kind === "ticket.status" && e.ticket === "T-2").map((e) => e.data.to)).toEqual(["in_progress", "in_review", "done"]);
    expect(s.unexpected).toEqual([]);
    expect(s.errors).toEqual([]);
  });
});
