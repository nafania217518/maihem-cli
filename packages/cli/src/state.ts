import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "./protocol.ts";
import { home } from "./registry.ts";

export interface AgentState {
  id: string;
  name: string;
  pid: number;
  status: "running" | "exited";
  workdir: string;
  sandbox: boolean;
  started: string;
  log: string;
  sock: string;
  exitCode?: number;
  detail?: string;
}

const dir = (): string => path.join(home(), "agents");
const file = (id: string): string => path.join(dir(), `${id}.json`);
export const logPath = (id: string): string => path.join(dir(), `${id}.log`);
export const eventsPath = (id: string): string => path.join(dir(), `${id}.events.jsonl`);

// The saved events of a session, one JSON object per line; bad lines are skipped.
export function readEvents(id: string): AgentEvent[] {
  if (!fs.existsSync(eventsPath(id))) return [];
  return fs.readFileSync(eventsPath(id), "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
}
// Unix socket paths are capped at 104 bytes on macOS, so sockets live in the OS temp dir, not MAIHEM_HOME.
export const sockPath = (id: string): string => path.join(os.tmpdir(), `maihem-${id}.sock`);

export function newId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export function saveState(s: AgentState): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(s.id), JSON.stringify(s), { mode: 0o600 });
}

export function loadState(id: string): AgentState {
  if (!fs.existsSync(file(id))) throw new Error(`no such agent: ${id}`);
  return JSON.parse(fs.readFileSync(file(id), "utf8"));
}

export function listStates(): AgentState[] {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => f.endsWith(".json") && !f.endsWith(".run.json"))
    .map((f) => loadState(f.slice(0, -5)))
    .sort((a, b) => b.started.localeCompare(a.started));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function refresh(s: AgentState): AgentState {
  if (s.status === "running" && !isAlive(s.pid)) {
    s.status = "exited";
    saveState(s);
  }
  return s;
}

export function removeState(s: AgentState): void {
  if (fs.existsSync(dir())) for (const f of fs.readdirSync(dir())) if (f.startsWith(`${s.id}.`)) fs.rmSync(path.join(dir(), f), { force: true });
  fs.rmSync(s.sock, { force: true });
}
