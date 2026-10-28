// Ticket operations with their guards (docs/org-design.md §3, §6, §8). Agents' tools, the human's CLI and
// the system all go through these, so a guard holds for every caller. Each op takes the actor (a member name, "user"
// or "org"), throws an Error when a guard fails, and returns a short result text.
import { isOpen } from "./types.ts";
import type { Milestone, Org, Priority, Role, Status, Ticket, TicketKind } from "./types.ts";
import type { TicketView, Tracker } from "./tracker.ts";
import { manager, neighbours } from "./config.ts";

export interface CreateInput {
  title: string; description?: string; label?: "bug" | "other"; priority?: Priority; parent?: string;
  assignee?: string; reviewers?: string[];
  status?: Status; kind?: TicketKind; milestone?: string; gate?: Ticket["gate"]; // the system only
}
export type Ops = ReturnType<typeof createOps>;

const STARTED: Status[] = ["in_progress", "in_review"];
// what to do when a ticket is in a status an op does not take
const CLOSED_NEXT = "It is closed; create a new ticket with ticket_create.";
const NEXT: Record<Status, string> = {
  triage: "PM decides on it first.", needs_reply: "It waits for an answer; end the session.", todo: "It waits until the system starts it.",
  in_progress: "Its assignee works on it; end the session.", in_review: "It waits for its reviewers; end the session.",
  done: CLOSED_NEXT, canceled: CLOSED_NEXT, duplicate: CLOSED_NEXT,
};
const WAIT = "wait until they are done and end the session";
const MINE = "work only on this session's ticket, then end the session";
const AUTO = "this happens automatically, do not call it";
const DROP = "drop one of the links";
const TRIAGE = "create a Triage ticket with ticket_create instead";
// owned documents (docs/org-design.md §4): only the owner changes them. Any path outside docs/ is code, reviewed by
// the TL in the author's reporting line, else any TL, else the SA.
export const OWNED: Record<string, Role> = { "docs/business-requirements.md": "ba", "docs/business-summary.txt": "ba", "docs/technical-requirements.md": "sa", "docs/tech-summary.txt": "sa" };
export const SUMMARY_CAP = 4000; // characters per summary file
const SUMMARIES = ["docs/business-summary.txt", "docs/tech-summary.txt"];
// tickets the system creates; a breakdown does not need reviewers on them
export const SYSTEM_KINDS: TicketKind[] = ["breakdown", "acceptance", "summary", "final", "roadmap", "requirements"];

// reviewRounds: the change requests on a ticket (since its last answer) before it goes to the reviewer's manager
export function createOps(t: Tracker, org: Org, o: { reviewRounds?: number } = {}) {
  const reviewRounds = o.reviewRounds ?? org.limits?.review_rounds ?? 3;
  const fail = (m: string): never => { throw new Error(m); };
  const system = (actor: string) => actor === "org" || actor === "user";
  // the system and the human pass role checks; the error names who to ask: a neighbour with the role, else the manager
  const need = (actor: string, roles: Role[], what: string) => {
    if (system(actor) || roles.includes(org.members[actor]?.role)) return;
    const ns = neighbours(org, actor), up = (r: Role[]) => r.map((x) => x.toUpperCase());
    const ask = ns.find((n) => roles.includes(org.members[n].role)) ?? manager(org, actor) ?? ns[0];
    fail(`only ${up(roles).join(" or ")} ${what}; this is ${up(roles).map((r) => `${r}'s`).join(" or ")} decision${ask ? `, ask ${ask}` : ""}`);
  };
  // "human": the person, wherever an assignee or a question's `to` may be the human
  const member = (m: string) => (m === "human" || m in org.members ? m : fail(`${m} is not a member; members: ${Object.keys(org.members).join(", ")}`));
  const inStatus = (id: string, allowed: Status[], verb: string): TicketView => {
    const tk = t.getTicket(id);
    if (!allowed.includes(tk.status)) fail(`${id} is ${tk.status}; only a ${allowed.join(" or ")} ticket can be ${verb}. ${NEXT[tk.status]}`);
    return tk;
  };
  const open = (id: string): Ticket => {
    const tk = t.getTicket(id);
    return isOpen(tk.status) ? tk : fail(`${id} is ${tk.status}; a closed ticket does not change. Create a new ticket with ticket_create.`);
  };
  const reason = (r: string) => r.trim() || fail("a reason is required; write in the reason field why");
  const reviewersOf = (id: string) => t.getTicket(id).approvals.map((a) => a.reviewer);
  const notSelf = (assignee: string | undefined, reviewers: string[]) => {
    const self = reviewers.find((r) => r === assignee);
    if (self) fail(`${self} cannot review its own ticket; choose another reviewer`);
  };
  const close = (id: string, status: Status, why: string, actor: string) => {
    t.addComment(id, why, actor);
    t.setStatus(id, status, actor);
  };
  // the grid (docs/org-design.md §6): a member asks only its neighbours; BA and SA (no manager) ask the human
  const reach = (actor: string, to: string) => {
    const ns = neighbours(org, actor), up = manager(org, actor);
    if (to === "human" ? up : !ns.includes(member(to))) fail(`${actor} cannot ask ${to}; ask ${up ?? ns[0]}`);
  };
  const answerer = (tk: Ticket, actor: string, what: string) => {
    if (tk.assignee !== actor && !(actor === "user" && tk.assignee === "human")) fail(`only ${tk.id}'s assignee ${what}; ${MINE}`);
  };
  // the breakdown's own tickets: still in Triage and blocked by it
  const own = (id: string, actor: string, breakdown: string): Ticket => {
    need(actor, ["tl"], "reworks a breakdown");
    const tk = t.getTicket(id);
    if (tk.status !== "triage" || !tk.relations.some((r) => r.kind === "blocks" && r.from === breakdown && r.to === id)) fail(`${id} is not a Triage ticket of ${breakdown}; change only the tickets this breakdown created`);
    return tk;
  };
  const toMilestone = (id: string, m: string, actor: string) => {
    t.getMilestone(m);
    t.setMilestone(id, m, actor);
    t.setStatus(id, "todo", actor);
  };

  // milestones: completion = done / (all − canceled − duplicate), started tickets count half; no tickets → 0
  const completion = (m: string): number => {
    const ts = t.listTickets({ milestone: m }).filter((x) => x.status !== "canceled" && x.status !== "duplicate");
    const done = ts.reduce((n, x) => n + (x.status === "done" ? 1 : STARTED.includes(x.status) ? 0.5 : 0), 0);
    return ts.length ? (done / ts.length) * 100 : 0;
  };
  const activeIndex = () => t.listMilestones().findIndex((m) => completion(m.id) < 100);
  const active = (): Milestone | undefined => t.listMilestones()[activeIndex()];
  const next = (): Milestone | undefined => { const i = activeIndex(); return i < 0 ? undefined : t.listMilestones()[i + 1]; };

  // true when `to` reaches `from` through blocking links
  const reaches = (to: string, from: string, seen = new Set<string>()): boolean => to === from || (!seen.has(to) && (seen.add(to), t.getTicket(to).relations.some((r) => r.kind === "blocks" && r.from === to && reaches(r.to, from, seen))));
  const ordOf = (m?: string) => t.listMilestones().findIndex((x) => x.id === m);

  // the ticket waits in Needs Reply for `to`; the answer returns it to status and assignee
  const park = (id: string, to: string, asker: string, note: string, actor: string, status: Status, assignee?: string) => {
    t.addComment(id, note, actor);
    t.setQuestion(id, { asker, status, assignee }, actor);
    t.setAssignee(id, to, actor);
    t.setStatus(id, "needs_reply", actor);
  };

  // --- review ---
  const withRole = (r: Role) => Object.keys(org.members).find((n) => org.members[n].role === r);
  // the TL in m's reporting line, else any TL, else the SA
  const tlFor = (m: string): string | undefined => {
    for (let x: string | undefined = m; x; x = manager(org, x)) if (org.members[x]?.role === "tl") return x;
    return withRole("tl") ?? withRole("sa");
  };
  const ownerOf = (file: string, author: string): string | undefined => {
    if (!file.startsWith("docs/")) return tlFor(author);
    return OWNED[file] && withRole(OWNED[file]);
  };
  const assigneeOnly = (tk: Ticket, actor: string, what: string) => { if (tk.assignee !== actor) fail(`only ${tk.id}'s assignee ${what}; ${MINE}`); };
  const pendingReviewer = (id: string, actor: string, verb: string) => {
    const tk = inStatus(id, ["in_review"], verb);
    if (!tk.approvals.some((a) => a.reviewer === actor && a.state === "pending")) fail(`${actor} has no pending review on ${id}; ${MINE}`);
  };
  // logs review.done once per review round: every reviewer approved
  // ponytail: scans all events; keep a per-ticket mark in meta if the event table grows large
  const reviewDone = (id: string) => {
    const tk = t.getTicket(id);
    if (tk.status !== "in_review" || !tk.approvals.length || tk.approvals.some((a) => a.state !== "approved")) return;
    for (const e of t.events().reverse().filter((x) => x.ticket === id)) {
      if (e.kind === "review.done") return;
      if (e.kind === "ticket.status" && e.data.to === "in_review") break;
    }
    t.log("review.done", "org", {}, id);
  };

  // checked: the caller already passed the role check (set_dependencies)
  const addLink = (from: string, to: string, kind: "blocks" | "related", actor: string, checked = false): string => {
    if (from === to) fail("a ticket cannot link to itself");
    const [a, b] = [t.getTicket(from), t.getTicket(to)];
    if (kind === "blocks") {
      if (!checked) need(actor, ["pm", "sa"], "manages blocking links");
      if (reaches(to, from)) fail(`${from} blocks ${to} would make a cycle; ${DROP}`);
      if (a.milestone && b.milestone && ordOf(a.milestone) > ordOf(b.milestone)) fail(`${from} is in a later milestone (${a.milestone}) than ${to} (${b.milestone}). A ticket cannot wait for a later milestone; drop the link or ask PM to move a ticket`);
    }
    t.addRelation(from, to, kind, actor);
    return `${from} ${kind === "blocks" ? "blocks" : "relates to"} ${to}`;
  };

  return {
    completion, active, next,

    // files: the changed files; size: a file's length in characters; summary: what was done, used and decided
    submit(id: string, actor: string, o: { files?: string[]; size?: (file: string) => number; summary?: string } = {}): string {
      const tk = inStatus(id, ["in_progress"], "submitted");
      assigneeOnly(tk, actor, "submits");
      const summary = o.summary?.trim() || fail("summary is required: what you did, what you used, what you decided");
      const b = t.blockers(id);
      if (b.length && tk.kind === "final") {
        t.setSummary(id, summary, actor);
        t.setStatus(id, "todo", actor);
        return `${id} waits for ${b.map((x) => x.id).join(", ")}; it is in Todo until they close`;
      }
      if (b.length) fail(`${id} is blocked by ${b.map((x) => x.id).join(", ")}; ${WAIT}`);
      if (t.children(id).some((c) => isOpen(c.status))) fail(`${id} has open sub-tickets; ${WAIT}`);
      for (const f of o.files ?? []) {
        if (OWNED[f] && OWNED[f] !== org.members[actor]?.role) fail(`${f} belongs to ${OWNED[f].toUpperCase()}; revert your change to it`);
        const n = SUMMARIES.includes(f) ? o.size?.(f) ?? 0 : 0;
        if (n > SUMMARY_CAP) fail(`${f} has ${n} characters; the cap is ${SUMMARY_CAP}. Shorten it.`);
      }
      const revs = reviewersOf(id), add = (r?: string) => { if (r && r !== actor && !revs.includes(r)) revs.push(r); };
      if (!revs.length) add(manager(org, actor));
      if (org.members[actor]?.role === "dev" && !revs.some((r) => ["tl", "sa"].includes(org.members[r]?.role))) add(tlFor(actor));
      for (const f of o.files ?? []) add(ownerOf(f, actor));
      if (!revs.length) fail(`${id} has no reviewer; ask who reviews it with ask`);
      t.setSummary(id, summary, actor);
      for (const r of revs) t.setApproval(id, r, "pending", actor);
      t.setStatus(id, "in_review", actor);
      return `submitted ${id} for review by ${revs.join(", ")}`;
    },

    approve(id: string, actor: string): string {
      pendingReviewer(id, actor, "approved");
      t.setApproval(id, actor, "approved", actor);
      reviewDone(id);
      return `approved ${id}`;
    },

    requestChanges(id: string, findings: string[], actor: string): string {
      pendingReviewer(id, actor, "reviewed");
      const fs = findings.filter((f) => f.trim());
      if (!fs.length) fail("findings must not be empty; write one problem per item in findings, or approve");
      t.addComment(id, `${actor} requests changes:\n${fs.map((f, i) => `${i + 1}. ${f.trim()}`).join("\n")}`, actor);
      t.setApproval(id, actor, "changes", actor);
      // change requests since the last answer (a cleared question)
      let n = 0;
      for (const e of t.events().reverse().filter((x) => x.ticket === id)) {
        if (e.kind === "ticket.question" && e.data.cleared) break;
        if (e.kind === "approval.set" && e.data.state === "changes") n++;
      }
      if (n >= reviewRounds) {
        const tk = t.getTicket(id), up = manager(org, actor);
        park(id, up ?? "human", up ? actor : "org", `${actor} requested changes ${n} times; the review does not converge. Last findings:\n${fs.map((f, i) => `${i + 1}. ${f.trim()}`).join("\n")}\nAnswer with a decision; the ticket goes back to ${tk.assignee} in progress.`, actor, "in_progress", tk.assignee);
        return `requested changes on ${id}: ${fs.length} findings; round ${n} of ${reviewRounds}, so it goes to ${up ?? "the human"}`;
      }
      t.setStatus(id, "in_progress", actor);
      return `requested changes on ${id}: ${fs.length} findings`;
    },

    // a question: the ticket goes to `to` in Needs Reply and comes back to its status and assignee with the answer
    ask(id: string, to: string, question: string, actor: string): string {
      const tk = inStatus(id, ["in_progress", "in_review", "triage"], "asked about");
      if (tk.status === "triage") need(actor, ["pm"], "asks about a Triage ticket");
      else if (tk.status === "in_progress") assigneeOnly(tk, actor, "asks");
      else pendingReviewer(id, actor, "asked about");
      const q = question.trim() || fail("a question is required; write what you need to know in question");
      reach(actor, to);
      t.addComment(id, `${actor} asks ${to}: ${q}`, actor);
      t.setQuestion(id, { asker: actor, status: tk.status, assignee: tk.status === "triage" ? undefined : tk.assignee }, actor);
      t.setAssignee(id, to, actor);
      t.setStatus(id, "needs_reply", actor);
      return `asked ${to} on ${id}; end the session, the answer comes back on the ticket`;
    },

    // an empty answer from the human means "try again"
    answer(id: string, text: string, actor: string): string {
      const tk = inStatus(id, ["needs_reply"], "answered");
      answerer(tk, actor, "answers");
      const a = text.trim() || (actor === "user" ? "try again" : fail("an answer is required; write it in text"));
      const status = tk.return_status ?? "in_progress";
      t.addComment(id, `${actor} answers: ${a}`, actor);
      t.setAssignee(id, tk.return_assignee ?? null, actor);
      t.setStatus(id, status, actor);
      t.setQuestion(id, null, actor);
      return `answered ${id}; it is ${status} again`;
    },

    forward(id: string, to: string, actor: string): string {
      const tk = inStatus(id, ["needs_reply"], "forwarded");
      answerer(tk, actor, "forwards");
      if (to === tk.asker) fail("the asker cannot answer its own question");
      reach(actor, to);
      t.addComment(id, `${actor} forwards to ${to}`, actor);
      t.setAssignee(id, to, actor);
      return `forwarded ${id} to ${to}`;
    },

    // the no-op cap: the ticket waits for the human; the human's answer returns it
    parkForHuman(id: string, note: string, actor = "org"): string {
      const tk = open(id);
      if (tk.status === "needs_reply" && tk.assignee === "human") fail(`${id} already waits for the human`);
      park(id, "human", "org", note, actor, tk.status, tk.assignee);
      return `${id} waits for the human`;
    },

    conflictBack(id: string, files: string[], actor = "org"): string {
      open(id);
      t.addComment(id, `main changed ${files.join(", ")} since your branch; MAIHEM merges main into your branch at your next session`, actor);
      t.setStatus(id, "in_progress", actor);
      return `moved ${id} back to in_progress: merge conflict`;
    },

    // --- milestones: the roadmap (PM, or the system) ---
    createMilestone(name: string, description: string, actor: string): string {
      need(actor, ["pm"], "creates milestones");
      return `created milestone ${t.createMilestone(name, description, actor).id}`;
    },

    updateMilestone(id: string, p: { name?: string; description?: string }, actor: string): string {
      need(actor, ["pm"], "updates milestones");
      if (p.name === undefined && p.description === undefined) throw new Error("give a name or a description");
      if (t.events().some((x) => x.kind === "milestone.completed" && x.data.id === id)) fail(`${id} is done; plan new requirement ids in a new milestone`);
      t.updateMilestone(id, p, actor);
      return `updated ${id}`;
    },

    reorderMilestones(ids: string[], actor: string): string {
      need(actor, ["pm"], "reorders milestones");
      const all = t.listMilestones().map((x) => x.id);
      if (ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((x) => all.includes(x))) fail("reorder needs every milestone id exactly once; milestone_list shows them");
      t.reorderMilestones(ids, actor);
      return `milestones: ${ids.join(", ")}`;
    },

    deleteMilestone(id: string, actor: string): string {
      need(actor, ["pm"], "deletes milestones");
      if (t.listTickets({ milestone: id }).length) fail(`${id} has tickets; only an empty milestone can be deleted`);
      t.deleteMilestone(id, actor);
      return `deleted milestone ${id}`;
    },

    // --- system moves (the bus) ---
    closeTicket(id: string, actor: string): string {
      if (actor !== "org") fail(`only the system closes tickets; ${AUTO}`);
      open(id);
      t.setStatus(id, "done", actor);
      return `closed ${id}`;
    },

    reopenToTodo(id: string, actor: string): string {
      if (actor !== "org") fail(`only the system moves work back to Todo; ${AUTO}`);
      const tk = inStatus(id, ["in_progress", "in_review"], "moved back");
      if (!t.isBlocked(id)) fail(`${id} is not blocked`);
      if (tk.status === "in_review") for (const a of tk.approvals) t.setApproval(id, a.reviewer, "pending", actor);
      t.setStatus(id, "todo", actor);
      return `moved ${id} back to todo`;
    },

    // breakdown: the TL's breakdown ticket; the new ticket goes to Triage with its milestone, blocked by the breakdown
    create(f: CreateInput, actor: string, opts: { breakdown?: string } = {}): string {
      const sys = actor === "org";
      if (!sys && (f.status || f.kind || f.gate || f.milestone)) fail(`only the system sets status, kind, gate or milestone at creation; ${AUTO}`);
      if (!sys && f.assignee !== undefined) need(actor, ["pm"], "assigns");
      if (!sys && f.reviewers !== undefined) need(actor, ["pm"], "sets reviewers");
      if (f.assignee !== undefined) member(f.assignee);
      f.reviewers?.forEach(member);
      let status: Status = "triage", milestone: string | undefined, priority = f.priority ?? 0, assignee = f.assignee, reviewers = f.reviewers ?? [];
      if (f.parent) {
        const p = open(f.parent);
        if (p.parent) fail(`${p.id} is a sub-ticket; a sub-ticket has no sub-tickets. Create a Triage ticket with ticket_create instead`);
        if (!system(actor) && org.members[actor]?.role !== "pm" && p.assignee !== actor) fail(`only PM or ${p.id}'s assignee creates its sub-tickets; ${TRIAGE}`);
        [status, milestone, priority, assignee, reviewers] = ["todo", p.milestone, f.priority ?? p.priority, f.assignee ?? p.assignee, f.reviewers ?? reviewersOf(p.id)];
      }
      if (opts.breakdown) {
        need(actor, ["tl"], "breaks a milestone down");
        const p = t.getTicket(opts.breakdown);
        if (p.kind !== "breakdown") fail(`${p.id} is not a breakdown ticket; this works only in a breakdown session`);
        milestone = p.milestone; // Triage: PM accepts it with an assignee and reviewers
      }
      notSelf(assignee, reviewers);
      const tk = t.createTicket({ title: f.title, description: f.description, label: f.label, priority, parent: f.parent, assignee, status: f.status ?? status, milestone: f.milestone ?? milestone, kind: f.kind, gate: f.gate }, actor);
      for (const r of reviewers) t.setApproval(tk.id, r, "pending", actor);
      if (opts.breakdown) t.addRelation(opts.breakdown, tk.id, "blocks", actor);
      return `created ${tk.id} in ${tk.status}`;
    },

    accept(id: string, actor: string, o: { milestone?: string; priority?: Priority; assignee?: string } = {}): string {
      need(actor, ["pm"], "accepts");
      inStatus(id, ["triage"], "accepted");
      const m = o.milestone || fail("accept needs a milestone; milestone_list shows them");
      t.getMilestone(m);
      const a = member(o.assignee || fail("accept needs an assignee; name the member who does the work"));
      // the grid sets the reviewer: DEV -> its TL, BA -> SA, SA -> BA; TL and PM change no files
      const role = org.members[a]?.role;
      if (!["dev", "ba", "sa"].includes(role)) fail(`${a} is ${a === "human" ? "the human" : role.toUpperCase()}; TL and PM change no files, so the assignee is a DEV, BA or SA`);
      const r = role === "dev" ? manager(org, a) ?? tlFor(a) : withRole(role === "ba" ? "sa" : "ba");
      const revs = r ? [r] : fail(`${a} has no reviewer on the grid; add a ${role === "dev" ? "TL" : role === "ba" ? "SA" : "BA"} to the org`);
      if (o.priority !== undefined) t.setPriority(id, o.priority, actor);
      t.setAssignee(id, a, actor);
      for (const r of revs) t.setApproval(id, r, "pending", actor);
      toMilestone(id, m, actor);
      return `accepted ${id}: todo in ${m} for ${a}, reviewed by ${revs.join(", ")}`;
    },

    reject(id: string, why: string, actor: string): string {
      need(actor, ["pm"], "rejects");
      inStatus(id, ["triage"], "rejected");
      close(id, "canceled", reason(why), actor);
      return `rejected ${id}`;
    },

    duplicate(id: string, of: string, actor: string): string {
      need(actor, ["pm"], "marks duplicates");
      inStatus(id, ["triage"], "marked as a duplicate");
      if (id === of) fail("a ticket cannot duplicate itself");
      t.addRelation(id, of, "duplicate", actor);
      t.setStatus(id, "duplicate", actor);
      return `marked ${id} as a duplicate of ${of}`;
    },

    editOwn(id: string, f: { title?: string; description?: string }, actor: string, breakdown: string): string {
      own(id, actor, breakdown);
      if (f.title !== undefined) t.setTitle(id, f.title, actor);
      if (f.description !== undefined) t.setDescription(id, f.description, actor);
      return `edited ${id}`;
    },

    dropOwn(id: string, actor: string, breakdown: string): string {
      own(id, actor, breakdown);
      close(id, "canceled", "dropped by the breakdown", actor);
      return `dropped ${id}`;
    },

    start(id: string, actor: string): string {
      if (actor !== "org") fail(`only the system starts work; ${AUTO}`);
      const tk = inStatus(id, ["todo"], "started");
      const b = t.blockers(id);
      if (b.length) fail(`${id} is blocked by ${b.map((x) => x.id).join(", ")}; ${WAIT}`);
      const a = active();
      if (!a || tk.milestone !== a.id) fail(`${id} is not in the active milestone ${a?.id ?? "(none)"}`);
      if (t.children(id).some((c) => isOpen(c.status))) fail(`${id} has open sub-tickets; ${WAIT}`);
      t.setStatus(id, "in_progress", actor);
      return `started ${id}`;
    },

    // PM or the human
    cancel(id: string, why: string, actor: string): string {
      need(actor, ["pm"], "cancels");
      open(id);
      const r = reason(why);
      const blocked = t.getTicket(id).relations.find((x) => x.kind === "blocks" && x.from === id && isOpen(t.getTicket(x.to).status));
      if (blocked) fail(`${id} blocks ${blocked.to}; remove the link first`);
      close(id, "canceled", r, actor);
      return `canceled ${id}`;
    },

    setPriority(id: string, priority: Priority, actor: string): string {
      const tk = open(id);
      if (!(tk.status === "triage" && tk.owner === actor)) need(actor, ["pm"], "changes priority");
      if (![0, 1, 2, 3, 4].includes(priority)) fail("priority must be 0 (none) to 4 (urgent)");
      t.setPriority(id, priority, actor);
      return `${id} priority ${priority}`;
    },

    // the human reassigns; the status stays
    assign(id: string, m: string, actor: string): string {
      if (!system(actor)) fail("only the human assigns: maihem org assign");
      open(id);
      notSelf(member(m), reviewersOf(id));
      t.setAssignee(id, m, actor);
      return `assigned ${id} to ${m}`;
    },

    link: addLink,

    // map: ticket → the tickets it waits for. Replaces the blocking links among the milestone's tickets; the links
    // from the breakdown ticket and out of the milestone stay. The new graph is checked for a cycle before any write.
    setDependencies(map: Record<string, string[]>, actor: string, breakdown: string): string {
      need(actor, ["tl"], "sets dependencies");
      const p = t.getTicket(breakdown);
      if (p.kind !== "breakdown") fail(`${breakdown} is not a breakdown ticket; this works only in a breakdown session`);
      const own = new Set(t.listTickets({ milestone: p.milestone }).map((x) => x.id).filter((x) => x !== breakdown));
      for (const x of new Set(Object.entries(map).flat(2))) if (!own.has(x)) fail(`${x} is not a ticket of ${p.milestone}; use only tickets of ${p.milestone} (ticket_list milestone ${p.milestone})`);
      const kept = (x: string) => t.getTicket(x).relations.filter((r) => r.kind === "blocks" && r.from === x && !(own.has(x) && own.has(r.to))).map((r) => r.to);
      const out = (x: string) => [...kept(x), ...Object.keys(map).filter((k) => map[k].includes(x))];
      const seen = new Map<string, "open" | "done">();
      const cyclic = (x: string): boolean => {
        if (seen.has(x)) return seen.get(x) === "open";
        seen.set(x, "open");
        const c = out(x).some(cyclic);
        seen.set(x, "done");
        return c;
      };
      if ([...own].some(cyclic)) fail(`the dependencies make a cycle; ${DROP}`);
      for (const x of own) for (const r of t.getTicket(x).relations) if (r.kind === "blocks" && r.from === x && own.has(r.to)) t.removeRelation(x, r.to, "blocks", actor);
      for (const [k, bs] of Object.entries(map)) for (const b of bs) addLink(b, k, "blocks", actor, true);
      return `dependencies set: ${Object.entries(map).map(([k, bs]) => `${k} after ${bs.join(", ")}`).join("; ")}`;
    },

    unlink(from: string, to: string, kind: "blocks" | "related", actor: string): string {
      if (kind === "blocks") need(actor, ["pm", "sa"], "manages blocking links");
      t.removeRelation(from, to, kind, actor);
      return `removed ${from} ${kind === "blocks" ? "blocks" : "relates to"} ${to}`;
    },
  };
}
