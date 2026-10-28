// Prompts in code (docs/org-design.md §5, §11): the role card per grid cell, the process rules per session kind, the
// context each role loads at session start, and the generated digests. The definition's own `system` follows the role card under # Style.
import type { Definition } from "../definition.ts";
import { manager, neighbours } from "./config.ts";
import { outcome, showMain, tree } from "./git.ts";
import { PLAN_CHANGE } from "./flow.ts";
import { SYSTEM_KINDS } from "./ops.ts";
import { DIFF_KINDS, fileToolsFor } from "./tools.ts";
import { CLOSED, LEVEL, STATUSES, TRACK, isOpen } from "./types.ts";
import type { Milestone, Org, Role, Ticket, TicketKind, Wake } from "./types.ts";
import type { TicketView, Tracker } from "./tracker.ts";

type Kind = Wake["kind"];
const up = (r: string) => r.toUpperCase();
const PRIORITY = ["none", "low", "medium", "high", "urgent"];
const BR = "docs/business-requirements.md", BS = "docs/business-summary.txt", TR = "docs/technical-requirements.md", TS = "docs/tech-summary.txt";
const MDIFF = "milestone_diff shows what the milestone changed; use it with path for a single file.";
const TITLE: Record<string, string> = { [BR]: "Business requirements", [BS]: "Business summary", [TR]: "Technical requirements", [TS]: "Tech summary" };
const PATH: Record<Role, string> = { ba: "PM → BA → human", pm: "PM → BA → human", sa: "DEV → TL → SA → human", tl: "DEV → TL → SA → human", dev: "DEV → TL → SA → human" };
const CAP = "under 4000 characters";

// the role cards (docs/org-design.md §3, §11): what the cell owns, decides, reviews and never does
const CARD: Record<Role, () => string> = {
  ba: () => `Owns: ${BR}, ${BS} and the final acceptance (the business verdict).
Decides: what the product must do and why. You speak for the customer.
Reviews: SA's documents and the roadmap coverage.
Never write code, technical requirements or the tech summary. Never create milestones or assign tickets.
Keep the summary in step with the full document. Other roles know the business only from your documents.`,
  sa: () => `Owns: ${TR}, ${TS} and the repo check after each milestone (.gitignore, no runtime data).
Decides: the tech stack, the architecture and the design answers.
Reviews: BA's documents, every milestone breakdown, the final acceptance (technical check).
Never write business requirements or product code.
Keep the summary in step with the full document. Other roles know the design only from your documents.
Name commands that run on this host. The summary ticket after each milestone runs them with exec.
Name the setting that moves the app's data for tests (an env var or a flag). Every check runs the app with it.
Ask the human before a change of the stack or of a key decision.`,
  pm: () => `Owns: the roadmap (the milestones in the tracker), Triage, priority and assignment.
Decides: Triage (accept into a milestone with an assignee, reject, duplicate) and priority.
Reviews: the business side of each milestone acceptance.
Create tickets only for defects you find in an acceptance review. Never write files or code.`,
  tl: () => `Owns: the breakdown of each milestone into tickets and their dependencies; the technical milestone acceptance.
Decides: how a milestone splits into tickets and in which order.
Reviews: every DEV ticket (run the checks, read the diff), the roadmap feasibility and order, the tech summary after each milestone.
Never write code.`,
  dev: () => `Owns: the code of one ticket, its tests and its documentation.
Decides: how to build the ticket inside its acceptance criteria.
Build only what the acceptance criteria ask. Other requirements have their own tickets; do not build them ahead.
Never read or look for the business documents. The acceptance criteria carry the business needs.
Never change the requirement documents or the summaries.`,
};

// the work rules for sessions that change files (the definition has write or edit)
const FILE_RULES = `- MAIHEM creates the branch and commits for you. Never run git.
- In the summary also name what you used (files, modules, commands).
- Delete scratch files (test inputs, outputs, temporary scripts) before you submit; the review rejects stray files.
- When a comment lists files with conflict markers: resolve the markers in those files, then submit. MAIHEM merges main for you.`;
const TRUST = "- Your task text holds your context. Trust it: do not read a document, ticket or list again with tools when the task shows it.";
const PAR = "- Call independent tools in one step.";
const RT = "runtime data (databases, logs, backups, caches)";
const CLEAN = { dev: `- Keep the repo clean: no ${RT} in git. Manage .gitignore.`, review: `- Request changes when ${RT} is in git or .gitignore misses it.`, breakdown: `- Plan .gitignore in the structure ticket: no ${RT} in git.` };
const IDS = "Milestone ids are fixed tracker ids, not positions; the order of the list is the roadmap order. Do not request id changes.";
const RULES: Record<Kind, string> = {
  triage: `# Triage
One session triages the whole batch in the task. Handle each ticket:
- accept with a milestone (the active one when it must be done now, else a later one), a priority and an assignee (a DEV, BA or SA). The system sets the reviewer by the grid.
- reject with a reason, or duplicate when another ticket covers it.
- Give a chain of dependent tickets to one member. Give DEV tickets to devs. Prefer the member with fewer open tickets.
- When you need an answer before you decide, ask BA (business) or TL (technical) with ask on that ticket; go on with the others; the ticket comes back to Triage with the answer.
- Do not create tickets. End with a short summary of what you did.
${TRUST}
${PAR}`,
  work: `# Work
- Work only on this ticket. Other work gets its own ticket.
${TRUST}
- When the work is done, call submit_review. Your session ends.
- submit_review takes a summary: one or two sentences on the ticket's whole change on the branch and the decisions you made. A verdict (acceptance, final) follows the format in your task.
- When a reviewer requested changes: fix each finding from the comments, then submit. When a finding is already fixed or wrong, say so in the summary and change nothing for it.
- A new idea or a bug: ticket_create. It goes to Triage.
- When you need an answer, ask one grid neighbour with ask; your session ends; you get the answer in the comments when the ticket comes back.
- Never put a question in your final text; a question goes through ask.
- An answer cannot run commands. Do not ask others to run anything; run it yourself, or ask for a decision.
${PAR}`,
  review: `# Review
- Check the change against the ticket and the context in your task.
- Approve when the change does what the ticket asks.
- Otherwise request_changes with the findings as a numbered list, one finding per item.
- Before you repeat a finding, check it against the current ticket text and diff. Drop it when it is fixed.
- Request changes only for a defect against the ticket or the requirements. Wording, format and citation style are not defects.
- Ask when you need an answer before you decide.
- Request only changes the author can make with its tools. The context the system shows is not editable.
${TRUST}
${PAR}`,
  reply: `# Reply
- Answer the question in the comments with answer.
- Use the fewest tool calls. Never run git. Never look into another member's worktree.
- When you cannot answer, forward the question to the neighbour who can, or to the human.
- Do not change tickets or files in this session.
${TRUST}
${PAR}`,
};

// the code-review rules: only for reviews of tickets with a diff (DIFF_KINDS)
// req: a requirements review (the documents are in the task); sum: the tech summary review
const codeReview = (exec: boolean, req: boolean, sum: boolean) => ["# Change review",
  req ? "- The documents in this task are the branch version. Call review_diff only to see what an update changed." : "- Call review_diff.",
  ...(req || sum ? [`- The documents and their summary files exist, match each other, and each summary file stays ${CAP}.`] : []),
  ...(exec ? ["- Run the checks that the tech summary names (tests and others)."] : []),
  "- Check the summary of the work against the diff. The diff is the truth. Request changes when the summary of the work is wrong or misses a change.",
  "- Request changes for stray files in the diff: test inputs, outputs, scratch scripts.",
  ...(req || sum ? [] : ["- Check each acceptance criterion: the diff or a check must show it is met. Request changes for each one that is not."])].join("\n");

const WRITING = `# Writing
Write replies and documentation "80% of the way to ASD-STE100" (Simplified Technical English): short sentences (about 20 words max), one idea per sentence, active voice, present tense, one approved meaning per word, no idioms, no filler. Do not go full STE: keep natural phrasing and domain terms where strict STE would read awkwardly.`;

const HOW = `# How MAIHEM works
- MAIHEM runs this org. It wakes a member when a ticket's status needs that member. A session is one member on one ticket (PM triage takes a batch). It ends when you call a stop tool; the rules below name yours.
- You have no memory between sessions. The ticket (description, comments, summary) and the documents carry everything. Your task text is built from the tracker and main when the session starts.
- Your ticket tools are the moves that the ticket's status allows. A ticket tool you do not have is not your move.
- Statuses: Triage → Todo → In Progress → In Review → Done. Needs Reply holds a question; the answer returns the ticket to its status and assignee. Canceled and Duplicate close a ticket.
- Git: each ticket has a branch and a worktree. MAIHEM commits your work when the session ends and squash-merges it into main when every reviewer approves. A merge conflict comes back as a comment.
- MAIHEM does these itself; never ask for them: branches, commits, merges, milestone tags, the system tickets (breakdown, acceptance, summary, final), and the blocker from a breakdown to each of its tickets.
- The human sits above BA and SA. The human approves the requirements and the final result, and answers what the grid cannot.`;

export function systemFor(o: { org: Org; member: string; goal: string; defs: Record<string, Definition>; kind: Kind; milestone?: Milestone; ticketKind?: TicketKind; req?: boolean }): string {
  const ms = o.org.members, role = ms[o.member].role;
  const name = (r: Role) => Object.keys(ms).find((n) => ms[n].role === r) ?? r;
  const cell = (r: Role) => `${up(r)} (${TRACK[r]} track)`;
  const tri = o.kind === "triage", bare = tri || role === "pm"; // these tasks have the roadmap; the grid and the documents do not help them
  const head = [
    "# Org",
    `You are ${o.member}, the ${up(role)} of the org "${o.org.name}".`,
    `Goal: ${o.goal}`,
    ...(o.milestone && role !== "pm" ? [`Active milestone: ${o.milestone.id} ${o.milestone.name}`] : []),
    "Members:",
    ...Object.entries(ms).map(([n, x]) => {
      const d = n === o.member ? undefined : o.defs[x.definition]?.description; // the role card covers the own member
      return `- ${n} (${up(x.role)}, reports to ${manager(o.org, n) ?? "the human"})${d ? `: ${d}` : ""}`;
    }),
    ...(bare ? [] : ["The grid: each role sits in one cell. The level sets the scope. The track sets the content.",
    `- Strategic level (the whole product): ${cell("ba")}, ${cell("sa")}`,
    `- Project level (all milestones): ${cell("pm")}, ${cell("tl")}`,
    `- Cycle level (one task inside a milestone): ${cell("dev")}`]),
    ...(role === "dev" || bare ? [] : [`Documents: ${[BR, BS, TR, TS].map((f) => `${f} (${f === BR || f === BS ? "BA" : "SA"})`).join(", ")}. Only the owner writes them. Code: TL reviews it.`]),
  ].join("\n");
  const nb = neighbours(o.org, o.member), talk = nb.map((n) => `${n} (${up(ms[n].role)})`).join(", ");
  const boss = manager(o.org, o.member) ?? "the human";
  const card = [
    `# Your role\n${up(role)}: ${LEVEL[role]} level, ${TRACK[role]} track.`,
    CARD[role](),
    `Talks to: ${talk}. Anything else goes through ${nb.length === 1 ? nb[0] : "one of them"}.`,
    role === "pm" ? `Questions: business to ${name("ba")} (it forwards to the human); technical to ${name("tl")}.`
      : role === "tl" ? `Questions: technical to ${boss} (it forwards to the human); business to ${name("pm")}.`
      : boss === "the human" ? "Questions: ask the human." : `Questions: ask ${boss}; it forwards along the grid: ${PATH[role]}.`,
  ].join("\n");
  const def = o.defs[ms[o.member].definition], ft = fileToolsFor(role, o.kind, def?.tools ?? [], o.ticketKind, o.req), files = ft.some((x) => x === "write" || x === "edit");
  // PM has no creation tools in a work session (org/tools.ts): drop the lines that name them
  let rules = role === "pm" ? RULES[o.kind].split("\n").filter((l) => !l.includes("ticket_create")).join("\n") : RULES[o.kind];
  if (o.kind === "reply") { // the human only above BA and SA; git and worktrees only with file tools
    if (role === "dev") rules = rules.replace(/- When you cannot answer, forward.*/, "- When you cannot answer, say so with answer.");
    else if (boss !== "the human") rules = rules.replace(", or to the human.", `; ${boss} when unsure.`);
    if (!ft.length) rules = rules.replace(" Never run git. Never look into another member's worktree.", "");
  }
  const fr = ft.includes("exec") ? FILE_RULES.replace("those files, then", "those files, run the checks, then").replace("- Delete scratch", "- Run the checks that the tech summary names (tests and others) before you submit.\n- Delete scratch") : FILE_RULES;
  // DEV work, TL reviews and the TL breakdown keep the repo free of runtime data
  const clean = role === "dev" && o.kind === "work" ? CLEAN.dev : role !== "tl" ? "" : o.kind === "review" ? CLEAN.review : o.kind === "work" && o.ticketKind === "breakdown" ? CLEAN.breakdown : "";
  if (clean) rules += `\n${clean}`;
  const style = def?.system?.trim();
  return [WRITING, head, HOW, card, style && `# Style\n${style}`, files ? `${rules}\n${fr}` : rules].filter(Boolean).join("\n\n");
}

export function ticketText(v: TicketView, t: Tracker): string {
  const out = (k: string) => v.relations.filter((r) => r.kind === k && r.from === v.id).map((r) => r.to);
  const related = v.relations.filter((r) => r.kind === "related").map((r) => (r.from === v.id ? r.to : r.from));
  const blockers = t.blockers(v.id).map((b) => b.id);
  const fields = [
    `kind ${v.kind}`, `label ${v.label}`, `priority ${PRIORITY[v.priority]}`,
    v.milestone && `milestone ${v.milestone}`,
    v.assignee && `assignee ${v.assignee}`,
    v.approvals.length && `reviewers ${v.approvals.map((a) => `${a.reviewer} (${a.state})`).join(", ")}`,
    blockers.length && `blocked by ${blockers.join(", ")}`,
    out("blocks").length && `blocks ${out("blocks").join(", ")}`,
    related.length && `related ${related.join(", ")}`,
    out("duplicate").length && `duplicate of ${out("duplicate").join(", ")}`,
    v.parent && `parent ${v.parent}`,
  ].filter(Boolean).join(" · ");
  const kids = t.children(v.id);
  // a breakdown ticket shows its milestone's live tickets with their blockers and descriptions, so its reviewers see the plan
  const plan = v.kind === "breakdown" && v.milestone ? t.listTickets({ milestone: v.milestone }).filter((x) => x.id !== v.id && x.status !== "canceled" && x.status !== "duplicate").map((x) => {
    const by = t.blockers(x.id).map((b) => b.id).filter((b) => b !== v.id);
    return `${x.id} [${x.status}] ${x.title}${by.length ? `; blocked by: ${by.join(", ")}` : ""}${x.description ? `\n${x.description.replace(/^/gm, "  ")}` : ""}`;
  }) : [];
  return [
    `${v.id} [${v.status}] ${v.title}`,
    fields,
    kids.length ? `sub-tickets: ${kids.map((k) => `${k.id} [${k.status}] ${k.title}`).join(", ")}` : "",
    v.description,
    plan.length ? `Tickets of ${v.milestone}:\nMAIHEM blocks every ticket below by this breakdown until it is approved; 'blocked by' shows only the other blockers.\n${plan.join("\n")}` : "",
    v.summary ? `Summary of the work:\n${v.summary}` : "",
    v.comments.length ? `Comments:\n${comments(v.comments).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

// why an open ticket waits (docs/org-design.md §10)
function reasons(t: Tracker, x: Ticket): string[] {
  const v = t.getTicket(x.id), by = t.blockers(x.id).map((b) => b.id), pend = v.approvals.filter((a) => a.state === "pending").map((a) => a.reviewer);
  const out = [
    by.length ? `blocked by ${by.join(", ")}` : "",
    x.assignee ? "" : "has no assignee",
    x.status === "in_review" && pend.length ? `waits for review by ${pend.join(", ")}` : "",
    x.status === "needs_reply" ? `waits for a reply by ${x.assignee}` : "",
  ].filter(Boolean);
  if (out.length) return out;
  return [x.status === "todo" ? `waits for ${x.assignee} to start` : x.status === "in_review" ? "waits for the merge" : `${x.status.replace("_", " ")} by ${x.assignee}`];
}

// the first milestone below 100 % completion, as ops.active() computes it
const active = (t: Tracker) => t.listMilestones().find((m) => {
  const ts = t.listTickets({ milestone: m.id }).filter((x) => x.status !== "canceled" && x.status !== "duplicate");
  return !ts.length || ts.some((x) => x.status !== "done");
});
const roadmap = (t: Tracker) => `# Roadmap\n${t.listMilestones().map((m) => `${m.id === active(t)?.id ? "(active) " : ""}${m.id} ${m.name}${m.description ? `: ${m.description}` : ""}`).join("\n") || "(no milestones yet)"}`;

// the open Triage tickets, descriptions cut at n characters
const triageList = (open: Ticket[], label = false, n = 300) => open.filter((x) => x.status === "triage")
  .map((x) => `- ${x.id} ${x.title} (${[label ? `label ${x.label}` : x.label === "bug" && "bug", `from ${x.owner}`].filter(Boolean).join(", ")}): ${x.description.slice(0, n)}`).join("\n") || "(empty)";

// the PM's board: Triage, open tickets by status with what each waits for
function board(t: Tracker, n?: number): string {
  const open = t.listTickets().filter((x) => isOpen(x.status)), a = active(t);
  const groups = STATUSES.filter((s) => s !== "triage" && !CLOSED.includes(s)).map((s) => {
    const ls = open.filter((x) => x.status === s).map((x) => `- ${x.id} ${x.title}${x.milestone ? ` (${x.milestone})` : ""}${x.assignee ? ` @${x.assignee}` : ""}: ${reasons(t, x).join("; ")}`);
    return ls.length ? `## ${s}\n${ls.join("\n")}` : "";
  }).filter(Boolean);
  return ["# Board", `Active milestone: ${a ? `${a.id} ${a.name}` : "(none)"}`, `## Triage\n${triageList(open, false, n)}`, ...groups].join("\n");
}

// the triage batch: each ticket with its description cut at n characters, the open tickets of its milestones, the team load
function triage(t: Tracker, org: Org, ids: string[], n = 300): string[] {
  const xs = ids.map((id) => t.getTicket(id)), ms = new Set(xs.map((x) => x.milestone).filter(Boolean));
  const batch = xs.map((x) => {
    const by = t.blockers(x.id).map((b) => b.id);
    return `- ${x.id} ${x.title} (label ${x.label}, from ${x.owner}${x.milestone ? `, milestone ${x.milestone}` : ""}${by.length ? `, blocked by ${by.join(", ")}` : ""}): ${x.description.slice(0, n).replace(/\n/g, "\n    ")}${x.comments.map((c) => `\n  - ${comment(c)}`).join("")}`;
  });
  const open = t.listTickets().filter((x) => isOpen(x.status) && x.status !== "triage");
  const mine = open.filter((x) => x.milestone && ms.has(x.milestone)).map((x) => `- ${x.id} ${x.title} [${x.status}] @${x.assignee ?? "nobody"}`);
  const load = Object.entries(org.members).filter(([, m]) => m.role === "dev").map(([n, m]) => `- ${n} (${up(m.role)}): ${open.filter((x) => x.assignee === n).length} open`);
  return [`# Batch\n${batch.join("\n")}`, `# Open tickets of the batch's milestones\n${mine.join("\n") || "(none)"}`, `# Team load\n${load.join("\n")}`];
}

// a milestone's work tickets with their changed files, summary and, with desc, description
function digest(t: Tracker, repo: string, m: string, desc = false): string {
  const ls = t.listTickets({ milestone: m }).filter((x) => work(x) && x.status !== "canceled" && x.status !== "duplicate").flatMap((x) => {
    const v = t.getTicket(x.id), o = v.merged ? outcome(repo, v.merged) : "";
    return [`${x.id} [${x.status}] ${x.title}${o ? `: ${o}` : ""}`, ...(desc && v.description ? v.description.split("\n").map((l) => `  ${l}`) : []), ...(v.summary ? [`  Summary: ${v.summary.replace(/\s+/g, " ")}`] : [])];
  });
  const ms = t.getMilestone(m);
  return `# Milestone ${ms.id} ${ms.name}\n${ls.join("\n") || "(no tickets)"}`;
}

// every bug ticket of all milestones, for the final acceptance
const defects = (t: Tracker) => `# Defects\n${t.listTickets().filter((x) => x.label === "bug").map((x) => `- ${x.id} [${x.status}] ${x.title} (${x.milestone ?? "no milestone"})`).join("\n") || "(none)"}`;
// a comment that starts with its author's name ("tl answers: …") needs no author prefix
const comment = (c: { author: string; text: string }) => (c.text.startsWith(`${c.author} `) ? c.text : `${c.author}: ${c.text}`);
// only the last change request in full; the review-cap note keeps its first sentence and its instruction
const CR = /^\S+ requests changes:/;
function comments(cs: { author: string; text: string }[]): string[] {
  const crs = cs.filter((c) => CR.test(c.text)), last = crs.at(-1);
  return cs.map((c) => {
    if (CR.test(c.text) && c !== last) return `${c.author} requested changes (round ${crs.indexOf(c) + 1}): ${c.text.split("\n").filter((l) => /^\s*\d+\./.test(l)).length} findings`;
    const i = c.text.indexOf("the review does not converge.");
    if (c.text.includes("requested changes") && i >= 0) {
      const ask = c.text.split("\n").find((l) => l.startsWith("Answer with a decision"));
      return comment({ ...c, text: [c.text.slice(0, i + "the review does not converge.".length), ...(ask ? [ask] : [])].join("\n") });
    }
    return comment(c);
  });
}
// the verdicts of the milestone acceptances: the acceptance tickets' summaries
const verdicts = (t: Tracker) => `# Milestone verdicts\n${t.listTickets().filter((x) => x.kind === "acceptance" && x.summary).map((x) => `- ${x.id} (${x.milestone}): ${x.summary}`).join("\n") || "(none)"}`;

// one line per ticket: "T-n title: summary"
const sumLine = (x: Ticket) => `${x.id} ${x.title}: ${x.summary?.replace(/\s+/g, " ") ?? "(no summary)"}`;
const work = (x: Ticket) => !SYSTEM_KINDS.includes(x.kind);
// the done tickets of the milestones before m, the last 60 (docs/org-design.md §5)
function doneSoFar(t: Tracker, m: string): string {
  const ord = t.getMilestone(m).ord, before = new Set(t.listMilestones().filter((x) => x.ord < ord).map((x) => x.id));
  const ls = t.listTickets({ status: "done" }).filter((x) => work(x) && x.milestone && before.has(x.milestone)).map(sumLine);
  return `# Done so far\n${[...(ls.length > 60 ? [`(${ls.length - 60} earlier tickets left out)`] : []), ...ls.slice(-60)].join("\n") || "(nothing yet)"}`;
}
// the work tickets of a milestone with their summaries
const summaries = (t: Tracker, m: string) => `# Ticket summaries of ${m}\n${t.listTickets({ milestone: m })
  .filter((x) => work(x) && x.status !== "canceled" && x.status !== "duplicate").map(sumLine).join("\n") || "(no tickets)"}`;

// a requirements ticket or a sub-ticket of one
export const isReq = (t: Tracker, v: Ticket): boolean => v.kind === "requirements" || (!!v.parent && t.getTicket(v.parent).kind === "requirements");

type Ctx = { t: Tracker; kind: Kind; member: string; org: Org; repo: string; main: string; batch?: string[]; tools?: string[]; branchStat?: string; triageChars?: number };
// tools: the member definition tools; branchStat: the diff stat of the ticket branch against main (work sessions);
// triageChars: where the triage lists cut each description (default 300)

// the context loaded at session start (docs/org-design.md §5)
function contextFor(o: Ctx, v?: TicketView): string[] {
  const role = o.org.members[o.member].role, k = v?.kind, review = o.kind === "review";
  const doc = (f: string) => `# ${TITLE[f]} (${f})\n${showMain(o.repo, review && v?.branch ? v.branch : o.main, f).trim() || "(not written yet)"}`;
  // a DEV never sees the business documents, not even their names
  const files = () => `# Files on main\n${tree(o.repo, o.main).split("\n").filter((f) => role !== "dev" || (f !== BR && f !== BS)).join("\n") || "(empty)"}`;
  const by = v?.assignee ? o.org.members[v.assignee]?.role : undefined, m = v?.milestone;
  const mdigest = (desc = false) => (m ? [digest(o.t, o.repo, m, desc)] : []);
  const msums = () => (m ? [summaries(o.t, m)] : []), done = () => (m ? [doneSoFar(o.t, m)] : []);
  const when = (c: boolean, f: () => string[]) => (c ? f() : []);
  if (o.kind === "reply" && role !== "dev") return { // a reply loads its role's context whatever the ticket kind
    ba: () => [doc(BR), doc(BS)], sa: () => [doc(TR), doc(TS), files()], pm: () => [doc(BR), roadmap(o.t)], tl: () => [doc(TS), doc(TR)],
  }[role]();
  switch (role) {
    case "ba": return [doc(BR), ...when(k !== "roadmap" && k !== "final" && !(review && by === "sa"), () => [doc(BS)]), ...when(review && by === "sa", () => [doc(TR), doc(TS)]), ...when(k === "final", () => [verdicts(o.t), defects(o.t)]), ...when(k === "roadmap", () => [roadmap(o.t)])];
    case "sa": if (k === "summary" && !review) return [doc(TS), files(), ...mdigest()]; // the digest holds the ticket summaries
      if (review && by === "ba" && v && isReq(o.t, v)) return [doc(BR), doc(BS)]; // the BR review checks the business documents only
      if (review && k === "final") return [doc(TR), doc(TS), files(), verdicts(o.t), defects(o.t)]; // the final review is the technical check, no business documents
      if (review && k === "breakdown") { // the breakdown review checks the plan against the scope, no business summary
        const ms = o.t.getMilestone(m!);
        return [`# Milestone ${ms.id} ${ms.name}${ms.description ? `\nScope: ${ms.description}` : ""}`, doc(TR), doc(TS), ...done(), files()];
      }
      return [doc(o.kind === "work" && v && isReq(o.t, v) ? BR : BS), ...when(review && by === "ba", () => [doc(BR)]), doc(TR), doc(TS), files(), ...when(k === "breakdown", done), ...when(k === "summary", () => mdigest())];
    case "pm": if (o.kind === "triage") return [doc(BS), roadmap(o.t), ...triage(o.t, o.org, o.batch ?? [], o.triageChars)];
      if (k === "acceptance") return [doc(BR), roadmap(o.t), `# Triage\n${triageList(o.t.listTickets().filter((x) => isOpen(x.status)), true, o.triageChars)}`, ...msums()];
      return [doc(k === "roadmap" ? BR : BS), roadmap(o.t), ...when(k !== "roadmap", () => [board(o.t, o.triageChars)])];
    case "tl": return [doc(TS), ...when(k === "breakdown", () => [doc(TR), ...done(), files()]), ...when(k === "acceptance", () => [doc(TR)]), ...when(k === "roadmap", () => [doc(TR), roadmap(o.t)]),
      ...when(k === "acceptance" || k === "summary", () => mdigest(k === "acceptance"))];
    case "dev": {
      const rest = m ? o.t.listTickets({ milestone: m }).filter((x) => x.id !== v!.id && isOpen(x.status)).map((x) => `${x.id} ${x.title} [${x.status}] @${x.assignee ?? "nobody"}`) : [];
      const done = (v?.relations ?? []).filter((r) => r.kind === "blocks" && r.to === v!.id).map((r) => o.t.getTicket(r.from))
        .filter((b) => b.merged && !isOpen(b.status) && b.kind !== "breakdown").map((b) => `${b.id}: ${outcome(o.repo, b.merged!)}`);
      return [doc(TS), ...when(rest.length > 0, () => [`# Unfinished tickets of ${m}\n${rest.join("\n")}`]), ...when(done.length > 0, () => [`# Finished blockers\n${done.join("\n")}`]), files()];
    }
  }
}

// the process block of a work session, by ticket kind
function processFor(v: TicketView, t: Tracker, role: Role): string {
  const m = v.milestone ?? "<M>", ms = v.milestone ? t.getMilestone(v.milestone) : undefined;
  const change = !!ms?.name.startsWith(PLAN_CHANGE); // the update tickets after a rejected final review
  switch (v.kind) {
    case "roadmap": return `# Roadmap work
- Create the milestones in order with milestone_create: a short name (two to four words) without the milestone id, the business scope and the requirement ids it covers (BR-1, BR-2, …).
- Each milestone delivers a working increment. Cover every in-scope requirement id once (not the out-of-scope ones).
- A milestone's description covers only the scope of its BR ids.
- On a plan change, add milestones only for new or changed requirements; the done milestones stay.
- To fix a name or the coverage, use milestone_update; it keeps the id.${change ? "\n- Plan every id this plan change adds in a new milestone. Never add ids to a done milestone: it gets no tickets." : ""}
- ${IDS}
- Plan only what the business requirements ask. No milestone for work that another milestone already covers, and no extra scope.
- Do not create tickets. TL breaks each milestone into tickets later.
- Then call submit_review. BA reviews the coverage. TL reviews the feasibility and the order.`;
    case "breakdown": return `# Breakdown of ${m}${ms ? ` ${ms.name}` : ""}${ms?.description ? `\nScope: ${ms.description}` : ""}
- Plan only this milestone's scope. Check the done work and the file tree; create tickets only for what is missing. Add a structure ticket (the ticket that creates the project layout: the package, its entry point and the test setup) only when no structure exists.
- Each ticket builds only the milestone's BR ids. A cited TR may also serve BR ids of other milestones. Plan only what the milestone's requirements ask: no ticket for a later milestone's scope, no extra features.
- A ticket includes the tests for its code. Plan no separate test ticket for new code.
- Tickets already in this milestone (accepted defects) are part of the plan. Do not create a ticket that repeats them.
- Plan no ticket only to verify existing behaviour; the acceptance verifies it. A breakdown with no new ticket is allowed when the work is done.
- Step 1: create every ticket of the milestone with ticket_create. Give each a title, a description and acceptance criteria that state each requirement in words and cite its TR id. Keep tickets small: one deliverable each.
- Step 2: call set_dependencies once, with every ticket that needs another one finished first. When a structure ticket exists, it blocks every ticket that adds to it. Tickets without dependencies run in parallel, so two tickets that change the same file must depend on each other.
- The tickets go to Triage; PM accepts and assigns them after the review.
- Rework tickets with ticket_edit and ticket_drop.
- Then call submit_review. SA reviews the breakdown.`;
    case "acceptance": return `# Acceptance of ${m} (technical)
- The tickets of ${m} are merged into main. Check the result on main.
- Run the checks that the tech summary names, and the program itself.
- Compare the result with the tech summary and each ticket's acceptance criteria.
- Check on main each TR that serves the milestone's BR ids, not only the tickets. A TR that is not met is a defect: ticket_create.
- ${MDIFF}
- For each defect: ticket_create with the steps to reproduce. It goes to Triage. PM decides.
- Write the verdict in the submit summary: each ticket, met or not met against its acceptance criteria; a reason only for not met; the defect tickets.
- Then call submit_review. PM reviews the business side.`;
    case "summary": return `# Tech summary and repo cleanup after ${m}
- ${MDIFF}
- Update docs/tech-summary.txt: the tech stack and the decisions crucial for planning and development. Keep it under 4000 characters.
- Run the commands the tech summary names (exec). Fix any command that fails on this host.
- When a decision changed, also update docs/technical-requirements.md (read it with read).
- A change of the stack or of a key decision: ask the human first with ask.
- Check .gitignore and the tracked files for runtime data (databases, logs, backups, caches). If one .gitignore change fixes it, make it. If more work is needed, file a ticket with ticket_create.
- Then call submit_review. TL reviews.`;
    case "final": return `# Final acceptance
- All milestones are complete. Compare the product with the business requirements, requirement by requirement.
- Use the milestone verdicts and the defect list in this task.
- Write the verdict in the submit summary: each requirement id, met or not met; a reason only for not met; the defect tickets.
- A gap, or a reviewer's finding about the product: ticket_create for it. It goes to Triage; the final acceptance waits until it is closed.
- Then call submit_review. SA does the technical check. Then the human approves.`;
  }
  const req = v.kind === "requirements" || /requirements/i.test(v.title) || (v.parent && t.getTicket(v.parent).kind === "requirements");
  if (req && role === "ba") return `# Business requirements and summary
- Write or update ${BR}: goal, users, features, business rules, out of scope; keep the existing ids and add new ones after the last.${change ? "\n- Never rewrite or renumber an id. A changed requirement gets a new id; mark the old one '(replaced by BR-n)'. A defect in built code also gets a new id that states the correct behavior." : ""}
- Number every feature as a BR (BR-1, BR-2, …): one testable sentence each.
- Write ${BS}: the problem and the final result in a few sentences, ${CAP}.
- Write what you can first. Ask the human only about open points that block the documents; your session ends until the answer comes. Write each answer into both files.
- Put technical items (paths, commands, modules, test setup) in the TRs: they are the SA's. The BRs stay at business level.
- Then call submit_review. SA reviews.`;
  if (req && role === "sa") return `# Technical requirements and summary
- Write or update ${TR}: tech stack, architecture, data, interfaces, constraints, how to test; keep the existing ids and add new ones after the last.${change ? "\n- Never rewrite or renumber an id. A changed requirement gets a new id; mark the old one '(replaced by TR-n)'. A defect in built code also gets a new id that states the correct behavior." : ""}
- Number each requirement: TR-1, TR-2, …. Cite the BR ids each TR serves.
- A TR states how: the module, command, table or check.
- One way per need: no fallbacks or options the BRs do not ask for.
- Write ${TS}: the tech stack and the decisions crucial for planning and development, ${CAP}.
- Write what you can first. Ask the human only about open points that block the documents; your session ends until the answer comes. Write each answer into both files.
- Name each command as it runs on this host; you cannot run it yet. The summary ticket checks it.
- Then call submit_review. BA reviews.`;
  return "";
}

const VERB = "Every BR verb has a command or interface that performs it.";
// the checklist and the decision line of a review session, by ticket kind
function reviewFor(v: TicketView, role: Role, exec: boolean, req: boolean, by?: Role): string[] {
  const decide = "Then approve or request_changes.", CODE_REVIEW = codeReview(exec, req, v.kind === "summary");
  const brIds = req && role === "ba" && by === "sa" ? ["Check that every BR id is covered by a TR that cites it. Request changes for a missing id or for a change of the business scope.", VERB]
    : req && role === "sa" && by === "ba" ? ["Check that each BR is testable and can be built, and that the requirements stay at business level: no tech stack and no design. Request changes for a BR that names a path, a command, a module or a test setup. Request changes for a requirement that cannot be tested or built.", `Judge only ${BR} and ${BS}. Findings on the TRs go to your own technical requirements ticket, which comes next.`] : [];
  switch (v.kind) {
    case "roadmap": return [role === "ba"
      ? "Check that the milestones cover every in-scope requirement id exactly once (not the out-of-scope ones). Request changes for a missing or repeated id, or for a milestone with scope outside the business requirements."
      : `Check feasibility and order: each milestone builds on the ones before, and the first milestone that builds code sets up the structure.`, IDS, `The roadmap is in this task; there is no diff. ${decide}`];
    case "breakdown": return ["Check the tickets of the milestone and their dependencies: the order, what runs in parallel, and that no two parallel tickets change the same file. Request changes when the order is wrong.",
      "When a structure ticket (the ticket that creates the project layout) exists, check that it blocks the tickets that add to it. Check that the acceptance criteria state each requirement in words and cite its TR id.",
      "Check the tickets against the done work and the file tree. Request changes for tickets that repeat done work, repeat a ticket already in the milestone, only verify existing behaviour, or go past the milestone scope. Request changes for a ticket that builds work outside the milestone's BR ids.",
      "If the breakdown creates no tickets, check on main that the code serves each TR the milestone cites. Request changes for each one it does not serve.", `The tickets are in this task. ${decide}`];
    case "acceptance": return ["Compare the milestone result and TL's verdict (the summary of the work in the ticket) with the business requirements. Approve when the milestone delivers its business scope.",
      ...(role === "pm" ? ["For each defect: ticket_create with the steps to reproduce. It goes to Triage.",
        "An open defect does not hold the acceptance. The milestone completes only when every ticket is closed, and each defect gets its own review. Do not request changes to wait for a defect."] : []), decide];
    case "summary": return [CODE_REVIEW, `Check that docs/tech-summary.txt does not contradict the code on main. Planned parts of later milestones are allowed.`, MDIFF, decide];
    case "final": return ["Technical check: run the checks on main. Go through the TRs one by one; for each interface TR, run the program on main, not only the tests.",
      "For each defect: ticket_create with the steps to reproduce. It goes to Triage; the final acceptance waits until it is closed.", "Request changes only when the BA's verdict is wrong.", decide];
  }
  return [CODE_REVIEW, ...brIds, decide];
}

export function taskFor(o: Ctx & { ticket: string }): string {
  const role = o.org.members[o.member].role;
  if (o.kind === "triage") return ["Triage batch.", ...contextFor(o)].join("\n\n");
  const v = o.t.getTicket(o.ticket), view = `# Ticket\n${ticketText(v, o.t)}`, ctx = contextFor(o, v);
  if (o.kind === "review") return [`Review ${v.id}.`, ...ctx, view, ...reviewFor(v, role, fileToolsFor(role, "review", o.tools ?? [], v.kind, isReq(o.t, v)).includes("exec"),
    isReq(o.t, v), v.assignee ? o.org.members[v.assignee]?.role : undefined)].join("\n\n");
  if (o.kind === "reply") {
    const q = v.comments.findLast((c) => c.text.startsWith(`${v.asker} asks`));
    return [`Question on ${v.id}: ${q?.text ?? "(none)"}`, ...ctx, view].join("\n\n");
  }
  const stat = o.branchStat?.trim() ? `# Changes on your branch so far\n${o.branchStat.trim()}` : "";
  const split = role !== "pm" && !v.parent && v.kind === "normal" ? "Split big work into sub-tickets with subticket_create." : ""; // only where tools.ts offers subticket_create
  return [`Work on ${v.id}.`, ...ctx, stat, view, processFor(v, o.t, role), split].filter(Boolean).join("\n\n");
}
