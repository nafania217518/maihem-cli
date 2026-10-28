import { parseCount } from "./count.ts";
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
  description?: string; // one line shown to other org members
  tools: Tool[];
  sandbox: boolean;
  workdir?: string;
  max_steps: number;
  reasoning?: Reasoning;
  context?: number;
  on_context_full: "compact" | "fail";
  compact_at: number;
  sandbox_exclude?: string[];
}

export function splitTools(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

export function validate(raw: Record<string, unknown>): Definition {
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
  const context = raw.context === undefined ? undefined : parseCount(raw.context, "definition: context");
  const on_context_full = raw.on_context_full ?? "compact";
  if (on_context_full !== "compact" && on_context_full !== "fail") throw new Error('definition: on_context_full must be "compact" or "fail"');
  const compact_at = raw.compact_at ?? 0.8;
  if (typeof compact_at !== "number" || !(compact_at > 0 && compact_at <= 1)) throw new Error("definition: compact_at must be a number in (0, 1]");
  const ex = raw.sandbox_exclude;
  if (ex !== undefined && (!Array.isArray(ex) || ex.some((p) => typeof p !== "string" || !p))) throw new Error("definition: sandbox_exclude must be a list of paths");
  if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description)) throw new Error("definition: description must be text");
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
  if (context !== undefined) d.context = context;
  if (ex !== undefined) d.sandbox_exclude = ex as string[];
  if (typeof raw.system === "string") d.system = raw.system;
  if (raw.description !== undefined) d.description = raw.description as string;
  return d;
}

export const FIELDS = ["name", "provider", "model", "system", "description", "tools", "sandbox", "max_steps", "reasoning", "context", "on_context_full", "compact_at", "sandbox_exclude"];
export const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// Checks an apply-file section: a map of name: settings, known fields only.
export function checkEntries<T>(kind: string, sec: unknown, fields: string[], check: (e: Record<string, unknown>) => T): T[] {
  if (!isMap(sec)) throw new Error(`apply file: "${kind}s" must be a map of name: settings`);
  return Object.entries(sec).map(([name, e]) => {
    if (!isMap(e)) throw new Error(`apply file: ${kind} "${name}" must be a map`);
    if ("name" in e) throw new Error(`apply file: unknown field "name" in ${kind} "${name}" (the key is the name)`);
    const bad = Object.keys(e).find((k) => !fields.includes(k));
    if (bad) throw new Error(`apply file: unknown field "${bad}" in ${kind} "${name}"`);
    return check({ ...e, name });
  });
}

export function parseDefinition(text: string): Definition {
  const raw = YAML.parse(text);
  if (!raw || typeof raw !== "object") throw new Error("definition: expected a YAML or JSON object");
  return validate(raw);
}

export function applyOverrides(def: Definition, o: { sandbox?: boolean; workdir?: string; max_steps?: number }): Definition {
  const d = { ...def };
  if (o.sandbox !== undefined) d.sandbox = o.sandbox;
  if (o.workdir !== undefined) d.workdir = o.workdir;
  if (o.max_steps !== undefined) d.max_steps = validate({ ...def, max_steps: o.max_steps }).max_steps;
  return d;
}

export function maskKey(key: string): string {
  return "****" + (key.length > 4 ? key.slice(-4) : "");
}
