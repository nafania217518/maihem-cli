import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { Backend, ExecResult } from "./backend.ts";
import type { Tool } from "./definition.ts";

const MAX = 16000;
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const msg = (e: unknown): string => `error: ${(e as Error).message}`;
const missing = (path: string): string => `error: ${path} does not exist; use list to see the files`;
// Host fs errors carry .code; sandbox worker errors carry the code in the message.
const fsMsg = (path: string) => (e: unknown): string => {
  const s = `${(e as { code?: string }).code} ${(e as Error).message}`;
  if (s.includes("ENOENT")) return missing(path);
  if (s.includes("EISDIR")) return `error: ${path} is a directory; use list`;
  return msg(e);
};

function format(r: ExecResult): string {
  const out = r.stdout + (r.stderr ? "\nstderr:\n" + r.stderr : "") + (r.exitCode ? "\nexit code " + r.exitCode : "");
  return out.length > MAX ? out.slice(0, MAX) + "\n[truncated]" : out;
}

export function createTools(backend: Backend, names: Tool[]): ToolSet {
  const root = backend.root;
  const p = z.string().describe(`file path, relative to ${root} or absolute`);
  const all: Record<Tool, ToolSet[string]> = {
    read: tool({
      description: `Read a text file. Root: ${root}.`,
      inputSchema: z.object({ path: p }),
      execute: ({ path }) => backend.readFile(path).catch(fsMsg(path)),
    }),
    write: tool({
      description: `Write a text file, creating parent directories. Root: ${root}.`,
      inputSchema: z.object({ path: p, content: z.string().describe("full file content") }),
      execute: ({ path, content }) => backend.writeFile(path, content).then(() => `wrote ${path}`, fsMsg(path)),
    }),
    edit: tool({
      description: `Replace one unique occurrence of old text in a file. Root: ${root}.`,
      inputSchema: z.object({ path: p, old: z.string().describe("exact text to replace, must occur once"), new: z.string().describe("replacement text") }),
      execute: async ({ path, old, new: next }) => {
        try {
          const text = await backend.readFile(path);
          const n = text.split(old).length - 1;
          if (n === 0) return "error: old text not found; read the file again and copy the exact text";
          if (n > 1) return "error: old text is not unique; include more surrounding lines";
          await backend.writeFile(path, text.replace(old, () => next));
          return `edited ${path}`;
        } catch (e) {
          return fsMsg(path)(e);
        }
      },
    }),
    list: tool({
      description: `List a directory (ls -la). Root: ${root}.`,
      inputSchema: z.object({ path: p.optional() }),
      execute: async ({ path }) => {
        const r = await backend.exec("ls -la " + quote(path || "."));
        if (r.exitCode && /no such file/i.test(r.stderr)) return missing(path || ".");
        return r.stdout || r.stderr;
      },
    }),
    exec: tool({
      description: `Run a bash command. Working directory defaults to ${root}.`,
      inputSchema: z.object({ command: z.string().describe("bash command"), cwd: z.string().optional().describe("working directory, relative to root") }),
      execute: ({ command, cwd }) => backend.exec(command, cwd).then(format, msg),
    }),
  };
  return Object.fromEntries(names.map((n) => [n, all[n]]));
}
