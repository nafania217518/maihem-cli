import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { applyOverrides, isMap, splitTools, validate } from "./definition.ts";
import type { Definition } from "./definition.ts";
import { checkDefinitions, listDefinitions, loadDefinition, removeDefinition, saveDefinition } from "./registry.ts";
import { isAlive, listStates, loadState, refresh, removeState, saveState } from "./state.ts";
import { ensureWorker, startWorker, stopWorker, workerStatus } from "./worker.ts";
import { removeWorkspace } from "./backend-sandbox.ts";
import readline from "node:readline/promises";
import { deps, launchCommand, runCommand, runFile } from "./run.ts";
import { encode } from "./protocol.ts";
import net from "node:net";
import { attach } from "./attach.ts";
import { serveAgent } from "./daemon.ts";
import fs from "node:fs";
import { VERSION } from "./version.ts";
import { checkProviders, listProviders, loadProvider, maskProvider, removeProvider, saveProvider } from "./providers.ts";
import type { Kind, Provider } from "./providers.ts";

const USAGE = `usage:
  maihem definition add --name N --provider P --model M [--system S] [--tools a,b] [--no-sandbox] [--max-steps N]
      [--reasoning LEVEL] [--context N] [--on-context-full compact|fail] [--compact-at X] [--sandbox-exclude a,b]
  maihem definition update NAME [same flags except --name] [--unset FIELD]...
  maihem definition rm NAME
  maihem definition ls
  maihem definition inspect NAME
  maihem apply -f FILE
  maihem run NAME [TASK] [-d] [--no-sandbox] [--workdir DIR] [--max-steps N] [--allow-empty]
  maihem launch NAME [FIRST_MESSAGE] [-d] [--no-sandbox] [--workdir DIR] [--max-steps N]
  maihem ps
  maihem provider add --name NAME --kind openai|anthropic|ollama [--base-url U] [--api-key K|'$VAR'] [--header K=V]...
  maihem provider update NAME [--base-url U] [--api-key K|'$VAR'] [--header K=V]... [--unset base_url|api_key|headers]...
  maihem provider rm [-f] NAME
  maihem provider ls
  maihem provider inspect NAME
  maihem stop [--discard] ID
  maihem attach ID
  maihem logs ID
  maihem prune [-f]
  maihem worker start|stop|status
  maihem --version`;

const RUN_OPTIONS = {
  detach: { type: "boolean", short: "d", default: false },
  "no-sandbox": { type: "boolean", default: false },
  workdir: { type: "string" },
  "max-steps": { type: "string" },
} as const;
const RUN_ONLY = { ...RUN_OPTIONS, "allow-empty": { type: "boolean", default: false } } as const;

export interface RunArgs { def: Definition; task?: string; detach: boolean; allowEmpty?: boolean }

export function resolveRunArgs(argv: string[], cmd = "run"): RunArgs {
  const { values: v, positionals: [name, task] } = parseArgs({ args: argv, options: cmd === "run" ? RUN_ONLY : RUN_OPTIONS, allowPositionals: true });
  if (!name) throw new Error(cmd === "run" ? "run needs a definition name: maihem run NAME [TASK]" : "launch needs a definition name: maihem launch NAME [FIRST_MESSAGE]");
  const def = applyOverrides(loadDefinition(name), {
    sandbox: v["no-sandbox"] ? false : undefined,
    workdir: path.resolve(v.workdir ?? process.cwd()),
    max_steps: v["max-steps"] === undefined ? undefined : Number(v["max-steps"]),
  });
  return { def, task, detach: v.detach, allowEmpty: (v as { "allow-empty"?: boolean })["allow-empty"] };
}

const pad = (rows: string[][]): string[] => {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sendStop = (sock: string, apply: boolean): Promise<boolean> => new Promise((resolve) => {
  const c = net.connect(sock, () => c.end(encode({ type: "stop", apply }), () => resolve(true)));
  c.on("error", () => resolve(false));
});

async function stop(id: string, discard: boolean): Promise<void> {
  const s = loadState(id);
  if (!(await sendStop(s.sock, !discard))) {
    try {
      process.kill(s.pid, "SIGTERM");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  for (let i = 0; i < 50 && isAlive(s.pid); i++) await sleep(100);
  s.status = "exited";
  saveState(s);
  fs.rmSync(runFile(id), { force: true });
  fs.rmSync(s.sock, { force: true });
  console.log(`stopped ${id}`);
}

const PROVIDER_OPTIONS = {
  name: { type: "string" }, kind: { type: "string" }, "base-url": { type: "string" }, "api-key": { type: "string" },
  header: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, force: { type: "boolean", short: "f" },
} as const;
const UNSET = ["base_url", "api_key", "headers"] as const;
const keyLabel = (p: Provider): string => p.api_key ? (/^\$(?!\$)/.test(p.api_key) ? p.api_key : "stored")
  : p.kind === "openai" ? "env OPENAI_API_KEY" : p.kind === "anthropic" ? "env ANTHROPIC_API_KEY" : "none";

const fileArg = (args: string[]): string | undefined => parseArgs({ args, options: { file: { type: "string", short: "f" } } }).values.file;

// Validates everything first (definition providers come from `ps` or the registry), then saves providers, then definitions.
function applyAll(file: string, ps: Provider[], ds: Definition[]): void {
  const given = new Set(ps.map((p) => p.name));
  for (const d of ds) if (!given.has(d.provider)) loadProvider(d.provider);
  const oldP = new Set(listProviders().map((p) => p.name));
  const oldD = new Set(listDefinitions().map((d) => d.name));
  const say = (old: Set<string>, kind: string, name: string) => console.log(`${old.has(name) ? "replaced" : "created"} ${kind} ${name}`);
  for (const p of ps) {
    if (p.api_key !== undefined && !/\$(\{[A-Za-z_]|[A-Za-z_])/.test(p.api_key.replaceAll("$$", ""))) console.error(`warning: api_key for "${p.name}" in ${file} is a plain key; use a reference like $OPENAI_API_KEY for files under version control`);
    saveProvider(p);
    say(oldP, "provider", p.name);
  }
  for (const d of ds) {
    saveDefinition(d);
    say(oldD, "definition", d.name);
  }
}

function applyStack(file: string): void {
  const doc: unknown = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!isMap(doc)) throw new Error("apply file: expected a providers and/or definitions map");
  const bad = Object.keys(doc).find((k) => k !== "providers" && k !== "definitions");
  if (bad) throw new Error(`apply file: unknown section "${bad}" (use providers, definitions)`);
  const ps = checkProviders(doc.providers ?? {}), ds = checkDefinitions(doc.definitions ?? {});
  if (!ps.length && !ds.length) throw new Error("apply file: expected a providers and/or definitions map");
  applyAll(file, ps, ds);
}

const DEF_OPTIONS = {
  name: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, system: { type: "string" }, tools: { type: "string" },
  "no-sandbox": { type: "boolean" }, "max-steps": { type: "string" }, reasoning: { type: "string" }, context: { type: "string" },
  "on-context-full": { type: "string" }, "compact-at": { type: "string" }, unset: { type: "string", multiple: true },
  "sandbox-exclude": { type: "string" },
} as const;
const DEF_UNSET = ["system", "tools", "sandbox", "max_steps", "reasoning", "context", "on_context_full", "compact_at", "sandbox_exclude"];

function definition(argv: string[]): boolean {
  const [sub, ...args] = argv;
  if (!["add", "update", "rm", "ls", "inspect"].includes(sub)) return false;
  const { values: v, positionals: [name] } = parseArgs({ args, options: DEF_OPTIONS, allowPositionals: true });
  const save = (raw: Record<string, unknown>): void => {
    for (const k of ["provider", "model", "system", "reasoning"] as const) if (v[k] !== undefined) raw[k] = v[k];
    if (v["on-context-full"] !== undefined) raw.on_context_full = v["on-context-full"];
    if (v.tools !== undefined) raw.tools = splitTools(v.tools);
    if (v["sandbox-exclude"] !== undefined) raw.sandbox_exclude = splitTools(v["sandbox-exclude"]);
    if (v["no-sandbox"]) raw.sandbox = false;
    for (const [f, k] of [["max-steps", "max_steps"], ["context", "context"], ["compact-at", "compact_at"]] as const) if (v[f] !== undefined) raw[k] = Number(v[f]);
    for (const f of v.unset ?? []) {
      if (!DEF_UNSET.includes(f)) throw new Error(`definition: --unset takes ${DEF_UNSET.join(", ")}`);
      delete raw[f];
    }
    const d = validate(raw);
    loadProvider(d.provider);
    saveDefinition(d);
  };
  if (sub === "add") {
    if (!v.name || !v.provider || !v.model) return false;
    if (listDefinitions().some((d) => d.name === v.name)) throw new Error(`definition "${v.name}" already exists; use maihem definition update ${v.name}`);
    save({ name: v.name });
    console.log(`added ${v.name}`);
  } else if (sub === "update" && name) {
    save({ ...loadDefinition(name) });
    console.log(`updated ${name}`);
  } else if (sub === "rm" && name) {
    removeDefinition(name);
    console.log(`removed ${name}`);
  } else if (sub === "ls") {
    for (const l of pad([["NAME", "PROVIDER", "MODEL", "SANDBOX", "TOOLS"], ...listDefinitions().map((d) => [d.name, d.provider, d.model, String(d.sandbox), d.tools.join(",")])])) console.log(l);
  } else if (sub === "inspect" && name) {
    console.log(YAML.stringify(loadDefinition(name)));
  } else return false;
  return true;
}

function provider(argv: string[]): boolean {
  const [sub, ...args] = argv;
  const { values: v, positionals: [name] } = parseArgs({ args, options: PROVIDER_OPTIONS, allowPositionals: true });
  const patch = (p: Provider): Provider => {
    if (v["base-url"] !== undefined) p.base_url = v["base-url"];
    if (v["api-key"] !== undefined) p.api_key = v["api-key"];
    for (const h of v.header ?? []) {
      const i = h.indexOf("=");
      if (i < 1) throw new Error("provider: --header needs K=V");
      p.headers = { ...p.headers, [h.slice(0, i)]: h.slice(i + 1) };
    }
    return p;
  };
  if (sub === "add") {
    if (!v.name || !v.kind) return false;
    if (listProviders().some((p) => p.name === v.name)) throw new Error(`provider "${v.name}" already exists; use maihem provider update ${v.name}`);
    saveProvider(patch({ name: v.name, kind: v.kind as Kind }));
    console.log(`added ${v.name}`);
  } else if (sub === "update" && name) {
    const p = patch(loadProvider(name));
    for (const f of v.unset ?? []) {
      if (!(UNSET as readonly string[]).includes(f)) throw new Error(`provider: --unset takes ${UNSET.join(", ")}`);
      delete p[f as (typeof UNSET)[number]];
    }
    saveProvider(p);
    console.log(`updated ${name}`);
  } else if (sub === "rm" && name) {
    loadProvider(name);
    const users = listDefinitions().filter((d) => d.provider === name).map((d) => d.name);
    if (users.length && !v.force) throw new Error(`provider "${name}" is used by definitions: ${users.join(", ")}; use -f to remove it anyway`);
    removeProvider(name);
    console.log(`removed ${name}`);
  } else if (sub === "ls") {
    for (const l of pad([["NAME", "KIND", "BASE_URL", "KEY"], ...listProviders().map((p) => [p.name, p.kind, p.base_url ?? "-", keyLabel(p)])])) console.log(l);
  } else if (sub === "inspect" && name) {
    console.log(YAML.stringify(maskProvider(loadProvider(name))));
  } else return false;
  return true;
}

async function prune(force: boolean): Promise<void> {
  const dead = listStates().map(refresh).filter((s) => s.status === "exited");
  if (!dead.length) return console.log("nothing to prune");
  if (!force) {
    if (!deps.stdin.isTTY) throw new Error("prune needs -f when stdin is not a terminal");
    const rl = readline.createInterface({ input: deps.stdin, output: process.stdout });
    const answer = await rl.question(`This removes ${dead.length} stopped agents. Continue? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") return;
  }
  const url = dead.some((s) => s.sandbox) ? await ensureWorker() : "";
  for (const s of dead) {
    if (s.sandbox) await removeWorkspace(url, s.id);
    removeState(s);
    console.log(s.id);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "--version":
      case "-v":
        console.log(VERSION);
        return 0;
      case "definition":
        if (!definition(rest)) break;
        return 0;
      case "apply": {
        const file = fileArg(rest);
        if (!file) break;
        applyStack(file);
        return 0;
      }
      case "ps": {
        const rows = [["ID", "NAME", "STATUS", "SANDBOX", "WORKDIR", "STARTED"], ...listStates().map(refresh).map((s) => [s.id, s.name, s.detail ? `${s.status === "running" ? "idle" : s.status} (${s.detail})` : s.status, String(s.sandbox), s.workdir, s.started])];
        for (const l of pad(rows)) console.log(l);
        return 0;
      }
      case "stop": {
        const discard = rest[0] === "--discard";
        const id = discard ? rest[1] : rest[0];
        if (!id) break;
        await stop(id, discard);
        return 0;
      }
      case "provider":
        if (!provider(rest)) break;
        return 0;
      case "launch":
        return await launchCommand(resolveRunArgs(rest, "launch"));
      case "run":
        return await runCommand(resolveRunArgs(rest));
      case "worker": {
        if (rest[0] === "start") console.log(await startWorker());
        else if (rest[0] === "stop") (await stopWorker(), console.log("stopped"));
        else if (rest[0] === "status") {
          const s = await workerStatus();
          console.log(s.running ? `running ${s.url} (pid ${s.pid})` : "stopped");
        } else break;
        return 0;
      }
      case "attach": {
        if (!rest[0]) break;
        const s = refresh(loadState(rest[0]));
        if (s.status !== "running") throw new Error(`agent ${rest[0]} is not running`);
        await attach(s.sock);
        return 0;
      }
      case "logs": {
        if (!rest[0]) break;
        const { log } = loadState(rest[0]);
        process.stdout.write(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
        return 0;
      }
      case "prune":
        await prune(rest[0] === "-f" || rest[0] === "--force");
        return 0;
      case "__agent": {
        if (!rest[0]) break;
        await (await serveAgent(rest[0])).done;
        process.exit(0); // dedicated daemon: do not wait for stray library handles
        return 0;
      }
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 1;
}
