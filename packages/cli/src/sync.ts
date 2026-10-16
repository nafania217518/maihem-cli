import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Backend } from "./backend.ts";
import type { SandboxBackend } from "./backend-sandbox.ts";

const ROOT = "/workspace";
const toBytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

export interface Entry { hash: string; size: number; mtime?: number }
export interface Snapshot { baseline: Map<string, Entry>; excludes: string[]; files: number; symlinks: number }
export const LIMITS = { files: 20000, bytes: 1024 * 1024 * 1024 };

export function readExcludes(workdir: string, extra: string[] = []): string[] {
  let text = "";
  try { text = fs.readFileSync(path.join(workdir, ".maihemignore"), "utf8"); } catch {}
  return [...text.split("\n"), ...extra].map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export function isExcluded(rel: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.replace(/\/$/, "");
    const base = p.replace(/^\//, "");
    const g = p.includes("/") ? base : `**/${base}`;
    return path.matchesGlob(rel, g) || path.matchesGlob(rel, `${g}/**`);
  });
}

function walk(workdir: string, excludes: string[], out: { rel: string; abs: string; size: number }[], dir = "", counts = { symlinks: 0 }) {
  for (const e of fs.readdirSync(path.join(workdir, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isSymbolicLink()) counts.symlinks++;
    else if (isExcluded(rel, excludes)) continue;
    else if (e.isDirectory()) walk(workdir, excludes, out, rel, counts);
    else if (e.isFile()) { const abs = path.join(workdir, rel); out.push({ rel, abs, size: fs.statSync(abs).size }); }
  }
  return counts.symlinks;
}

export async function copyIn(workdir: string, backend: Backend, extra: string[] = [], limits = LIMITS): Promise<Snapshot> {
  const sb = backend as Partial<SandboxBackend>;
  const excludes = readExcludes(workdir, extra);
  const found: { rel: string; abs: string; size: number }[] = [];
  const symlinks = walk(workdir, excludes, found);
  const bytes = found.reduce((a, f) => a + f.size, 0);
  if (found.length > limits.files || bytes > limits.bytes)
    throw new Error(`workdir too large for the sandbox: ${found.length} files, ${Math.round(bytes / 1024 / 1024)} MB (limit ${limits.files} files, ${limits.bytes / 1024 / 1024} MB); add paths to .maihemignore or sandbox_exclude, or use --no-sandbox`);
  const baseline = new Map<string, Entry>();
  for (const { rel, abs, size } of found) {
    const buf = fs.readFileSync(abs);
    if (sb.writeBytes) await sb.writeBytes(`${ROOT}/${rel}`, buf);
    else await backend.writeFile(`${ROOT}/${rel}`, buf.toString("utf8"));
    baseline.set(rel, { hash: sha(buf), size });
  }
  if (sb.listFiles) for (const f of await sb.listFiles()) {
    const e = baseline.get(path.posix.relative(ROOT, f.path));
    if (e) e.mtime = f.mtime;
  }
  return { baseline, excludes, files: found.length, symlinks };
}

// ponytail: no host deletes on copy-out; add when needed
export async function copyOut(backend: Backend, workdir: string, snap: Snapshot): Promise<{ written: string[]; conflicts: string[] }> {
  const sb = backend as Partial<SandboxBackend>;
  const written: string[] = [];
  const conflicts: string[] = [];
  for (const f of sb.listFiles ? await sb.listFiles() : []) {
    const rel = path.posix.relative(ROOT, f.path);
    if (isExcluded(rel, snap.excludes)) continue;
    const entry = snap.baseline.get(rel);
    if (entry && entry.mtime !== undefined && f.size === entry.size && f.mtime === entry.mtime) continue;
    const bytes = sb.readBytes ? await sb.readBytes(f.path) : toBytes(await backend.readFile(f.path));
    const s = sha(bytes);
    if (entry && s === entry.hash) continue;
    const abs = path.join(workdir, rel);
    const host = fs.existsSync(abs) ? sha(fs.readFileSync(abs)) : null;
    if (host === s) continue;
    if (host === null || host === entry?.hash) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      written.push(rel);
    } else {
      fs.writeFileSync(`${abs}.sandbox`, bytes);
      conflicts.push(rel);
    }
  }
  return { written, conflicts };
}
