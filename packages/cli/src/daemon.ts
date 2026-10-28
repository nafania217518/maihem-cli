import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { APICallError, RetryError } from "ai";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";
import type { Resolved } from "./providers.ts";
import { encode, lineSplitter } from "./protocol.ts";
import type { AgentEvent, ClientMessage } from "./protocol.ts";
import { expandRepo } from "./org/daemon.ts";
import { changedFiles, commitAll, diff, dirtyFiles, discard, emptyDirs, mergeMain, milestoneDiff } from "./org/git.ts";
import { loadOrg } from "./org/store.ts";
import { createOrgTools, stopTools } from "./org/tools.ts";
import { openTracker } from "./org/tracker.ts";
import { buildAgent, openBackend, printEvent, reportCopyOut, runFile } from "./run.ts";
import type { OrgRef } from "./run.ts";
import { loadState, saveState } from "./state.ts";
import { copyOut } from "./sync.ts";

export interface DaemonHandle { shutdown(apply?: boolean): Promise<void>; done: Promise<void>; sock: string }

export async function serveAgent(id: string, opts: { model?: LanguageModel } = {}): Promise<DaemonHandle> {
  const state = loadState(id);
  const { def, task, provider, mode = "chat", allowEmpty, org } = JSON.parse(fs.readFileSync(runFile(id), "utf8")) as { def: Definition; task?: string; provider: Resolved; mode?: "run" | "chat"; allowEmpty?: boolean; org?: OrgRef };
  const readonly = mode === "run";
  const { backend, snap } = await openBackend(def, id, org && path.join(path.dirname(org.db), "home"));
  // an org session works the org tracker and ends its turn after a stop tool (submit_review, a review decision, escalate)
  const tracker = org && openTracker(org.db);
  const o = org && loadOrg(org.name);
  // a work session's submit commits the work so far, then merges main into the ticket's branch (the submit guard)
  const merge = (): ReturnType<typeof mergeMain> => {
    const tk = tracker!.getTicket(org!.ticket!);
    if (!tk.branch) return { ok: true }; // a read-only work session: the runner discards its changes
    commitAll(def.workdir!, `${org!.member}: ${tk.id} ${tk.title}`, { name: org!.member, email: `${org!.member}@${org!.name}.maihem` });
    return mergeMain(def.workdir!, org!.main);
  };
  const orgTools = org && tracker && o ? createOrgTools(tracker, org.member, o,
    { ticket: org.ticket!, kind: org.kind, batch: org.batch, diff: (t) => diff(expandRepo(o.repo), org.main, tracker.getTicket(t).branch ?? org.main), files: () => changedFiles(def.workdir!, org.main),
      size: (f) => { try { return fs.readFileSync(path.join(def.workdir!, f), "utf8").length; } catch { return 0; } },
      emptyDirs: () => emptyDirs(def.workdir!),
      dirty: async () => dirtyFiles(def.workdir!), discard: async () => void discard(def.workdir!),
      milestoneDiff: (tags, p) => milestoneDiff(expandRepo(o.repo), org.main, tags, p),
      ...(org.kind === "work" && { merge }) }) : {};
  const agent = buildAgent(def, provider, backend, opts.model, readonly, readonly && !allowEmpty, orgTools, org && stopTools(org.kind));
  if (org && tracker) tracker.log("session.started", org.member, { member: org.member, id }, org.ticket);
  const clients = new Set<net.Socket>();
  let busy = false;
  let exitCode = 0;
  let tools = 0; // tool calls in the current turn
  let text = "", inText = false; // the last assistant text, for session.ended

  const broadcast = (e: AgentEvent): void => {
    // the log keeps the full error of a failed tool call (e.g. an invalid input); the screen preview stays short
    if (e.type === "tool-result" && !e.ok) process.stderr.write(`  → ✗ ${e.output}\n`); else printEvent(e);
    if (e.type === "tool") tools++;
    if (e.type === "text") { if (!inText) text = ""; text += e.delta; inText = true; } else if (e.type !== "thinking") inText = false;
    if (e.type === "done" && e.incomplete) { saveState({ ...loadState(id), detail: e.incomplete }); if (readonly) exitCode = 2; }
    if (e.type === "done" && org && tracker) {
      if (e.incomplete === "step limit") tracker.log("session.capped", org.member, { member: org.member, id, steps: e.steps }, org.ticket);
      const input = e.usage?.inputTokens ?? 0, output = e.usage?.outputTokens ?? 0;
      // an empty answer (e.g. a provider that times out with an empty stream) fails, so the runner backs off and pauses
      if (e.incomplete === "stream cut") { exitCode = 1; tracker.log("session.failed", org.member, { member: org.member, id, error: "stream cut: the provider stream ended without a finish reason" }, org.ticket); }
      else if (!output && !tools && !e.incomplete && !e.interrupted) { exitCode = 1; tracker.log("session.failed", org.member, { member: org.member, id, error: "empty answer: no output and no tool call" }, org.ticket); }
      else tracker.log("session.ended", org.member, { member: org.member, id, tokens: input + output, input, output, text: text.slice(0, 500) }, org.ticket);
    }
    for (const c of clients) c.write(encode(e));
  };
  const handle = async (text: string, reply?: net.Socket): Promise<void> => {
    if (readonly && reply) { reply.write(encode({ type: "error", message: "read-only: this agent runs one task" })); return; }
    if (busy) { reply?.write(encode({ type: "error", message: "busy: a turn is in progress" })); return; }
    busy = true;
    tools = 0;
    if (loadState(id).detail) saveState({ ...loadState(id), detail: undefined });
    try { await agent.run(text, broadcast); } catch (e) {
      exitCode = 1; // agent.run already broadcast the error; the org learns of it through session.failed
      const err = RetryError.isInstance(e) ? e.lastError : e;
      if (org && tracker) tracker.log("session.failed", org.member, { member: org.member, id, error: e instanceof Error ? e.message : String(e),
        ...(APICallError.isInstance(err) && { status: err.statusCode }) }, org.ticket);
    }
    busy = false;
  };

  fs.rmSync(state.sock, { force: true });
  const server = net.createServer((c) => {
    clients.add(c);
    c.write(encode({ type: "hello", name: def.name, model: def.model, provider: def.provider, sandbox: def.sandbox, id, readonly, workdir: def.workdir!, history: agent.history }));
    c.on("data", lineSplitter((o) => { const m = o as ClientMessage; if (m.type === "msg") void handle(m.text, c);
      else if (m.type === "inject") agent.inject(m.text);
      else if (m.type === "interrupt") { if (readonly) c.write(encode({ type: "error", message: "read-only: this agent runs one task" })); else agent.interrupt(); }
      else if (m.type === "stop") void shutdown(m.apply); }));
    const drop = (): void => { clients.delete(c); };
    c.on("close", drop);
    c.on("error", drop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.sock, resolve);
  });

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let closing: Promise<void> | undefined;
  const shutdown = (apply = true): Promise<void> => (closing ??= (async () => {
    server.close();
    for (const c of clients) c.end();
    if (def.sandbox && apply) reportCopyOut(await copyOut(backend, def.workdir!, snap!), (s) => process.stderr.write(s));
    saveState({ ...loadState(id), status: "exited", exitCode });
    fs.rmSync(runFile(id), { force: true });
    fs.rmSync(state.sock, { force: true });
    tracker?.close();
    resolveDone();
  })());
  process.once("SIGTERM", () => void shutdown(true));
  process.once("SIGINT", () => void shutdown(true));
  if (task) void handle(task).then(() => { if (readonly) void shutdown(true); });
  return { shutdown, done, sock: state.sock };
}
