// The fixed org flows as bus handlers (docs/org-design.md §6–9, §12). Each
// handler is pure: it reads the current state through the view and returns commands. Each checks that state before it acts, so a re-read of
// the same event after a crash gives no second effect.
import { SYSTEM_KINDS } from "./ops.ts";
import { CLOSED, isOpen } from "./types.ts";
import type { OrgEvent, Role, Status, Ticket } from "./types.ts";
import type { Command, Handler, View } from "./bus.ts";

const DOCS = ["docs/business-requirements.md", "docs/business-summary.txt", "docs/technical-requirements.md", "docs/tech-summary.txt"];
export const PLAN_CHANGE = "Plan change";

const who = (v: View, r: Role) => Object.keys(v.org.members).find((n) => v.org.members[n].role === r)!;
const closing = (e: OrgEvent) => e.kind === "ticket.status" && CLOSED.includes(e.data.to as Status);
const childrenClosed = (v: View, id: string) => v.t.children(id).every((c) => !isOpen(c.status));
const parentOf = (v: View, id: string): Ticket | undefined => { const p = v.t.getTicket(id).parent; return p ? v.t.getTicket(p) : undefined; };
const finalAnswer = (v: View) => v.t.getInbox(v.t.getMeta<string>("final")!).answer ?? "";
const inMs = (v: View, m: string | undefined) => (m ? v.t.listTickets({ milestone: m }) : []);
const ofKind = (v: View, m: string | undefined, k: string) => inMs(v, m).find((x) => x.kind === k);
// a requirements milestone (M0, Plan change n) holds a requirements parent and the roadmap; no acceptance, no summary
const isReq = (v: View, m: string | undefined) => inMs(v, m).some((x) => x.kind === "requirements");
// a milestone with no work ticket (canceled and duplicate ones do not count) still gets its acceptance, but no summary
const hasWork = (v: View, m: string | undefined) => inMs(v, m).some((x) => !SYSTEM_KINDS.includes(x.kind) && x.status !== "canceled" && x.status !== "duplicate");
const nameOf = (v: View, m: string | undefined) => v.t.listMilestones().find((x) => x.id === m)?.name ?? "";
// an urgent system ticket (roadmap, breakdown, acceptance, summary, final)
const auto = (title: string, kind: Ticket["kind"], milestone: string | undefined, assignee: string, reviewers: string[], description: string): Command =>
  ({ kind: "create", input: { title, kind, status: "todo", priority: 4, milestone, assignee, reviewers, description } });

// the sub-tickets of a requirements parent, by the parent's title; CHAIN: title → the sibling that blocks it
type Sub = { title: string; priority?: 4; assignee: string; reviewers: string[]; description: string };
const SUBS: Record<string, (v: View) => Sub[]> = {
  Requirements: (v) => {
    const [ba, sa] = [who(v, "ba"), who(v, "sa")];
    return [
      { title: "Business requirements", priority: 4, assignee: ba, reviewers: [sa], description: "The business requirements and the business summary for the goal." },
      { title: "Technical requirements", priority: 4, assignee: sa, reviewers: [ba], description: "The technical requirements and the tech summary for the business requirements." },
    ];
  },
  [PLAN_CHANGE]: (v) => updates(v, finalAnswer(v)),
};
// the chained update pair: BA updates the business documents with the human's text, then SA the technical ones
const UPDATE_BR = "Update docs/business-requirements.md and docs/business-summary.txt for the human's feedback.";
const updateBr = (text: string) => (text ? `${UPDATE_BR}\nThe human's feedback: ${text}` : UPDATE_BR);
const UPDATE_TR = "Update docs/technical-requirements.md and docs/tech-summary.txt to the updated business requirements.";
function updates(v: View, text: string, priority?: 4): Sub[] {
  const [ba, sa] = [who(v, "ba"), who(v, "sa")];
  return [
    { title: "Update business requirements", priority, assignee: ba, reviewers: [sa], description: updateBr(text) },
    { title: "Update technical requirements", priority, assignee: sa, reviewers: [ba], description: text ? `${UPDATE_TR}\nThe human's feedback: ${text}` : UPDATE_TR },
  ];
}
const CHAIN: Record<string, string> = { "Technical requirements": "Business requirements", "Update technical requirements": "Update business requirements" };

// org-design.md §7: M0 and the Requirements parent (each part only when missing)
const start: Handler = (e, v) => {
  if (e.kind !== "org.started") return [];
  const out: Command[] = [];
  if (!v.t.listMilestones().length) out.push({ kind: "milestone", name: "Requirements", description: "Business and technical requirements, and the roadmap" });
  if (!v.t.listTickets().some((x) => x.kind === "requirements"))
    out.push({ kind: "create", input: { title: "Requirements", kind: "requirements", status: "todo", milestone: "M0", assignee: who(v, "ba"), description: "The business and technical requirements and their summaries; the human approves them." } });
  return out;
};

// org-design.md §7: the sub-tickets of a new requirements parent, each only when missing
const subTickets: Handler = (e, v) => {
  if (e.kind !== "ticket.created") return [];
  const tk = v.t.getTicket(e.ticket!), subs = SUBS[tk.title];
  if (tk.kind !== "requirements" || !subs) return [];
  const have = v.t.children(tk.id).map((c) => c.title);
  return subs(v).filter((s) => !have.includes(s.title)).map((s) => ({ kind: "create", input: { ...s, parent: tk.id } }));
};

// org-design.md §7: Technical requirements is blocked by Business requirements (also their updates in a Plan change)
const chain: Handler = (e, v) => {
  if (e.kind !== "ticket.created") return [];
  const tk = v.t.getTicket(e.ticket!), p = parentOf(v, tk.id), before = CHAIN[tk.title];
  if (p?.kind !== "requirements" || !before) return [];
  const from = v.t.children(p.id).findLast((c) => c.title === before); // the latest pair after a rejected gate
  if (!from || v.t.blockers(tk.id).some((b) => b.id === from.id)) return [];
  return [{ kind: "link", from: from.id, to: tk.id, rel: "blocks" }];
};

// org-design.md §7: the last child of a requirements parent closed → the human approves the documents
const askApproval: Handler = (e, v) => {
  if (!closing(e)) return [];
  const p = parentOf(v, e.ticket!);
  if (p?.kind !== "requirements" || !isOpen(p.status) || p.gate || !childrenClosed(v, p.id)) return [];
  if (v.t.inbox("open").some((q) => q.kind === "approval" && q.ticket === p.id)) return [];
  const text = `The requirements documents are ready: ${DOCS.join(", ")}. Approve to accept the documents, or reject with feedback.`;
  return [{ kind: "ask", text, ticket: p.id, files: DOCS }, { kind: "gate", ticket: p.id, gate: "pending" }];
};

// org-design.md §7: approve → gate approved and the urgent Roadmap ticket for PM; reject → the urgent update pair
const ROADMAP = "Plan the roadmap: the milestones in order.";
const approvalAnswered: Handler = (e, v) => {
  if (e.kind !== "inbox.answered" || e.data.kind !== "approval" || !e.ticket) return [];
  const p = v.t.getTicket(e.ticket);
  if (p.kind !== "requirements" || !isOpen(p.status)) return [];
  if (e.data.approved) return [
    ...(p.gate !== "approved" ? [{ kind: "gate", ticket: p.id, gate: "approved" } as Command] : []),
    ...(ofKind(v, p.milestone, "roadmap") ? [] : [auto("Roadmap", "roadmap", p.milestone, who(v, "pm"), [who(v, "ba"), who(v, "tl")], ROADMAP)]),
  ];
  const answer = String(e.data.answer);
  const out: Command[] = [];
  if (!v.t.children(p.id).some((c) => c.title === "Update business requirements" && c.description === updateBr(answer)))
    out.push(...updates(v, answer, 4).map((s) => ({ kind: "create", input: { ...s, parent: p.id } }) as Command));
  if (p.gate === "pending") out.push({ kind: "gate", ticket: p.id, gate: null });
  return out;
};

// org-design.md §7: an approved requirements parent closes once its children and its milestone's roadmap are closed;
// the roadmap closes last, so its milestone completes after the roadmap even when PM created no later milestone
const closeRequirements: Handler = (e, v) => {
  if (!closing(e)) return [];
  const done = (m?: string) => { const r = ofKind(v, m, "roadmap"); return !!r && !isOpen(r.status); };
  return inMs(v, v.t.getTicket(e.ticket!).milestone).filter((p) => p.kind === "requirements" && isOpen(p.status) && p.gate === "approved" && childrenClosed(v, p.id) && done(p.milestone))
    .map((p) => ({ kind: "close", ticket: p.id }));
};

// org-design.md §8.5: a parent closes when its children are closed and it has no branch or its branch is merged
const closeParent: Handler = (e, v) => {
  if (!closing(e)) return [];
  const p = parentOf(v, e.ticket!);
  if (!p || p.kind === "requirements" || !isOpen(p.status) || !childrenClosed(v, p.id) || (p.branch && !p.merged)) return [];
  return [{ kind: "close", ticket: p.id }];
};

// org-design.md §8.5, §8.7: a merged ticket closes; a merged parent with open children keeps In Review
const merged: Handler = (e, v) => {
  if (e.kind !== "git.merged") return [];
  const tk = v.t.getTicket(e.ticket!);
  return isOpen(tk.status) && childrenClosed(v, tk.id) ? [{ kind: "close", ticket: tk.id }] : [];
};

// org-design.md §8.3, §13: a merge conflict sends the ticket back to In Progress with a comment
const conflict: Handler = (e, v) =>
  e.kind === "git.conflict" && v.t.getTicket(e.ticket!).status === "in_review" ? [{ kind: "conflict", ticket: e.ticket!, files: (e.data.files as string[]) ?? [] }] : [];

// status-workflow.md §3: review is fail-fast; a ticket sent back stops every reviewer's session on it
// org-design.md §7: a blocked final ticket goes to Todo at a review result
const blockedFinal = (v: View, tk: Ticket) => tk.kind === "final" && v.t.isBlocked(tk.id);
const reviewBack: Handler = (e, v) => {
  if (e.kind !== "ticket.status" || e.data.from !== "in_review" || e.data.to !== "in_progress") return [];
  const tk = v.t.getTicket(e.ticket!);
  return [...tk.approvals.map((a) => ({ kind: "stop", member: a.reviewer, ticket: tk.id }) as Command), ...(tk.status === "in_progress" && blockedFinal(v, tk) ? [{ kind: "todo", ticket: tk.id } as Command] : [])];
};

// org-design.md §8.7: all reviewers approved → merge (the runner merges serially); a blocked final ticket → Todo
const reviewDone: Handler = (e, v) => {
  if (e.kind !== "review.done") return [];
  const tk = v.t.getTicket(e.ticket!);
  if (tk.status !== "in_review") return [];
  return [{ kind: blockedFinal(v, tk) ? "todo" : "merge", ticket: tk.id }];
};

// org-design.md §7: a ticket created while the final ticket is open blocks the final ticket
const finalDefect: Handler = (e, v) => {
  if (e.kind !== "ticket.created") return [];
  const f = v.t.listTickets().find((x) => x.kind === "final" && isOpen(x.status));
  if (!f || f.id === e.ticket || v.t.blockers(f.id).some((b) => b.id === e.ticket)) return [];
  return [{ kind: "link", from: e.ticket!, to: f.id, rel: "blocks" }];
};

// org-design.md §8.8: the last ticket of a milestone closed → milestone.completed, once per milestone; a milestone that is
// not a requirements milestone also needs its acceptance ticket closed, and its summary ticket closed when it has work
// ponytail: scans all events for the mark; keep it in meta if the event table grows large
const milestoneDone: Handler = (e, v) => {
  if (!closing(e)) return [];
  const m = v.t.getTicket(e.ticket!).milestone, shut = (k: string) => { const x = ofKind(v, m, k); return !!x && !isOpen(x.status); };
  if (!m || v.ops.completion(m) < 100 || v.t.events().some((x) => x.kind === "milestone.completed" && x.data.id === m)) return [];
  if (!isReq(v, m) && !(shut("acceptance") && (!hasWork(v, m) || shut("summary")))) return [];
  return [{ kind: "log", event: "milestone.completed", data: { id: m } }];
};

// org-design.md §7: milestone.completed → the urgent breakdown ticket of the next milestone for TL; after the last
// milestone, the final acceptance ticket for BA. The final ticket goes into the last milestone: that milestone already
// completed (once per milestone), so milestoneDone ignores it, and it is active again until the ticket closes.
const BREAKDOWN = "Break down the milestone's scope into tickets with dependencies.";
export const FINAL = "Final acceptance: check the product against the business requirements.";
const nextStep: Handler = (e, v) => {
  if (e.kind !== "milestone.completed") return [];
  const ms = v.t.listMilestones(), i = ms.findIndex((m) => m.id === e.data.id), next = ms[i + 1];
  if (next) return ofKind(v, next.id, "breakdown") ? [] : [auto(`Break down ${next.name}`, "breakdown", next.id, who(v, "tl"), [who(v, "sa")], BREAKDOWN)];
  return ofKind(v, ms[i].id, "final") ? [] : [auto("Final acceptance", "final", ms[i].id, who(v, "ba"), [who(v, "sa")], FINAL)];
};

// org-design.md §13: milestone.completed → the runner tags main with the milestone id and pushes the tag
const tagMain: Handler = (e, v) =>
  e.kind === "milestone.completed" && !v.t.events().some((x) => x.kind === "git.tagged" && x.data.milestone === e.data.id) ? [{ kind: "tag", milestone: String(e.data.id) }] : [];

// org-design.md §7: the milestone's work closed (all but its acceptance, summary and final tickets) → the urgent
// acceptance ticket: TL checks, PM reviews; not in a requirements milestone
const SYSTEM = ["acceptance", "summary", "final"];
const ACCEPT = "Accept the milestone.";
const acceptance: Handler = (e, v) => {
  if (!closing(e)) return [];
  const m = v.t.getTicket(e.ticket!).milestone;
  if (!m || isReq(v, m) || ofKind(v, m, "acceptance") || inMs(v, m).some((x) => !SYSTEM.includes(x.kind) && isOpen(x.status))) return [];
  return [auto(`Accept ${nameOf(v, m)}`, "acceptance", m, who(v, "tl"), [who(v, "pm")], ACCEPT)];
};

// org-design.md §7: acceptance closed in a milestone with work → the urgent tech summary and repo cleanup for SA
const SUMMARY = "Update the tech summary and check the repo for runtime files.";
const summary: Handler = (e, v) => {
  if (!closing(e)) return [];
  const tk = v.t.getTicket(e.ticket!);
  if (tk.kind !== "acceptance" || !hasWork(v, tk.milestone) || ofKind(v, tk.milestone, "summary")) return [];
  return [auto(`Tech summary and repo cleanup after ${nameOf(v, tk.milestone)}`, "summary", tk.milestone, who(v, "sa"), [who(v, "tl")], SUMMARY)];
};

// org-design.md §7: the final acceptance closed → the human approves the end
const finalAsk: Handler = (e, v) => {
  if (!closing(e) || v.t.getTicket(e.ticket!).kind !== "final") return [];
  const final = v.t.getMeta<string>("final");
  if (final && v.t.getInbox(final).state === "open") return [];
  return [{ kind: "ask", text: "Final review: all milestones are complete. Approve to finish, or reject with what is missing.", files: DOCS, remember: "final" }];
};

// org-design.md §7: approve the final review → the org ends; reject → milestone "Plan change n"
const finalAnswered: Handler = (e, v) => {
  if (e.kind !== "inbox.answered" || e.data.id !== v.t.getMeta("final")) return [];
  if (e.data.approved) return [{ kind: "done" }];
  if (v.t.events(e.id).some((x) => x.kind === "milestone.created" && String(x.data.name).startsWith(PLAN_CHANGE))) return [];
  const n = v.t.listMilestones().filter((m) => m.name.startsWith(PLAN_CHANGE)).length + 1;
  return [{ kind: "milestone", name: `${PLAN_CHANGE} ${n}`, description: "Update the requirements and the roadmap from the final review" }];
};

// org-design.md §7: a new, empty "Plan change n" milestone gets the parent "Plan change" for BA; after its approval, a
// Roadmap ticket again (approvalAnswered)
const planChange: Handler = (e, v) => {
  if (e.kind !== "milestone.created" || !String(e.data.name).startsWith(PLAN_CHANGE)) return [];
  const id = String(e.data.id);
  if (v.t.listTickets({ milestone: id }).length) return [];
  return [{ kind: "create", input: { title: PLAN_CHANGE, kind: "requirements", status: "todo", milestone: id, assignee: who(v, "ba"), description: "Update the requirements and their summaries from the final review; the human approves them." } }];
};

// org-design.md §12.5: a new blocker stops the work and moves the ticket back to Todo
const newBlocker: Handler = (e, v) => {
  if (e.kind !== "relation.added" || e.data.kind !== "blocks") return [];
  const tk = v.t.getTicket(String(e.data.to));
  if (tk.status !== "in_progress" || tk.kind === "final" || !v.t.isBlocked(tk.id)) return [];
  return [...(tk.assignee ? [{ kind: "stop", member: tk.assignee, ticket: tk.id } as Command] : []), { kind: "todo", ticket: tk.id }];
};

export const handlers: Handler[] = [
  start, subTickets, chain, askApproval, approvalAnswered, closeRequirements, closeParent, merged, conflict, reviewBack, reviewDone,
  milestoneDone, nextStep, tagMain, acceptance, summary, finalAsk, finalAnswered, planChange, newBlocker, finalDefect,
];
