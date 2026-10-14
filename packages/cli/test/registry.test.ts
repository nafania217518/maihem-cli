import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveImage, listImages, loadImage, removeImage } from "../src/registry.ts";
import { parseDefinition } from "../src/definition.ts";

const def = (name: string) => parseDefinition(JSON.stringify({ name, provider: "openai", model: "gpt" }));

describe("registry", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
  });
  it("saveImage writes file with mode 600", () => {
    saveImage(def("a"));
    const f = path.join(home, "images", "a.yaml");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(loadImage("a").model).toBe("gpt");
  });
  it("--name override stores under that name", () => {
    saveImage(def("a"), "b");
    expect(loadImage("b").name).toBe("a");
  });
  it("listImages lists sorted", () => {
    saveImage(def("z"));
    saveImage(def("a"));
    expect(listImages().map((d) => d.name)).toEqual(["a", "z"]);
  });
  it("listImages is empty when dir is missing", () => {
    expect(listImages()).toEqual([]);
  });
  it("removeImage deletes", () => {
    saveImage(def("a"));
    removeImage("a");
    expect(listImages()).toEqual([]);
  });
  it("loadImage throws for missing", () => {
    expect(() => loadImage("nope")).toThrow("no such image: nope");
  });
});
