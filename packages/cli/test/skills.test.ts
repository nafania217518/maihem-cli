import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addSkill, createSkillTool, freezeSkills, loadSkill, parseSkill, skillCatalog, updateSkill } from "../src/skills.ts";
import type { Skill } from "../src/skills.ts";

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

// req: 1-add-skills/TR-18
describe("updateSkill when the final rename fails", () => {
  afterEach(() => vi.restoreAllMocks());
  it("a failed final rename in update keeps the old copy registered", () => {
    const root = newHome();
    addSkill(source(root, "aa"));
    const next = path.join(root, "next");
    fs.mkdirSync(next);
    fs.writeFileSync(path.join(next, "SKILL.md"), "---\nname: aa\ndescription: new\n---\n");
    const rename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++calls === 2) throw new Error("rename failed");
      rename(from, to);
    });
    expect(() => updateSkill("aa", next)).toThrow("rename failed");
    expect(loadSkill("aa").description).toBe("aa skill");
    expect(fs.readdirSync(path.join(root, "home", "skills")).filter((n) => !n.startsWith("."))).toEqual(["aa"]);
  });
});

const newHome = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-sk-"));
  process.env.MAIHEM_HOME = path.join(root, "home");
  return root;
};
const source = (root: string, name: string, files: Record<string, string> = {}): string => {
  const dir = path.join(root, "src", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${name} skill\n---\n# ${name}\n`);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};
const frozen = (id: string, name = ""): string => path.join(process.env.MAIHEM_HOME!, "agents", `${id}.skills`, name);

// req: 1-add-skills/TR-7
describe("freezeSkills", () => {
  let root: string;
  beforeEach(() => { root = newHome(); });

  it("copies under agents/ID.skills", () => {
    addSkill(source(root, "pdf", { "ref/a.md": "A" }));
    const [s] = freezeSkills(["pdf"], "id1");
    expect(s.dir).toBe(frozen("id1", "pdf"));
    expect(fs.readFileSync(frozen("id1", "pdf/ref/a.md"), "utf8")).toBe("A");
  });
  it("no skills creates nothing", () => {
    expect(freezeSkills([], "id1")).toEqual([]);
    expect(fs.existsSync(frozen("id1"))).toBe(false);
  });
  it("one missing skill copies nothing and names it", () => {
    addSkill(source(root, "pdf"));
    expect(() => freezeSkills(["pdf", "gone"], "id1")).toThrow("no such skill: gone; add it: maihem skill add PATH");
    expect(fs.existsSync(frozen("id1"))).toBe(false);
  });
  it("a failed copy leaves no ID.skills folder", () => {
    addSkill(source(root, "pdf", { "a.md": "A" }));
    fs.chmodSync(path.join(process.env.MAIHEM_HOME!, "skills", "pdf", "a.md"), 0o000);
    expect(() => freezeSkills(["pdf"], "id1")).toThrow(/EACCES/);
    expect(fs.existsSync(frozen("id1"))).toBe(false);
  });
  it("a later update does not change the frozen copy", () => {
    addSkill(source(root, "pdf", { "a.md": "old" }));
    freezeSkills(["pdf"], "id1");
    const next = path.join(root, "next", "pdf");
    fs.cpSync(path.join(root, "src", "pdf"), next, { recursive: true });
    fs.writeFileSync(path.join(next, "a.md"), "new");
    updateSkill("pdf", next);
    expect(fs.readFileSync(frozen("id1", "pdf/a.md"), "utf8")).toBe("old");
  });
});

// req: 1-add-skills/TR-10
describe("skillCatalog", () => {
  it("escapes & < > \" ' in names and descriptions", () => {
    const text = skillCatalog([{ name: "pdf", description: `a & <b> "c" 'd'`, body: "", dir: "/x" }]);
    expect(text).toContain("<available_skills><skill><name>pdf</name><description>a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;</description></skill></available_skills>");
  });
});

describe("skill tool", () => {
  let root: string;
  let skill: Skill;
  const call = (input: { name: string; file?: string }, sandbox = false): Promise<string> =>
    (createSkillTool([skill], sandbox).execute as (i: unknown, o: unknown) => Promise<string>)(input, {});
  beforeEach(() => {
    root = newHome();
    addSkill(source(root, "pdf", { "ref/b.md": "B text", "ref/a.md": "A text", "bin.dat": "x\0y" }));
    fs.mkdirSync(path.join(root, "outside"));
    fs.writeFileSync(path.join(root, "outside", "secret.txt"), "secret");
    [skill] = freezeSkills(["pdf"], "id1");
    fs.symlinkSync(path.join(root, "outside", "secret.txt"), path.join(skill.dir, "leak.txt"));
  });

  // req: 1-add-skills/TR-11
  it("body in skill_content with resources", async () => {
    expect(await call({ name: "pdf" })).toBe(`<skill_content name="pdf">\n# pdf\n\nSkill folder: ${skill.dir}. Relative paths in this skill resolve against this folder; run its scripts there with exec.\n`
      + "<skill_resources>\n<file>bin.dat</file>\n<file>leak.txt</file>\n<file>ref/a.md</file>\n<file>ref/b.md</file>\n</skill_resources>\n</skill_content>");
  });
  // req: 1-add-skills/TR-11
  it("no resources block for a SKILL.md alone", async () => {
    addSkill(source(root, "solo"));
    [skill] = freezeSkills(["solo"], "id2");
    expect(await call({ name: "solo" })).not.toContain("skill_resources");
  });
  // req: 1-add-skills/TR-11
  it("returns a reference file", async () => {
    expect(await call({ name: "pdf", file: "ref/a.md" })).toBe("A text");
  });
  // req: 1-add-skills/TR-11
  it("refuses an absolute path", async () => {
    expect(await call({ name: "pdf", file: "/etc/passwd" })).toBe("error: file must be a path relative to the skill folder");
  });
  // req: 1-add-skills/TR-11
  it("refuses ..", async () => {
    expect(await call({ name: "pdf", file: "../../x" })).toBe("error: ../../x is outside the skill folder");
  });
  // req: 1-add-skills/TR-11
  it("refuses a symlink that points outside", async () => {
    expect(await call({ name: "pdf", file: "leak.txt" })).toBe("error: leak.txt is outside the skill folder");
  });
  // req: 1-add-skills/TR-11
  it("reports a missing file", async () => {
    expect(await call({ name: "pdf", file: "nope.md" })).toBe('error: nope.md does not exist in skill "pdf"');
  });
  // req: 1-add-skills/TR-11
  it("reports a directory", async () => {
    expect(await call({ name: "pdf", file: "ref" })).toBe("error: ref is a directory");
  });
  // req: 1-add-skills/TR-11
  it("refuses a binary file", async () => {
    expect(await call({ name: "pdf", file: "bin.dat" })).toBe("error: bin.dat is not a text file");
  });
  // req: 1-add-skills/TR-11
  it("the name schema accepts only the definition's skills", () => {
    const schema = createSkillTool([skill], false).inputSchema as { safeParse: (v: unknown) => { success: boolean } };
    expect([schema.safeParse({ name: "pdf" }).success, schema.safeParse({ name: "other" }).success]).toEqual([true, false]);
  });
  // req: 1-add-skills/TR-12
  it("host mode names the frozen folder", async () => {
    expect(await call({ name: "pdf" })).toContain(`Skill folder: ${frozen("id1", "pdf")}. `);
  });
  // req: 1-add-skills/TR-12
  it("sandbox mode says scripts cannot run and names the file argument", async () => {
    const text = await call({ name: "pdf" }, true);
    expect(text).toContain('Scripts in this skill cannot run in this sandbox. Load its reference files with skill({ name: "pdf", file: "<path>" }).');
    expect(text).not.toContain("Skill folder:");
  });
});
