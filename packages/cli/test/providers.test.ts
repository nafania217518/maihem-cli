import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveProvider, loadProvider, listProviders, removeProvider, resolveProvider, maskProvider, parseProviders } from "../src/providers.ts";
import type { Provider } from "../src/providers.ts";

describe("providers", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
  });
  it("add validates name and kind", () => {
    expect(() => saveProvider({ name: "Bad!", kind: "openai" })).toThrow('provider: invalid name "Bad!" (use a-z, 0-9, . _ -)');
    expect(() => saveProvider({ name: "a", kind: "x" } as unknown as Provider)).toThrow('provider: unknown kind "x" (use openai, anthropic, ollama)');
  });
  it("saved provider file is mode 0600", () => {
    saveProvider({ name: "a", kind: "openai", base_url: "http://x" });
    expect(fs.statSync(path.join(home, "providers", "a.yaml")).mode & 0o777).toBe(0o600);
    expect(loadProvider("a")).toEqual({ name: "a", kind: "openai", base_url: "http://x" });
  });
  it("unknown provider error shows the add command", () => {
    expect(() => loadProvider("x")).toThrow('provider "x" not found; add it: maihem provider add --name x --kind openai|anthropic|ollama');
  });
  it("api_key and header values expand $VAR and ${VAR} at resolve time", () => {
    saveProvider({ name: "a", kind: "openai", api_key: "$MY", headers: { Authorization: "Bearer ${TOK}x", B: "plain" } });
    expect(resolveProvider("a", { MY: "mine", TOK: "t" })).toEqual({ name: "a", kind: "openai", api_key: "mine", headers: { Authorization: "Bearer tx", B: "plain" } });
  });
  it("$$ is a literal dollar and a lone $ stays", () => {
    saveProvider({ name: "a", kind: "openai", api_key: "a$$b$", headers: { X: "$ {y} $1" } });
    expect(resolveProvider("a", {})).toEqual({ name: "a", kind: "openai", api_key: "a$b$", headers: { X: "$ {y} $1" } });
  });
  it("an unset referenced var fails and names the var and the field", () => {
    saveProvider({ name: "x", kind: "openai", api_key: "k", headers: { Authorization: "Bearer ${LAB_TOKEN}" } });
    expect(() => resolveProvider("x", { LAB_TOKEN: "" })).toThrow('provider "x": env var LAB_TOKEN is not set (used in headers.Authorization)');
    saveProvider({ name: "y", kind: "openai", api_key: "$K" });
    expect(() => resolveProvider("y", {})).toThrow('provider "y": env var K is not set (used in api_key)');
  });
  it("without api_key the kind's standard env var is used", () => {
    const env = { OPENAI_API_KEY: "std", ANTHROPIC_API_KEY: "ant" };
    saveProvider({ name: "a", kind: "openai", api_key: "lit" });
    saveProvider({ name: "c", kind: "openai" });
    saveProvider({ name: "d", kind: "anthropic" });
    expect(resolveProvider("a", env).api_key).toBe("lit");
    expect(resolveProvider("c", env).api_key).toBe("std");
    expect(resolveProvider("d", env).api_key).toBe("ant");
  });
  it("base_url is not expanded", () => {
    saveProvider({ name: "o", kind: "ollama", base_url: "http://$HOST" });
    expect(resolveProvider("o", { HOST: "h" }).base_url).toBe("http://$HOST");
  });
  it("ollama needs no key", () => {
    saveProvider({ name: "o", kind: "ollama" });
    expect(resolveProvider("o", {})).toEqual({ name: "o", kind: "ollama" });
  });
  it("missing key error names the env var and the update command", () => {
    saveProvider({ name: "c", kind: "openai" });
    expect(() => resolveProvider("c", {})).toThrow(`no API key for provider "c": set OPENAI_API_KEY, or maihem provider update c --api-key '$VAR' | --api-key KEY`);
  });
  it("mask hides api_key and header values", () => {
    const p: Provider = { name: "a", kind: "openai", api_key: "sk-abcdef", headers: { X: "secret1234" } };
    expect(maskProvider(p)).toEqual({ name: "a", kind: "openai", api_key: "****cdef", headers: { X: "****1234" } });
    expect(p.api_key).toBe("sk-abcdef");
    expect(maskProvider({ name: "b", kind: "ollama" })).toEqual({ name: "b", kind: "ollama" });
  });
  it("mask shows values starting with $ and masks the rest", () => {
    expect(maskProvider({ name: "a", kind: "openai", api_key: "$K", headers: { A: "${T}", B: "$$secret1234", C: "Bearer ${T}" } }))
      .toEqual({ name: "a", kind: "openai", api_key: "$K", headers: { A: "${T}", B: "****1234", C: "****${T}" } });
  });
  it("api_key_env is an unknown field in a providers file", () => {
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n    api_key_env: V\n")).toThrow('providers file: unknown field "api_key_env" in provider "a"');
  });
  it("list returns providers sorted by name and remove deletes one", () => {
    expect(listProviders()).toEqual([]);
    saveProvider({ name: "z", kind: "ollama" });
    saveProvider({ name: "a", kind: "ollama" });
    expect(listProviders().map((p) => p.name)).toEqual(["a", "z"]);
    removeProvider("a");
    expect(listProviders().map((p) => p.name)).toEqual(["z"]);
    expect(() => removeProvider("a")).toThrow(/not found/);
  });
  it("parseProviders reads a providers list", () => {
    expect(parseProviders("providers:\n  - name: o\n    kind: ollama\n  - name: lab\n    kind: openai\n    base_url: http://x\n    api_key: $K\n    headers:\n      X-Team: infra\n"))
      .toEqual([{ name: "o", kind: "ollama" }, { name: "lab", kind: "openai", base_url: "http://x", api_key: "$K", headers: { "X-Team": "infra" } }]);
    expect(parseProviders('{"providers":[{"name":"a","kind":"openai"}]}')).toEqual([{ name: "a", kind: "openai" }]);
  });
  it("parseProviders rejects a file without a providers list", () => {
    for (const t of ["", "- a", "providers: []", "providers: x", "other: 1"]) expect(() => parseProviders(t)).toThrow('providers file: expected a "providers:" list');
  });
  it("parseProviders rejects unknown fields, bad headers and duplicate names", () => {
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n    model: m\n")).toThrow('providers file: unknown field "model" in provider "a"');
    expect(() => parseProviders("providers:\n  - x\n")).toThrow("providers file: each provider must be a map");
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n    headers: [1]\n")).toThrow('providers file: headers in provider "a" must map strings to strings');
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n    headers:\n      X: 1\n")).toThrow('providers file: headers in provider "a" must map strings to strings');
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n  - name: a\n    kind: ollama\n")).toThrow('providers file: duplicate provider "a"');
  });
  it("parseProviders validates every entry", () => {
    expect(() => parseProviders("providers:\n  - name: a\n    kind: openai\n  - name: b\n    kind: x\n")).toThrow('provider: unknown kind "x"');
  });
});
