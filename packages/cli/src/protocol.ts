export type ClientMessage = { type: "msg"; text: string } | { type: "stop"; apply: boolean };

export type AgentEvent =
  | { type: "hello"; name: string; model: string; provider: string; sandbox: boolean; id: string; readonly: boolean; workdir: string; history: AgentEvent[] }
  | { type: "user"; text: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool-result"; name: string; ok: boolean; preview: string }
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; message: string };

export function encode(m: object): string {
  return JSON.stringify(m) + "\n";
}

export function lineSplitter(onLine: (obj: unknown) => void): (chunk: string | Buffer) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        onLine({ type: "error", message: `bad line: ${line}` });
      }
    }
  };
}
