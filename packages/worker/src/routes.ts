export type Route =
  | { kind: "health" }
  | { kind: "file"; id: string; path: string }
  | { kind: "files"; id: string }
  | { kind: "exec"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "method" };

const ID = "([A-Za-z0-9_-]+)";
const TABLE: [RegExp, string[], (m: RegExpMatchArray) => Route | null][] = [
  [/^\/health$/, ["GET"], () => ({ kind: "health" })],
  [new RegExp(`^/w/${ID}/file(/.*)$`), ["GET", "PUT"], (m) => filePath(m[1], m[2])],
  [new RegExp(`^/w/${ID}/files$`), ["GET"], (m) => ({ kind: "files", id: m[1] })],
  [new RegExp(`^/w/${ID}$`), ["DELETE"], (m) => ({ kind: "delete", id: m[1] })],
  [new RegExp(`^/w/${ID}/exec$`), ["POST"], (m) => ({ kind: "exec", id: m[1] })],
];

function filePath(id: string, path: string): Route | null {
  const parts = path.split("/").slice(1);
  if (parts[0] !== "workspace" || parts.length < 2 || parts.some((p) => p === "" || p === "..")) return null;
  return { kind: "file", id, path };
}

export function matchRoute(method: string, pathname: string): Route | null {
  for (const [re, methods, build] of TABLE) {
    const m = pathname.match(re);
    if (!m) continue;
    return methods.includes(method) ? build(m) : { kind: "method" };
  }
  return null;
}

export function parseExecBody(body: unknown): { command: string; cwd?: string } {
  const b = body as { command?: unknown; cwd?: unknown } | null;
  if (!b || typeof b.command !== "string" || b.command === "") throw new Error("must provide command");
  return typeof b.cwd === "string" ? { command: b.command, cwd: b.cwd } : { command: b.command };
}
