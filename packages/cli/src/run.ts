import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { resolveKey } from "./definition.ts";
import type { Definition } from "./definition.ts";
import type { Backend } from "./backend.ts";
import { createAgent } from "./agent.ts";
import type { Agent } from "./agent.ts";
import { createHostBackend } from "./backend-host.ts";
import { createSandboxBackend } from "./backend-sandbox.ts";
import type { RunArgs } from "./main.ts";
import { createModel } from "./model.ts";
import type { AgentEvent } from "./protocol.ts";
import { home } from "./registry.ts";
import { attach } from "./attach.ts";
import { isAlive, logPath, newId, saveState, sockPath } from "./state.ts";
import type { AgentState } from "./state.ts";
import { copyIn, copyOut } from "./sync.ts";
import { createTools } from "./tools.ts";
import { ensureWorker } from "./worker.ts";

export const deps: { spawn: typeof spawn; attach: typeof attach; stdin: NodeJS.ReadableStream & { isTTY?: boolean }; pollMs: number } = { spawn, attach, stdin: process.stdin, pollMs: 100 };

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

export function printEvent(e: AgentEvent): void {
  if (e.type === "text") process.stdout.write(e.delta);
  else if (e.type === "tool") process.stderr.write(dim(`⚙ ${e.name}`) + "\n");
  else if (e.type === "tool-result") process.stderr.write(dim(`  → ${e.ok ? "✓" : "✗"} ${e.preview}`) + "\n");
}

export const runFile = (id: string): string => path.join(home(), "agents", `${id}.run.json`);

export async function openBackend(def: Definition, id: string): Promise<Backend> {
  if (!def.sandbox) return createHostBackend(def.workdir!);
  const backend = createSandboxBackend(await ensureWorker(), id);
  await copyIn(def.workdir!, backend);
  return backend;
}

export function buildAgent(def: Definition, key: string | undefined, backend: Backend, model?: LanguageModel): Agent {
  return createAgent({ model: model ?? createModel(def, key), system: def.system, tools: createTools(backend, def.tools), maxSteps: def.max_steps });
}

function newState(id: string, def: Definition, pid: number): AgentState {
  return { id, name: def.name, pid, status: "running", workdir: def.workdir!, sandbox: def.sandbox, started: new Date().toISOString(), log: logPath(id), sock: sockPath(id) };
}

export function spawnAgent(def: Definition, task: string | undefined, key: string | undefined, mode: "run" | "chat"): AgentState {
  const id = newId();
  const state = newState(id, def, 0);
  saveState(state);
  fs.writeFileSync(runFile(id), JSON.stringify({ def, task, apiKey: key, mode }), { mode: 0o600 });
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
  return text.trim() || undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchCommand(args: RunArgs): Promise<number> {
  const state = spawnAgent(args.def, args.task, resolveKey(args.def, args.apiKey), "chat");
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
  const task = args.task ?? (await readStdin());
  if (!task) throw new Error("run needs a task; use maihem launch for chat");
  const key = resolveKey(def, args.apiKey);
  if (args.detach) {
    console.log(spawnAgent(def, task, key, "run").id);
    return 0;
  }
  const id = newId();
  const state = newState(id, def, process.pid);
  saveState(state);
  console.log(id);
  const backend = await openBackend(def, id);
  const agent = buildAgent(def, key, backend);
  let exitCode = 0;
  try {
    await agent.run(task, printEvent);
    process.stdout.write("\n");
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    if (def.sandbox) await copyOut(backend, def.workdir!);
  }
  saveState({ ...state, status: "exited", exitCode });
  return exitCode;
}
