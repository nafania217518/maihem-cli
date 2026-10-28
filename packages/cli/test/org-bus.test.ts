import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOps } from "../src/org/ops.ts";
import { validateOrg } from "../src/org/config.ts";
import { openTracker } from "../src/org/tracker.ts";
import type { Tracker } from "../src/org/tracker.ts";
import { createBus, execute } from "../src/org/bus.ts";
import type { Command, View } from "../src/org/bus.ts";
import type { OrgEvent } from "../src/org/types.ts";

const m = (role: string, reports_to?: string) => ({ role, definition: "d", ...(reports_to ? { reports_to } : {}) });
const org = validateOrg({ name: "x", repo: "r", members: { ba: m("ba"), sa: m("sa"), pm: m("pm"), tl: m("tl"), dev1: m("dev"), dev2: m("dev") } });

let dir: string, t: Tracker, v: View;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bus-"));
  t = openTracker(join(dir, "org.db"));
  v = { t, ops: createOps(t, org), org, goal: "G" };
});
afterEach(() => { t.close(); rmSync(dir, { recursive: true, force: true }); });

const io = () => ({ merge: vi.fn(), stop: vi.fn(), done: vi.fn(), tag: vi.fn() });

describe("bus", () => {
  it("handle concatenates the commands of all handlers", () => {
    const bus = createBus([() => [{ kind: "done" }], () => [], () => [{ kind: "merge", ticket: "T-1" }]]);
    expect(bus.handle(t.log("a", "org"), v)).toEqual([{ kind: "done" }, { kind: "merge", ticket: "T-1" }]);
  });

  it("drain handles each event once and stores the cursor", () => {
    const seen: number[] = [];
    const bus = createBus([(e) => (seen.push(e.id), [])]);
    t.log("a", "org");
    t.log("b", "org");
    bus.drain(t, v, () => {});
    bus.drain(t, v, () => {});
    expect(seen).toEqual([1, 2]);
    expect(t.getMeta("cursor")).toBe(2);
    t.log("c", "org");
    bus.drain(t, v, () => {});
    expect(seen).toEqual([1, 2, 3]);
  });

  it("drain continues with the events that its commands produced", () => {
    const seen: string[] = [];
    const bus = createBus([(e) => (seen.push(e.kind), e.kind === "a" ? [{ kind: "log", event: "b", data: {} }] : [])]);
    t.log("a", "org");
    bus.drain(t, v, (c) => execute(c, v, io()));
    expect(seen).toEqual(["a", "b"]);
    expect(t.getMeta("cursor")).toBe(2);
  });

  it("a failing exec does not advance the cursor past the event", () => {
    const seen: string[] = [];
    const bus = createBus([(e: OrgEvent) => (seen.push(e.kind), [{ kind: "done" }])]);
    t.log("a", "org");
    t.log("b", "org");
    let n = 0;
    expect(() => bus.drain(t, v, () => { if (n++ === 1) throw new Error("boom"); })).toThrow("boom");
    expect(t.getMeta("cursor")).toBe(1);
    bus.drain(t, v, () => {});
    expect(seen).toEqual(["a", "b", "b"]);
    expect(t.getMeta("cursor")).toBe(2);
  });

  it("execute maps every command kind onto the store, the ops or the io", () => {
    const x = io(), run = (c: Command) => execute(c, v, x);
    t.setMeta("main", "main");
    run({ kind: "milestone", name: "Req", description: "d" });
    expect(t.listMilestones()).toMatchObject([{ id: "M0", name: "Req", description: "d" }]);
    run({ kind: "create", input: { title: "P", kind: "roadmap", status: "todo", milestone: "M0", assignee: "pm" } });
    run({ kind: "create", input: { title: "C", status: "todo", milestone: "M0" } });
    expect(t.getTicket("T-1")).toMatchObject({ kind: "roadmap", status: "todo", owner: "org" });
    run({ kind: "create", input: { title: "D", status: "todo", milestone: "M0" } });
    run({ kind: "link", from: "T-2", to: "T-3", rel: "blocks" });
    expect(t.blockers("T-3").map((b) => b.id)).toEqual(["T-2"]);
    run({ kind: "status", ticket: "T-3", status: "in_progress" });
    expect(t.getTicket("T-3").status).toBe("in_progress");
    run({ kind: "todo", ticket: "T-3" });
    expect(t.getTicket("T-3").status).toBe("todo");
    run({ kind: "gate", ticket: "T-1", gate: "pending" });
    expect(t.getTicket("T-1").gate).toBe("pending");
    run({ kind: "gate", ticket: "T-1", gate: null });
    expect(t.getTicket("T-1").gate).toBeUndefined();
    run({ kind: "comment", ticket: "T-1", text: "hi" });
    expect(t.getTicket("T-1").comments).toMatchObject([{ author: "org", text: "hi" }]);
    run({ kind: "status", ticket: "T-3", status: "in_review" });
    run({ kind: "conflict", ticket: "T-3", files: ["a.ts"] });
    expect(t.getTicket("T-3")).toMatchObject({ status: "in_progress", comments: [{ text: expect.stringContaining("a.ts") }] });
    run({ kind: "ask", text: "ok?", ticket: "T-1", files: ["f"], remember: "final" });
    run({ kind: "ask", text: "q?" });
    expect(t.inbox()).toMatchObject([{ id: "Q-1", kind: "approval", author: "org", ticket: "T-1", files: ["f"], text: "ok?" }, { id: "Q-2", kind: "approval", files: [] }]);
    expect(t.getMeta("final")).toBe("Q-1");
    run({ kind: "log", event: "milestone.completed", data: { id: "M0" }, ticket: "T-1" });
    expect(t.events().at(-1)).toMatchObject({ kind: "milestone.completed", actor: "org", ticket: "T-1", data: { id: "M0" } });
    run({ kind: "close", ticket: "T-2" });
    expect(t.getTicket("T-2").status).toBe("done");
    run({ kind: "merge", ticket: "T-3" });
    run({ kind: "tag", milestone: "M0" });
    run({ kind: "stop", member: "dev1", ticket: "T-3" });
    run({ kind: "done" });
    expect(x.merge).toHaveBeenCalledWith("T-3");
    expect(x.tag).toHaveBeenCalledWith("M0");
    expect(x.stop).toHaveBeenCalledWith("dev1", "T-3");
    expect(x.done).toHaveBeenCalledOnce();
  });
});
