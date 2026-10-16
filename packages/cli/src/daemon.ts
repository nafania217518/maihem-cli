import fs from "node:fs";
import net from "node:net";
import type { LanguageModel } from "ai";
import type { Definition } from "./definition.ts";
import type { Resolved } from "./providers.ts";
import { encode, lineSplitter } from "./protocol.ts";
import type { AgentEvent, ClientMessage } from "./protocol.ts";
import { buildAgent, openBackend, printEvent, reportCopyOut, runFile } from "./run.ts";
import { loadState, saveState } from "./state.ts";
import { copyOut } from "./sync.ts";

export interface DaemonHandle { shutdown(apply?: boolean): Promise<void>; done: Promise<void>; sock: string }

export async function serveAgent(id: string, opts: { model?: LanguageModel } = {}): Promise<DaemonHandle> {
  const state = loadState(id);
  const { def, task, provider, mode = "chat", allowEmpty } = JSON.parse(fs.readFileSync(runFile(id), "utf8")) as { def: Definition; task?: string; provider: Resolved; mode?: "run" | "chat"; allowEmpty?: boolean };
  const readonly = mode === "run";
  const { backend, snap } = await openBackend(def, id);
  const agent = buildAgent(def, provider, backend, opts.model, readonly, readonly && !allowEmpty);
  const clients = new Set<net.Socket>();
  let busy = false;
  let exitCode = 0;

  const broadcast = (e: AgentEvent): void => {
    printEvent(e);
    if (e.type === "done" && e.incomplete) { saveState({ ...loadState(id), detail: e.incomplete }); if (readonly) exitCode = 2; }
    for (const c of clients) c.write(encode(e));
  };
  const handle = async (text: string, reply?: net.Socket): Promise<void> => {
    if (readonly && reply) { reply.write(encode({ type: "error", message: "read-only: this agent runs one task" })); return; }
    if (busy) { reply?.write(encode({ type: "error", message: "busy: a turn is in progress" })); return; }
    busy = true;
    if (loadState(id).detail) saveState({ ...loadState(id), detail: undefined });
    try { await agent.run(text, broadcast); } catch { exitCode = 1; /* agent.run already broadcast the error */ }
    busy = false;
  };

  fs.rmSync(state.sock, { force: true });
  const server = net.createServer((c) => {
    clients.add(c);
    c.write(encode({ type: "hello", name: def.name, model: def.model, provider: def.provider, sandbox: def.sandbox, id, readonly, workdir: def.workdir!, history: agent.history }));
    c.on("data", lineSplitter((o) => { const m = o as ClientMessage; if (m.type === "msg") void handle(m.text, c);
      else if (m.type === "interrupt") { if (readonly) c.write(encode({ type: "error", message: "read-only: this agent runs one task" })); else agent.interrupt(); }
      else if (m.type === "stop") void shutdown(m.apply); }));
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
    if (def.sandbox && apply) reportCopyOut(await copyOut(backend, def.workdir!, snap!), (s) => process.stderr.write(s));
    saveState({ ...loadState(id), status: "exited", exitCode });
    fs.rmSync(runFile(id), { force: true });
    fs.rmSync(state.sock, { force: true });
    resolveDone();
  })());
  process.once("SIGTERM", () => void shutdown(true));
  process.once("SIGINT", () => void shutdown(true));
  if (task) void handle(task).then(() => { if (readonly) void shutdown(true); });
  return { shutdown, done, sock: state.sock };
}
