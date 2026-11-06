import fs from "node:fs";
import path from "node:path";
import { tool } from "ai";
import type { ToolSet } from "ai";
import YAML from "yaml";
import { z } from "zod";
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
    // a field with no value parses to null; treat it as absent
    if (fields[k] === null) delete fields[k];
    if (fields[k] !== undefined && typeof fields[k] !== "string") throw new Error(`skill: ${file}: "${k}" must be text`);
  }
  const name = (fields.name as string | undefined) ?? path.basename(dir);
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`skill: invalid name "${name}": use lowercase letters, digits and single hyphens, at most 64 characters`);
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.replace(/^[#\s]+/, "");
  const description = (fields.description as string | undefined)?.trim() || firstLine;
  if (!description) throw new Error(`skill "${name}": no description; add description: to the front matter or a first line to the body of SKILL.md`);
  return { name, description, body, dir };
}

const skillDir = (name: string): string => path.join(home(), "skills", name);
// verbatimSymlinks: Node otherwise rewrites relative symlinks to absolute paths into the source folder
const copyFolder = (from: string, to: string): void => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });

// Copies to the hidden .NAME.new sibling, so a failed copy never leaves a half-copied skill registered.
function copyToFresh(name: string, src: string): string {
  const fresh = skillDir(`.${name}.new`);
  fs.rmSync(fresh, { recursive: true, force: true });
  try {
    copyFolder(src, fresh);
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
  return fresh;
}

export function addSkill(src: string): string {
  const { name } = parseSkill(src);
  if (fs.existsSync(skillDir(name))) throw new Error(`skill "${name}" already exists; use maihem skill update ${name} PATH`);
  fs.renameSync(copyToFresh(name, src), skillDir(name));
  return name;
}

export function loadSkill(name: string): Skill {
  if (!SKILL_NAME.test(name) || !fs.existsSync(skillDir(name))) throw new Error(`no such skill: ${name}; add it: maihem skill add PATH`);
  return parseSkill(skillDir(name));
}

export function listSkills(): Skill[] {
  const root = path.join(home(), "skills");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => !n.startsWith(".")).sort().map(loadSkill);
}

// Every non-directory entry under the skill folder, relative, with / separators.
export function skillFiles(skill: Skill): string[] {
  return (fs.readdirSync(skill.dir, { recursive: true }) as string[])
    .filter((f) => !fs.lstatSync(path.join(skill.dir, f)).isDirectory())
    .map((f) => f.split(path.sep).join("/"))
    .sort();
}

// Parses and copies to a hidden sibling first, so a refused PATH leaves the old copy as it was.
export function updateSkill(name: string, src: string): void {
  loadSkill(name);
  const parsed = parseSkill(src);
  if (parsed.name !== name) throw new Error(`skill update: ${src} holds skill "${parsed.name}", not "${name}"`);
  const target = skillDir(name), old = skillDir(`.${name}.old`);
  fs.rmSync(old, { recursive: true, force: true });
  const fresh = copyToFresh(name, src);
  fs.renameSync(target, old);
  fs.renameSync(fresh, target);
  fs.rmSync(old, { recursive: true, force: true });
}

export function removeSkill(name: string): void {
  loadSkill(name);
  fs.rmSync(skillDir(name), { recursive: true });
}

export const SKILL_TOOL = "skill";
const frozenRoot = (id: string): string => path.resolve(home(), "agents", `${id}.skills`);

// Reads an agent's skills from its frozen copy, never from the registry.
export const frozenSkills = (id: string, names: string[]): Skill[] => names.map((n) => parseSkill(path.join(frozenRoot(id), n)));

// Loads every skill first, so a missing one copies nothing.
export function freezeSkills(names: string[], id: string): Skill[] {
  const skills = names.map(loadSkill);
  try {
    for (const s of skills) copyFolder(s.dir, path.join(frozenRoot(id), s.name));
  } catch (e) {
    fs.rmSync(frozenRoot(id), { recursive: true, force: true });
    throw e;
  }
  return frozenSkills(id, names);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function skillCatalog(skills: Skill[]): string {
  const entries = skills.map((s) => `<skill><name>${escapeXml(s.name)}</name><description>${escapeXml(s.description)}</description></skill>`);
  return `Before a task that matches a skill's description, call the ${SKILL_TOOL} tool with that skill's name.\n<available_skills>${entries.join("")}</available_skills>`;
}

const locationNote = (s: Skill, sandbox: boolean): string => sandbox
  ? `Scripts in this skill cannot run in this sandbox. Load its reference files with ${SKILL_TOOL}({ name: "${s.name}", file: "<path>" }).`
  : `Skill folder: ${s.dir}. Relative paths in this skill resolve against this folder; run its scripts there with exec.`;

function skillContent(s: Skill, sandbox: boolean): string {
  const others = skillFiles(s).filter((f) => f !== "SKILL.md");
  const resources = others.length ? `<skill_resources>\n${others.map((f) => `<file>${f}</file>\n`).join("")}</skill_resources>\n` : "";
  return `<skill_content name="${s.name}">\n${s.body}\n${locationNote(s, sandbox)}\n${resources}</skill_content>`;
}

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// Errors come back as text: the agent loop treats a result starting with "error:" as a failed call.
function readSkillFile(s: Skill, file: string): string {
  if (path.isAbsolute(file)) return "error: file must be a path relative to the skill folder";
  const full = path.resolve(s.dir, file);
  if (!inside(s.dir, full)) return `error: ${file} is outside the skill folder`;
  if (!fs.existsSync(full)) return `error: ${file} does not exist in skill "${s.name}"`;
  if (!inside(fs.realpathSync(s.dir), fs.realpathSync(full))) return `error: ${file} is outside the skill folder`;
  if (fs.statSync(full).isDirectory()) return `error: ${file} is a directory`;
  const data = fs.readFileSync(full);
  return data.includes(0) ? `error: ${file} is not a text file` : data.toString("utf8");
}

export function createSkillTool(skills: Skill[], sandbox: boolean): ToolSet[string] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return tool({
    description: "Load a skill's instructions, or one of its files.",
    inputSchema: z.object({
      name: z.enum(skills.map((s) => s.name) as [string, ...string[]]).describe("skill name"),
      file: z.string().optional().describe("a file of the skill, relative to its folder; leave out for its instructions"),
    }),
    execute: async ({ name, file }) => {
      const s = byName.get(name)!;
      return file === undefined ? skillContent(s, sandbox) : readSkillFile(s, file);
    },
  });
}
