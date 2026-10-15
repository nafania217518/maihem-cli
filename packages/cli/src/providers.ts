import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { home } from "./registry.ts";
import { maskKey } from "./definition.ts";

export const KINDS = ["openai", "anthropic", "ollama"] as const;
export type Kind = (typeof KINDS)[number];
export interface Provider { name: string; kind: Kind; base_url?: string; api_key?: string; headers?: Record<string, string> }
export interface Resolved { name: string; kind: Kind; base_url?: string; api_key?: string; headers?: Record<string, string> }

const STANDARD_ENV: Record<Kind, string | undefined> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", ollama: undefined };
const dir = (): string => path.join(home(), "providers");
const file = (name: string): string => path.join(dir(), `${name}.yaml`);

export function validateProvider(p: Provider): Provider {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(p.name ?? "")) throw new Error(`provider: invalid name "${p.name}" (use a-z, 0-9, . _ -)`);
  if (!KINDS.includes(p.kind)) throw new Error(`provider: unknown kind "${p.kind}" (use ${KINDS.join(", ")})`);
  return p;
}

const FIELDS = ["name", "kind", "base_url", "api_key", "headers"];
const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function parseProviders(text: string): Provider[] {
  const doc: unknown = YAML.parse(text);
  if (!isMap(doc) || !Array.isArray(doc.providers) || !doc.providers.length) throw new Error('providers file: expected a "providers:" list');
  const seen = new Set<string>();
  return doc.providers.map((p: unknown) => {
    if (!isMap(p)) throw new Error("providers file: each provider must be a map");
    const bad = Object.keys(p).find((k) => !FIELDS.includes(k));
    if (bad) throw new Error(`providers file: unknown field "${bad}" in provider "${p.name}"`);
    if (p.headers !== undefined && (!isMap(p.headers) || Object.values(p.headers).some((v) => typeof v !== "string")))
      throw new Error(`providers file: headers in provider "${p.name}" must map strings to strings`);
    const v = validateProvider(p as unknown as Provider);
    if (seen.has(v.name)) throw new Error(`providers file: duplicate provider "${v.name}"`);
    seen.add(v.name);
    return v;
  });
}

export function saveProvider(p: Provider): void {
  validateProvider(p);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(p.name), YAML.stringify(p), { mode: 0o600 });
}

export function loadProvider(name: string): Provider {
  if (!fs.existsSync(file(name))) throw new Error(`provider "${name}" not found; add it: maihem provider add --name ${name} --kind openai|anthropic|ollama`);
  return validateProvider(YAML.parse(fs.readFileSync(file(name), "utf8")));
}

export function listProviders(): Provider[] {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadProvider(f.slice(0, -5)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeProvider(name: string): void {
  loadProvider(name);
  fs.rmSync(file(name));
}

const REF = /\$\$|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
const expand = (name: string, field: string, v: string, env: NodeJS.ProcessEnv): string => v.replace(REF, (m, a?: string, b?: string) => {
  const n = a ?? b;
  if (!n) return "$";
  if (!env[n]) throw new Error(`provider "${name}": env var ${n} is not set (used in ${field})`);
  return env[n];
});

export function resolveProvider(name: string, env: NodeJS.ProcessEnv = process.env): Resolved {
  const p = loadProvider(name);
  const envName = STANDARD_ENV[p.kind];
  const key = p.api_key !== undefined ? expand(name, "api_key", p.api_key, env) : envName ? env[envName] : undefined;
  if (envName && !key) throw new Error(`no API key for provider "${name}": set ${envName}, or maihem provider update ${name} --api-key '$VAR' | --api-key KEY`);
  const r: Resolved = key ? { ...p, api_key: key } : p;
  if (p.headers) r.headers = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, expand(name, `headers.${k}`, v, env)]));
  return r;
}

const mask = (v: string): string => v.startsWith("$") && !v.startsWith("$$") ? v : maskKey(v);
export function maskProvider(p: Provider): Provider {
  const m = { ...p };
  if (m.api_key) m.api_key = mask(m.api_key);
  if (m.headers) m.headers = Object.fromEntries(Object.entries(m.headers).map(([k, v]) => [k, mask(v)]));
  return m;
}
