import fs from "node:fs";
import net from "node:net";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";
import { encode, lineSplitter } from "./protocol.ts";
import type { AgentEvent, ClientMessage } from "./protocol.ts";
import { buildAgent, openBackend, printEvent, runFile } from "./run.ts";
import { loadState, saveState } from "./state.ts";
import { copyOut } from "./sync.ts";

export interface DaemonHandle { shutdown(apply?: boolean): Promise<void>; done: Promise<void>; sock: string }

export async function serveAgent(id: string, opts: { model?: LanguageModel } = {}): Promise<DaemonHandle> {
  const state = loadState(id);
  const { def, task, apiKey, mode = "chat" } = JSON.parse(fs.readFileSync(runFile(id), "utf8")) as { def: Definition; task?: string; apiKey?: string; mode?: "run" | "chat" };
  const readonly = mode === "run";
  const backend = await openBackend(def, id);
  const agent = buildAgent(def, apiKey, backend, opts.model);
  const clients = new Set<net.Socket>();
  let busy = false;
  let exitCode = 0;

  const broadcast = (e: AgentEvent): void => {
    printEvent(e);
    for (const c of clients) c.write(encode(e));
  };
  const handle = async (text: string, reply?: net.Socket): Promise<void> => {
    if (readonly && reply) { reply.write(encode({ type: "error", message: "read-only: this agent runs one task" })); return; }
    if (busy) { reply?.write(encode({ type: "error", message: "busy: a turn is in progress" })); return; }
    busy = true;
    try { await agent.run(text, broadcast); } catch { exitCode = 1; /* agent.run already broadcast the error */ }
    busy = false;
  };

  fs.rmSync(state.sock, { force: true });
  const server = net.createServer((c) => {
    clients.add(c);
    c.write(encode({ type: "hello", name: def.name, model: def.model, provider: def.provider, sandbox: def.sandbox, id, readonly, workdir: def.workdir!, history: agent.history }));
    c.on("data", lineSplitter((o) => { const m = o as ClientMessage; if (m.type === "msg") void handle(m.text, c); else if (m.type === "stop") void shutdown(m.apply); }));
    const drop = (): void => { clients.delete(c); };
    c.on("close", drop);
    c.on("error", drop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.sock, resolve);
  });

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let closing: Promise<void> | undefined;
  const shutdown = (apply = true): Promise<void> => (closing ??= (async () => {
    server.close();
    for (const c of clients) c.end();
    if (def.sandbox && apply) await copyOut(backend, def.workdir!);
    saveState({ ...state, status: "exited", exitCode });
    fs.rmSync(runFile(id), { force: true });
    fs.rmSync(state.sock, { force: true });
    resolveDone();
  })());
  process.once("SIGTERM", () => void shutdown(true));
  process.once("SIGINT", () => void shutdown(true));
  if (task) void handle(task).then(() => { if (readonly) void shutdown(true); });
  return { shutdown, done, sock: state.sock };
}
