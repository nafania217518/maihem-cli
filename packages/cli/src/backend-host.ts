import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Backend, ExecResult } from "./backend.ts";

const TIMEOUT_MS = 120_000;

export function createHostBackend(root: string): Backend {
  const abs = (p: string): string => path.resolve(root, p);
  return {
    root,
    readFile: (p) => fs.readFile(abs(p), "utf8"),
    async writeFile(p, content) {
      await fs.mkdir(path.dirname(abs(p)), { recursive: true });
      await fs.writeFile(abs(p), content);
    },
    exec(command, cwd) {
      return new Promise<ExecResult>((resolve, reject) => {
        const child = spawn("bash", ["-lc", command], { cwd: abs(cwd ?? ".") });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1) });
        });
      });
    },
  };
}
