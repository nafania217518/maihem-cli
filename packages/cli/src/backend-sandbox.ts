import path from "node:path";
import type { Backend, ExecResult } from "./backend.ts";

export const ROOT = "/workspace";

export function workspacePath(p: string): string {
  const abs = path.posix.normalize(path.posix.isAbsolute(p) ? p : path.posix.join(ROOT, p));
  if (abs !== ROOT && !abs.startsWith(`${ROOT}/`)) throw new Error(`path escapes ${ROOT}: ${p}`);
  return abs;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.ok) return r;
  const body = await r.text();
  if (r.status === 404) throw Object.assign(new Error(`not found: ${url}`), { code: "ENOENT" });
  throw new Error(`worker ${r.status}: ${body}`);
}

export async function listFiles(baseUrl: string, id: string): Promise<{ path: string; size: number; mtime: number }[]> {
  return (await call(`${baseUrl}/w/${id}/files`)).json();
}

export async function readBytes(baseUrl: string, id: string, p: string): Promise<Uint8Array> {
  return new Uint8Array(await (await call(`${baseUrl}/w/${id}/file${workspacePath(p)}`)).arrayBuffer());
}

export async function writeBytes(baseUrl: string, id: string, p: string, bytes: Uint8Array): Promise<void> {
  await call(`${baseUrl}/w/${id}/file${workspacePath(p)}`, { method: "PUT", body: bytes as BodyInit });
}

export async function removeWorkspace(baseUrl: string, id: string): Promise<void> {
  await call(`${baseUrl}/w/${id}`, { method: "DELETE" });
}

export interface SandboxBackend extends Backend {
  listFiles(): Promise<{ path: string; size: number; mtime: number }[]>;
  readBytes(p: string): Promise<Uint8Array>;
  writeBytes(p: string, bytes: Uint8Array): Promise<void>;
}

export function createSandboxBackend(baseUrl: string, id: string): SandboxBackend {
  return {
    root: ROOT,
    listFiles: () => listFiles(baseUrl, id),
    readBytes: (p) => readBytes(baseUrl, id, p),
    writeBytes: (p, bytes) => writeBytes(baseUrl, id, p, bytes),
    readFile: async (p) => new TextDecoder().decode(await readBytes(baseUrl, id, p)),
    writeFile: (p, content) => writeBytes(baseUrl, id, p, new TextEncoder().encode(content)),
    async exec(command, cwd = ROOT): Promise<ExecResult> {
      const r = await call(`${baseUrl}/w/${id}/exec`, { method: "POST", body: JSON.stringify({ command, cwd }) });
      return r.json();
    },
  };
}
