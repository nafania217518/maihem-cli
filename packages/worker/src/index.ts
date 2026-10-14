import { DurableObject } from "cloudflare:workers";
import { getWorkspace, WorkspaceServiceProxy, withWorkspace } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import curl from "@cloudflare/computer/shell/curl";
import jq from "@cloudflare/computer/shell/jq";
import { matchRoute, parseExecBody } from "./routes.ts";

export { WorkspaceServiceProxy };

export class Maihem extends withWorkspace(
  class extends DurableObject<Env> {},
  (self) => {
    const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
    return {
      storage: ctx.storage,
      backends: [
        new WorkerShellBackend({
          loader: env.LOADER as never,
          workspace: { binding: "Maihem", id: ctx.id.toString() },
          ctx,
          commands: [curl, jq],
        }),
      ],
    };
  },
) {
  async destroy(): Promise<void> {
    await (this as unknown as { ctx: DurableObjectState }).ctx.storage.deleteAll();
  }
}

type Ws = Awaited<ReturnType<typeof getWorkspace>>;
type FileInfo = { path: string; size: number; mtime: number };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function listFiles(ws: Ws, dir: string, out: FileInfo[]): Promise<FileInfo[]> {
  for (const e of await ws.fs.readdir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) await listFiles(ws, path, out);
    else if (e.isFile) out.push({ path, size: e.size, mtime: e.mtime });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const route = matchRoute(request.method, new URL(request.url).pathname);
    if (!route) return json({ error: "not found" }, 404);
    if (route.kind === "method") return json({ error: "method not allowed" }, 405);
    if (route.kind === "health") return new Response("ok");
    try {
      if (route.kind === "delete") {
        await (env.Maihem.get(env.Maihem.idFromName(route.id)) as unknown as { destroy(): Promise<void> }).destroy();
        return new Response(null, { status: 204 });
      }
      using ws = await getWorkspace(env.Maihem.get(env.Maihem.idFromName(route.id)) as never);
      if (route.kind === "file" && request.method === "PUT") {
        await ws.fs.mkdir(route.path.slice(0, route.path.lastIndexOf("/")), { recursive: true });
        await ws.fs.writeFile(route.path, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      if (route.kind === "file") {
        const stream = await ws.fs.readFile(route.path);
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      }
      if (route.kind === "files") {
        return json((await ws.fs.stat("/workspace").catch(() => null)) ? await listFiles(ws, "/workspace", []) : []);
      }
      let body;
      try {
        body = parseExecBody(await request.json().catch(() => null));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      using run = await ws.runtime.exec(body.command, { cwd: body.cwd, encoding: "utf8" });
      const { stdout, stderr, exitCode } = await run.result();
      return json({ stdout, stderr, exitCode });
    } catch (e) {
      const { message, code } = e as { message: string; code?: string };
      return json({ error: message, code }, code === "ENOENT" ? 404 : 500);
    }
  },
} satisfies ExportedHandler<Env>;
