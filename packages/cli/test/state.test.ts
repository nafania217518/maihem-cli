import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId, saveState, loadState, listStates, isAlive, refresh, logPath, sockPath, removeState, eventsPath, readEvents } from "../src/state.ts";
import type { AgentState } from "../src/state.ts";

const mk = (id: string, started: string, pid = process.pid): AgentState => ({
  id, name: "a", pid, status: "running", workdir: "/w", sandbox: true, started, log: logPath(id), sock: sockPath(id),
});

describe("state", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
    process.env.MAIHEM_HOME = home;
  });
  it("newId gives 12 hex chars", () => {
    expect(newId()).toMatch(/^[0-9a-f]{12}$/);
  });
  it("save/load round-trip", () => {
    const s = mk("abc", "2026-01-01T00:00:00.000Z");
    saveState(s);
    expect(loadState("abc")).toEqual(s);
    expect(s.log).toBe(path.join(home, "agents", "abc.log"));
    expect(s.sock).toBe(sockPath("abc"));
  });

  it("sockPath stays under the 104-byte unix socket limit even with a long MAIHEM_HOME", () => {
    process.env.MAIHEM_HOME = path.join(home, "x".repeat(150));
    expect(sockPath("abc").length).toBeLessThan(100);
    expect(sockPath("abc")).toContain("maihem-abc.sock");
    process.env.MAIHEM_HOME = home;
    expect(() => loadState("zzz")).toThrow("no such agent: zzz");
  });
  it("listStates sorted", () => {
    saveState(mk("old", "2026-01-01T00:00:00.000Z"));
    saveState(mk("new", "2026-02-01T00:00:00.000Z"));
    expect(listStates().map((s) => s.id)).toEqual(["new", "old"]);
  });
  it("listStates is empty when dir is missing", () => {
    expect(listStates()).toEqual([]);
  });
  it("isAlive(process.pid) true", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it("isAlive(999999) false", () => {
    expect(isAlive(999999)).toBe(false);
  });
  it("refresh marks dead pid exited", () => {
    const s = mk("dead", "2026-01-01T00:00:00.000Z", 999999);
    saveState(s);
    expect(refresh(s).status).toBe("exited");
    expect(loadState("dead").status).toBe("exited");
    const live = mk("live", "2026-01-01T00:00:00.000Z");
    expect(refresh(live).status).toBe("running");
  });
  it("removeState deletes the state, log, run file and socket", () => {
    const a = mk("rm1", "2026-01-01T00:00:00.000Z");
    const b = mk("keep", "2026-01-01T00:00:00.000Z");
    saveState(a); saveState(b);
    const dir = path.join(home, "agents");
    fs.writeFileSync(a.log, ""); fs.writeFileSync(path.join(dir, "rm1.run.json"), "{}"); fs.writeFileSync(a.sock, "");
    removeState(a);
    expect(fs.readdirSync(dir)).toEqual(["keep.json"]);
    expect(fs.existsSync(a.sock)).toBe(false);
    removeState(a);
  });
  it("readEvents returns the saved events and skips bad lines", () => {
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    fs.writeFileSync(eventsPath("ev1"), '{"type":"user","text":"hi"}\nnot json\n\n{"type":"done"}\n');
    expect(readEvents("ev1")).toEqual([{ type: "user", text: "hi" }, { type: "done" }]);
  });
  it("readEvents of an agent without an events file is empty", () => {
    expect(readEvents("none")).toEqual([]);
  });
  it("removeState removes the events file", () => {
    const a = mk("rm2", "2026-01-01T00:00:00.000Z");
    saveState(a);
    fs.writeFileSync(eventsPath("rm2"), "{}\n");
    removeState(a);
    expect(fs.existsSync(eventsPath("rm2"))).toBe(false);
  });
});
