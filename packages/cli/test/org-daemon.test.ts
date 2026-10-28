import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as run from "../src/run.ts";
import { saveProvider } from "../src/providers.ts";
import { saveDefinition } from "../src/registry.ts";
import { parseDefinition } from "../src/definition.ts";
import { saveOrg } from "../src/org/store.ts";
import { validateOrg } from "../src/org/config.ts";
import { createOps } from "../src/org/ops.ts";
import type { Ops } from "../src/org/ops.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import { dbFile, defaultDeps, transient, expandRepo, loadRunnable, orgDir, orgPid, pidFile, runOrg, runOrgMain } from "../src/org/daemon.ts";
import type { OrgDeps } from "../src/org/daemon.ts";
import type { InboxItem, Org, Wake } from "../src/org/types.ts";

let home: string, repo: string, n: number, u: Tracker | undefined;
const db = () => (u ??= openTracker(dbFile("acme")));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=u", "-c", "user.email=u@x", ...a], { cwd, encoding: "utf8" }).trim();
const def = (name: string) => ({ name, provider: "p", model: "m", system: `I am ${name}`, description: `${name} desc`, tools: ["read", "write", "edit", "list", "exec"], sandbox: false, max_steps: 5, workdir: "/x" }) as never;
const wt = (m: string) => path.join(orgDir("acme"), "worktrees", m);
const m = (role: string, reports_to?: string) => ({ role, definition: `d${role}`, ...(reports_to ? { reports_to } : {}) });
const org = (limits: Partial<Org["limits"]> = {}, extra: Record<string, object> = {}): Org =>
  validateOrg({ name: "acme", repo, members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev"), ...extra }, limits: { parallel: 2, ...limits } });

// a fake session: acts through ops as the member on the same db and writes files into its worktree (def.workdir)
interface Ctx { t: Tracker; ops: Ops; member: string; ticket: string; kind: Wake["kind"]; task: string; wt: string; id: string }
type Agent = (c: Ctx) => void | "fail" | 429; // "fail" or 429: the session logs session.failed
interface Spawn { at: number; id: string; member: string; ticket: string; kind: Wake["kind"]; batch?: string[]; task: string; system: string; tools: string[]; reasoning?: string; wt: string; branch: string; head: string; status: string }
function fake(script: Record<string, Agent>, o: Partial<OrgDeps> = {}) {
  const spawned: Spawn[] = [], stopped: string[] = [];
  const live = new Set<string>();
  const deps: OrgDeps = {
    pollMs: 1, retryMs: 0,
    alive: (id) => live.has(id),
    stop: (id) => { stopped.push(id); live.delete(id); },
    spawn: ({ org: og, member, task, db: file, def: d, ticket, kind, batch }) => {
      const id = `s${++n}`, w = d.workdir!;
      const t = openTracker(file);
      spawned.push({ at: Date.now(), id, member, ticket, kind, batch, task, system: d.system!, tools: d.tools, reasoning: d.reasoning, wt: w, branch: git(w, "branch", "--show-current"), head: git(w, "log", "-1", "--format=%an <%ae>|%s"), status: ticket ? t.getTicket(ticket).status : "" });
      t.log("session.started", member, { member, id }, ticket);
      const r = script[member]?.({ t, ops: createOps(t, og), member, ticket, kind, task, wt: w, id });
      if (r === "fail" || r === 429) t.log("session.failed", member, { member, id, error: "boom", ...(r === 429 && { status: 429 }) }, ticket);
      else t.log("session.ended", member, { member, id, tokens: 10, input: 7, output: 3, text: `last words of ${id}` }, ticket);
      t.close();
      return id;
    },
    ...o,
  };
  return { deps, spawned, stopped, live };
}
const write = (c: Ctx, f: string, body = "x") => { fs.mkdirSync(path.dirname(path.join(c.wt, f)), { recursive: true }); fs.writeFileSync(path.join(c.wt, f), body); };
const DOC: Record<string, string> = { "Business requirements": "docs/business-requirements.md", "Technical requirements": "docs/technical-requirements.md" };
// a member writes its ticket's document and submits it; a reviewer approves; triage does nothing
const std = (o: { work?: (c: Ctx) => void; review?: (c: Ctx) => void } = {}): Agent => (c) => {
  if (c.kind === "triage") return;
  const tk = c.t.getTicket(c.ticket);
  if (c.kind === "review") return (o.review ?? ((x: Ctx) => void x.ops.approve(x.ticket, x.member)))(c);
  if (c.kind !== "work") return;
  (o.work ?? ((x: Ctx) => write(x, DOC[tk.title] ?? `src/${tk.id}.txt`, tk.title)))(c);
  c.ops.submit(c.ticket, c.member, { summary: "did it" });
};
const happy = { ba: std(), sa: std(), pm: std(), tl: std(), dev: std() };

// drives the runner until cond holds (or a timeout), answering the inbox as the human
type Answer = (t: Tracker, q: InboxItem) => void;
const yes: Answer = (t, q) => void t.answer(q.id, "ok", "user", true);
async function until(f: ReturnType<typeof fake>, cond: (t: Tracker) => boolean, answer: Answer = yes, ms = 5000, opts?: { resume?: boolean }) {
  const ac = new AbortController();
  let hit = false;
  const i = setInterval(() => {
    if (!fs.existsSync(dbFile("acme")) || !db().getMeta("pid")) return;
    for (const q of db().inbox("open")) answer(db(), q);
    if (cond(db())) { hit = true; ac.abort(); }
  }, 2);
  const to = setTimeout(() => ac.abort(), ms);
  try { return await runOrg("acme", "build it", f.deps, ac.signal, opts); }
  finally { clearInterval(i); clearTimeout(to); expect(hit || cond(db()), "condition not reached").toBe(true); }
}
const kinds = () => db().events().map((e) => e.kind);
const ev = (kind: string) => db().events().filter((e) => e.kind === kind);
const status = (id: string) => (t: Tracker) => t.getTicket(id).status;
const log = () => git(repo, "log", "--format=%an <%ae>|%s|%b|").split("|\n").map((l) => l.replace(/\|$/, "").trim());

beforeEach(() => {
  n = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "od-")); process.env.MAIHEM_HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  git(repo, "init", "-q", "-b", "main");
  for (const r of ["ba", "sa", "pm", "tl", "dev"]) saveDefinition(def(`d${r}`));
  saveOrg(org());
});
afterEach(() => { try { u?.close(); } catch { /* closed */ } u = undefined; vi.restoreAllMocks(); });

describe("org runner", () => {
  it("start logs org.started and the flow creates M0 and the Requirements tickets", async () => {
    await until(fake({}), (t) => t.listTickets().length === 3);
    expect(ev("org.started")[0].data).toEqual({ goal: "build it" });
    expect(db().listMilestones().map((x) => `${x.id} ${x.name}`)).toEqual(["M0 Requirements"]);
    expect(db().listTickets().map((x) => `${x.id} ${x.title} ${x.kind} ${x.parent ?? "-"} ${x.assignee}`)).toEqual([
      "T-1 Requirements requirements - ba", "T-2 Business requirements normal T-1 ba", "T-3 Technical requirements normal T-1 sa"]);
    expect(db().getMeta("main")).toBe("main");
    expect(db().getMeta("goal")).toBe("build it");
    expect(db().getMeta("pid")).toBe(process.pid);
    expect(db().getMeta("state")).toEqual({ status: "stopped" });
    expect(git(repo, "log", "--format=%s")).toBe("maihem: start org");
  });

  it("a work wake runs on the ticket branch in the member's worktree and starts the ticket", async () => {
    const f = fake({});
    await until(f, () => f.spawned.length > 0);
    expect(f.spawned[0]).toMatchObject({ member: "ba", ticket: "T-2", kind: "work", wt: wt("ba"), branch: "t-2-business-requirements", status: "in_progress", tools: ["read", "write", "edit", "list"] });
    expect(f.spawned[0].system).toContain("I am dba");
    expect(f.spawned[0].system).toContain("Goal: build it");
    expect(f.spawned[0].task).toMatch(/^Work on T-2\./);
    expect(db().getTicket("T-2").branch).toBe("t-2-business-requirements");
  });

  it("a definition without reasoning gets its level's default", async () => {
    saveDefinition({ ...(def("dsa") as object), reasoning: "max" } as never);
    const f = fake(happy);
    await until(f, () => ["ba", "sa", "pm"].every((x) => f.spawned.some((y) => y.member === x)));
    const r = (x: string) => f.spawned.find((y) => y.member === x)?.reasoning;
    expect([r("ba"), r("sa"), r("pm")]).toEqual(["high", "max", "medium"]);
  });

  it("a review wake waits for the assignee's session and runs detached at the branch", async () => {
    let saw = -1;
    const f = fake({ ...happy, ba: std({ work: (c) => { write(c, "docs/business-requirements.md"); f.live.add(c.id); setTimeout(() => { saw = f.spawned.length; f.live.delete(c.id); }, 50); } }) });
    await until(f, () => f.spawned.some((x) => x.member === "sa"));
    expect(saw).toBe(1); // sa was not spawned while ba's session ran
    expect(f.spawned[1]).toMatchObject({ member: "sa", ticket: "T-2", kind: "review", wt: wt("sa"), branch: "", tools: ["read", "list"] });
    expect(f.spawned[1].task).toMatch(/^Review T-2\./);
  });

  it("the session's work is committed when it ends", async () => {
    const f = fake(happy);
    await until(f, () => f.spawned.some((x) => x.member === "sa"));
    expect(f.spawned.find((x) => x.member === "sa")?.head).toBe("ba <ba@acme.maihem>|ba: T-2 Business requirements");
    expect(git(wt("ba"), "branch", "--show-current")).toBe(""); // the branch is free for other worktrees
  });

  it("approve by every reviewer merges the branch with Reviewed-by and the flow closes the ticket", async () => {
    const f = fake({ ...happy, ba: std({ work: (c) => { write(c, "docs/business-requirements.md", "br"); c.t.setApproval(c.ticket, "tl", "pending", "org"); } }) });
    await until(f, (t) => status("T-2")(t) === "done");
    expect(log()).toEqual(["ba <ba@acme.maihem>|T-2: Business requirements|Reviewed-by: sa, tl", "maihem <maihem@localhost>|maihem: start org|"]);
    expect(fs.readFileSync(path.join(repo, "docs/business-requirements.md"), "utf8")).toBe("br");
    expect(db().getTicket("T-2").merged).toBe(git(repo, "rev-parse", "HEAD"));
    expect(db().getTicket("T-2").branch).toBeUndefined();
    expect(ev("git.merged")[0]).toMatchObject({ ticket: "T-2", data: { commit: git(repo, "rev-parse", "HEAD") } });
    expect(git(repo, "branch", "--list", "t-2-*")).toBe("");
  });

  it("a ticket without a branch closes with git.merged commit null", async () => {
    const f = fake({ ...happy, sa: std({ review: (c) => { c.t.setBranch(c.ticket, null, "org"); c.ops.approve(c.ticket, c.member); } }) });
    await until(f, (t) => status("T-2")(t) === "done");
    expect(ev("git.merged")[0]).toMatchObject({ ticket: "T-2", data: { commit: null } });
    expect(log()).toHaveLength(1);
  });

  it("a merge conflict comments and sends the ticket back", async () => {
    const f = fake({ ...happy, sa: std({ review: (c) => {
      fs.mkdirSync(path.join(repo, "docs")); fs.writeFileSync(path.join(repo, "docs/business-requirements.md"), "main");
      git(repo, "add", "-A"); git(repo, "commit", "-qm", "other");
      c.ops.approve(c.ticket, c.member);
    } }) });
    await until(f, () => ev("git.conflict").length > 0 && f.spawned.filter((x) => x.member === "ba").length > 1);
    expect(ev("git.conflict")[0]).toMatchObject({ ticket: "T-2", data: { files: ["docs/business-requirements.md"] } });
    const tk = db().getTicket("T-2");
    expect(tk.comments.map((x) => x.text)).toEqual([expect.stringContaining("main changed docs/business-requirements.md since your branch"),
      expect.stringMatching(/^Merging main into your branch conflicts in docs\/business-requirements\.md\. Main changed by: [0-9a-f]+ other\./)]);
    expect(f.spawned.filter((x) => x.member === "ba")[1]).toMatchObject({ ticket: "T-2", kind: "work", branch: "t-2-business-requirements", status: "in_progress" });
  });

  it("a rework session starts with main merged into the branch, and a conflict leaves the markers and a comment", async () => {
    const seen: string[] = [];
    const f = fake({ ...happy,
      ba: std({ work: (c) => { const p = path.join(c.wt, "docs/business-requirements.md"); if (fs.existsSync(p)) seen.push(fs.readFileSync(p, "utf8")); write(c, "docs/business-requirements.md", "branch\n"); } }),
      sa: std({ review: (c) => {
        fs.mkdirSync(path.join(repo, "docs")); fs.writeFileSync(path.join(repo, "docs/business-requirements.md"), "main\n");
        git(repo, "add", "-A"); git(repo, "commit", "-qm", "other");
        c.ops.requestChanges(c.ticket, ["shorter"], c.member);
      } }) });
    await until(f, () => seen.length > 0);
    expect(seen[0]).toMatch(/^<<<<<<< HEAD\nbranch\n=======\nmain\n>>>>>>> main\n$/);
    const sha = git(repo, "log", "-1", "--format=%h");
    expect(db().getTicket("T-2").comments.at(-1)).toMatchObject({ author: "org", text: `Merging main into your branch conflicts in docs/business-requirements.md. Main changed by: ${sha} other. Resolve the conflict markers in those files, run the checks, then submit again.` });
  });

  it("a read-only session's file changes are discarded", async () => {
    const f = fake({ ...happy, sa: std({ review: (c) => { write(c, "docs/business-requirements.md", "changed"); write(c, "junk.txt"); c.ops.approve(c.ticket, c.member); } }) });
    await until(f, () => ev("git.discarded").length > 0);
    expect(ev("git.discarded")[0]).toMatchObject({ ticket: "T-2", data: { member: "sa", files: ["docs/business-requirements.md", "junk.txt"] } });
    expect(git(wt("sa"), "status", "--porcelain")).not.toContain("junk.txt");
    expect(git(repo, "log", "--all", "--name-only", "--format=")).not.toContain("junk.txt");
  });

  it("the requirements approval reaches the inbox when the two documents are done, and approving it creates the Roadmap ticket for PM", async () => {
    const texts: string[] = [];
    const f = fake(happy);
    await until(f, () => f.spawned.some((x) => x.member === "pm" && x.kind === "work"), (t, q) => { texts.push(q.text); yes(t, q); });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^The requirements documents are ready: docs\/business-requirements\.md, docs\/business-summary\.txt, docs\/technical-requirements\.md, docs\/tech-summary\.txt\./);
    const r = db().listTickets().find((x) => x.kind === "roadmap")!;
    expect(r).toMatchObject({ title: "Roadmap", assignee: "pm", milestone: "M0" });
    expect(f.spawned.find((x) => x.member === "pm" && x.kind === "work")).toMatchObject({ ticket: r.id, wt: wt("pm"), tools: [] });
    expect(log().map((l) => l.split("|")[1])).toEqual(expect.arrayContaining(["T-3: Technical requirements", "T-2: Business requirements"]));
    expect(f.spawned.some((x) => x.ticket === "T-1")).toBe(false); // the requirements parent is only a container
  });

  it("the runner tags main when a milestone completes and logs git.tagged", async () => {
    await until(fake(happy), () => kinds().includes("git.tagged"));
    expect(ev("git.tagged").map((e) => e.data)).toEqual([{ milestone: "M0", tag: "M0" }]);
    expect(git(repo, "tag", "-n1", "-l", "M0")).toMatch(/^M0\s+M0 Requirements$/);
    expect(git(repo, "rev-list", "-n1", "M0")).toBe(db().listTickets().find((x) => x.kind === "roadmap")!.merged);
    expect(kinds()).not.toContain("git.push_failed");
  });

  it("a failed tag push logs git.push_failed and the org goes on", async () => {
    git(repo, "remote", "add", "origin", path.join(repo, "missing"));
    await until(fake(happy), (t) => kinds().includes("git.push_failed") && t.listTickets().some((x) => x.kind === "final"));
    expect(ev("git.push_failed")[0].data).toMatchObject({ milestone: "M0", tag: "M0" });
    expect(kinds()).not.toContain("org.paused");
  });

  it("a failing command pauses the org and approve skips the event", async () => {
    const texts: string[] = [];
    let edited = 0, failed = 0;
    const f = fake({ ba: (c) => { f.live.add(c.id); } }, { stop: () => { if (!failed++) throw new Error("socket gone"); } });
    await until(f, (t) => {
      if (f.spawned.length && !edited) {
        const ops = createOps(t, org());
        ops.link(ops.create({ title: "Blocker", status: "todo", milestone: "M0" }, "org").split(" ")[1], "T-2", "blocks", "sa");
        edited = ev("relation.added").at(-1)!.id;
      }
      return kinds().includes("org.resumed");
    }, (t, q) => { texts.push(q.text); yes(t, q); });
    expect(texts).toEqual([`Command failed on event ${edited}: socket gone. Approve to skip it, or reject to stop.`]);
    expect(db().getMeta<number>("cursor")).toBeGreaterThanOrEqual(edited);
  });

  it("a blocker added during work stops the session and the ticket returns to Todo", async () => {
    let linked = false;
    const f = fake({ ba: (c) => { write(c, "docs/business-requirements.md", "half"); f.live.add(c.id); } });
    await until(f, (t) => {
      if (f.spawned.length && !linked) {
        linked = true;
        const ops = createOps(t, org());
        const b = ops.create({ title: "Blocker", status: "todo", milestone: "M0" }, "org").split(" ")[1];
        ops.link(b, "T-2", "blocks", "sa");
      }
      return f.stopped.length > 0 && t.getTicket("T-2").status === "todo" && !!t.getMeta<Record<string, unknown>>("sessions") && !Object.keys(t.getMeta<Record<string, unknown>>("sessions")!).length;
    });
    expect(f.stopped).toEqual(["s1"]);
    expect(git(repo, "log", "-1", "--format=%an|%s", "t-2-business-requirements")).toBe("ba|ba: T-2 Business requirements");
  });

  it("parallel bounds the running sessions and one member runs one session at a time", async () => {
    saveOrg(org({ parallel: 2 }, { dev2: m("dev") }));
    const bad: string[] = [];
    let made = false;
    const f = fake({});
    const sp = f.deps.spawn;
    f.deps.spawn = (o) => {
      const busy = f.spawned.filter((x) => f.live.has(x.id));
      if (busy.length >= 2 || busy.some((x) => x.member === o.member)) bad.push(`${o.member} ${o.ticket}`);
      const id = sp(o);
      f.live.add(id);
      setTimeout(() => f.live.delete(id), 15);
      return id;
    };
    await until(f, (t) => {
      if (!made && t.listTickets().length === 3) {
        made = true;
        const ops = createOps(t, org({}, { dev2: m("dev") }));
        for (const [title, assignee] of [["a", "dev"], ["b", "tl"], ["c", "dev2"], ["d", "sa"]]) ops.create({ title, assignee, status: "todo", milestone: "M0" }, "org");
      }
      return new Set(f.spawned.map((x) => x.ticket)).size >= 5;
    });
    expect(bad).toEqual([]);
    expect(f.spawned.length).toBeGreaterThanOrEqual(5);
  });

  it("a resumed org keeps its tracker and logs org.resumed", async () => {
    await until(fake({}), (t) => t.listTickets().length === 3);
    const before = db().events().length, tickets = db().listTickets();
    const r = await until(fake({}), () => ev("org.resumed").length > 0, yes, 2000, { resume: true });
    expect(r).toEqual({ status: "stopped" });
    expect(fs.existsSync(path.join(orgDir("acme"), "history"))).toBe(false);
    expect(db().events().length).toBeGreaterThan(before);
    expect(db().listTickets().slice(0, 3)).toEqual(tickets.map((x) => expect.objectContaining({ id: x.id, title: x.title })));
    expect(ev("org.resumed")[0].data).toEqual({ from: "stopped" });
    expect(ev("org.started")).toHaveLength(1);
    expect(db().listMilestones().map((x) => x.id)).toEqual(["M0"]);
  });

  it("a resumed org keeps the token limit its approvals raised", async () => {
    saveOrg(org({ tokens: 15 }));
    await until(fake({ ba: () => {} }), (t) => kinds().includes("org.resumed") && t.getMeta("tokenLimit") === 30);
    const spent = ev("session.ended").reduce((a, e) => a + Number(e.data.tokens), 0); // the log, not the stale meta
    const idle = fake({}, { spawn: () => `x${++n}`, alive: () => true });
    await until(idle, () => ev("org.resumed").some((e) => e.data.from === "stopped"), () => {}, 2000, { resume: true });
    expect(db().getMeta("tokenLimit")).toBe(30);
    expect(db().getMeta("tokens")).toBe(spent);
  });

  it("a resumed org wakes the tickets that were in progress", async () => {
    await until(fake({ ba: () => {} }), (t) => status("T-2")(t) === "in_progress");
    const f = fake({});
    await until(f, () => f.spawned.length > 0, yes, 2000, { resume: true });
    expect(f.spawned[0]).toMatchObject({ member: "ba", ticket: "T-2", kind: "work" });
  });

  it("stop ends live sessions and logs org.stopped", async () => {
    const f = fake({}, { alive: () => true });
    const s = await until(f, () => f.spawned.length > 0);
    expect(s).toEqual({ status: "stopped" });
    expect(f.stopped).toEqual(["s1"]);
    expect(kinds().at(-1)).toBe("org.stopped");
  });

  it("a stopped org leaves no running sessions in meta", async () => {
    const f = fake({}, { alive: () => true });
    await until(f, () => f.spawned.length > 0);
    expect(db().getMeta("sessions")).toEqual({});
  });

  it("approving the final review ends the org with org.done", async () => {
    let asked = false;
    const s = await until(fake({}), (t) => {
      if (!asked && t.listTickets().length) { asked = true; t.setMeta("final", t.ask("Final review", "org").id); }
      return t.getMeta<{ status: string }>("state")?.status === "done";
    });
    expect(s).toEqual({ status: "done" });
    expect(kinds()).toContain("org.done");
    expect(kinds()).not.toContain("org.stopped");
  });

  it("the runner stores the current token limit in meta, raised after an approved token pause", async () => {
    saveOrg(org({ tokens: 15 }));
    const f = fake({ ba: () => {} });
    let first: unknown;
    await until(f, (t) => kinds().includes("org.resumed") && t.getMeta("tokenLimit") === 30, (t, q) => { first = t.getMeta("tokenLimit"); yes(t, q); });
    expect(first).toBe(15);
  });

  it("the token limit pauses the org and approve adds another budget", async () => {
    saveOrg(org({ tokens: 15 }));
    const texts: string[] = [];
    const f = fake({ ba: () => {} });
    await until(f, () => kinds().includes("org.resumed") && f.spawned.length >= 3, (t, q) => { texts.push(q.text); yes(t, q); });
    expect(texts[0]).toBe("Token limit reached: 20 of 15 tokens. Approve to continue (adds 15 more) or reject to stop.");
  });

  it("a dirty main checkout pauses the org and the merge retries after approve", async () => {
    const texts: string[] = [];
    const f = fake({ ...happy, sa: std({ review: (c) => { fs.writeFileSync(path.join(repo, "junk.txt"), "j"); c.ops.approve(c.ticket, c.member); } }) });
    await until(f, (t) => status("T-2")(t) === "done", (t, q) => { texts.push(q.text); fs.rmSync(path.join(repo, "junk.txt"), { force: true }); yes(t, q); });
    expect(texts[0]).toBe(`The main checkout ${repo} has local changes; commit or discard them, then approve to retry the merge of T-2.`);
    expect(log()[0]).toBe("ba <ba@acme.maihem>|T-2: Business requirements|Reviewed-by: sa");
  });

  it("a failing commit at reap pauses the org once and retries", async () => {
    let lock = "";
    const texts: string[] = [];
    const f = fake({ ...happy, ba: std({ work: (c) => { write(c, "docs/business-requirements.md"); lock = path.join(git(c.wt, "rev-parse", "--absolute-git-dir"), "index.lock"); fs.writeFileSync(lock, ""); } }) });
    await until(f, (t) => status("T-2")(t) === "done", (t, q) => { texts.push(q.text); fs.rmSync(lock, { force: true }); yes(t, q); });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^git commit failed for T-2: .*index\.lock.*approve to retry, or reject to stop\.$/s);
    expect(ev("git.error")[0]).toMatchObject({ ticket: "T-2", data: { op: "commit" } });
  });

  it("a failing checkout pauses the org and retries after approve", async () => {
    fs.mkdirSync(path.dirname(wt("ba")), { recursive: true }); fs.writeFileSync(wt("ba"), "in the way");
    const texts: string[] = [];
    const f = fake({});
    await until(f, () => f.spawned.length > 0, (t, q) => { texts.push(q.text); fs.rmSync(wt("ba"), { force: true }); yes(t, q); });
    expect(texts[0]).toMatch(new RegExp(`^git checkout failed for T-2: .+\\. Fix it in ${wt("ba")}, then approve to retry, or reject to stop\\.$`, "s"));
    expect(f.spawned[0]).toMatchObject({ member: "ba", ticket: "T-2", branch: "t-2-business-requirements" });
  });

  // ba's first session unassigns the Requirements sub-tickets: nothing is left to wake
  const unassign = (c: Ctx) => { for (const x of c.t.listTickets()) if (x.parent && x.assignee) c.t.setAssignee(x.id, null, "org"); };
  // every session stays live; `once` seeds tickets once, outside any session
  const liveAll = (f: ReturnType<typeof fake>) => { const sp = f.deps.spawn; f.deps.spawn = (o) => { const id = sp(o); f.live.add(id); return id; }; return f; };
  const once = (seed: (t: Tracker) => void) => { let done = false; return (t: Tracker) => { if (!done && t.listTickets().length === 3) { done = true; seed(t); } }; };
  const mkT = (t: Tracker, title: string, o: Parameters<Tracker["createTicket"]>[0] extends infer N ? Partial<N> : never = {}) => t.createTicket({ title, milestone: "M0", ...o }, "org").id;
  const queue = (t: Tracker) => t.getMeta<Wake[]>("queue") ?? [];
  const extra = { dev2: m("dev"), dev3: m("dev") };
  // tl: Needs Reply; sa: In Review; dev, dev2: In Progress (dev2's higher priority); dev3: Todo; pm: Triage
  const slots = (t: Tracker) => {
    const x = mkT(t, "X", { status: "needs_reply", assignee: "tl" });
    const y = mkT(t, "Y", { status: "in_review", assignee: "ba" }); t.setApproval(y, "sa", "pending", "org");
    const z = mkT(t, "Z", { status: "in_progress", assignee: "dev" }), z2 = mkT(t, "Z2", { status: "in_progress", assignee: "dev2", priority: 3 });
    const w = mkT(t, "W", { status: "todo", assignee: "dev3" });
    t.createTicket({ title: "bug" }, "dev");
    return [["tl", x, "reply"], ["sa", y, "review"], ["dev2", z2, "work"], ["dev", z, "work"], ["dev3", w, "work"], ["pm", "", "triage"]].map(([member, ticket, kind]) => ({ member, ticket, kind }));
  };

  it("the cycle wakes by status in slot order", async () => {
    saveOrg(org({ parallel: 7 }, extra));
    let want: Wake[] = [];
    const f = liveAll(fake({}));
    const seed = once((t) => { want = slots(t) as Wake[]; });
    await until(f, (t) => { seed(t); return f.spawned.length >= 7; });
    expect(f.spawned.slice(1).map(({ member, ticket, kind }) => ({ member, ticket, kind }))).toEqual(want);
  });

  it("the wakes without a free slot are the queue", async () => {
    saveOrg(org({ parallel: 2 }, extra));
    let want: Wake[] = [];
    const f = liveAll(fake({}));
    const seed = once((t) => { want = slots(t) as Wake[]; });
    await until(f, (t) => { seed(t); return f.spawned.length >= 2 && queue(t).length === 5; });
    expect(f.spawned[1]).toMatchObject(want[0]);
    expect(queue(db())).toEqual(want.slice(1));
  });

  it("a blocked ticket is skipped", async () => {
    saveOrg(org({ parallel: 4 }));
    const f = liveAll(fake({}));
    const seed = once((t) => {
      const b = mkT(t, "B", { status: "in_progress", assignee: "dev" }); t.addRelation("T-2", b, "blocks", "org");
      mkT(t, "C", { status: "todo", assignee: "tl" });
    });
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.member === "tl"); });
    expect(f.spawned.map((x) => x.member)).toEqual(["ba", "tl"]);
  });

  it("a ticket with open sub-tickets is skipped", async () => {
    saveOrg(org({ parallel: 4 }));
    const f = liveAll(fake({}));
    const seed = once((t) => { const p = mkT(t, "P", { status: "todo", assignee: "dev" }); mkT(t, "C", { status: "todo", assignee: "tl", parent: p }); });
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.member === "tl"); });
    expect(f.spawned.map((x) => x.member)).toEqual(["ba", "tl"]);
  });

  it("a Todo ticket outside the active milestone waits", async () => {
    saveOrg(org({ parallel: 4 }));
    const f = liveAll(fake({}));
    const seed = once((t) => { t.createMilestone("Next", "", "org"); mkT(t, "Later", { status: "todo", assignee: "dev", milestone: "M1" }); mkT(t, "Now", { status: "todo", assignee: "tl" }); });
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.member === "tl"); });
    expect(f.spawned.map((x) => x.member)).toEqual(["ba", "tl"]);
  });

  it("a dev with a ticket In Progress gets no new Todo", async () => {
    saveOrg(org({ parallel: 4 }));
    let a = "", b = "";
    const f = fake({ ba: (c) => void f.live.add(c.id) });
    const seed = once((t) => { a = mkT(t, "A", { status: "in_progress", assignee: "dev" }); b = mkT(t, "B", { status: "todo", assignee: "dev" }); });
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.ticket === b); });
    expect(f.spawned.filter((x) => x.member === "dev").map((x) => x.ticket)).toEqual([a, a, a, b]); // the third no-op parks A for the human
  });

  it("a triage session takes every unblocked Triage ticket", async () => {
    saveOrg(org({ parallel: 2 }));
    let ids: string[] = [];
    const f = fake({ ba: (c) => void f.live.add(c.id), pm: (c) => write(c, "junk.txt") });
    const seed = once((t) => {
      ids = ["a", "b", "c"].map((x) => t.createTicket({ title: x }, "dev").id);
      t.addRelation("T-2", ids[2], "blocks", "org");
    });
    await until(f, (t) => { seed(t); return ev("git.discarded").length > 0; });
    const s = f.spawned.find((x) => x.kind === "triage")!;
    expect(s).toMatchObject({ member: "pm", ticket: "", batch: ids.slice(0, 2), wt: wt("pm"), branch: "", reasoning: "medium" });
    expect(s.tools).not.toContain("write");
    expect(ev("git.discarded")[0]).toMatchObject({ data: { member: "pm", files: ["junk.txt"] } });
  });

  it("a triage batch takes a chain of Triage tickets at once", async () => {
    let ids: string[] = [];
    const f = fake({ ba: (c) => void f.live.add(c.id) });
    const seed = once((t) => {
      ids = ["a", "b", "c"].map((x) => t.createTicket({ title: x }, "dev").id);
      t.addRelation(ids[0], ids[1], "blocks", "org");
      t.addRelation("T-2", ids[2], "blocks", "org"); // a Triage ticket blocked by an open breakdown waits
    });
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.kind === "triage"); });
    expect(f.spawned.find((x) => x.kind === "triage")!.batch).toEqual(ids.slice(0, 2));
  });

  it("three no-op sessions move the ticket to Needs Reply for the human", async () => {
    const f = fake({ ba: () => {} });
    await until(f, (t) => t.getTicket("T-2").status === "needs_reply");
    expect(f.spawned.filter((x) => x.member === "ba")).toHaveLength(3);
    expect(db().getTicket("T-2")).toMatchObject({ assignee: "human", return_status: "in_progress", return_assignee: "ba" });
    expect(db().getTicket("T-2").comments.at(-1)!.text).toBe("ba ended 3 sessions on T-2 without a transition. The last session's final text: last words of s3");
  });

  it("a transition resets the no-op count", async () => {
    const at: string[] = [];
    let n = 0;
    const f = fake({ ba: (c) => { n++; at.push(c.t.getTicket("T-2").status); if (n === 3) c.t.setStatus("T-2", "todo", "ba"); } });
    await until(f, () => n >= 6);
    expect(at).toEqual(Array(6).fill("in_progress"));
  });

  it("a stream cut is a transient failure", () => {
    expect(transient({ error: "stream cut: no finish reason" })).toBe(true);
    expect(transient({ error: "boom" })).toBe(false);
  });

  it("the daemon uses the configured caps", async () => {
    // noop_sessions 2: the ticket waits for the human after two no-op sessions
    saveOrg(org({ noop_sessions: 2 }));
    const f = fake({ ba: () => {} });
    await until(f, (t) => t.getTicket("T-2").status === "needs_reply");
    expect(f.spawned.filter((x) => x.member === "ba")).toHaveLength(2);
  });

  it("the daemon backs off by retry_seconds without a deps override", async () => {
    saveOrg(org({ retry_seconds: 1, retry_max_seconds: 1 }));
    let n = 0;
    const f = fake({ ba: () => (++n <= 2 ? 429 : undefined) });
    delete (f.deps as Partial<OrgDeps>).retryMs;
    await until(f, () => n >= 3, yes, 8000);
    const t = f.spawned.map((x) => x.at);
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(1000);
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(1000);
    expect(t[2] - t[1]).toBeLessThan(1900); // capped by retry_max_seconds, not doubled to 2 s
  }, 10_000);

  it("a triage session cuts descriptions at triage_chars", async () => {
    saveOrg(org({ triage_chars: 20 }));
    const f = fake({ ba: (c) => void f.live.add(c.id) });
    const seed = once((t) => void t.createTicket({ title: "a", description: "y".repeat(100) }, "dev"));
    await until(f, (t) => { seed(t); return f.spawned.some((x) => x.kind === "triage"); });
    const task = f.spawned.find((x) => x.kind === "triage")!.task;
    expect(task).toContain("y".repeat(20));
    expect(task).not.toContain("y".repeat(21));
  });

  it("a work session sees its branch changes", async () => {
    let n = 0;
    const f = fake({ ba: (c) => { if (++n === 1) write(c, "docs/notes.md", "n"); } });
    await until(f, () => f.spawned.filter((x) => x.member === "ba").length >= 2);
    const [a, b] = f.spawned.filter((x) => x.member === "ba");
    expect(a.task).not.toContain("# Changes on your branch so far");
    expect(b.task).toMatch(/# Changes on your branch so far\n.*docs\/notes\.md/);
  });

  it("a worktree with leftover changes is cleaned before checkout", async () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    fs.writeFileSync(path.join(repo, ".gitignore"), "keep.log\n"); fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "ignore");
    fs.mkdirSync(path.dirname(wt("ba")), { recursive: true });
    git(repo, "worktree", "add", "-q", "--detach", wt("ba"));
    fs.writeFileSync(path.join(wt("ba"), "a.txt"), "changed\n");
    fs.writeFileSync(path.join(wt("ba"), "junk.txt"), "j");
    fs.writeFileSync(path.join(wt("ba"), "keep.log"), "k");
    let seen: string[] = [];
    const f = fake({ ba: (c) => { seen = ["junk.txt", "keep.log"].filter((x) => fs.existsSync(path.join(c.wt, x))); seen.push(fs.readFileSync(path.join(c.wt, "a.txt"), "utf8")); } });
    await until(f, () => f.spawned.length > 0);
    expect(seen).toEqual(["keep.log", "a\n"]);
    expect(ev("git.discarded")[0]).toMatchObject({ data: { member: "ba", files: ["a.txt", "junk.txt"] } });
    expect(kinds()).not.toContain("org.paused");
  });

  it("a transient failure backs off without counting", async () => {
    const at: string[] = [];
    let n = 0;
    const f = fake({ ba: (c) => { at.push(c.t.getTicket("T-2").status); return ++n <= 3 ? 429 : undefined; } }, { retryMs: 10 });
    await until(f, () => n >= 5);
    expect(at).toEqual(Array(5).fill("in_progress"));
    const t = f.spawned.map((x) => x.at);
    expect([t[1] - t[0], t[2] - t[1], t[3] - t[2]].map((d, i) => d >= 10 * 2 ** i)).toEqual([true, true, true]);
  });

  it("an idle org waits for the human answer", async () => {
    let waited = false;
    const f = fake({ ba: () => {} });
    await until(f, (t) => {
      if (!waited && t.getMeta("waiting") === true) { waited = true; createOps(t, org()).answer("T-2", "", "user"); }
      return f.spawned.filter((x) => x.member === "ba").length >= 4;
    });
    expect(waited).toBe(true);
    expect(kinds()).not.toContain("org.paused");
    expect(f.spawned[3]).toMatchObject({ member: "ba", ticket: "T-2", status: "in_progress" });
  });

  it("an idle org with nothing to wake pauses with a digest", async () => {
    const texts: string[] = [];
    await until(fake({ ba: unassign }), () => texts.length > 0, (t, q) => { texts.push(q.text); });
    expect(texts[0]).toBe("The org is idle and nothing can wake. Open tickets:\nT-1 todo ba\nT-2 in_progress -\nT-3 todo - blocked by T-2\nApprove to retry or reject to stop.");
    expect(ev("org.paused")[0].data).toEqual({ reason: "idle" });
    expect(db().getMeta("waiting")).toBe(false);
  });

  it("a rejected pause stops the org", async () => {
    const s = await until(fake({ ba: unassign }), (t) => t.getMeta<{ status: string }>("state")?.status === "stopped", (t, q) => void t.answer(q.id, "no", "user", false));
    expect(s.status).toBe("stopped");
    expect(ev("org.stopped").map((e) => e.data.reason)).toEqual([expect.stringMatching(/^Q-1 rejected/)]);
  });

  it("an org with events the bus has not handled yet is not idle", async () => {
    // a merge logs git.merged after the drain; the close and the next wakes come on the next drain
    const f = fake(happy);
    await until(f, (t) => t.inbox("open").some((q) => q.kind === "approval"), () => {});
    expect(kinds()).toContain("git.merged");
    expect(kinds()).not.toContain("org.paused");
  });

  it("an old run is moved to history", async () => {
    const dir = orgDir("acme");
    fs.mkdirSync(dir, { recursive: true });
    for (const x of ["org.db", "org.db-wal", "org.db-shm"]) fs.writeFileSync(path.join(dir, x), "old");
    const ac = new AbortController();
    ac.abort();
    expect(await runOrg("acme", "g", fake({}).deps, ac.signal)).toEqual({ status: "stopped" });
    const [stamp] = fs.readdirSync(path.join(dir, "history"));
    expect(fs.readFileSync(path.join(dir, "history", stamp, "org.db"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(dir, "history", stamp, "org.db-wal"))).toBe(true);
    expect(db().getMeta("goal")).toBe("g");
  });
});

describe("org runner deps", () => {
  it("defaultDeps spawn passes the org ref with the session kind; alive and stop use the agent state", () => {
    saveProvider({ name: "p", kind: "ollama" } as never);
    const spawn = vi.spyOn(run.deps, "spawn").mockReturnValue({ pid: 4242, unref() {} } as never);
    const id = defaultDeps.spawn({ org: org(), member: "pm", def: def("dpm"), task: "t", db: "/db", ticket: "", kind: "triage", batch: ["T-2"], main: "main" });
    expect(JSON.parse(fs.readFileSync(run.runFile(id), "utf8"))).toMatchObject({ org: { name: "acme", member: "pm", db: "/db", ticket: "", main: "main", kind: "triage", batch: ["T-2"] }, def: { sandbox: false } });
    expect(spawn).toHaveBeenCalled();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(defaultDeps.alive(id)).toBe(true);
    defaultDeps.stop(id);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(() => defaultDeps.alive("missing")).toThrow("no such agent");
    defaultDeps.stop("missing"); // unknown id: nothing to stop
    expect(defaultDeps).toMatchObject({ pollMs: 1000 });
  });
});

describe("org daemon helpers", () => {
  it("loadRunnable returns the org with its definitions and refuses a missing repo or definition", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
    const members = Object.fromEntries(["ba", "sa", "pm", "tl", "dev"].map((r) => [r, { role: r, definition: "d1" }]));
    saveOrg(validateOrg({ name: "solo", repo: work, members }));
    expect(() => loadRunnable("solo")).toThrow("no such definition: d1");
    saveDefinition(parseDefinition(JSON.stringify({ name: "d1", provider: "p", model: "m" })));
    const { org: o, defs } = loadRunnable("solo");
    expect(o.repo).toBe(work);
    expect(Object.keys(defs)).toEqual(["d1"]);
    saveOrg(validateOrg({ name: "gone", repo: path.join(work, "nope"), members }));
    expect(() => loadRunnable("gone")).toThrow(`org "gone": repo ${path.join(work, "nope")} does not exist`);
  });

  it("expandRepo expands ~ and orgPid reads a live pid", () => {
    expect(expandRepo("~/r")).toBe(path.join(os.homedir(), "r"));
    expect(orgPid("acme")).toBeUndefined();
    fs.mkdirSync(path.dirname(pidFile("acme")), { recursive: true });
    fs.writeFileSync(pidFile("acme"), String(process.pid));
    expect(orgPid("acme")).toBe(process.pid);
  });

  it("runOrgMain runs the org from start.json, stops on SIGTERM and removes org.pid", async () => {
    saveProvider({ name: "p", kind: "ollama" } as never);
    vi.spyOn(run.deps, "spawn").mockReturnValue({ pid: 4242, unref() {} } as never);
    fs.mkdirSync(orgDir("acme"), { recursive: true });
    fs.writeFileSync(path.join(orgDir("acme"), "start.json"), JSON.stringify({ goal: "g" }));
    fs.writeFileSync(pidFile("acme"), "1");
    const p = runOrgMain("acme");
    setTimeout(() => process.emit("SIGTERM"), 20);
    await p;
    expect(fs.existsSync(pidFile("acme"))).toBe(false);
    expect(db().getMeta("state")).toEqual({ status: "stopped" });
    expect(db().getMeta("goal")).toBe("g");
  });
});
