import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { Board, eventRole } from "../src/ui/Board.ts";
import { Detail } from "../src/ui/Detail.ts";
import { replaySource } from "../src/ui/App.ts";
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
      expect(r.lastFrame()).toContain("\x1b[2mM0 Requirements \x1b[22m\x1b[92m✓");
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
    expect(f).toContain("P3 ⊘ blocked");
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

  it("the inbox shows approvals and tickets that wait for the human", async () => {
    const inbox = [{ id: "Q-1", kind: "approval", author: "org", ticket: "T-1", text: "Approve the requirements", files: [], state: "open", at: 0 }] as BoardData["inbox"];
    const r = mount(() => data({ inbox, human: [{ id: "T-2", title: "Login", question: "dev1 asks human: which db?" }] }));
    await see(() => expect(r.lastFrame()).toContain("Inbox (2)"));
    const f = r.lastFrame()!;
    expect(f).toContain("Q-1 approval T-1: Approve the requirements");
    expect(f).toContain("T-2 Login: dev1 asks human: which db?");
    expect(f).not.toContain("maihem org approve");
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
    expect(r.lastFrame()).toContain("↑↓←→ move · enter open · q quit");
    r.stdin.write("q");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(1));
    r.stdin.write("\u0003");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(2));
    r.stdin.write("\u001b");
    await see(() => expect(r.onExit).toHaveBeenCalledTimes(3));
  });

  describe("interactive", () => {
    const K = { up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", left: "\u001b[D", enter: "\r", esc: "\u001b" };
    // the focused item renders inverse: the text between the inverse codes
    const focus = (f: string) => (/\x1b\[7m(.*?)\x1b\[27m/.exec(f)?.[1] ?? "").replace(/\x1b\[\d+m/g, "");
    const MS = [{ id: "M0", name: "Req", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }];
    const TS = [tk("T-1", "Login", "todo"), tk("T-2", "Api", "todo"), tk("T-3", "Db", "in_review"), tk("T-9", "Pick", "needs_reply", { assignee: "human" })];
    const INBOX = [{ id: "Q-1", kind: "approval", author: "org", ticket: "T-1", text: "Approve the requirements", files: [], state: "open", at: 0 }] as BoardData["inbox"];
    const HUMAN = [{ id: "T-9", title: "Pick", question: "dev1 asks human: which db?" }];
    const full = (o: Partial<BoardData> = {}) => data({ milestones: MS, tickets: TS, inbox: INBOX, human: HUMAN, sessions: { dev1: { id: "s-dev1", ticket: "T-3", kind: "work", started: 0 } }, ...o });
    const hello = { name: "dev1", model: "m", provider: "p", sandbox: false, id: "s", workdir: "/w", readonly: true };
    const props = () => ({
      act: vi.fn((a: { kind: string; id: string }) => `answered ${a.id}`),
      ticket: vi.fn((id: string) => [`${id} Ticket title`, "status    todo", "", "the description", "", "comments", "  ba: first comment", "", "history", "10:00:00 org ticket.created " + id]),
      thread: vi.fn(() => ["summary: did the work", "comments", "  ba: first comment"]),
      milestone: vi.fn(() => ({ lines: ["M1 Core 40%", "acceptance: all checks pass"], tickets: [{ id: "T-2", title: "Api", status: "todo" }, { id: "T-3", title: "Db", status: "in_review" }] })),
      sessions: vi.fn(() => [{ id: "s1", member: "dev1", kind: "work", started: 0 }, { id: "s2", member: "tl", kind: "review", started: 0 }]),
      lastSession: vi.fn(() => "s9"),
      source: vi.fn(() => ({ subscribe: replaySource(hello, [{ type: "user", text: "replayed task" }] as never), close: vi.fn() })),
    });
    const open = async (o: Partial<BoardData> = {}) => {
      const p = props(), r = mount(() => full(o), p);
      await see(() => expect(r.stdin.listenerCount("readable")).toBeGreaterThan(0));
      const key = async (k: string, n = 1) => { for (let i = 0; i < n; i++) { r.stdin.write(k); await new Promise((x) => setTimeout(x, 15)); } };
      return { r, p, key, f: () => r.lastFrame()! };
    };
    const typed = async (r: { stdin: { write: (s: string) => void } }, s: string) => { r.stdin.write(s); await new Promise((x) => setTimeout(x, 30)); };
    beforeEach(() => { chalk.level = 1; });
    afterEach(() => { chalk.level = 0; });

    it("arrow keys move the focus across the milestones, the columns, the members and the inbox", async () => {
      const { key, f } = await open();
      await see(() => expect(focus(f())).toContain("Q-1 approval"));
      await key(K.down); expect(focus(f())).toContain("T-9 Pick: dev1 asks");
      await key(K.up, 2); expect(focus(f())).toMatch(/^ba /); // members row, first member
      await key(K.right); expect(focus(f())).toMatch(/^pm /);
      await key(K.up); expect(focus(f())).toContain("T-3 Db"); // In Review: the second non-empty column
      await key(K.left); expect(focus(f())).toContain("T-1 Login");
      await key(K.down); expect(focus(f())).toContain("T-2 Api");
      await key(K.up, 2); expect(focus(f())).toContain("M0 Req");
      await key(K.right); expect(focus(f())).toContain("M1 Core");
      await key(K.down); expect(focus(f())).toContain("T-");
      const r2 = mount(() => data({ tickets: TS }));
      await see(() => expect(focus(r2.lastFrame()!)).toContain("T-1 Login"));
    });

    it("enter on a ticket opens its fields, description, approvals, comments and history", async () => {
      const { key, f, p } = await open();
      await key(K.up, 4); await key(K.left); await see(() => expect(focus(f())).toContain("T-1 Login"));
      await key(K.enter);
      await see(() => expect(f()).toContain("the description"));
      expect(p.ticket).toHaveBeenCalledWith("T-1");
      for (const x of ["T-1 Ticket title", "status    todo", "ba: first comment", "ticket.created T-1"]) expect(f()).toContain(x);
      expect(f()).not.toContain(" org acme");
    });

    it("esc returns to the board with the same focus", async () => {
      const { key, f } = await open();
      await key(K.up, 4); await key(K.left); await key(K.down);
      await see(() => expect(focus(f())).toContain("T-2 Api"));
      await key(K.enter); await see(() => expect(f()).toContain("the description"));
      await key(K.esc);
      await see(() => expect(f()).toContain(" org acme"));
      expect(focus(f())).toContain("T-2 Api");
    });

    it("the ticket detail lists its sessions, and enter opens one", async () => {
      const { key, f, p } = await open();
      await key(K.up, 4); await key(K.left); await key(K.enter);
      await see(() => expect(f()).toContain("dev1 work"));
      expect(p.sessions).toHaveBeenCalledWith("T-1");
      expect(focus(f())).toContain("dev1 work");
      await key(K.down); expect(focus(f())).toContain("tl review");
      expect(f()).toContain("s2");
      await key(K.enter);
      await see(() => expect(f()).toContain("replayed task"));
      expect(p.source).toHaveBeenCalledWith("s2");
      expect(f()).toContain("read-only · Esc to go back");
      await key(K.esc);
      await see(() => expect(f()).toContain("the description"));
      expect(p.source.mock.results[0].value.close).toHaveBeenCalled();
    });

    it("enter on an approval opens its thread with the ticket summary and comments", async () => {
      const { key, f, p } = await open();
      await see(() => expect(focus(f())).toContain("Q-1"));
      await key(K.enter);
      await see(() => expect(f()).toContain("summary: did the work"));
      expect(p.thread).toHaveBeenCalledWith("T-1");
      expect(f()).toContain("Q-1 approval T-1: Approve the requirements");
      expect(f()).toContain("ba: first comment");
      expect(f()).toContain("❯");
      expect(f()).toContain("/approve [note] · /reject TEXT");
      await key("\u001b[6~"); await key("\u001b[5~"); await key("\u001b[F"); await key("\u001b[H"); // PgDn, PgUp, End, Home
      expect(f()).toContain("summary: did the work");
    });

    it("/approve note approves the item and /reject text rejects it", async () => {
      const { r, key, f, p } = await open();
      await see(() => expect(focus(f())).toContain("Q-1"));
      for (const [cmd, a] of [["/approve looks good", { kind: "approve", id: "Q-1", text: "looks good" }], ["/approve", { kind: "approve", id: "Q-1", text: "approved" }], ["/reject not yet", { kind: "reject", id: "Q-1", text: "not yet" }]] as const) {
        await key(K.enter); await see(() => expect(f()).toContain("❯"));
        await typed(r, cmd); await key(K.enter);
        await see(() => expect(p.act).toHaveBeenLastCalledWith(a));
        await see(() => expect(f()).toContain(" org acme"));
        expect(f()).toContain("answered Q-1");
      }
    });

    it("/reject without text is refused", async () => {
      const { r, key, f, p } = await open();
      await see(() => expect(focus(f())).toContain("Q-1"));
      await key(K.enter); await see(() => expect(f()).toContain("❯"));
      await typed(r, "/reject"); await key(K.enter);
      await see(() => expect(f()).toContain("a reason is needed: /reject TEXT"));
      expect(f()).toContain("❯ /reject");
      expect(p.act).not.toHaveBeenCalled();
      await typed(r, "hello"); await key(K.enter);
      await see(() => expect(f()).toContain("use /approve [note] or /reject TEXT"));
    });

    it("plain text on a human question answers it", async () => {
      const { r, key, f, p } = await open();
      await key(K.down); await key(K.enter);
      await see(() => expect(f()).toContain("T-9 Pick: dev1 asks human: which db?"));
      expect(p.thread).toHaveBeenCalledWith("T-9");
      await typed(r, "postgres"); await key(K.enter);
      await see(() => expect(p.act).toHaveBeenLastCalledWith({ kind: "answer", id: "T-9", text: "postgres" }));
      await see(() => expect(f()).toContain("answered T-9"));
      // the ticket detail of a Needs Reply ticket that waits for the human has the input line too
      await key(K.up, 3); await key(K.left); await see(() => expect(focus(f())).toContain("T-9"));
      await key(K.enter); await see(() => expect(f()).toContain("the description"));
      expect(f()).toContain("❯");
      await typed(r, "mysql"); await key(K.enter);
      await see(() => expect(p.act).toHaveBeenLastCalledWith({ kind: "answer", id: "T-9", text: "mysql" }));
    });

    it("the footer note shows green after an action and red after an error", async () => {
      const { r, key, f, p } = await open();
      await see(() => expect(focus(f())).toContain("Q-1"));
      await key(K.enter); await see(() => expect(f()).toContain("❯"));
      await typed(r, "/approve"); await key(K.enter);
      await see(() => expect(f()).toContain("\x1b[92manswered Q-1"));
      p.act.mockImplementation(() => { throw new Error("org acme is not running"); });
      await key(K.enter); await see(() => expect(f()).toContain("❯"));
      await typed(r, "/approve"); await key(K.enter);
      await see(() => expect(f()).toContain("\x1b[31morg acme is not running"));
    });

    it("the ticket detail colors its history by state", async () => {
      const { key, f, p } = await open();
      p.ticket.mockImplementation(() => ["history", "10:00:00 org ticket.status T-1 todo → done", "10:00:01 dev1 session.failed T-1 boom"]);
      await key(K.up, 4); await key(K.left); await key(K.enter);
      await see(() => expect(f()).toContain("\x1b[92m10:00:00 org ticket.status T-1 todo → done"));
      expect(f()).toContain("\x1b[31m10:00:01 dev1 session.failed T-1 boom");
      expect(f()).not.toContain("\x1b[92mhistory");
    });

    it("an action on a stopped org shows the error and keeps the input", async () => {
      const { r, key, f, p } = await open();
      p.act.mockImplementation(() => { throw new Error("org acme is not running"); });
      await key(K.down); await key(K.enter); await see(() => expect(f()).toContain("❯"));
      await typed(r, "postgres"); await key(K.enter);
      await see(() => expect(f()).toContain("org acme is not running"));
      expect(f()).toContain("❯ postgres");
    });

    it("enter on a milestone lists its tickets by status and its acceptance summary", async () => {
      const { key, f, p } = await open();
      await key(K.up, 5); await key(K.right); await see(() => expect(focus(f())).toContain("M1 Core"));
      await key(K.enter);
      await see(() => expect(f()).toContain("acceptance: all checks pass"));
      expect(p.milestone).toHaveBeenCalledWith("M1");
      expect(f()).toContain("todo T-2 Api");
      await key(K.down); expect(focus(f())).toContain("in_review T-3 Db");
      await key(K.enter);
      await see(() => expect(p.ticket).toHaveBeenCalledWith("T-3"));
      await key(K.esc); await see(() => expect(f()).toContain("acceptance: all checks pass"));
    });

    it("enter on a busy member attaches to its live session read-only", async () => {
      const { key, f, p } = await open();
      await key(K.up); await key(K.right, 3); await see(() => expect(focus(f())).toMatch(/^dev1 /));
      await key(K.enter);
      await see(() => expect(f()).toContain("read-only · Esc to go back"));
      expect(p.source).toHaveBeenCalledWith("s-dev1");
      await key(K.esc);
      await see(() => expect(f()).toContain(" org acme"));
      expect(p.source.mock.results[0].value.close).toHaveBeenCalled();
    });

    it("enter on an idle member replays its last session", async () => {
      const { key, f, p } = await open();
      await key(K.up); await key(K.right); await see(() => expect(focus(f())).toMatch(/^pm /));
      await key(K.enter);
      await see(() => expect(f()).toContain("replayed task"));
      expect(p.lastSession).toHaveBeenCalledWith("pm");
      expect(p.source).toHaveBeenCalledWith("s9");
      await key(K.esc); await see(() => expect(f()).toContain(" org acme"));
      p.lastSession.mockReturnValue(undefined as never);
      await key(K.enter);
      await see(() => expect(f()).toContain("pm has no session yet"));
    });
  });
});

describe("Detail and log layout", () => {
  const detail = (lines: string[], size: { columns: number; rows: number }) =>
    render(React.createElement(Detail, { title: "t", lines, size, onBack: () => {} }));

  it("detail lines wrap to the width instead of being cut", async () => {
    const r = detail([Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ") + " LASTWORD"], { columns: 30, rows: 20 });
    await see(() => expect(r.lastFrame()).toContain("LASTWORD"));
  });

  it("a wrapped detail scrolls by screen rows", async () => {
    const r = detail([Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ") + " ENDROW"], { columns: 20, rows: 8 });
    await see(() => expect(r.lastFrame()).toContain("w0"));
    expect(r.lastFrame()).not.toContain("ENDROW");
    for (let i = 0; i < 20; i++) { r.stdin.write("\u001B[6~"); await new Promise((s) => setTimeout(s, 5)); }
    await see(() => expect(r.lastFrame()).toContain("ENDROW"));
  });

  it("the event log fills the space down to the footer", async () => {
    const recent = Array.from({ length: 100 }, (_, i) => `event ${i}`);
    const r = mount(() => data({ recent }), { size: { columns: 180, rows: 60 } });
    await see(() => expect(r.lastFrame()).toContain("event 99"));
    const rows = r.lastFrame()!.split("\n");
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows.at(-1)).toContain("q quit");
    expect(rows.at(-2)).toContain("event 99");
    expect(rows.filter((l) => l.includes("event ")).length).toBeGreaterThan(60 - 24);
  });

  it("the event log shows the newest events when they do not fit", async () => {
    const recent = Array.from({ length: 100 }, (_, i) => `event ${i}`);
    const r = mount(() => data({ recent }), { size: { columns: 180, rows: 20 } });
    await see(() => expect(r.lastFrame()).toContain("event 99"));
    expect(r.lastFrame()).not.toContain("event 0\n");
    expect(r.lastFrame()).toContain("MAIHEM org acme");
    expect(r.lastFrame()!.split("\n").length).toBeLessThanOrEqual(20);
  });
});

describe("state colors", () => {
  beforeEach(() => { chalk.level = 1; });
  afterEach(() => { chalk.level = 0; });
  const G = "\x1b[92m", Y = "\x1b[33m", R = "\x1b[31m";
  const frame = async (o: Partial<BoardData>, want: string) => { const r = mount(() => data(o)); await see(() => expect(r.lastFrame()).toContain(want)); return r.lastFrame()!; };

  it("a working member shows green and a queued member amber", async () => {
    const f = await frame({ sessions: { dev1: { id: "s", ticket: "T-1", kind: "work", started: 0 } }, queue: [{ member: "pm", kind: "triage", ticket: "" }] as BoardData["queue"] }, "working");
    expect(f).toContain(G + "dev1 ● working");
    expect(f).toContain(Y + "pm ○ queued triage");
    expect(f).toContain("\x1b[2mba · idle");
  });

  it("approval marks show their state color", async () => {
    const approvals = [{ reviewer: "tl", state: "approved" }, { reviewer: "qa", state: "pending" }, { reviewer: "ba", state: "changes" }] as BoardTicket["approvals"];
    const f = await frame({ tickets: [tk("T-1", "Login", "in_review", { approvals })] }, "tl");
    expect(f).toContain("tl \x1b[22m" + G + "✓");
    expect(f).toContain("qa \x1b[22m" + Y + "…");
    expect(f).toContain("ba \x1b[22m" + R + "✗");
  });

  it("a blocked ticket shows ⊘ in amber", async () => {
    const f = await frame({ tickets: [tk("T-1", "Login", "todo", { blocked: true })] }, "blocked");
    expect(f).toContain(Y + "⊘ blocked");
    expect(f).not.toContain("⛔");
  });

  it("a ticket waiting for a reply shows ? in amber", async () => {
    const f = await frame({ tickets: [tk("T-9", "Pick", "needs_reply")] }, "Pick");
    expect(f).toContain(Y + "? ");
  });

  it("the header status shows its color", async () => {
    for (const [status, c] of [["running", G], ["paused", Y], ["stopped", R], ["done", G]] as const) {
      const f = await frame({ state: { status } }, c + status);
      expect(f).toContain("\x1b[1m\x1b[31mMAIHEM\x1b[39m org acme\x1b[22m"); // only MAIHEM has the accent
      cleanup();
    }
    const f = await frame({ state: { status: "running" }, waiting: true }, G + "running" + Y + " · waiting for human");
  });

  it("a completed milestone shows a green ✓", async () => {
    const f = await frame({ milestones: [{ id: "M0", name: "Req", completion: 100, active: false }, { id: "M1", name: "Core", completion: 40, active: true }] }, "Core");
    expect(f).toContain("\x1b[2mM0 Req \x1b[22m" + G + "✓");
    expect(f).toContain("\x1b[37mM1 Core 40% ◀");
  });

  it("the token count turns amber at 80 % and red over the limit", async () => {
    expect(await frame({ usage: { input: 1600, output: 0 }, tokenLimit: 2000 }, "tokens")).toContain(Y + "tokens 1.6k / 2k");
    cleanup();
    expect(await frame({ usage: { input: 2001, output: 0 }, tokenLimit: 2000 }, "tokens")).toContain(R + "tokens");
    cleanup();
    expect(await frame({ usage: { input: 1000, output: 0 }, tokenLimit: 2000 }, "tokens")).not.toMatch(/\x1b\[(33|31)mtokens/);
  });

  it("the inbox title is amber when it has items", async () => {
    expect(await frame({ human: [{ id: "T-9", title: "Pick", question: "which db?" }] }, "Inbox")).toContain(Y + "Inbox (1)");
  });

  it("the event kind shows its state color", async () => {
    const f = await frame({ recent: ["10:00:00 dev1 session.failed T-1 boom", "10:00:01 org ticket.created T-2"] }, "boom");
    expect(f).toContain(R + "session.failed");
    expect(f).toMatch(/\x1b\[2m T-1 boom/);
    expect(f).not.toMatch(/\x1b\[(92|33|31)mticket.created/);
    const cases: [string, string | undefined][] = [
      ["session.failed T-1 x", "fail"], ["git.push_failed x", "fail"], ["git.conflict T-1 conflict: a", "fail"], ["approval.set T-1 tl changes", "fail"],
      ["ticket.status T-1 todo → canceled", "fail"], ["ticket.status T-1 todo → duplicate", "fail"], ["inbox.answered Q-1 rejected", "fail"], ["org.stopped x", "fail"],
      ["review.done T-1 all reviewers approved", "live"], ["ticket.merged T-1 abc", "live"], ["git.merged T-1 merged abc", "live"], ["org.done", "live"], ["milestone.completed M1", "live"],
      ["approval.set T-1 tl approved", "live"], ["ticket.status T-1 in_review → done", "live"], ["inbox.answered Q-1 approved", "live"], ["inbox.answered Q-1 answered", "live"],
      ["inbox.opened Q-1 approval", "wait"], ["ticket.gate T-1 gate M1", "wait"], ["ticket.question T-1 dev1 asks, back to @pm todo", "wait"], ["ticket.question T-1 answered", undefined],
      ["org.paused x", "wait"], ["session.capped T-1 step cap 50", "wait"], ["approval.set T-1 tl pending", "wait"], ["ticket.created T-1", undefined],
    ];
    for (const [rest, role] of cases) expect(eventRole("10:00:00 pm " + rest), rest).toBe(role);
    expect(eventRole("status    todo")).toBeUndefined();
  });
});
