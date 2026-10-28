import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { Board } from "../src/ui/Board.ts";
import type { BoardData, BoardTicket } from "../src/ui/Board.ts";

const see = (fn: () => void) => vi.waitFor(fn, { timeout: 2000, interval: 10 });
const SIZE = { columns: 180, rows: 40 };
const tk = (id: string, title: string, status: string, o: Partial<BoardTicket> = {}): BoardTicket =>
  ({ id, title, description: "", status, label: "other", priority: 0, ord: 0, owner: "pm", kind: "normal", created: 0, updated: 0, blocked: false, approvals: [], ...o }) as BoardTicket;
const data = (o: Partial<BoardData> = {}): BoardData => ({
  org: "acme", goal: "build it", state: { status: "running" },
  usage: { input: 420300, output: 31200 }, memberUsage: {},
  members: [{ name: "ba", role: "ba" }, { name: "pm", role: "pm" }, { name: "dev1", role: "dev" }],
  milestones: [], tickets: [], sessions: {}, queue: [], inbox: [], human: [], waiting: false, recent: [], time: { running: 0 }, now: 0, ...o,
});
const mount = (read: () => BoardData, extra: Record<string, unknown> = {}) => {
  const onExit = vi.fn();
  const r = render(React.createElement(Board, { read, onExit, size: SIZE, ...extra } as never));
  return { ...r, onExit };
};
afterEach(cleanup);

describe("Board", () => {
  it("the board shows the active milestone and its completion in the milestones list", async () => {
    const milestones = [{ id: "M0", name: "Requirements", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }, { id: "M2", name: "Polish", completion: 0, active: false }];
    const r = mount(() => data({ milestones }));
    await see(() => expect(r.lastFrame()).toContain("MAIHEM org acme · running · ⏱ 0s · tokens 451.5k (↑ 420.3k / ↓ 31.2k)"));
    expect(r.lastFrame()).toContain("goal: build it");
    expect(r.lastFrame()).toContain("M0 Requirements ✓ · M1 Core 40% ◀ · M2 Polish 0%");
    expect(r.lastFrame()).toContain("q quit");
  });

  it("the board header does not show the active milestone", async () => {
    const milestones = [{ id: "M0", name: "Requirements", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }];
    const r = mount(() => data({ milestones }));
    await see(() => expect(r.lastFrame()).toContain("MAIHEM org acme · running · ⏱"));
    const header = r.lastFrame()!.split("\n").find((l) => l.includes("MAIHEM org"))!;
    expect(header).not.toContain("M1 Core 40% · running");
  });

  it("the board clock shows the run time without pauses", async () => {
    const r = mount(() => data({ time: { running: 7 * 3600e3 + 5 * 60e3 } }));
    await see(() => expect(r.lastFrame()).toContain("running · ⏱ 7h 05m · tokens"));
    const q = mount(() => data({ state: { status: "paused", gate: "Q-3" }, waiting: true, time: { running: 2400e3 } }));
    await see(() => expect(q.lastFrame()).toContain("paused Q-3 · waiting for human · ⏱ 40m 00s · tokens"));
  });

  it("the board header shows total tokens against the limit with arrows for input and output", async () => {
    const r = mount(() => data({ usage: { input: 2000000, output: 19768 }, tokenLimit: 3000000 }));
    await see(() => expect(r.lastFrame()).toContain(" · tokens 2.02M / 3M (↑ 2M / ↓ 19.8k)"));
  });

  it("the board header tells a total just over the limit from the limit", async () => {
    const r = mount(() => data({ usage: { input: 1844809, output: 174959 }, tokenLimit: 2000000 }));
    await see(() => expect(r.lastFrame()).toContain(" · tokens 2.02M / 2M (↑ 1.84M / ↓ 175k)"));
  });

  it("a member with a running session shows how long the session has run", async () => {
    const r = mount(() => data({ now: 723000, sessions: { dev1: { id: "s", ticket: "T-20", kind: "work", started: 0 } }, memberUsage: { dev1: { input: 65000, output: 1000 } } }));
    await see(() => expect(r.lastFrame()).toContain("dev1 ● working T-20 12m 03s 65k/1k"));
  });

  it("the board shows the active milestone in white in the milestones list", async () => {
    chalk.level = 1;
    try {
      const milestones = [{ id: "M0", name: "Requirements", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }];
      const r = mount(() => data({ milestones }));
      await see(() => expect(r.lastFrame()).toContain("\x1b[37mM1 Core 40% ◀"));
      expect(r.lastFrame()).toContain("\x1b[2mM0 Requirements ✓");
    } finally { chalk.level = 0; }
  });

  it("the Done column shows only the done tickets of the active milestone", async () => {
    const tickets = [tk("T-1", "Spec", "done", { milestone: "M0" }), tk("T-2", "Core done", "done", { milestone: "M1" }), tk("T-3", "Loose", "done"), tk("T-4", "Next", "todo", { milestone: "M0" })];
    const ms = (a: boolean) => [{ id: "M0", name: "Req", completion: 100, active: false }, { id: "M1", name: "Core", completion: 50, active: a }];
    const r = mount(() => data({ milestones: ms(true), tickets }));
    await see(() => expect(r.lastFrame()).toContain("T-2 Core done"));
    const f = r.lastFrame()!;
    expect(f).toContain("Done (1)");
    expect(f).not.toContain("T-1 Spec");
    expect(f).not.toContain("T-3 Loose");
    expect(f).toContain("T-4 Next");
    r.unmount();
    const r2 = mount(() => data({ milestones: ms(false), tickets }));
    await see(() => expect(r2.lastFrame()).toContain("Done (0)"));
    expect(r2.lastFrame()).not.toContain("T-2 Core done");
  });

  it("the header shows the status without milestones, with the gate", async () => {
    const r = mount(() => data({ state: { status: "paused", gate: "Q-3" } }));
    await see(() => expect(r.lastFrame()).toContain("MAIHEM org acme · paused Q-3 · ⏱"));
  });

  it("tickets sit in their status column with assignee, priority and approvals", async () => {
    const tickets = [
      tk("T-1", "Login", "todo", { assignee: "dev1", priority: 3, blocked: true }),
      tk("T-2", "Api", "in_review", { assignee: "dev1", branch: "t-2-api", approvals: [{ ticket: "T-2", reviewer: "tl", state: "approved" }, { ticket: "T-2", reviewer: "sa", state: "pending" }, { ticket: "T-2", reviewer: "ba", state: "changes" }] }),
      tk("T-3", "Docs", "done", { milestone: "M1" }), tk("T-4", "Old", "canceled"), tk("T-5", "Twin", "duplicate"), tk("T-6", "Idea", "triage"),
    ];
    const r = mount(() => data({ tickets, milestones: [{ id: "M1", name: "Core", completion: 50, active: true }] }));
    await see(() => expect(r.lastFrame()).toContain("T-1 Login @dev1"));
    const f = r.lastFrame()!;
    for (const c of ["Triage (1)", "Todo / Reply", "In Progress (0)", "In Review (1)", "Done (1)", "+2 canceled"]) expect(f).toContain(c);
    expect(f).toContain("P3 ⛔ blocked");
    expect(f).toContain("T-2 Api @dev1");
    for (const x of ["tl ✓", "sa …", "ba ✗", "⎇ t-2-api"]) expect(f).toContain(x);
    expect(f).not.toContain("T-4 Old");
  });

  it("the board has no Backlog column", async () => {
    const r = mount(() => data({ tickets: [tk("T-1", "Login", "todo")] }));
    await see(() => expect(r.lastFrame()).toContain("Todo / Reply"));
    expect(r.lastFrame()).not.toContain("Backlog");
  });

  it("sub-tickets are shown under their parent", async () => {
    const tickets = [tk("T-1", "Parent", "todo"), tk("T-2", "Other", "todo"), tk("T-3", "Child", "todo", { parent: "T-1" }), tk("T-4", "Away", "in_progress", { parent: "T-1" })];
    const r = mount(() => data({ tickets }));
    await see(() => expect(r.lastFrame()).toContain("T-1 Parent"));
    const lines = r.lastFrame()!.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(at("↳ T-3 Child")).toBe(at("T-1 Parent") + 1);
    expect(at("T-2 Other")).toBeGreaterThan(at("↳ T-3 Child"));
    expect(lines[at("↳ T-3 Child")]).toMatch(/ {2}↳ T-3 Child/);
    expect(r.lastFrame()).toContain("↳ T-4 Away");
  });

  it("sub-tickets stay readable at 100 columns", async () => {
    const tickets = [
      tk("T-1", "Requirements", "todo", { assignee: "ba" }),
      tk("T-2", "Business requirements", "todo", { parent: "T-1", assignee: "ba", priority: 2 }),
      tk("T-3", "Technical requirements", "todo", { parent: "T-1", assignee: "sa", blocked: true, approvals: [{ ticket: "T-3", reviewer: "sa", state: "pending" }] }),
    ];
    const r = mount(() => data({ tickets }), { size: { columns: 100, rows: 40 } });
    await see(() => expect(r.lastFrame()).toContain("T-1 Requirements"));
    const lines = r.lastFrame()!.split("\n");
    const col = lines.find((l) => l.includes("Todo / Reply"))!.indexOf("Todo / Reply");
    const cells = lines.map((l) => l.slice(col, col + 16).trimEnd());
    const row = (id: string) => cells.find((c) => c.includes(id))!;
    expect(row("T-1")).toMatch(/^T-1 Requirements/);
    expect(row("T-2")).toMatch(/^ ↳ ?T-2 Business/);
    expect(row("T-3")).toMatch(/^ ↳ ?T-3 Technical/);
    expect(cells.indexOf(row("T-3"))).toBe(cells.indexOf(row("T-2")) + 1); // no detail line under narrow cards
    for (const l of lines) expect(l.trim()).not.toBe("…");
  });

  it("members show their session kind and ticket", async () => {
    const r = mount(() => data({
      members: [{ name: "dev1", role: "dev" }, { name: "ba", role: "ba" }, { name: "pm", role: "pm" }, { name: "tl", role: "tl" }, { name: "sa", role: "sa" }],
      sessions: { ba: { id: "s", ticket: "T-2", kind: "work", started: 0 }, tl: { id: "s2", ticket: "T-3", kind: "review", started: 0 }, sa: { id: "s3", ticket: "T-4", kind: "reply", started: 0 } },
      queue: [{ member: "dev1", ticket: "T-5", kind: "work" }],
      memberUsage: { ba: { input: 12345, output: 1100 } },
    }));
    await see(() => expect(r.lastFrame()).toContain("ba ● working T-2 0s 12.3k/1.1k"));
    const f = r.lastFrame()!;
    expect(f).toContain("tl ● reviewing T-3");
    expect(f).toContain("sa ● replying T-4");
    expect(f).toContain("dev1 ○ queued T-5");
    expect(f).toContain("pm · idle");
    expect(f.indexOf("ba ●")).toBeLessThan(f.indexOf("dev1 ○")); // role order: ba, sa, pm, tl, dev
  });

  it("a triage session shows as triaging", async () => {
    const r = mount(() => data({ sessions: { pm: { id: "s", ticket: "", kind: "triage", started: 0 } } }));
    await see(() => expect(r.lastFrame()).toContain("pm ● triaging 0s"));
    r.unmount();
    const q = mount(() => data({ queue: [{ member: "pm", ticket: "", kind: "triage" }] }));
    await see(() => expect(q.lastFrame()).toContain("pm ○ queued triage"));
  });

  it("the joined column is titled Todo / Reply", async () => {
    const r = mount(() => data({ tickets: [tk("T-1", "Ask", "needs_reply", { assignee: "tl" }), tk("T-2", "Do", "todo"), tk("T-3", "Idea", "triage")] }));
    await see(() => expect(r.lastFrame()).toContain("Todo / Reply"));
    const f = r.lastFrame()!;
    expect(f).toContain("? T-1 Ask @tl");
    expect(f).toContain("T-2 Do");
    expect(f).not.toContain("? T-2");
    expect(f).not.toContain("Needs Reply (1)");
    expect(f.indexOf("Triage (1)")).toBeLessThan(f.indexOf("Todo / Reply"));
  });

  it("the board keeps the active milestone in view", async () => {
    const long = (id: string, active = false) => ({ id, name: "A very long milestone name that takes room", completion: 0, active });
    const r = mount(() => data({ milestones: [long("M1"), long("M2"), long("M3"), long("M4", true)] }), { size: { columns: 80, rows: 40 } });
    await see(() => expect(r.lastFrame()).toMatch(/M4 A very long.*◀/));
  });

  it("a completed milestone shows ✓ instead of 100 %", async () => {
    const r = mount(() => data({ milestones: [{ id: "M0", name: "Requirements", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }] }));
    await see(() => expect(r.lastFrame()).toContain("M0 Requirements ✓ · M1 Core 40% ◀"));
    expect(r.lastFrame()).not.toContain("100%");
  });

  it("the board header shows waiting for human", async () => {
    const r = mount(() => data({ waiting: true }));
    await see(() => expect(r.lastFrame()).toContain("running · waiting for human · ⏱"));
    const q = mount(() => data());
    await see(() => expect(q.lastFrame()).toContain("running · ⏱"));
    expect(q.lastFrame()).not.toContain("waiting for human");
  });

  it("the inbox shows approvals and tickets that wait for the human with the answer commands", async () => {
    const inbox = [{ id: "Q-1", kind: "approval", author: "org", ticket: "T-1", text: "Approve the requirements", files: [], state: "open", at: 0 }] as BoardData["inbox"];
    const r = mount(() => data({ inbox, human: [{ id: "T-2", title: "Login", question: "dev1 asks human: which db?" }] }));
    await see(() => expect(r.lastFrame()).toContain("Inbox (2)"));
    const f = r.lastFrame()!;
    expect(f).toContain("Q-1 approval T-1: Approve the requirements");
    expect(f).toContain("maihem org approve acme Q-1 | maihem org reject acme Q-1 -m TEXT");
    expect(f).toContain("T-2 Login: dev1 asks human: which db?");
    expect(f).toContain("maihem org answer acme T-2 TEXT");
  });

  it("an empty inbox says so and recent events show", async () => {
    const r = mount(() => data({ recent: ["10:00:00 ba ticket.created T-1"] }));
    await see(() => expect(r.lastFrame()).toContain("inbox empty"));
    expect(r.lastFrame()).toContain("10:00:00 ba ticket.created T-1");
  });

  it("the board re-reads data every pollMs", async () => {
    let n = 0;
    const r = mount(() => data({ usage: { input: 1000 * ++n, output: 0 } }), { pollMs: 20 });
    await see(() => expect(r.lastFrame()).toContain("tokens 3k (↑ 3k"));
  });

  it("q, Esc and Ctrl+C exit", async () => {
    const r = mount(() => data());
    await see(() => expect(r.stdin.listenerCount("readable")).toBeGreaterThan(0));
    r.stdin.write("q");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(1));
    r.stdin.write("\u0003");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(2));
    r.stdin.write("\u001b");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(3));
  });
});
