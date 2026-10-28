// Tools an org member's agent uses to work the tracker (docs/org-design.md §3.2, §12.3). Every tool calls an op with the member as
// actor; the ops hold the guards. The tools only pick which ops a role and a session kind get.
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createOps } from "./ops.ts";
import { ticketText } from "./prompt.ts";
import { STATUSES } from "./types.ts";
import type { Org, Priority, Role, Ticket, TicketKind, Wake } from "./types.ts";
import type { Tracker } from "./tracker.ts";
import type { mergeMain } from "./git.ts";

type Kind = Wake["kind"];
type Merge = ReturnType<typeof mergeMain>;
// ticket: "" for a triage session; batch: the Triage tickets a triage session decides; merge: merges main into the session's branch (work sessions on a branch);
// size: a changed file's length in characters (the summary cap); emptyDirs: the worktree's empty directories (git drops them);
// milestoneDiff: main's diff since the latest existing tag of the earlier milestones (ids in order)
export interface OrgToolOpts { ticket: string; kind: Kind; batch?: string[]; diff?: (id: string) => string; files?: () => string[]; size?: (file: string) => number; merge?: () => Merge; emptyDirs?: () => string[];
  milestoneDiff?: (tags: string[], path?: string) => string;
  // dirty: the changed paths in the session's worktree; discard: drops them. A session without write tools refuses its first stop call on changes.
  dirty?: () => Promise<string[]>; discard?: () => Promise<void> }

// a call ends the session's turn
export const STOP_TOOLS = ["submit_review", "ask", "answer", "forward", "approve", "request_changes"];
// a triage ask parks one batch ticket; the PM goes on with the others
export const stopTools = (kind: Kind) => kind === "triage" ? STOP_TOOLS.filter((x) => x !== "ask") : STOP_TOOLS;

// the ticket kinds whose review has a branch diff
export const DIFF_KINDS: TicketKind[] = ["normal", "requirements", "summary"];

// the definition's file tools filtered by role and session kind (docs/org-design.md §3, §5): PM has none, TL reads and
// runs checks, BA writes documents, SA writes documents and runs, DEV keeps all; only work sessions write
export function fileToolsFor(role: Role, kind: Kind, defTools: string[], ticketKind?: TicketKind, req = false): string[] {
  if (role === "pm" || (kind === "review" && ticketKind === "roadmap")) return []; // the roadmap review context holds everything
  const drop = [...(role === "tl" || kind !== "work" || ticketKind === "final" ? ["write", "edit"] : []), ...(role === "ba" || (role === "sa" && kind === "work" && req) || kind === "reply" || (kind === "review" && (req || ticketKind === "breakdown" || ticketKind === "summary")) || (role === "tl" && kind === "work" && ticketKind === "breakdown") ? ["exec"] : [])]; // SA writes requirements with file tools only; a reply, a requirements, breakdown or summary review, a TL breakdown work runs nothing
  return defTools.filter((x) => !drop.includes(x));
}

const line = (t: Ticket): string => {
  const extra = [t.assignee && `assignee: ${t.assignee}`, t.milestone].filter(Boolean).join(", ");
  return `${t.id} [${t.status}] ${t.title}${extra ? ` (${extra})` : ""}`;
};
const id = z.string().describe("ticket id, like T-3");
const priority = z.number().int().min(0).max(4).describe("0 none, 1 low, 2 medium, 3 high, 4 urgent");
const NAME = "Name: a short name (two to four words) without the milestone id.";
const ticketFields = { title: z.string().describe("short title"), description: z.string().describe("what to do and the acceptance criteria"), label: z.enum(["bug", "other"]).optional(), priority: priority.optional() };

export function createOrgTools(t: Tracker, member: string, org: Org, opts: OrgToolOpts): ToolSet {
  const tools = orgTools(t, member, org, opts), { dirty, discard } = opts;
  if (!dirty || !discard || fileToolsFor(org.members[member].role, opts.kind, ["write", "edit"], opts.ticket ? t.listTickets().find((x) => x.id === opts.ticket)?.kind : undefined).length) return tools;
  let warned = false;
  for (const name of STOP_TOOLS.filter((x) => tools[x])) {
    const run = tools[name].execute!;
    tools[name] = { ...tools[name], execute: async (i: unknown, o: never) => {
      const paths = await dirty();
      if (paths.length && !warned) { warned = true; return `error: your worktree has changes (${paths.join(", ")}); your role does not change files. Call again to discard them and go on.`; }
      if (paths.length) await discard();
      return run(i, o);
    } } as never;
  }
  return tools;
}

function orgTools(t: Tracker, member: string, org: Org, opts: OrgToolOpts): ToolSet {
  const ops = createOps(t, org), me = opts.ticket, role = org.members[member].role;
  const def = <S extends z.ZodObject>(description: string, inputSchema: S, run: (i: z.infer<S>) => string) =>
    tool({ description, inputSchema, execute: (i: z.infer<S>) => { try { return run(i); } catch (e) { return `error: ${(e as Error).message}`; } } });
  const none = z.object({});

  const common: ToolSet = {
    ticket_get: def("Show a ticket: fields, relations, reviewers, description and comments.", z.object({ id }), (i) => ticketText(t.getTicket(i.id), t)),
    ticket_list: def("List tickets.", z.object({ status: z.enum(STATUSES).optional(), milestone: z.string().optional().describe("milestone id, like M1"), mine: z.boolean().optional().describe("only tickets assigned to you") }),
      (i) => t.listTickets({ status: i.status, milestone: i.milestone, assignee: i.mine ? member : undefined }).map(line).join("\n") || "no tickets"),
    milestone_list: def("List the milestones in order with their completion.", none, () => {
      const a = ops.active()?.id;
      return t.listMilestones().map((x) => `${x.id} ${x.name}: ${Math.round(ops.completion(x.id))}%${x.id === a ? " (active)" : ""}${x.description ? ` - ${x.description}` : ""}`).join("\n") || "no milestones";
    }),
  };
  const ask = def("Ask a grid neighbour (BA and SA: also human) a question. The ticket waits for the answer and comes back to you. Your turn ends. An answer cannot run commands. Do not ask others to run anything; run it yourself, or ask for a decision.",
    z.object({ to: z.string().describe("the member to ask, or human"), question: z.string() }), (i) => ops.ask(me, i.to, i.question, member));
  if (opts.kind === "reply") return {
    ...common,
    answer: def("Answer the question on this ticket. The ticket goes back to the asker. Your turn ends.", z.object({ text: z.string() }), (i) => ops.answer(me, i.text, member)),
    // a DEV's only neighbour is its TL, always the asker: a forward only sends the question back
    ...(role === "dev" ? {} : { forward: def("Pass the question to a grid neighbour (BA and SA: also human) who can answer it. Your turn ends.", z.object({ to: z.string() }), (i) => ops.forward(me, i.to, member)) }),
  };
  if (opts.kind === "triage") {
    const batch = (x: string) => { if (!opts.batch?.includes(x)) throw new Error(`${x} is not in this triage batch`); return x; };
    return {
      ...common,
      accept: def("Accept a Triage ticket: its milestone and assignee (a DEV, BA or SA). The system sets the reviewer by the grid.",
        z.object({ id, milestone: z.string().describe("milestone id, like M1"), assignee: z.string(), priority: priority.optional() }),
        (i) => ops.accept(batch(i.id), member, { milestone: i.milestone, assignee: i.assignee, priority: i.priority as Priority | undefined })),
      reject: def("Reject a Triage ticket with the reason.", z.object({ id, reason: z.string() }), (i) => ops.reject(batch(i.id), i.reason, member)),
      ask: def("Ask BA or TL a question about a Triage ticket. It waits for the answer and comes back to Triage. Go on with the other tickets. An answer cannot run commands. Do not ask others to run anything; run it yourself, or ask for a decision.",
        z.object({ id, to: z.string(), question: z.string() }), (i) => ops.ask(batch(i.id), i.to, i.question, member)),
      duplicate: def("Mark a Triage ticket as a duplicate of another ticket.", z.object({ id, of: id }), (i) => ops.duplicate(batch(i.id), i.of, member)),
    };
  }
  // TL and SA read what the milestone changed on acceptance and summary tickets; a diff can be large, so it is a tool, not context
  const tk = t.getTicket(me);
  const mdiff: ToolSet = (role === "tl" || role === "sa") && (tk.kind === "acceptance" || tk.kind === "summary") ? {
    milestone_diff: def("Show what this milestone changed on main: the diff since the previous milestone's tag.", z.object({ path: z.string().optional().describe("limit the diff to one file or directory") }), (i) => {
      const ms = t.listMilestones().map((x) => x.id);
      return opts.milestoneDiff?.(ms.slice(0, Math.max(0, ms.indexOf(tk.milestone ?? ""))), i.path) ?? "(no diff)";
    }),
  } : {};
  // PM files the defects it finds in a milestone acceptance, SA in the final acceptance; they go to Triage (docs/org-design.md §7, §8.4)
  const defects: ToolSet = (role === "pm" && tk.kind === "acceptance") || (role === "sa" && tk.kind === "final")
    ? { ticket_create: def("Create a defect ticket (label bug) with the steps to reproduce. It goes to Triage.", z.object(ticketFields), (i) => ops.create({ ...i, label: "bug", priority: i.priority as Priority }, member)) } : {};
  if (opts.kind === "review") return {
    ...common,
    ...defects,
    ...mdiff,
    ...(DIFF_KINDS.includes(tk.kind) ? { review_diff: def("Show the ticket you review and the diff of its branch.", none, () => `${ticketText(t.getTicket(me), t)}\n\n${opts.diff?.(me) ?? "(no diff)"}`) } : {}),
    approve: def("Approve the ticket you review. Your turn ends.", none, () => ops.approve(me, member)),
    request_changes: def("Request changes: one finding per item. The ticket goes back to its assignee. Your turn ends.", z.object({ findings: z.array(z.string()) }),
      (i) => ops.requestChanges(me, i.findings, member)),
    ask,
  };

  const mine = t.getTicket(me), breakdown = role === "tl" && mine.kind === "breakdown";
  const create = breakdown
    ? def("Create a ticket of this milestone. It goes to Triage, blocked by this breakdown; PM accepts it with an assignee.", z.object(ticketFields),
      (i) => ops.create({ ...i, priority: i.priority as Priority }, member, { breakdown: me }))
    : def("Create a ticket for a new idea or a bug. It goes to Triage.", z.object(ticketFields), (i) => ops.create({ ...i, priority: i.priority as Priority }, member));
  const plan: ToolSet = breakdown ? {
    set_dependencies: def("Set the dependencies of this milestone's tickets in one call: each ticket with the tickets that must finish first. Replaces the previous dependencies.",
      z.object({ dependencies: z.record(z.string(), z.array(z.string())).describe('like { "T-3": ["T-1", "T-2"] }') }), (i) => ops.setDependencies(i.dependencies, member, me)),
    ticket_edit: def("Replace the title or the description of a ticket this breakdown created, while it is in Triage.", z.object({ id, title: z.string().optional(), description: z.string().optional() }), (i) => ops.editOwn(i.id, { title: i.title, description: i.description }, member, me)),
    ticket_drop: def("Drop a ticket this breakdown created, while it is in Triage.", z.object({ id }), (i) => ops.dropOwn(i.id, member, me)),
  } : {};
  // the roadmap: only the PM's roadmap session
  const roadmap: ToolSet = role !== "pm" || mine.kind !== "roadmap" ? {} : {
    milestone_create: def(`Create a milestone at the end of the order. ${NAME}`, z.object({ name: z.string(), description: z.string() }), (i) => ops.createMilestone(i.name, i.description, member)),
    milestone_update: def(`Change the name or the description of a milestone; the id stays. ${NAME}`,
      z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional().describe("the business scope and the requirement ids it covers") }),
      (i) => ops.updateMilestone(i.id, { name: i.name, description: i.description }, member)),
    milestone_reorder: def("Reorder the milestones: every milestone id once.", z.object({ ids: z.array(z.string()) }), (i) => ops.reorderMilestones(i.ids, member)),
    milestone_delete: def("Delete an empty milestone.", z.object({ id: z.string() }), (i) => ops.deleteMilestone(i.id, member)),
  };
  const extra: Record<Role, ToolSet> = { pm: roadmap, sa: {}, ba: {}, tl: {}, dev: {} };
  // PM never creates tickets in a work session (docs/org-design.md §8.4)
  const creates: ToolSet = role === "pm" ? {} : {
    ticket_create: create,
    ...(mine.parent || mine.kind !== "normal" || opts.kind !== "work" ? {} : { subticket_create: def("Create a sub-ticket of this session's ticket. It skips Triage.", z.object(ticketFields),
      (i) => ops.create({ ...i, priority: i.priority as Priority, parent: me }, member)) }), // a sub-ticket has no sub-tickets (ops refuses them)
  };
  return {
    ...common,
    ...creates,
    submit_review: def("Submit this session's ticket for review when the work is done. Your turn ends.",
      z.object({ summary: z.string().describe("One or two sentences on what changed; not the whole work. Acceptance and final reviews keep the compact verdict per BR.") }), (i) => {
        const empty = opts.emptyDirs?.() ?? [], many = empty.length > 1;
        if (empty.length) return `error: ${empty.join(", ")} ${many ? "are" : "is"} empty, and git does not store empty directories. Add a file${many ? " to each" : ""}, for example ${empty[0]}__init__.py.`;
        const r = opts.merge?.();
        if (r && !r.ok) { ops.conflictBack(me, r.conflicts); return `error: merge from main conflicts in ${r.conflicts.join(", ")}; resolve the markers first`; }
        return ops.submit(me, member, { files: opts.files?.(), size: opts.size, summary: i.summary });
      }),
    ask,
    ...extra[role],
    ...plan,
    ...mdiff,
  };
}
