import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { checkEntries, FIELDS, parseDefinition, validate } from "./definition.ts";
import type { Definition } from "./definition.ts";

export const home = (): string => process.env.MAIHEM_HOME ?? path.join(os.homedir(), ".maihem");
const dir = (): string => path.join(home(), "images");
const file = (name: string): string => path.join(dir(), `${name}.yaml`);

export function saveImage(def: Definition, name: string = def.name): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name), YAML.stringify(def), { mode: 0o600 });
}

export function loadImage(name: string): Definition {
  if (!fs.existsSync(file(name))) throw new Error(`no such image: ${name}; add it: maihem image add --name ${name} … or maihem apply -f FILE`);
  return parseDefinition(fs.readFileSync(file(name), "utf8"));
}

export function listImages(): Definition[] {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadImage(f.slice(0, -5)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeImage(name: string): void {
  loadImage(name);
  fs.rmSync(file(name));
}

export const checkImages = (sec: unknown): Definition[] => checkEntries("image", sec, [...FIELDS, "base_url", "api_key"], validate);
