import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./registry.ts";

export const deps = { spawn };

interface WorkerState { pid: number; port: number; log: string }

export const workerDir = (): string => fileURLToPath(new URL("../../worker", import.meta.url));
const port = (): number => Number(process.env.MAIHEM_WORKER_PORT ?? 8799);
const stateFile = (): string => path.join(home(), "worker.json");
const logFile = (): string => path.join(home(), "worker.log");
const urlOf = (p: number): string => `http://127.0.0.1:${p}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readState = (): WorkerState | null => (fs.existsSync(stateFile()) ? JSON.parse(fs.readFileSync(stateFile(), "utf8")) : null);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const healthy = (url: string): Promise<boolean> =>
  fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.status === 200, () => false);

export async function workerStatus(): Promise<{ running: boolean; url: string; pid?: number }> {
  const s = readState();
  if (!s) return { running: false, url: urlOf(port()) };
  const url = urlOf(s.port);
  return { running: alive(s.pid) && (await healthy(url)), url, pid: s.pid };
}

export async function startWorker(): Promise<string> {
  const st = await workerStatus();
  if (st.running) return st.url;
  fs.mkdirSync(home(), { recursive: true });
  const p = port();
  const fd = fs.openSync(logFile(), "a");
  const child = deps.spawn("npx", ["wrangler", "dev", "--port", String(p)], { cwd: workerDir(), detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.unref();
  fs.writeFileSync(stateFile(), JSON.stringify({ pid: child.pid, port: p, log: logFile() }));
  const url = urlOf(p);
  const deadline = Date.now() + Number(process.env.MAIHEM_WORKER_TIMEOUT_MS ?? 60_000);
  while (Date.now() < deadline) {
    if (await healthy(url)) return url;
    await sleep(250);
  }
  await stopWorker();
  const tail = fs.readFileSync(logFile(), "utf8").trimEnd().split("\n").slice(-20).join("\n");
  throw new Error(`worker did not start on port ${p}:\n${tail}`);
}

export async function stopWorker(): Promise<void> {
  const s = readState();
  if (!s) return;
  try {
    process.kill(-s.pid, "SIGTERM"); // detached: kill the whole process group (npx + wrangler + workerd)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  for (let i = 0; i < 50 && alive(s.pid); i++) await sleep(100);
  fs.rmSync(stateFile(), { force: true });
}

export const ensureWorker = startWorker;
