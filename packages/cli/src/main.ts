import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { applyOverrides, definitionFromFlags, loadDefinition } from "./definition.ts";
import type { Definition } from "./definition.ts";
import { listImages, loadImage, removeImage, saveImage } from "./registry.ts";
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
import { listProviders, loadProvider, maskProvider, parseProviders, removeProvider, saveProvider } from "./providers.ts";
import type { Kind, Provider } from "./providers.ts";

const USAGE = `usage:
  maihem build -f FILE [--name NAME]
  maihem images
  maihem inspect NAME
  maihem rmi NAME
  maihem run [NAME | -f FILE | --provider P --model M] [TASK] [-d] [--no-sandbox] [--workdir DIR]
  maihem launch [NAME | -f FILE | --provider P --model M] [FIRST_MESSAGE] [-d] [--no-sandbox] [--workdir DIR]
  maihem ps
  maihem provider add --name NAME --kind openai|anthropic|ollama [--base-url U] [--api-key K|'$VAR'] [--header K=V]...
  maihem provider apply -f FILE
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
  file: { type: "string", short: "f" },
  name: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  system: { type: "string" },
  tools: { type: "string" },
} as const;

export interface RunArgs { def: Definition; task?: string; detach: boolean }

export function resolveRunArgs(argv: string[]): RunArgs {
  const { values: v, positionals } = parseArgs({ args: argv, options: RUN_OPTIONS, allowPositionals: true });
  let def: Definition;
  const pos = [...positionals];
  if (v.file) def = loadDefinition(v.file);
  else if (v.name) def = loadImage(v.name);
  else if (pos.length && !v.provider) def = loadImage(pos.shift()!);
  else if (v.provider && v.model) def = definitionFromFlags({ provider: v.provider, model: v.model, system: v.system, tools: v.tools });
  else throw new Error(`no agent source given\n${USAGE}`);
  def = applyOverrides(def, {
    sandbox: v["no-sandbox"] ? false : undefined,
    workdir: path.resolve(v.workdir ?? process.cwd()),
    tools: v.file || v.name ? v.tools : undefined,
  });
  return { def, task: pos[0], detach: v.detach };
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

function provider(argv: string[]): boolean {
  const [sub, ...args] = argv;
  if (sub === "apply") {
    const { values: { file } } = parseArgs({ args, options: { file: { type: "string", short: "f" } } });
    if (!file) return false;
    const ps = parseProviders(fs.readFileSync(file, "utf8"));
    const existing = new Set(listProviders().map((p) => p.name));
    for (const p of ps) {
      if (p.api_key !== undefined && !/\$(\{[A-Za-z_]|[A-Za-z_])/.test(p.api_key.replaceAll("$$", ""))) console.error(`warning: api_key for "${p.name}" in ${file} is a plain key; use a reference like $OPENAI_API_KEY for files under version control`);
      saveProvider(p);
      console.log(`${existing.has(p.name) ? "replaced" : "created"} ${p.name}`);
    }
    return true;
  }
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
    const users = listImages().filter((d) => d.provider === name).map((d) => d.name);
    if (users.length && !v.force) throw new Error(`provider "${name}" is used by images: ${users.join(", ")}; use -f to remove it anyway`);
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
      case "build": {
        const { values: v } = parseArgs({ args: rest, options: { file: { type: "string", short: "f" }, name: { type: "string" } } });
        if (!v.file) break;
        const def = loadDefinition(v.file);
        const name = v.name ?? def.name;
        saveImage(def, name);
        console.log(`built ${name}`);
        return 0;
      }
      case "images": {
        const rows = [["NAME", "PROVIDER", "MODEL", "SANDBOX", "TOOLS"], ...listImages().map((d) => [d.name, d.provider, d.model, String(d.sandbox), d.tools.join(",")])];
        for (const l of pad(rows)) console.log(l);
        return 0;
      }
      case "inspect":
        if (!rest[0]) break;
        console.log(YAML.stringify(loadImage(rest[0])));
        return 0;
      case "rmi":
        if (!rest[0]) break;
        removeImage(rest[0]);
        console.log(`removed ${rest[0]}`);
        return 0;
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
        return await launchCommand(resolveRunArgs(rest));
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
