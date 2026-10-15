export type ClientMessage = { type: "msg"; text: string } | { type: "stop"; apply: boolean } | { type: "interrupt" };

type Stamped<T> = T & { at?: number };

export type Incomplete = "step limit" | "output limit" | "context full" | "content filter";

export type AgentEvent =
  | { type: "hello"; name: string; model: string; provider: string; sandbox: boolean; id: string; readonly: boolean; workdir: string; history: AgentEvent[] }
  | Stamped<{ type: "user"; text: string }>
  | Stamped<{ type: "text"; delta: string }>
  | Stamped<{ type: "thinking"; delta: string }>
  | Stamped<{ type: "context"; used: number; budget?: number; tps?: number }>
  | Stamped<{ type: "compacted"; before: number; after: number }>
  | Stamped<{ type: "step" }>
  | Stamped<{ type: "tool"; id: string; name: string; input: unknown }>
  | Stamped<{ type: "tool-result"; id: string; name: string; ok: boolean; output: string }>
  | Stamped<{
      type: "done";
      usage?: { inputTokens?: number; outputTokens?: number };
      interrupted?: boolean;
      incomplete?: Incomplete;
      steps?: number;
      tps?: number;
      rateLimits?: Record<string, string>;
    }>
  | Stamped<{ type: "error"; message: string; status?: number; attempts?: number }>;

export function encode(m: object): string {
  return JSON.stringify(m) + "\n";
}

export function lineSplitter(onLine: (obj: unknown) => void): (chunk: string | Buffer) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop()!; // split always returns at least one element
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
