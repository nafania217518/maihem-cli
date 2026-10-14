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
import { logPath, newId, saveState, sockPath } from "./state.ts";
import type { AgentState } from "./state.ts";
import { copyIn, copyOut } from "./sync.ts";
import { createTools } from "./tools.ts";
import { ensureWorker } from "./worker.ts";

export const deps = { spawn };

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

export async function runCommand(args: RunArgs): Promise<number> {
  const { def, task } = args;
  const key = resolveKey(def, args.apiKey);
  const id = newId();
  if (args.detach) {
    const state = newState(id, def, 0);
    saveState(state);
    fs.writeFileSync(runFile(id), JSON.stringify({ def, task, apiKey: key }), { mode: 0o600 });
    const binPath = fileURLToPath(new URL("../bin/maihem.js", import.meta.url));
    const logFd = fs.openSync(state.log, "a");
    const child = deps.spawn(process.execPath, [binPath, "__agent", id], { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
    fs.closeSync(logFd);
    child.unref();
    saveState({ ...state, pid: child.pid! });
    console.log(id);
    return 0;
  }
  if (!task) throw new Error("run needs a task (or use -d)");
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
