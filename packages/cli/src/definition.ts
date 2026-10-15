import fs from "node:fs";
import YAML from "yaml";

export const TOOLS = ["read", "write", "edit", "list", "exec"] as const;
export type Tool = (typeof TOOLS)[number];
export const REASONING = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Reasoning = (typeof REASONING)[number];
export interface Definition {
  name: string;
  provider: string;
  model: string;
  system?: string;
  tools: Tool[];
  sandbox: boolean;
  workdir?: string;
  max_steps: number;
  reasoning?: Reasoning;
  context?: number;
  on_context_full: "compact" | "fail";
  compact_at: number;
}

function splitTools(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function validate(raw: Record<string, unknown>): Definition {
  for (const k of ["name", "provider", "model"]) {
    if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`definition: "${k}" is required`);
  }
  if (raw.base_url !== undefined) throw new Error('definition: "base_url" moved to providers: maihem provider add|update NAME --base-url URL');
  if (raw.api_key !== undefined) throw new Error('definition: "api_key" moved to providers: maihem provider add|update NAME --api-key KEY | --api-key \'$VAR\'');
  const tools = (raw.tools ?? [...TOOLS]) as string[];
  for (const t of tools) {
    if (!(TOOLS as readonly string[]).includes(t)) throw new Error(`definition: unknown tool "${t}" (use ${TOOLS.join(", ")})`);
  }
  const max_steps = raw.max_steps ?? 50;
  if (!Number.isInteger(max_steps) || (max_steps as number) < 1) throw new Error("definition: max_steps must be a positive integer");
  if (raw.reasoning !== undefined && !(REASONING as readonly unknown[]).includes(raw.reasoning)) throw new Error(`definition: unknown reasoning "${raw.reasoning}" (use ${REASONING.join(", ")})`);
  if (raw.context !== undefined && (!Number.isInteger(raw.context) || (raw.context as number) < 1)) throw new Error("definition: context must be a positive integer");
  const on_context_full = raw.on_context_full ?? "compact";
  if (on_context_full !== "compact" && on_context_full !== "fail") throw new Error('definition: on_context_full must be "compact" or "fail"');
  const compact_at = raw.compact_at ?? 0.8;
  if (typeof compact_at !== "number" || !(compact_at > 0 && compact_at <= 1)) throw new Error("definition: compact_at must be a number in (0, 1]");
  const d: Definition = {
    name: raw.name as string,
    provider: raw.provider as string,
    model: raw.model as string,
    tools: tools as Tool[],
    sandbox: raw.sandbox !== false,
    max_steps: max_steps as number,
    on_context_full,
    compact_at,
  };
  if (raw.reasoning !== undefined) d.reasoning = raw.reasoning as Reasoning;
  if (raw.context !== undefined) d.context = raw.context as number;
  for (const k of ["system", "workdir"] as const) {
    if (typeof raw[k] === "string") d[k] = raw[k] as string;
  }
  return d;
}

export function parseDefinition(text: string): Definition {
  const raw = YAML.parse(text);
  if (!raw || typeof raw !== "object") throw new Error("definition: expected a YAML or JSON object");
  return validate(raw);
}

export function loadDefinition(file: string): Definition {
  return parseDefinition(fs.readFileSync(file, "utf8"));
}

export function definitionFromFlags(f: { provider?: string; model?: string; system?: string; tools?: string }): Definition {
  return validate({ name: "inline", provider: f.provider, model: f.model, system: f.system, tools: f.tools ? splitTools(f.tools) : undefined });
}

export function applyOverrides(def: Definition, o: { sandbox?: boolean; workdir?: string; tools?: string }): Definition {
  const d = { ...def, tools: [...def.tools] };
  if (o.sandbox !== undefined) d.sandbox = o.sandbox;
  if (o.workdir !== undefined) d.workdir = o.workdir;
  if (o.tools !== undefined) d.tools = validate({ ...def, tools: splitTools(o.tools) }).tools;
  return d;
}

export function maskKey(key: string): string {
  return "****" + (key.length > 4 ? key.slice(-4) : "");
}
