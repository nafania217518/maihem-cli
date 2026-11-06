import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { isMap, SKILL_NAME } from "./definition.ts";
import { home } from "./registry.ts";

export interface Skill { name: string; description: string; body: string; dir: string }

// Splits SKILL.md into its front matter fields and its body.
function splitFrontMatter(file: string, text: string): { fields: Record<string, unknown>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/(?<=\n)/);
  if (lines[0]?.replace(/\r?\n$/, "") !== "---") return { fields: {}, body: text.replace(/^\uFEFF/, "") };
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r?\n$/, "") === "---");
  if (end < 0) throw new Error(`skill: ${file}: front matter has no closing --- line`);
  let parsed: unknown;
  try {
    parsed = YAML.parse(lines.slice(1, end).join(""));
  } catch (e) {
    throw new Error(`skill: ${file}: invalid front matter: ${(e as Error).message}; quote values that contain a colon, e.g. description: "Use when: ..."`);
  }
  // yaml parses an empty block to null
  if (parsed === null) parsed = {};
  if (!isMap(parsed)) throw new Error(`skill: ${file}: front matter must be a map of field: value`);
  return { fields: parsed, body: lines.slice(end + 1).join("") };
}

export function parseSkill(dir: string): Skill {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) throw new Error(`skill: no SKILL.md in ${dir}`);
  const { fields, body } = splitFrontMatter(file, fs.readFileSync(file, "utf8"));
  for (const k of ["name", "description"]) {
    if (fields[k] !== undefined && typeof fields[k] !== "string") throw new Error(`skill: ${file}: "${k}" must be text`);
  }
  const name = (fields.name as string | undefined) ?? path.basename(dir);
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`skill: invalid name "${name}": use lowercase letters, digits and single hyphens, at most 64 characters`);
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.replace(/^[#\s]+/, "");
  const description = (fields.description as string | undefined) || firstLine;
  if (!description) throw new Error(`skill "${name}": no description; add description: to the front matter or a first line to the body of SKILL.md`);
  return { name, description, body, dir };
}

const skillDir = (name: string): string => path.join(home(), "skills", name);
// verbatimSymlinks: Node otherwise rewrites relative symlinks to absolute paths into the source folder
const copyFolder = (from: string, to: string): void => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });

export function addSkill(src: string): string {
  const { name } = parseSkill(src);
  if (fs.existsSync(skillDir(name))) throw new Error(`skill "${name}" already exists; use maihem skill update ${name} PATH`);
  copyFolder(src, skillDir(name));
  return name;
}
