import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Backend } from "./backend.ts";
import type { SandboxBackend } from "./backend-sandbox.ts";

const ROOT = "/workspace";
const toBytes = (s: string) => new TextEncoder().encode(s);

function gitFiles(workdir: string): string[] {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: workdir });
  if (r.status !== 0) throw new Error("workdir must be a git repository for sandbox mode; use --no-sandbox");
  return r.stdout.toString().split("\0").filter(Boolean);
}

export async function copyIn(workdir: string, backend: Backend): Promise<number> {
  const sb = backend as Partial<SandboxBackend>;
  let n = 0;
  for (const rel of gitFiles(workdir)) {
    const abs = path.join(workdir, rel);
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = fs.readFileSync(abs);
    if (sb.writeBytes) await sb.writeBytes(`${ROOT}/${rel}`, bytes);
    else await backend.writeFile(`${ROOT}/${rel}`, bytes.toString("utf8"));
    n++;
  }
  return n;
}

// ponytail: no host deletes on copy-out; add when needed
export async function copyOut(backend: Backend, workdir: string): Promise<number> {
  const sb = backend as Partial<SandboxBackend>;
  const files = sb.listFiles ? await sb.listFiles() : [];
  let n = 0;
  for (const f of files) {
    const bytes = sb.readBytes ? await sb.readBytes(f.path) : toBytes(await backend.readFile(f.path));
    const abs = path.join(workdir, path.posix.relative(ROOT, f.path));
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    if (cur && Buffer.compare(cur, bytes) === 0) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    n++;
  }
  return n;
}
