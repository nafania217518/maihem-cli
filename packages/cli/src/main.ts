import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { applyOverrides, definitionFromFlags, loadDefinition, mask } from "./definition.ts";
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

const USAGE = `usage:
  maihem build -f FILE [--api-key KEY] [--name NAME]
  maihem images
  maihem inspect NAME
  maihem rmi NAME
  maihem run [NAME | -f FILE | --provider P --model M] [TASK] [-d] [--no-sandbox] [--workdir DIR] [--api-key KEY]
  maihem launch [NAME | -f FILE | --provider P --model M] [FIRST_MESSAGE] [-d] [--no-sandbox] [--workdir DIR] [--api-key KEY]
  maihem ps
  maihem stop [--discard] ID
  maihem attach ID
  maihem logs ID
  maihem prune [-f]
  maihem worker start|stop|status`;

const RUN_OPTIONS = {
  detach: { type: "boolean", short: "d", default: false },
  "no-sandbox": { type: "boolean", default: false },
  workdir: { type: "string" },
  "api-key": { type: "string" },
  file: { type: "string", short: "f" },
  name: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  system: { type: "string" },
  tools: { type: "string" },
  "base-url": { type: "string" },
} as const;

export interface RunArgs { def: Definition; task?: string; detach: boolean; apiKey?: string }

export function resolveRunArgs(argv: string[]): RunArgs {
  const { values: v, positionals } = parseArgs({ args: argv, options: RUN_OPTIONS, allowPositionals: true });
  let def: Definition;
  const pos = [...positionals];
  if (v.file) def = loadDefinition(v.file);
  else if (v.name) def = loadImage(v.name);
  else if (pos.length && !v.provider) def = loadImage(pos.shift()!);
  else if (v.provider && v.model) def = definitionFromFlags({ provider: v.provider, model: v.model, system: v.system, tools: v.tools, base_url: v["base-url"] });
  else throw new Error(`no agent source given\n${USAGE}`);
  def = applyOverrides(def, {
    sandbox: v["no-sandbox"] ? false : undefined,
    workdir: path.resolve(v.workdir ?? process.cwd()),
    tools: v.file || v.name ? v.tools : undefined,
  });
  return { def, task: pos[0], detach: v.detach, apiKey: v["api-key"] };
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
      case "build": {
        const { values: v } = parseArgs({ args: rest, options: { file: { type: "string", short: "f" }, "api-key": { type: "string" }, name: { type: "string" } } });
        if (!v.file) break;
        const def = loadDefinition(v.file);
        if (v["api-key"]) def.api_key = v["api-key"];
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
        console.log(YAML.stringify(mask(loadImage(rest[0]))));
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
