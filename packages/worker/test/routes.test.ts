import { describe, expect, it } from "vitest";
import { matchRoute, parseExecBody } from "../src/routes.ts";

describe("matchRoute", () => {
  it("matches health", () => {
    expect(matchRoute("GET", "/health")).toEqual({ kind: "health" });
  });
  it("builds /workspace/<path> for file routes", () => {
    expect(matchRoute("PUT", "/w/a1/file/workspace/dir/x.txt")).toEqual({ kind: "file", id: "a1", path: "/workspace/dir/x.txt" });
    expect(matchRoute("GET", "/w/a1/file/workspace/x.txt")).toEqual({ kind: "file", id: "a1", path: "/workspace/x.txt" });
  });
  it("rejects .. segments", () => {
    expect(matchRoute("GET", "/w/a1/file/workspace/../etc")).toBeNull();
  });
  it("rejects empty path and paths outside /workspace", () => {
    expect(matchRoute("GET", "/w/a1/file/workspace/")).toBeNull();
    expect(matchRoute("GET", "/w/a1/file/workspace")).toBeNull();
    expect(matchRoute("GET", "/w/a1/file/etc/passwd")).toBeNull();
  });
  it("matches files", () => {
    expect(matchRoute("GET", "/w/a-b_1/files")).toEqual({ kind: "files", id: "a-b_1" });
  });
  it("matches exec", () => {
    expect(matchRoute("POST", "/w/a1/exec")).toEqual({ kind: "exec", id: "a1" });
  });
  it("returns method for a wrong method on a known path", () => {
    expect(matchRoute("POST", "/health")).toEqual({ kind: "method" });
    expect(matchRoute("DELETE", "/w/a1/file/workspace/x")).toEqual({ kind: "method" });
    expect(matchRoute("POST", "/w/a1/files")).toEqual({ kind: "method" });
    expect(matchRoute("GET", "/w/a1/exec")).toEqual({ kind: "method" });
  });
  it("DELETE /w/:id matches a delete route", () => {
    expect(matchRoute("DELETE", "/w/abc")).toEqual({ kind: "delete", id: "abc" });
    expect(matchRoute("GET", "/w/abc")).toEqual({ kind: "method" });
  });
  it("returns null for unknown paths", () => {
    expect(matchRoute("GET", "/nope")).toBeNull();
    expect(matchRoute("GET", "/w/bad id/files")).toBeNull();
  });
});

describe("parseExecBody", () => {
  it("accepts a command", () => {
    expect(parseExecBody({ command: "ls" })).toEqual({ command: "ls" });
  });
  it("rejects a missing command", () => {
    expect(() => parseExecBody({})).toThrow("must provide command");
    expect(() => parseExecBody(null)).toThrow("must provide command");
    expect(() => parseExecBody({ command: "" })).toThrow("must provide command");
  });
  it("keeps cwd", () => {
    expect(parseExecBody({ command: "ls", cwd: "/workspace" })).toEqual({ command: "ls", cwd: "/workspace" });
  });
});
