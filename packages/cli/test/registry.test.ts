import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveDefinition, listDefinitions, loadDefinition, removeDefinition, checkDefinitions } from "../src/registry.ts";
import { parseDefinition } from "../src/definition.ts";

const def = (name: string) => parseDefinition(JSON.stringify({ name, provider: "openai", model: "gpt" }));

describe("registry", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
  });
  it("saveDefinition writes file with mode 600", () => {
    saveDefinition(def("a"));
    const f = path.join(home, "definitions", "a.yaml");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(loadDefinition("a").model).toBe("gpt");
  });
  it("--name override stores under that name", () => {
    saveDefinition(def("a"), "b");
    expect(loadDefinition("b").name).toBe("a");
  });
  it("listDefinitions lists sorted", () => {
    saveDefinition(def("z"));
    saveDefinition(def("a"));
    expect(listDefinitions().map((d) => d.name)).toEqual(["a", "z"]);
  });
  it("listDefinitions is empty when dir is missing", () => {
    expect(listDefinitions()).toEqual([]);
  });
  it("removeDefinition deletes", () => {
    saveDefinition(def("a"));
    removeDefinition("a");
    expect(listDefinitions()).toEqual([]);
  });
  it("loadDefinition throws for missing", () => {
    expect(() => loadDefinition("nope")).toThrow("no such definition: nope; add it: maihem definition add --name nope … or maihem apply -f FILE");
  });
  it("workdir is an unknown field in apply files", () => {
    expect(() => checkDefinitions({ x: { provider: "p", model: "m", workdir: "/w" } })).toThrow('apply file: unknown field "workdir" in definition "x"');
  });

  it("checkDefinitions reads a map keyed by name, rejects unknown fields, and keeps the base_url hint", () => {
    expect(checkDefinitions({ a: { provider: "p", model: "m", max_steps: 3 }, b: { provider: "p", model: "m" } }).map((d) => [d.name, d.max_steps])).toEqual([["a", 3], ["b", 50]]);
    expect(() => checkDefinitions({ a: { provider: "p", model: "m", foo: 1 } })).toThrow('apply file: unknown field "foo" in definition "a"');
    expect(() => checkDefinitions({ a: { provider: "p", model: "m", base_url: "x" } })).toThrow('definition: "base_url" moved to providers');
    expect(() => checkDefinitions({ a: { provider: "p", model: "m", max_steps: 0 } })).toThrow("definition: max_steps must be a positive integer");
  });
});
