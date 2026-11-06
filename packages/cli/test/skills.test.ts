import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addSkill, loadSkill, parseSkill, updateSkill } from "../src/skills.ts";

// req: 1-add-skills/TR-1
describe("parseSkill", () => {
  let root: string;
  const skill = (name: string, text?: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (text !== undefined) fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    return dir;
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sk-")); });

  it("front matter with name and description gives both and the body without the front matter", () => {
    const dir = skill("folder", "---\nname: pdf\ndescription: Reads PDFs\n---\n# PDF\nUse it.\n");
    expect(parseSkill(dir)).toEqual({ name: "pdf", description: "Reads PDFs", body: "# PDF\nUse it.\n", dir });
  });
  it("no front matter: the folder name, and the first non-empty body line as the description", () => {
    const dir = skill("pdf-tools", "\n\n  Reads PDFs.  \nMore.\n");
    const s = parseSkill(dir);
    expect([s.name, s.description, s.body]).toEqual(["pdf-tools", "Reads PDFs.", "\n\n  Reads PDFs.  \nMore.\n"]);
  });
  it("no description: the first body line, with a leading # stripped", () => {
    expect(parseSkill(skill("x", "---\nname: pdf\n---\n\n## PDF tools\n")).description).toBe("PDF tools");
  });
  it("unknown fields accepted", () => {
    expect(parseSkill(skill("x", "---\ndescription: d\nlicense: MIT\nallowed-tools: [a]\n---\nb\n")).description).toBe("d");
  });
  it("an empty block counts as no fields", () => {
    const s = parseSkill(skill("x", "---\n---\nHello\n"));
    expect([s.name, s.description, s.body]).toEqual(["x", "Hello", "Hello\n"]);
  });
  it("CRLF and BOM accepted", () => {
    const s = parseSkill(skill("x", "\uFEFF---\r\nname: pdf\r\ndescription: d\r\n---\r\nbody\r\n"));
    expect([s.name, s.description, s.body]).toEqual(["pdf", "d", "body\r\n"]);
  });
  it("a name of 64 characters accepted, 65 refused", () => {
    expect(parseSkill(skill("x", `---\nname: ${"a".repeat(64)}\n---\nd\n`)).name).toBe("a".repeat(64));
    expect(() => parseSkill(skill("y", `---\nname: ${"a".repeat(65)}\n---\nd\n`)))
      .toThrow(`skill: invalid name "${"a".repeat(65)}": use lowercase letters, digits and single hyphens, at most 64 characters`);
  });
  it("uppercase, double hyphen and leading hyphen refused", () => {
    for (const n of ["Pdf", "a--b", "-a"]) expect(() => parseSkill(skill("x", `---\nname: "${n}"\n---\nd\n`))).toThrow(`skill: invalid name "${n}"`);
  });
  it("a bad folder name refused when the front matter has no name", () => {
    expect(() => parseSkill(skill("My_Skill", "d\n"))).toThrow('skill: invalid name "My_Skill"');
  });
  it("no description and an empty body refused", () => {
    expect(() => parseSkill(skill("x", "---\nname: pdf\n---\n\n  \n")))
      .toThrow('skill "pdf": no description; add description: to the front matter or a first line to the body of SKILL.md');
  });
  it("invalid YAML refused with the YAML message and the colon hint", () => {
    const dir = skill("x", "---\ndescription: Use when: x\n---\nb\n");
    let msg = "";
    try { parseSkill(dir); } catch (e) { msg = (e as Error).message; }
    expect(msg.startsWith(`skill: ${dir}/SKILL.md: invalid front matter: `)).toBe(true);
    expect(msg).toMatch(/mapping/);
    expect(msg.endsWith('; quote values that contain a colon, e.g. description: "Use when: ..."')).toBe(true);
  });
  it("an unclosed front matter refused", () => {
    const dir = skill("x", "---\nname: pdf\nb\n");
    expect(() => parseSkill(dir)).toThrow(`skill: ${dir}/SKILL.md: front matter has no closing --- line`);
  });
  it("a list front matter refused", () => {
    const dir = skill("x", "---\n- a\n---\nb\n");
    expect(() => parseSkill(dir)).toThrow(`skill: ${dir}/SKILL.md: front matter must be a map of field: value`);
  });
  it("a non-text name refused", () => {
    const dir = skill("x", "---\nname: 3\n---\nb\n");
    expect(() => parseSkill(dir)).toThrow(`skill: ${dir}/SKILL.md: "name" must be text`);
    const d2 = skill("y", "---\ndescription: [a]\n---\nb\n");
    expect(() => parseSkill(d2)).toThrow(`skill: ${d2}/SKILL.md: "description" must be text`);
  });
  it("no SKILL.md refused", () => {
    const dir = skill("x");
    expect(() => parseSkill(dir)).toThrow(`skill: no SKILL.md in ${dir}`);
  });
});

// req: 1-add-skills/TR-16
describe("parseSkill with blank fields", () => {
  let root: string;
  const skill = (name: string, text: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    return dir;
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sk-")); });

  it("a blank description: falls back to the first body line", () => {
    expect(parseSkill(skill("x", "---\nname: pdf\ndescription:\n---\n# PDF tools\n")).description).toBe("PDF tools");
  });
  it("a blank name: falls back to the folder name", () => {
    expect(parseSkill(skill("pdf", "---\nname:\ndescription: d\n---\nb\n")).name).toBe("pdf");
  });
  it("a whitespace-only description falls back to the first body line", () => {
    expect(parseSkill(skill("x", "---\ndescription: \"   \"\n---\nHello\n")).description).toBe("Hello");
  });
  it("a whitespace-only description with an empty body is refused", () => {
    expect(() => parseSkill(skill("x", "---\ndescription: \"  \"\n---\n\n")))
      .toThrow('skill "x": no description; add description: to the front matter or a first line to the body of SKILL.md');
  });
  it("a block description loses its trailing newline", () => {
    expect(parseSkill(skill("x", "---\ndescription: |\n  Reads PDFs\n---\nb\n")).description).toBe("Reads PDFs");
  });
});

// req: 1-add-skills/TR-15
describe("addSkill and updateSkill when the copy fails", () => {
  let root: string;
  const source = (text: string, unreadable: boolean): string => {
    const dir = fs.mkdtempSync(path.join(root, "src-"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), text);
    fs.mkdirSync(path.join(dir, "assets"));
    const asset = path.join(dir, "assets", "a.txt");
    fs.writeFileSync(asset, "a");
    if (unreadable) fs.chmodSync(asset, 0o000);
    return dir;
  };
  const skills = (): string[] => fs.readdirSync(path.join(root, "home", "skills"));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sk-"));
    process.env.MAIHEM_HOME = path.join(root, "home");
  });

  it("a failed add copy leaves nothing registered", () => {
    expect(() => addSkill(source("---\nname: aa\ndescription: d\n---\n", true))).toThrow(/EACCES/);
    expect(skills()).toEqual([]);
  });
  it("a retry after a failed add copy succeeds", () => {
    expect(() => addSkill(source("---\nname: aa\ndescription: d\n---\n", true))).toThrow(/EACCES/);
    expect(addSkill(source("---\nname: aa\ndescription: d\n---\n", false))).toBe("aa");
    expect(skills()).toEqual(["aa"]);
  });
  it("a failed update copy keeps the old copy and leaves no .NAME.new", () => {
    addSkill(source("---\nname: aa\ndescription: old\n---\n", false));
    expect(() => updateSkill("aa", source("---\nname: aa\ndescription: new\n---\n", true))).toThrow(/EACCES/);
    expect(loadSkill("aa").description).toBe("old");
    expect(skills()).toEqual(["aa"]);
  });
});
