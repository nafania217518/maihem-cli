// Org runner (docs/org-design.md §12, status-workflow.md §5): each tick drains the event bus, merges approved tickets one
// at a time, reaps ended sessions, checks the token limit and runs the cycle: it scans the tracker for the sessions the
// tickets need and spawns them into the free slots, one per member, at most `parallel` in all. An idle org waits for
// the human's reply, or pauses with a digest of the open tickets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Definition } from "../definition.ts";
import { resolveProvider } from "../providers.ts";
import { home, loadDefinition } from "../registry.ts";
import { spawnAgent } from "../run.ts";
import { isAlive, loadState } from "../state.ts";
import { createBus, execute } from "./bus.ts";
import type { Io, View } from "./bus.ts";
import { crossCheck } from "./config.ts";
import { handlers } from "./flow.ts";
import { branchStat, checkoutReview, checkoutTicket, commitAll, discard, dropBranch, mergeMain, prepareRepo, pushTag, slug, squashMerge, tag, worktree } from "./git.ts";
import { createOps } from "./ops.ts";
import { isReq, systemFor, taskFor } from "./prompt.ts";
import { loadOrg } from "./store.ts";
import { fileToolsFor } from "./tools.ts";
import { openTracker } from "./tracker.ts";
import { isOpen, LEVEL, REASONING } from "./types.ts";
import type { Org, OrgEvent, Status, Wake } from "./types.ts";

type Kind = Wake["kind"];
export interface OrgDeps {
  // def.workdir is the member's worktree; returns the session id
  spawn: (o: { org: Org; member: string; def: Definition; task: string; db: string; ticket: string; kind: Kind; batch?: string[]; main: string }) => string;
  alive: (id: string) => boolean;
  stop: (id: string) => void;
  pollMs: number;
  retryMs?: number; // the first backoff of a ticket after a transient failure (default limits.retry_seconds); it doubles, at most limits.retry_max_seconds
}
export interface OrgState { status: "running" | "paused" | "done" | "stopped"; gate?: string } // gate: the pause's inbox approval

export const orgDir = (name: string): string => path.join(home(), "orgs", name);
export const dbFile = (name: string): string => path.join(orgDir(name), "org.db");
export const expandRepo = (repo: string): string => repo.replace(/^~(?=$|\/)/, os.homedir());
export const pidFile = (name: string): string => path.join(orgDir(name), "org.pid");

// pid of the running org daemon, if any
export function orgPid(name: string): number | undefined {
  const pid = fs.existsSync(pidFile(name)) ? Number(fs.readFileSync(pidFile(name), "utf8")) : 0;
  return pid && isAlive(pid) ? pid : undefined;
}

// Loads an org and everything it needs to run; throws on the first problem. The repo comes back with "~" expanded.
export function loadRunnable(name: string): { org: Org; defs: Record<string, Definition> } {
  const o = loadOrg(name);
  const org = { ...o, repo: expandRepo(o.repo) };
  if (!fs.existsSync(org.repo)) throw new Error(`org "${name}": repo ${org.repo} does not exist`);
  const defs = Object.fromEntries(Object.values(org.members).map(({ definition: d }) => [d, loadDefinition(d)]));
  crossCheck(org, (d) => d in defs);
  return { org, defs };
}

export const defaultDeps: OrgDeps = {
  spawn: ({ org, member, def, task, db, ticket, kind, batch, main }) =>
    spawnAgent({ ...def, sandbox: false }, task, resolveProvider(def.provider), "run", true, { name: org.name, member, db, ticket, main, kind, batch }, `${org.name}/${member}`).id,
  alive: (id) => { const s = loadState(id); return s.status === "running" && isAlive(s.pid); },
  stop: (id) => { try { process.kill(loadState(id).pid, "SIGTERM"); } catch { /* already gone */ } },
  pollMs: 1000,
};

// org-design.md §12.4: a provider fault (429, 5xx, a malformed 2xx, an empty answer, no connection) is not the member's
export const transient = (d: OrgEvent["data"]): boolean => {
  const st = Number(d.status), err = String(d.error ?? "");
  return st === 429 || st >= 500 || (st >= 200 && st < 300) || err.startsWith("empty answer") || err.startsWith("stream cut") || (!d.status && /fetch failed|ECONNREFUSED|ETIMEDOUT|socket/i.test(err));
};
// slot order (status-workflow.md §5)
const SLOT: Partial<Record<Status, number>> = { needs_reply: 0, in_review: 1, in_progress: 2, todo: 3, triage: 4 };

// git: the failed operation stays queued and retries; command: the event that failed
type Pause = { kind: "tokens" } | { kind: "git" } | { kind: "command"; event: number } | { kind: "idle" };
// since: the last event id before the session started, to find its transitions
interface Session { id: string; ticket: string; kind: Kind; batch?: string[]; wt: string; ro: boolean; since: number }
type Candidate = Wake & { batch?: string[]; rank: number; priority: number; ord: number };

export async function runOrg(name: string, goal: string, deps: OrgDeps, signal?: AbortSignal, opts: { resume?: boolean } = {}): Promise<OrgState> {
  const { org, defs } = loadRunnable(name);
  const db = dbFile(name);
  if (!opts.resume && fs.existsSync(db)) {
    const hist = path.join(orgDir(name), "history", String(Date.now()));
    fs.mkdirSync(hist, { recursive: true });
    for (const f of [db, `${db}-wal`, `${db}-shm`]) if (fs.existsSync(f)) fs.renameSync(f, path.join(hist, path.basename(f)));
  }
  const { main, created } = prepareRepo(org.repo);
  const t = openTracker(db);
  const ops = createOps(t, org);
  const l = org.limits, noopCap = l.noop_sessions ?? 3; // no-op sessions in a row on a ticket before it waits for the human
  const retryMs = deps.retryMs ?? (l.retry_seconds ?? 30) * 1000, maxBackoff = (l.retry_max_seconds ?? 600) * 1000;
  const bus = createBus(handlers);
  const view: View = { t, ops, org, goal };
  const wtOf = (m: string) => path.join(orgDir(name), "worktrees", m);
  const who = (m: string) => ({ name: m, email: `${m}@${name}.maihem` });

  let state: OrgState = { status: "running" }, pause: Pause | undefined;
  let tokens = 0, tokenLimit = (opts.resume && t.getMeta<number>("tokenLimit")) || org.limits.tokens, seen = 0, queue: Wake[] = [], waiting = false;
  const sessions: Record<string, Session> = {}; // member → its session
  const merges: string[] = [];
  const tags: string[] = []; // completed milestones to tag
  const outcome = new Map<string, OrgEvent>(); // session id → its session.ended or session.failed event
  const noops: Record<string, number> = {}; // "member ticket" → sessions in a row without a transition
  const backoff: Record<string, { until: number; n: number }> = {}; // ticket → its backoff after transient failures

  const meta = () => {
    t.setMeta("state", state); t.setMeta("tokens", tokens); t.setMeta("tokenLimit", tokenLimit); t.setMeta("queue", queue); t.setMeta("waiting", waiting);
    t.setMeta("sessions", Object.fromEntries(Object.entries(sessions).map(([m, s]) => [m, { id: s.id, ticket: s.ticket, kind: s.kind }])));
  };
  const ended = () => state.status === "done" || state.status === "stopped";
  // once: one drain can hold several done commands
  const finish = (status: "done" | "stopped", data: Record<string, unknown> = {}) => {
    if (ended()) return;
    state = { status };
    t.log(`org.${status}`, "org", data);
  };
  // one gate at a time: a problem found while paused waits for the resume
  const halt = (reason: string, text: string, p: Pause) => {
    if (state.status !== "running") return;
    state = { status: "paused", gate: t.ask(text, "org").id };
    pause = p;
    t.log("org.paused", "org", { reason });
  };
  const gitFail = (op: string, id: string, where: string, e: unknown) => {
    if (state.status !== "running") return;
    const message = (e as Error).message;
    t.log("git.error", "org", { op, message }, id);
    halt(`git ${op}`, `git ${op} failed for ${id}: ${message}. Fix it in ${where}, then approve to retry, or reject to stop.`, { kind: "git" });
  };
  const on = (member: string, ticket: string) => (sessions[member]?.ticket === ticket ? sessions[member] : undefined);
  const io: Io = {
    merge: (ticket) => { if (!merges.includes(ticket)) merges.push(ticket); },
    tag: (ms) => { if (!tags.includes(ms)) tags.push(ms); },
    stop: (m, ticket) => { const s = on(m, ticket); if (s) deps.stop(s.id); },
    done: () => finish("done"),
  };

  // 1. the bus; a failing command pauses the org on its event (the cursor stays before it)
  const drain = () => {
    if (pause?.kind === "command") return;
    try { bus.drain(t, view, (c) => execute(c, view, io)); }
    catch (e) {
      const id = t.events(t.getMeta<number>("cursor") ?? 0, 1)[0].id;
      halt(`command failed on event ${id}`, `Command failed on event ${id}: ${(e as Error).message}. Approve to skip it, or reject to stop.`, { kind: "command", event: id });
    }
  };
  const resume = (approved: boolean) => {
    const p = pause!;
    pause = undefined;
    if (!approved) return finish("stopped", { reason: `${state.gate} rejected` });
    if (p.kind === "tokens") tokenLimit = tokenLimit! + org.limits.tokens!;
    else if (p.kind === "command") t.setMeta("cursor", p.event);
    state = { status: "running" };
    t.log("org.resumed", "org");
  };
  // a status or assignee change of a ticket is a transition: it resets the ticket's no-op counts
  const transition = (e: OrgEvent) => e.kind === "ticket.status" || e.kind === "ticket.assigned";
  // the runner's own reading of the log: session outcomes, tokens, transitions and the answer to the pause
  const observe = () => {
    for (const e of t.events(seen)) {
      seen = e.id;
      if (e.kind === "session.ended" || e.kind === "session.failed") outcome.set(String(e.data.id), e);
      if (e.kind === "session.ended") tokens += Number(e.data.tokens ?? 0);
      if (transition(e)) for (const k in noops) if (k.endsWith(` ${e.ticket}`)) delete noops[k];
      if (e.kind === "inbox.answered" && state.status === "paused" && e.data.id === state.gate) resume(Boolean(e.data.approved));
    }
  };

  // 2. squash-merge an approved ticket into main
  const merge = (id: string) => {
    const tk = t.getTicket(id);
    if (tk.status !== "in_review") return;
    if (!tk.branch) return void t.log("git.merged", "org", { commit: null }, id);
    const by = tk.approvals.filter((a) => a.state === "approved").map((a) => a.reviewer).join(", ");
    let r: ReturnType<typeof squashMerge>;
    try { r = squashMerge(org.repo, tk.branch, `${id}: ${tk.title}\n\nReviewed-by: ${by}`, who(tk.assignee ?? tk.owner)); }
    catch (e) { merges.unshift(id); return gitFail("merge", id, org.repo, e); }
    if ("dirty" in r) { merges.unshift(id); return halt("dirty main", `The main checkout ${org.repo} has local changes; commit or discard them, then approve to retry the merge of ${id}.`, { kind: "git" }); }
    if (!r.ok) return void t.log("git.conflict", "org", { files: r.conflicts }, id);
    t.setMerged(id, r.commit ?? "none", "org");
    t.log("git.merged", "org", { commit: r.commit }, id);
    try { dropBranch(org.repo, tk.branch, Object.keys(org.members).map(wtOf)); } catch { /* a stale branch is harmless */ }
    t.setBranch(id, null, "org");
  };

  // 2b. tag main with a completed milestone's id, once; a push to origin is best effort
  const tagMain = (ms: string) => {
    try { if (tag(org.repo, main, ms, `${ms} ${t.getMilestone(ms).name}`)) t.log("git.tagged", "org", { milestone: ms, tag: ms }); }
    catch (e) { tags.unshift(ms); return gitFail("tag", ms, org.repo, e); }
    try { pushTag(org.repo, ms); } catch (e) { t.log("git.push_failed", "org", { milestone: ms, tag: ms, message: (e as Error).message }); }
  };

  // 3. an ended session: commit its work (or drop a read-only session's changes), then judge how it ended.
  // A failed commit keeps the session, so it retries on the next tick.
  const reap = (m: string, s: Session) => {
    try {
      if (s.ro) {
        const files = discard(s.wt);
        if (files.length) t.log("git.discarded", "org", { member: m, files }, s.ticket);
      } else {
        const tk = t.getTicket(s.ticket);
        commitAll(s.wt, `${m}: ${tk.id} ${tk.title}`, who(m));
        checkoutReview(s.wt, "HEAD"); // frees the branch for other worktrees
      }
    } catch (e) { return gitFail(s.ro ? "discard" : "commit", s.ticket || "the triage", s.wt, e); }
    delete sessions[m];
    const e = outcome.get(s.id);
    outcome.delete(s.id);
    if (e?.kind === "session.failed" && transient(e.data)) {
      const b = backoff[s.ticket] ?? { until: 0, n: 0 };
      backoff[s.ticket] = { until: Date.now() + Math.min(retryMs * 2 ** b.n, maxBackoff), n: b.n + 1 };
      return;
    }
    delete backoff[s.ticket];
    // a no-op: no transition on its ticket since the session started; a triage session, for each batch ticket left in Triage
    const evs = t.events(s.since).filter((x) => transition(x) || (x.kind === "approval.set" && x.actor === m));
    const left = s.kind === "triage" ? (s.batch ?? []).filter((x) => t.getTicket(x).status === "triage") : evs.some((x) => x.ticket === s.ticket) ? [] : [s.ticket];
    for (const id of left) {
      const k = `${m} ${id}`, n = noops[k] = (noops[k] ?? 0) + 1;
      if (n < noopCap || !isOpen(t.getTicket(id).status)) continue;
      delete noops[k];
      const text = e?.data.text ? String(e.data.text) : "(none)";
      try { ops.parkForHuman(id, `${m} ended ${n} sessions on ${id} without a transition. The last session's final text: ${text}`); }
      catch { /* it already waits for the human */ }
    }
  };

  // 4. limits
  const limits = () => {
    if (tokenLimit !== undefined && tokens > tokenLimit)
      halt(`tokens ${tokens} > ${tokenLimit}`, `Token limit reached: ${tokens} of ${tokenLimit} tokens. Approve to continue (adds ${org.limits.tokens} more) or reject to stop.`, { kind: "tokens" });
  };

  // 5. the cycle (status-workflow.md §5): scan the open tickets for wakes, drop the ones that cannot run now, sort by slot
  // order, then priority and manual order. Returns every wake, also those held by a session or a backoff.
  const scan = (): { ready: Candidate[]; held: number } => {
    const a = ops.active()?.id, pm = Object.keys(org.members).find((m) => org.members[m].role === "pm")!;
    const busy = new Set(Object.values(sessions).map((s) => s.ticket));
    const working = new Set(t.listTickets({ status: "in_progress" }).map((x) => x.assignee));
    const all: Candidate[] = [], batch: string[] = [];
    for (const tk of t.listTickets()) {
      if (!isOpen(tk.status) || tk.kind === "requirements" || t.blockers(tk.id).some((b) => tk.status !== "triage" || b.status !== "triage") || t.children(tk.id).some((c) => isOpen(c.status))) continue;
      const add = (member: string | undefined, kind: Kind) => { if (member && member in org.members) all.push({ member, ticket: tk.id, kind, rank: SLOT[tk.status]!, priority: tk.priority, ord: tk.ord }); };
      if (tk.status === "triage") batch.push(tk.id);
      else if (tk.status === "needs_reply") add(tk.assignee, "reply");
      else if (tk.status === "todo") { if (tk.milestone === a && !working.has(tk.assignee)) add(tk.assignee, "work"); }
      else if (tk.status === "in_progress") add(tk.assignee, "work");
      else if (tk.status === "in_review") for (const p of t.getTicket(tk.id).approvals) if (p.state === "pending") add(p.reviewer, "review");
    }
    if (batch.length) all.push({ member: pm, ticket: "", kind: "triage", batch, rank: SLOT.triage!, priority: 0, ord: 0 });
    const now = Date.now();
    const ready = all.filter((w) => !sessions[w.member] && (backoff[w.ticket]?.until ?? 0) <= now
      && !(busy.has(w.ticket) && (w.kind !== "review" || Object.values(sessions).some((s) => s.ticket === w.ticket && s.kind !== "review"))));
    ready.sort((x, y) => x.rank - y.rank || y.priority - x.priority || x.ord - y.ord);
    return { ready, held: all.length - ready.length };
  };

  // spawn one wake; read-only: review, reply, triage (at main, or at the ticket's branch)
  const spawn = (w: Candidate): boolean => {
    const tk = w.ticket ? t.getTicket(w.ticket) : undefined, wt = wtOf(w.member), ro = w.kind !== "work";
    try {
      worktree(org.repo, wt);
      const left = discard(wt); // leftovers of a crashed session; never the main checkout
      if (left.length) t.log("git.discarded", "org", { member: w.member, files: left }, w.ticket);
      if (ro) checkoutReview(wt, tk?.branch ?? main);
      else if (tk) {
        const b = tk.branch ?? `t-${tk.id.slice(2)}-${slug(tk.title)}`;
        checkoutTicket(wt, b, main);
        // rework starts from the current main; a conflict leaves the markers for the member and a comment
        const r = tk.branch ? mergeMain(wt, main) : { ok: true as const };
        if (!r.ok) t.addComment(tk.id, `Merging main into your branch conflicts in ${r.conflicts.join(", ")}. Main changed by: ${r.commits.join("; ")}. Resolve the conflict markers in those files, run the checks, then submit again.`, "org");
        t.setBranch(tk.id, b, "org");
        if (tk.status === "todo") ops.start(tk.id, "org");
      }
    } catch (e) { gitFail("checkout", w.ticket || "the triage", wt, e); return false; }
    const { role, definition } = org.members[w.member], d = defs[definition];
    const req = !!tk && isReq(t, tk);
    const tools = fileToolsFor(role, w.kind, d.tools, tk?.kind, req).filter((x) => !ro || (x !== "write" && x !== "edit")) as Definition["tools"];
    const def = { ...d, reasoning: d.reasoning ?? REASONING[LEVEL[role]], system: systemFor({ org, member: w.member, goal, defs, kind: w.kind, milestone: ops.active(), ticketKind: tk?.kind, req }), workdir: wt, tools };
    const since = t.events().at(-1)?.id ?? 0;
    const id = deps.spawn({ org, member: w.member, def, task: taskFor({ t, ticket: w.ticket, kind: w.kind, member: w.member, org, repo: wt, main, batch: w.batch, tools: d.tools, triageChars: l.triage_chars, branchStat: ro ? undefined : branchStat(wt, main) }), db, ticket: w.ticket, kind: w.kind, batch: w.batch, main });
    sessions[w.member] = { id, ticket: w.ticket, kind: w.kind, batch: w.batch, wt, ro, since };
    return true;
  };

  const cycle = () => {
    queue = [];
    const free = org.limits.parallel - Object.keys(sessions).length;
    if (free <= 0) return;
    drain();
    if (state.status !== "running") return;
    const { ready, held } = scan();
    const taken = new Set<string>();
    for (const w of ready) {
      if (taken.has(w.member) || taken.size >= free) { queue.push({ member: w.member, ticket: w.ticket, kind: w.kind }); continue; }
      if (!spawn(w)) return;
      taken.add(w.member);
    }
    // idle: no session, no wake, nothing left for the bus or git, no open approval
    waiting = false;
    if (ready.length || held || Object.keys(sessions).length || merges.length || tags.length || t.events(t.getMeta<number>("cursor") ?? 0, 1).length) return;
    const open = t.listTickets().filter((x) => isOpen(x.status));
    if (t.inbox("open").length || open.some((x) => x.status === "needs_reply" && x.assignee === "human")) { waiting = true; return; }
    const digest = open.map((x) => { const b = t.blockers(x.id).map((y) => y.id); return `${x.id} ${x.status} ${x.assignee ?? "-"}${b.length ? ` blocked by ${b.join(", ")}` : ""}`; });
    halt("idle", `The org is idle and nothing can wake. Open tickets:\n${digest.join("\n")}\nApprove to retry or reject to stop.`, { kind: "idle" });
  };

  const tick = () => {
    drain();
    observe();
    while (state.status === "running" && tags.length) tagMain(tags.shift()!); // before merges: a queued merge is of a later milestone
    while (state.status === "running" && merges.length) merge(merges.shift()!);
    for (const [m, s] of Object.entries(sessions)) if (!deps.alive(s.id)) reap(m, s);
    if (state.status === "running") limits();
    if (state.status === "running") cycle();
    meta();
  };
  const sleep = () => new Promise<void>((res) => {
    const tm = setTimeout(res, deps.pollMs);
    signal?.addEventListener("abort", () => { clearTimeout(tm); res(); }, { once: true });
  });
  const over = () => signal?.aborted || ended();

  t.setMeta("main", main); t.setMeta("goal", goal); t.setMeta("pid", process.pid);
  if (created) t.log("git.init", "org", { repo: org.repo });
  if (opts.resume) t.log("org.resumed", "org", { from: "stopped" });
  else t.log("org.started", "org", { goal });
  try {
    for (;;) {
      tick();
      if (over()) break;
      await sleep();
      if (signal?.aborted) break;
    }
  } finally {
    for (const s of Object.values(sessions)) if (deps.alive(s.id)) deps.stop(s.id);
    for (const m in sessions) delete sessions[m];
    finish("stopped");
    meta();
    t.close();
  }
  return state;
}

// entry of the detached `__org NAME [--resume]` process
export async function runOrgMain(name: string, resume = false): Promise<void> {
  const { goal } = JSON.parse(fs.readFileSync(path.join(orgDir(name), "start.json"), "utf8"));
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGTERM", stop).once("SIGINT", stop);
  try { await runOrg(name, goal, defaultDeps, ac.signal, { resume }); }
  finally {
    process.off("SIGTERM", stop).off("SIGINT", stop);
    fs.rmSync(pidFile(name), { force: true });
  }
}
