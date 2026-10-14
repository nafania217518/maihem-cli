import fs from "node:fs";
import YAML from "yaml";

export const TOOLS = ["read", "write", "edit", "list", "exec"] as const;
export type Tool = (typeof TOOLS)[number];
export type Provider = "openai" | "anthropic" | "ollama";
export interface Definition {
  name: string;
  provider: Provider;
  model: string;
  base_url?: string;
  system?: string;
  tools: Tool[];
  sandbox: boolean;
  workdir?: string;
  max_steps: number;
  api_key?: string;
}

const PROVIDERS = ["openai", "anthropic", "ollama"];
const ENV_KEY: Record<Provider, string | undefined> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", ollama: undefined };

function splitTools(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function validate(raw: Record<string, unknown>): Definition {
  for (const k of ["name", "provider", "model"]) {
    if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`definition: "${k}" is required`);
  }
  if (!PROVIDERS.includes(raw.provider as string)) throw new Error(`definition: unknown provider "${raw.provider}" (use ${PROVIDERS.join(", ")})`);
  const tools = (raw.tools ?? [...TOOLS]) as string[];
  for (const t of tools) {
    if (!(TOOLS as readonly string[]).includes(t)) throw new Error(`definition: unknown tool "${t}" (use ${TOOLS.join(", ")})`);
  }
  const max_steps = raw.max_steps ?? 50;
  if (!Number.isInteger(max_steps) || (max_steps as number) < 1) throw new Error("definition: max_steps must be a positive integer");
  const d: Definition = {
    name: raw.name as string,
    provider: raw.provider as Provider,
    model: raw.model as string,
    tools: tools as Tool[],
    sandbox: raw.sandbox !== false,
    max_steps: max_steps as number,
  };
  for (const k of ["base_url", "system", "workdir", "api_key"] as const) {
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

export function definitionFromFlags(f: { provider?: string; model?: string; system?: string; tools?: string; base_url?: string }): Definition {
  return validate({ name: "inline", provider: f.provider, model: f.model, system: f.system, base_url: f.base_url, tools: f.tools ? splitTools(f.tools) : undefined });
}

export function applyOverrides(def: Definition, o: { sandbox?: boolean; workdir?: string; tools?: string }): Definition {
  const d = { ...def, tools: [...def.tools] };
  if (o.sandbox !== undefined) d.sandbox = o.sandbox;
  if (o.workdir !== undefined) d.workdir = o.workdir;
  if (o.tools !== undefined) d.tools = validate({ ...def, tools: splitTools(o.tools) }).tools;
  return d;
}

export function resolveKey(def: Definition, flagKey: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envName = ENV_KEY[def.provider];
  if (!envName) return undefined;
  const key = flagKey || def.api_key || env[envName];
  if (!key) throw new Error(`no API key for ${def.provider}: pass --api-key, set the api_key field in the definition, or set ${envName}`);
  return key;
}

export function maskKey(key: string): string {
  return "****" + (key.length > 4 ? key.slice(-4) : "");
}

export function mask(def: Definition): Definition {
  return def.api_key ? { ...def, api_key: maskKey(def.api_key) } : { ...def };
}
