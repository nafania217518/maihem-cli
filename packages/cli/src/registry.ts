import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { checkEntries, FIELDS, parseDefinition, validate } from "./definition.ts";
import type { Definition } from "./definition.ts";

export const home = (): string => process.env.MAIHEM_HOME ?? path.join(os.homedir(), ".maihem");
const dir = (): string => path.join(home(), "definitions");
const file = (name: string): string => path.join(dir(), `${name}.yaml`);

export function saveDefinition(def: Definition, name: string = def.name): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name), YAML.stringify(def), { mode: 0o600 });
}

export function loadDefinition(name: string): Definition {
  if (!fs.existsSync(file(name))) throw new Error(`no such definition: ${name}; add it: maihem definition add --name ${name} … or maihem apply -f FILE`);
  return parseDefinition(fs.readFileSync(file(name), "utf8"));
}

export function listDefinitions(): Definition[] {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadDefinition(f.slice(0, -5)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeDefinition(name: string): void {
  loadDefinition(name);
  fs.rmSync(file(name));
}

export const checkDefinitions = (sec: unknown): Definition[] => checkEntries("definition", sec, [...FIELDS, "base_url", "api_key"], validate);
