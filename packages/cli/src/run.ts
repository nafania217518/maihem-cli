import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";
import type { Backend } from "./backend.ts";
import { createAgent } from "./agent.ts";
import type { Agent } from "./agent.ts";
import { createHostBackend } from "./backend-host.ts";
import { createSandboxBackend } from "./backend-sandbox.ts";
import type { RunArgs } from "./main.ts";
import { createModel } from "./model.ts";
import { resolveProvider } from "./providers.ts";
import type { Resolved } from "./providers.ts";
import type { AgentEvent } from "./protocol.ts";

type DoneEvent = Extract<AgentEvent, { type: "done" }>;
import { home } from "./registry.ts";
import { attach } from "./attach.ts";
import { isAlive, logPath, newId, saveState, sockPath } from "./state.ts";
import type { AgentState } from "./state.ts";
import { copyIn, copyOut } from "./sync.ts";
import type { Snapshot } from "./sync.ts";
import { createTools } from "./tools.ts";
import { ensureWorker } from "./worker.ts";

type StdinKind = "tty" | "pipe" | "file" | "other";
function stdinKind(): StdinKind {
  if (deps.stdin.isTTY) return "tty";
  const st = fs.fstatSync(0);
  return st.isFIFO() ? "pipe" : st.isFile() ? "file" : "other";
}
export const deps: { spawn: typeof spawn; attach: typeof attach; stdin: NodeJS.ReadableStream & { isTTY?: boolean }; stdout: NodeJS.WritableStream & { isTTY?: boolean }; pollMs: number; stdinKind: () => StdinKind } =
  { spawn, attach, stdin: process.stdin, stdout: process.stdout, pollMs: 100, stdinKind };

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

let midLine = false;
export function printEvent(e: AgentEvent): void {
  if (e.type === "text") { process.stdout.write(e.delta); if (e.delta) midLine = !e.delta.endsWith("\n"); }
  else if (e.type === "tool") { if (midLine) process.stdout.write("\n"); midLine = false; process.stderr.write(dim(`⚙ ${e.name}`) + "\n"); }
  else if (e.type === "tool-result") process.stderr.write(dim(`  → ${e.ok ? "✓" : "✗"} ${e.output.split("\n")[0].slice(0, 80)}`) + "\n");
}

export const runFile = (id: string): string => path.join(home(), "agents", `${id}.run.json`);

export async function openBackend(def: Definition, id: string): Promise<{ backend: Backend; snap?: Snapshot }> {
  if (!def.sandbox) return { backend: createHostBackend(def.workdir!) };
  const backend = createSandboxBackend(await ensureWorker(), id);
  const snap = await copyIn(def.workdir!, backend, def.sandbox_exclude);
  if (snap.symlinks) process.stderr.write(`sandbox: skipped ${snap.symlinks} symlinks\n`);
  return { backend, snap };
}

export function reportCopyOut(r: { written: string[]; conflicts: string[] }, write: (s: string) => void): void {
  if (midLine) process.stdout.write("\n");
  midLine = false;
  write(`sandbox: ${r.written.length} files copied back\n`);
  for (const p of r.conflicts) write(`conflict: ${p} changed on the host and in the sandbox; sandbox copy saved as ${p}.sandbox\n`);
}

export function buildAgent(def: Definition, provider: Resolved, backend: Backend, model?: LanguageModel, oneShot = false, requireOutput = false): Agent {
  return createAgent({ model: model ?? createModel(def, provider), system: def.system, tools: createTools(backend, def.tools), maxSteps: def.max_steps,
    reasoning: def.reasoning, context: def.context, onContextFull: def.on_context_full, compactAt: def.compact_at, oneShot, requireOutput });
}

export function incompleteText(e: DoneEvent): string {
  return e.incomplete === "step limit" ? `step limit reached (${e.steps})` : e.incomplete === "output limit" ? "output limit reached" : e.incomplete === "no output" ? "agent finished without output" : e.incomplete!;
}

function newState(id: string, def: Definition, pid: number): AgentState {
  return { id, name: def.name, pid, status: "running", workdir: def.workdir!, sandbox: def.sandbox, started: new Date().toISOString(), log: logPath(id), sock: sockPath(id) };
}

export function spawnAgent(def: Definition, task: string | undefined, provider: Resolved, mode: "run" | "chat", allowEmpty = false): AgentState {
  const id = newId();
  const state = newState(id, def, 0);
  saveState(state);
  fs.writeFileSync(runFile(id), JSON.stringify({ def, task, provider, mode, allowEmpty }), { mode: 0o600 });
  const binPath = fileURLToPath(new URL("../bin/maihem.js", import.meta.url));
  const logFd = fs.openSync(state.log, "a");
  const child = deps.spawn(process.execPath, [binPath, "__agent", id], { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  fs.closeSync(logFd);
  child.unref();
  const running = { ...state, pid: child.pid! };
  saveState(running);
  return running;
}

async function readStdin(): Promise<string | undefined> {
  if (deps.stdin.isTTY) return undefined;
  let text = "";
  for await (const chunk of deps.stdin) text += chunk.toString();
  return text.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchCommand(args: RunArgs): Promise<number> {
  const state = spawnAgent(args.def, args.task, resolveProvider(args.def.provider), "chat");
  if (args.detach) { console.log(state.id); return 0; }
  for (let waited = 0; !fs.existsSync(state.sock); waited += deps.pollMs) {
    if (!isAlive(state.pid) || waited >= 120_000) throw new Error(`agent exited, see maihem logs ${state.id}`);
    await sleep(deps.pollMs);
  }
  await deps.attach(state.sock);
  return 0;
}

export async function runCommand(args: RunArgs): Promise<number> {
  const { def } = args;
  midLine = false;
  // with a task argument, read only a pipe or file: a socket stdin may never close
  const input = args.task && !["pipe", "file"].includes(deps.stdinKind()) ? undefined : await readStdin();
  if (args.task && input === "") throw new Error("piped input is empty");
  const task = args.task && input ? `${args.task}\n\n<input>\n${input}\n</input>` : args.task ?? input;
  if (!task) throw new Error("run needs a task; use maihem launch for chat");
  const provider = resolveProvider(def.provider);
  if (args.detach) {
    console.log(spawnAgent(def, task, provider, "run", args.allowEmpty).id);
    return 0;
  }
  const id = newId();
  const state = newState(id, def, process.pid);
  saveState(state);
  console.error(id);
  const { backend, snap } = await openBackend(def, id);
  const agent = buildAgent(def, provider, backend, undefined, true, !args.allowEmpty);
  let exitCode = 0;
  let done: DoneEvent | undefined;
  const live = deps.stdout.isTTY;
  let step = ""; // piped: only the final step's text goes to stdout
  try {
    await agent.run(task, (e) => {
      if (e.type === "step") step = "";
      if (!live && e.type === "text") step += e.delta;
      else printEvent(e);
      if (e.type === "done" && e.incomplete) done = e;
    });
    if (live) { deps.stdout.write("\n"); midLine = false; }
    else if (step.trim()) deps.stdout.write(step + "\n");
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    if (def.sandbox) reportCopyOut(await copyOut(backend, def.workdir!, snap!), (s) => process.stderr.write(s));
  }
  if (done && exitCode === 0) { process.stderr.write(`incomplete: ${incompleteText(done)}\n`); exitCode = 2; }
  saveState({ ...state, status: "exited", exitCode, detail: done?.incomplete });
  return exitCode;
}
