import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listOrgs, loadOrg, removeOrg, saveOrg } from "../src/org/store.ts";
import { validateOrg } from "../src/org/config.ts";

const m = (role: string) => ({ role, definition: "d" });
const org = validateOrg({ name: "x", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev: m("dev") } });

describe("org store", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-")); process.env.MAIHEM_HOME = home; });
  it("saves and loads orgs with mode 600", () => {
    expect(listOrgs()).toEqual([]);
    saveOrg(org);
    expect(loadOrg("x")).toEqual(org);
    expect(fs.statSync(path.join(home, "orgs/x.yaml")).mode & 0o777).toBe(0o600);
    expect(listOrgs()).toEqual([org]);
    removeOrg("x");
    expect(listOrgs()).toEqual([]);
  });
  it("listOrgs ignores runtime directories", () => {
    saveOrg(org);
    fs.mkdirSync(path.join(home, "orgs/x"));
    fs.mkdirSync(path.join(home, "orgs/y.yaml"));
    fs.writeFileSync(path.join(home, "orgs/notes.txt"), "");
    expect(listOrgs().map((o) => o.name)).toEqual(["x"]);
  });
  it("a missing org error shows the apply hint", () => {
    expect(() => loadOrg("q")).toThrow("no such org: q; add it with maihem apply -f FILE");
    expect(() => removeOrg("q")).toThrow("no such org");
  });
  it("there is no workflow store", async () => {
    expect(Object.keys(await import("../src/org/store.ts")).sort()).toEqual(["listOrgs", "loadOrg", "removeOrg", "saveOrg"]);
  });
});
