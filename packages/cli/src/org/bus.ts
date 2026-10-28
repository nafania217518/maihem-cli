// Event bus (docs/org-design.md §12.1): handlers read the events after a cursor stored in meta and return commands as data.
// The runner executes the commands. The cursor moves past an event only after all its commands ran, so a crash
// re-reads that event; the handlers check the current state, so a re-read is harmless.
import type { Org, OrgEvent, Status } from "./types.ts";
import type { Tracker } from "./tracker.ts";
import type { CreateInput, Ops } from "./ops.ts";

export type Command =
  | { kind: "merge"; ticket: string }
  | { kind: "tag"; milestone: string } // tag main with the milestone id and push the tag
  | { kind: "stop"; member: string; ticket: string } // stop that member's running session
  | { kind: "create"; input: CreateInput }
  | { kind: "close"; ticket: string }
  | { kind: "todo"; ticket: string }
  | { kind: "status"; ticket: string; status: Status } // system transitions only
  | { kind: "gate"; ticket: string; gate: "pending" | "approved" | null }
  | { kind: "milestone"; name: string; description: string }
  | { kind: "link"; from: string; to: string; rel: "blocks" | "related" }
  | { kind: "ask"; text: string; ticket?: string; files?: string[]; remember?: string } // an approval; remember: meta key for the new inbox id
  | { kind: "comment"; ticket: string; text: string }
  | { kind: "conflict"; ticket: string; files: string[] } // a merge conflict: back to In Progress with a comment
  | { kind: "log"; event: string; data: Record<string, unknown>; ticket?: string }
  | { kind: "done" };

export interface View { t: Tracker; ops: Ops; org: Org; goal: string } // read only in handlers
export type Handler = (e: OrgEvent, v: View) => Command[];
export interface Io {
  merge(ticket: string): void;
  tag(milestone: string): void;
  stop(member: string, ticket: string): void;
  done(): void;
}

export function createBus(handlers: Handler[]) {
  const handle = (e: OrgEvent, v: View): Command[] => handlers.flatMap((h) => h(e, v));
  return {
    handle,
    drain(t: Tracker, v: View, exec: (c: Command) => void): void {
      for (let evs; (evs = t.events(t.getMeta<number>("cursor") ?? 0)).length; ) {
        for (const e of evs) {
          for (const c of handle(e, v)) exec(c);
          t.setMeta("cursor", e.id);
        }
      }
    },
  };
}

export function execute(c: Command, { t, ops }: View, io: Io): void {
  switch (c.kind) {
    case "merge": return io.merge(c.ticket);
    case "tag": return io.tag(c.milestone);
    case "stop": return io.stop(c.member, c.ticket);
    case "done": return io.done();
    case "create": ops.create(c.input, "org"); return;
    case "close": ops.closeTicket(c.ticket, "org"); return;
    case "todo": ops.reopenToTodo(c.ticket, "org"); return;
    case "status": t.setStatus(c.ticket, c.status, "org"); return;
    case "gate": t.setGate(c.ticket, c.gate, "org"); return;
    case "milestone": ops.createMilestone(c.name, c.description, "org"); return;
    case "link": ops.link(c.from, c.to, c.rel, "org"); return;
    case "comment": t.addComment(c.ticket, c.text, "org"); return;
    case "conflict": ops.conflictBack(c.ticket, c.files); return;
    case "log": t.log(c.event, "org", c.data, c.ticket); return;
    case "ask": {
      const q = t.ask(c.text, "org", { ticket: c.ticket, files: c.files });
      if (c.remember) t.setMeta(c.remember, q.id);
    }
  }
}
