# Org design

Status: status workflow built on branch `workflow-experiment` (2026-10-20). This is the only design document for orgs.
The code in `packages/cli/src/org/` is the truth. Fix this document when the two disagree.

Contents: 1 Why · 2 The grid · 3 Roles · 4 Documents and summaries · 5 Context per role · 6 Questions and comments ·
7 Lifecycle · 8 Tickets · 9 Sessions and tools · 10 The cycle · 11 Instructions · 12 Engine · 13 Git ·
14 Limits and pauses · 15 The human · 16 Audit · 17 Deferred and open

## 1. Why

Live runs 11–13 (see `issues.md`) showed two things:

- **Cost comes from steps, not from context size.** Every role read all requirement documents with tools,
  whatever its role (in run 13 the devs read the business requirements 5 times, TL 6 times). Each read is a step,
  and each step sends the whole context again. A small context loaded at session start removes those steps.
- **Code must keep the flow.** Models skip and reorder steps (PM planned inside Triage, BA created milestones too
  early). Run 13 reached `org.done` because guards and automation in code caught or prevented those mistakes.

So: each role gets its own small context, and code keeps the workflow; the PM makes the project decisions.

Live runs 14–17 then showed that chat (threads, mentions, PM turns) and wake repair (reconcile, stall turns) cost
most of the steps and still lost work. So the status of a ticket now decides who works and with which tools
(§8–§10). A question is a status, Needs Reply. A cycle reads the tracker and wakes whoever a ticket needs.

## 2. The grid

Each role sits in one cell. The level sets the scope and time horizon. The track sets the kind of content.

| Level | Business track | Technical track |
|---|---|---|
| Strategic: the whole product | BA | SA |
| Project: all milestones | PM | TL |
| Cycle: one task inside a milestone | — | DEV |

Check every question on roles, context, tools, communication and reasoning against this grid.

Rules from the grid:

1. **Context.** A role loads the artifacts of its own cell and short outputs of the cells next to it (§5).
2. **Communication.** A role talks up and down its own track and across its own level. Anything else goes through
   a neighbour (§6).
3. **Ownership.** Each cell owns its artifacts. Only the owner writes them (§4).
4. **Reasoning.** The level sets the default model reasoning: strategic `high`, project `medium`, cycle `low`.
   A `reasoning` field in the definition overrides it. Some providers ignore the setting.
5. **The human** talks only to the strategic roles (BA, SA). System pauses are the exception (§14).

The empty cell (cycle level, business) is on purpose. Business reaches the cycle level only through the acceptance
criteria in each task.

## 3. Roles

| Role | Cell | Owns and decides | Reviews |
|---|---|---|---|
| BA | strategic, business | business requirements, business summary, business answers, final acceptance | SA's documents, roadmap coverage (each id once, no extra scope) |
| SA | strategic, technical | technical requirements, tech summary, design answers, blocking links | BA's documents, every milestone breakdown, final acceptance (technical) |
| PM | project, business | roadmap, Triage (milestone, priority, assignee) | milestone acceptance (business) |
| TL | project, technical | milestone breakdown (tickets and dependencies), milestone acceptance (technical) | roadmap feasibility, every DEV ticket, tech summary updates |
| DEV | cycle, technical | the code of one ticket, its tests and its documentation | — |

### 3.1 Members and the org yaml

- The role set is fixed in code: `ba`, `sa`, `pm`, `tl`, `dev`. Every org has all five.
- BA, SA and PM have exactly one member each. TL and DEV can have several.
- A member has a `role` and a `definition`. The role sets the duties, the tools and the rules (built in). The
  definition sets the model, the reasoning, the style prompt and the step cap.
- The grid sets the reporting line: DEV → TL → SA → human, PM → BA → human. There is no `reports_to` field,
  with one exception: when the org has several TLs, each DEV names its TL in `reports_to`. Any other
  `reports_to` is an error.
- `limits`: `parallel` (default 1), `tokens` (no limit), `review_rounds` (3, §8.7), `noop_sessions` (3, §10.2),
  `retry_seconds` (30) and `retry_max_seconds` (600, §10.2), `triage_chars` (300, §9.1). See §14.
- A token count (`context` in a definition, `limits.tokens`, `--context`) takes an integer or a short form,
  case-insensitive: `10k` = 10,000, `1.5M` = 1,500,000.
- Member names: lower case letters, digits, `_` and `-`. `user` and `org` are reserved.

### 3.2 Tools by role

A role gets only the tools it may use. Guards on the ticket state still refuse calls (§8.3).
Tool sets also depend on the session kind, and the session kind comes from the ticket status (§9).

| Capability | BA | SA | PM | TL | DEV |
|---|---|---|---|---|---|
| Create a ticket (goes to Triage) | yes | yes | only defects, in an acceptance review | yes | yes |
| Breakdown: create, edit and drop its Triage tickets, set dependencies | | | | yes | |
| Triage batch: accept, reject, duplicate | | | yes | | |
| Add or remove blocking links (work session) | | yes | | | |
| Create, update, reorder, delete milestones (roadmap session) | | | yes | | |
| Create sub-tickets of the session's ticket | yes | yes | | yes | yes |
| Submit (own ticket), link related tickets | yes | yes | yes | yes | yes |
| Approve or request changes (as reviewer) | yes | yes | yes | yes | yes |
| Ask a grid neighbour; answer or forward a question | yes | yes | yes | yes | yes |
| `milestone_diff` (acceptance and summary tickets, work and review) | | yes | | yes | |
| File tools: write and edit | yes | yes | — | — | yes |
| File tools: run commands (`exec`, not in a reply) | — | yes | — | yes | yes |

- File tools come from the definition's `tools` list; the role and the session kind filter them.
- PM gets no file tools at all. TL reads and runs checks but never writes. BA never runs commands. A roadmap review has no file tools.
- `milestone_diff` shows what the ticket's milestone changed: `git diff --stat <tag>..main` and the diff, where
  `<tag>` is the latest existing tag of an earlier milestone (§13). Optional `path`: one file or directory. The
  output is capped at 40,000 characters ("… truncated; read the files you need"). Without an earlier tag it says
  so and points to the file list. It is a tool, not context, since a diff can be large.
- Only a work session writes files (§9).

## 4. Documents and summaries

| File | Owner | Content |
|---|---|---|
| `docs/business-requirements.md` | BA | the full business requirements, numbered (BR-1, BR-2, …) |
| `docs/business-summary.txt` | BA | the problem the product solves and the final result, in a few sentences |
| `docs/technical-requirements.md` | SA | the full technical requirements, numbered (TR-1, TR-2, …) |
| `docs/tech-summary.txt` | SA | the tech stack and the architectural decisions crucial for planning and development |

- Summaries are plain text, in separate files, so code loads each one whole.
- **Ownership guard:** a submit that changes an owned file is refused when the author's role is not the owner.
  The error names the owner and asks to revert the change.
- **Summary cap:** a submit is refused when a summary has more than 4,000 characters. The error names the cap.
- Any path outside `docs/` is code. A code change adds the TL in the author's reporting line as a reviewer
  (else any TL, else the SA).
- The BA and SA instructions say: keep the summary short and accurate; update it with every change to the full
  document.
- The roadmap, the breakdowns and the reports live in the tracker, not in files (§7, §8).
- Session context reads these files from main, never from the member's branch. A review reads them from the reviewed ticket branch.

## 5. Context per role

Code loads the context at session start. A role reads more with tools only where the table says so.
Every session also gets the goal and the roster (system prompt) and the view of its ticket. The system prompt has these parts, in
this order: the writing rule ("# Writing", Simplified Technical English), the "# Org" header, "# How MAIHEM works"
(sessions, no memory, ticket tools as moves, statuses, git, what MAIHEM does itself, the human above BA and SA), the
"# Your role" card (the same in every session kind), "# Style" with the definition's own `system` text (trimmed, only
when set), and the rules of the session kind.
A ticket view shows the latest change request in full; earlier rounds are one line each ("sa requested changes
(round 1): 2 findings"), and the review-cap note keeps only its first sentence. A reply loads its role's reply context
whatever the ticket kind.
The rules of every session kind (work, review, reply, triage) say: your task text holds your context; do not read a
document, ticket or list again with tools when the task shows it.
A work session gets the core work rules. A member whose definition has `write` or `edit` also gets the file rules:
never run git, name the files used in the summary, delete scratch files, resolve conflict markers. With `exec` they also say: run the checks that the tech summary names (tests and others) before submit and after a conflict resolve.
The work rules also say: the summary is one or two sentences on what changed (acceptance and final keep the
compact verdict, §8.9); it describes the ticket's whole change on the branch, not only this session. Every session
kind also says: call independent tools in one step. A work session on a branch with changes gets
"# Changes on your branch so far": the diff stat of the branch against main.
DEV work, TL reviews and the TL breakdown also say: keep the repo clean, no runtime data (databases, logs,
backups, caches) in git; manage `.gitignore`.
Every review says: request only changes the author can make with its tools; the context the system shows is not editable.
The DEV card says: build only what the acceptance criteria ask; other requirements have their own tickets. The tool rules
(`ticket_create`, `subticket_create`) go only to sessions that have those tools; `subticket_create` only on a ticket without a parent.

| Role | Always loaded | Loaded only for some sessions | Reads with tools |
|---|---|---|---|
| BA | business requirements, business summary (not in roadmap review or final) | SA documents (review of an SA ticket), milestone verdicts and all bug tickets with status (final), roadmap (roadmap review) | — |
| SA | business summary (business requirements on its requirements work), technical requirements, tech summary, file tree | only the business requirements and the business summary (review of a BA requirements ticket: BRs testable, buildable, business level), business requirements (review of another BA ticket), milestone scope, technical requirements, tech summary, done-so-far digest and file tree, no business summary and no exec (breakdown review), only the technical requirements, the tech summary, the file tree and the milestone verdicts (final review, no business documents); a summary update loads only the tech summary, the file tree and the milestone digest with the ticket summaries; a reply loads only the technical requirements, the tech summary and the file tree | code, the milestone diff (summary update, no exec) |
| PM | business summary, roadmap, board digest | business requirements instead of the summary (roadmap, acceptance, reply), no board digest (roadmap, reply), no grid, documents or active milestone lines in the system prompt (every session), the open Triage list and the ticket summaries instead of the board (acceptance review), the triage context (triage, §9.1) | — |
| TL | tech summary | technical requirements, done-so-far digest and file tree (breakdown), technical requirements and roadmap (roadmap review), milestone digest (acceptance with ticket descriptions, summary review) | code, the diff, the milestone diff (acceptance, summary review), runs checks (not in the summary review) |
| DEV | tech summary, unfinished tickets of its milestone, outcomes of its finished blockers (not breakdown tickets), file tree without the business documents | — | code |

The human's answers reach the roles through the documents: BA and SA write each answer into their documents and
summaries.

Generated by code, never written by a model:

- **Board digest** (PM): Triage tickets, open tickets by status, and what each one waits for.
- **Milestone digest**: header `# Milestone <id> <name>`; the milestone's work tickets (no system tickets), their changed
  files (`files (a, b)` or `(no changes)`) and the work summary (`  Summary: …`). The TL acceptance also shows each ticket's description.
- **Milestone verdicts**: the summaries of the acceptance tickets.
- **Done so far** (breakdown, breakdown review): one line per Done work ticket (not a system kind) of the earlier
  milestones: `T-n title: <summary or (no summary)>`. The last 60 lines.
- **Ticket summaries** (PM acceptance review): one line per work ticket of the milestone, without Canceled
  and Duplicate: `T-n title: <summary or (no summary)>`.
- **Ticket view**: fields, relations, sub-tickets, description, the work summary of the last submit, the comments. A breakdown ticket also lists its milestone's tickets with status, blockers and descriptions, after its own description. It skips canceled and duplicate tickets.
- **Unfinished tickets** (DEV): one line each: id, title, status, assignee.
- **Blocker outcomes** (DEV): one line per finished blocker, except a breakdown ticket: `T-n: files (a, b)`, no commit subject.
- **File tree** of main, at most 200 paths.

Budget: about 1k tokens for the role instructions, up to 1.5k per summary or document slice, 1–2k for the generated
slice; about 4–6k tokens before tool schemas. Prompt caching is optional and not supported by every provider, so
the context must stay small without it.

## 6. Questions and comments

### 6.1 Questions

- A question is a status: Needs Reply. `ask(to, question)` stores the asker, the status to return to and the
  assignee to return to. It sets the assignee to `to`, writes the question as a comment and ends the session.
- The assignee asks from In Progress; a pending reviewer asks from In Review; PM asks from Triage (no return
  assignee: the answer returns the ticket to Triage and the next batch takes it).
- `ask` and `forward` reach grid neighbours only: a member's manager, its reports, and the other track on its own
  level (BA ↔ SA, PM ↔ TL). BA and SA also reach `human`. Paths: DEV → TL → SA → human, PM → BA → human.
- A question that crosses tracks goes across one level first: TL asks PM a business question; PM asks TL a
  technical question. A DEV reaches SA only through TL.
- The answerer gets a reply session with read and list only, no `exec`: `answer(text)` writes the answer, restores the status and the assignee;
  `forward(to)` passes the question up the grid. Only BA and SA forward to the human. A forward never goes to the asker.
  A DEV reply has `answer` only: the only DEV neighbour is its TL, and the TL is always the asker.
- The asker is free for other work while it waits.
- The human answers with `maihem org answer ORG T-n TEXT` (§15). A strategic role writes the human's answer into
  its documents and summary, so every role below gets it.

### 6.2 Comments

- Comments are a flat list per ticket. Only transitions and system notes write them: `ask`, `answer`,
  `request_changes` (one comment, findings numbered), `reject`, the human's `cancel` and `assign`, and system
  notes (a new blocker, a merge conflict, the no-op cap).
- There are no threads, mentions or acks. A mention in a description is a reference only and wakes nobody.
- The work summary is a field, not a comment (§8.1).

## 7. Lifecycle

Start (strategic):

1. `org start` creates milestone M0 "Requirements" and the parent ticket "Requirements" (BA) with two sub-tickets.
2. "Business requirements": BA writes the business requirements and the business summary. BA numbers every feature
   as a BR (BR-1, …): one testable sentence each. A rewrite keeps the existing ids and adds new ones after the last. SA reviews (testable, buildable, business level). A review of a requirements ticket has no `exec`.
   The goal text is in this ticket's description.
3. "Technical requirements": SA writes the technical requirements and the tech summary from the business requirements.
   Each TR cites the BR ids it serves and states how: the module, command, table or check. One way per need: no
   fallbacks or options the BRs do not ask for. A rewrite keeps the existing ids. BA reviews: every BR id has a TR,
   and every BR verb has a command or interface that performs it.
   It is blocked by "Business requirements".
4. When both sub-tickets close, the human gets one inbox approval for the four files.
   Approve: the gate opens and code creates the Roadmap ticket.
   Reject: code creates the chained pair "Update business requirements" (BA, SA reviews, with the human's text)
   and "Update technical requirements" (SA, BA reviews, with the human's text), both urgent, as in a plan change
   (step 14). The approval opens again when the sub-tickets close.

Roadmap (project):

5. PM writes the roadmap in the tracker (the Roadmap ticket, urgent): the milestones in order, each with a short name
   (two to four words, no milestone id), its business scope and the requirement ids it covers. PM plans only what
   the business requirements ask: no milestone for work that another milestone covers, no extra scope. The ticket
   description is one line. A milestone's description covers only the scope of its BR ids. On a plan change, PM
   adds milestones only for new or changed requirements; the done milestones stay. BA reviews coverage. TL reviews
   feasibility and order: the first milestone that builds code sets up the structure, and every BR verb has a
   command or interface.
   The work rules and both reviews say: milestone ids are fixed tracker ids, not positions; the order of the list is
   the roadmap order; do not request id changes. PM fixes a name or the coverage with `milestone_update`; the id stays.
6. When the Roadmap ticket closes, the Requirements parent closes, M0 completes, and the next milestone starts.

Each milestone:

7. Code creates "Break down <milestone>" for TL (urgent, SA reviews). TL plans only the milestone's scope: it
   checks the done-so-far digest and the file tree and creates tickets only for what is missing, and a structure
   ticket only when no structure exists. The acceptance criteria state each requirement in words and cite its TR id. Each ticket covers only TRs that serve
   the milestone's BR ids: no ticket for a later milestone's scope, no extra features. It sets their dependencies. A structure ticket blocks the tickets that add
   to it. A ticket includes the tests for its code. Accepted defects already in the milestone are part of the plan.
   No ticket only verifies existing behaviour; a breakdown with no new ticket is allowed. SA requests changes for
   tickets that repeat done work, repeat a milestone ticket, only verify existing behaviour, or go past the scope, and for a ticket whose TRs serve
   BR ids outside the milestone.
   When the approved breakdown leaves no work ticket (Canceled and Duplicate do not count), the acceptance ticket
   follows at once; the milestone completes when it closes, with no summary update. The next breakdown or the final acceptance follows.
8. The breakdown tickets wait in Triage, blocked by the breakdown. When SA approves the breakdown, PM triages them
   in one batch: milestone and assignee for each; the grid sets the reviewer (§8.3, §9.1).
9. DEVs implement. TL reviews each ticket.
10. When every work ticket of the milestone is closed, code creates "Accept <milestone>" for TL (urgent, PM
    reviews). The ticket description is one line. TL checks the result technically against the tech summary and the milestone digest (not
    the full technical requirements: those are for the breakdown only) and runs the checks; PM checks it against
    the business requirements. TL runs the checks that the tech summary names, and the program itself. The verdict is the submit summary (§8.9). Each defect becomes a ticket in Triage.
11. When the acceptance closes, code creates "Tech summary and repo cleanup after <milestone>" for SA (urgent, TL
    reviews). SA updates the tech summary and checks `.gitignore` and the tracked files for runtime data
    (databases, logs, backups, caches). When one `.gitignore` change fixes it, SA makes it; else SA files a ticket.
    No human approval for routine updates. SA asks the human about a change of stack or of a key decision (`ask`, §6).
12. When the summary update closes, the milestone completes, and the next milestone starts at step 7.

End:

13. After the last milestone, code creates "Final acceptance" for BA (urgent, SA reviews) in the last milestone. BA checks the business requirements only, with no write tools and no sub-tickets. The ticket description is one line.
    BA checks each business requirement; SA does the technical check.
    - Defects: a ticket created while the final ticket is open blocks the final ticket. The SA review and the BA
      file defects with `ticket_create`; they go to Triage, and PM accepts them into the last milestone.
    - A review result (approve or request changes) or a BA submit on a blocked final ticket moves it to Todo and
      resets the approvals. The final ticket starts again when its defects close.
14. When it closes, the human gets the final approval. Approve: the org ends (`org.done`).
    Reject: code creates milestone "Plan change n" with the parent "Plan change" (BA) and the sub-tickets
    "Update business requirements" (BA, with the human's text) and "Update technical requirements" (SA, with the
    human's text), chained: the second waits for the first. The flow
    then repeats from step 4: approval, roadmap (PM extends it), milestones.

## 8. Tickets

The model follows Linear (linear.app): issues, statuses, sub-issues, relations and milestones. An org has one
project.

### 8.1 Fields

| Field | Rule |
|---|---|
| Id | `T-n`, sequential. |
| Title | Required. Fixed after creation (a breakdown may edit its own Triage tickets). Code strips a leading id (`T-4: Login` → `Login`). |
| Description | Markdown. Set at creation; a breakdown edits its own Triage tickets (`ticket_edit`). No member tool edits it later. No edit history. |
| Status | One of the statuses in §8.2. |
| Label | `bug` or `other`. The reporter sets it at creation. Nobody changes it later. |
| Priority | 0 none, 1 low, 2 medium, 3 high, 4 urgent, plus a manual order. The reporter sets it; PM may change it in `accept`. |
| Kind | `normal`, or a system kind: `requirements`, `roadmap`, `breakdown`, `acceptance`, `summary`, `final` (§8.9). Only code sets it. |
| Owner | The creator. Fixed. |
| Assignee | One member. PM sets it in `accept`; the human reassigns (`maihem org assign`). `ask` and `answer` move it while a question is open. A sub-ticket inherits it. |
| Reviewers | One or more members, each with a state: pending, approved, changes. §8.7. |
| Milestone | Zero or one. Set by `accept`, a breakdown, a parent, or code. |
| Parent | Zero or one ticket. One level only. |
| Relations | blocks / blocked by, related, duplicate of. |
| Question | Asker, return status and return assignee while the ticket is in Needs Reply. |
| Branch, merged | Set by code: the ticket branch and the squash commit. |
| Summary | The assignee's work summary, set by `submit_review` (each submit replaces it): what was done, what was used, which decisions were made. One or two sentences on what changed; no length cap. |
| Comments | A flat list (§6.2). |
| Gate | Human approval on a requirements parent: pending or approved. |

There are no epics, estimates, due dates, templates or archiving.

### 8.2 Statuses

| Status | Meaning |
|---|---|
| Triage | New ticket. Waits for the PM's triage batch. |
| Needs Reply | A question waits for the assignee (the answerer). |
| Todo | In a milestone, with an assignee. Ready for work. |
| In Progress | Work runs. |
| In Review | Work is done. The reviewers check it. |
| Done | Approved, and merged when it has changes. Terminal. |
| Canceled | Will not be done. Terminal. |
| Duplicate | Same as another ticket. Terminal. |

- Blocked is not a status. A ticket with an open blocker stays in its status; the cycle skips it.
- There is no Backlog and no Failed status.

### 8.3 Transitions

Each transition is one tool. Guards run in the ticket operations (`ops.ts`), so a guard holds for every caller.
"System" means MAIHEM does it; no session sees a tool for it.

| From | To | Who | Tool | Comment written |
|---|---|---|---|---|
| (new) | Triage | any member except PM; PM only defects in acceptance | `ticket_create` | — |
| (new) | Triage, blocked by the breakdown | TL (breakdown) | `ticket_create` | — |
| (new) | Todo | code, or the parent's assignee | system tickets, `subticket_create` | — |
| Triage | Todo | PM | `accept(id, milestone, assignee, priority?)` | — |
| Triage | Canceled | PM | `reject(id, reason)` | the reason |
| Triage | Duplicate | PM | `duplicate(id, of)` | — |
| Todo | In Progress | system | the cycle starts the assignee's session | — |
| In Progress | In Review | assignee | `submit_review(summary)` | — (the summary is a field) |
| In Progress, In Review, Triage | Needs Reply | assignee, pending reviewer, PM (Triage) | `ask(to, question)` | the question |
| Needs Reply | the stored status | answerer | `answer(text)` | the answer |
| Needs Reply | Needs Reply | answerer | `forward(to)` | — |
| In Review | Done | all reviewers | `approve`, then the system merges | — |
| In Review | In Progress | one reviewer | `request_changes(findings[])` | the findings, numbered |
| In Review | Needs Reply (the reviewer's manager) | one reviewer | `request_changes` at the review-round cap (§8.7) | system note |
| In Progress | Todo | system | a new blocker | system note |
| In Review | In Progress | system | a merge conflict | system note |
| any open | Needs Reply (`human`) | system | the no-op cap (§10.2) | system note |
| Needs Reply (`human`) | the stored status | human | `maihem org answer ORG T-n TEXT` | the answer |
| any open | Canceled | human | `maihem org cancel ORG T-n REASON` | the reason |
| any open | same status | human | `maihem org assign ORG T-n MEMBER` | system note |

Guards:

- `accept` needs a milestone and an assignee. The assignee of a normal ticket is a DEV, BA or SA (TL and PM change
  no files). The grid sets the reviewer: DEV → its TL, BA → SA, SA → BA. System tickets keep their fixed reviewers (§8.9).
- `submit_review` needs a summary. It refuses: a blocked ticket, open sub-tickets, an empty directory in the
  worktree, an ownership or summary-file cap break (§4), a merge conflict with main (§13).
- `request_changes` needs at least one finding. It writes one comment: "<reviewer> requests changes:", then the numbered findings.
- `ask` and `forward` reach grid neighbours only (§6.1).
- Done, Canceled and Duplicate are terminal. Follow-up work is a new ticket.
- A member cannot review its own ticket.

### 8.4 Triage

- Only PM acts on Triage, in a triage batch (§9.1). Outcomes: accept, reject with a reason, or duplicate.
- PM never creates tickets or sub-tickets. Exception: in an acceptance review PM files defects with
  `ticket_create`.
- Breakdown tickets go to Triage too, with their milestone set, each blocked by the breakdown ticket. The TL edits
  or drops them with `ticket_edit` and `ticket_drop` while they wait. PM triages them after SA approves the
  breakdown.

### 8.5 Sub-tickets

- The parent's assignee creates sub-tickets (never PM). Code also creates them (requirements). They skip Triage.
- A new sub-ticket starts in Todo in the parent's milestone. It inherits the parent's priority, assignee and
  reviewers unless the creator sets them.
- One level only: a sub-ticket has no sub-tickets.
- A parent with open sub-tickets gets no session and cannot be submitted: its work is the children's.
- A sub-ticket branches from main, always. When one ticket needs another's code, a blocking link says so.
- A parent closes to Done when all its children are closed and it has no branch, or its branch is merged.
- A requirements parent closes only after the human approved it, its children closed and its milestone's roadmap
  closed.

### 8.6 Relations

- **Blocks / blocked by.** A blocked ticket gets no session and cannot be submitted. TL sets them in the breakdown (`set_dependencies`); code adds some.
  Guards: no link to itself, no cycle, the blocker is not in a later milestone than the blocked ticket.
- **`set_dependencies`** (TL, breakdown session): one map, ticket → the tickets it waits for. It replaces the
  links among the milestone's tickets; the links from the breakdown ticket and out of the milestone stay. A cycle
  is refused before any write.
- **Related.** It informs only. No member tool adds it.
- **Duplicate.** Set by `duplicate`. The duplicate links to the original.
- A new blocking link on an In Progress ticket stops its work (§8.3).

### 8.7 Review

- Reviewers come from `accept`, the breakdown, the parent, code, and the submit.
- At submit, code adds reviewers:
  - none set: the author's manager;
  - a DEV's ticket without a TL or SA reviewer: the TL in the dev's line (else any TL, else the SA);
  - a code change: the TL in the author's line (§4).
- A submit with no reviewer after these rules is refused.
- Each submit sets every reviewer back to pending. So a change after an approval needs every approval again.
- **Fail-fast:** one `request_changes` moves the ticket back to In Progress at once and stops the other reviewers'
  sessions.
- All reviewers must approve. Then code merges.
- Every review gets the core review rules; the change-review rules (`review_diff`, checks only for a reviewer with exec, stray files) go only to reviews of normal, requirements and summary tickets.
- The reviewer checks the work summary against the real changes. The diff is the truth. `review_diff` shows the
  summary next to the diff.
- A reviewer with exec gets one line: run the checks that the tech summary names (tests and others).
- Only for document tickets (requirements and summary) the reviewer checks that the documents and their summary files exist, match each other,
  and each summary file keeps the cap.
- On a re-review the reviewer checks that each of its earlier findings is fixed.
- **Review-round cap:** when a reviewer's change requests since the last answer reach `limits.review_rounds`
  (default 3), the ticket goes to Needs Reply for the reviewer's grid manager: TL → SA, PM → BA, DEV → TL; SA and
  BA → the human. A note names the count and the last findings. The answer returns the ticket to the assignee in
  In Progress and resets the count.

### 8.8 Milestones

- Fields: id (`M0`…), name, description, order. Completion is computed. No status and no date. Code strips a
  leading id from a name (`M2 Login` → `Login`).
- Completion: Done tickets over all tickets, without Canceled and Duplicate. In Progress and In Review count half.
  A milestone with no tickets counts as 0 % and is not complete.
- The active milestone is the first one in order that is not complete. Only one is active at a time.
- The cycle starts Todo work only on tickets of the active milestone.
- PM creates, updates (name, description; the id stays), reorders and deletes milestones, only in the roadmap session. Delete needs an empty
  milestone. Reorder needs every id exactly once.
- Code creates M0 "Requirements" at start and "Plan change n" after a rejected final review.
- `milestone.completed` fires once per milestone: completion 100 %, and for a milestone that is not a
  requirements milestone with a work ticket, its acceptance and summary tickets are closed. A milestone with no
  work ticket (Canceled and Duplicate do not count) gets no acceptance and no summary ticket. It creates the next breakdown (or the
  final acceptance).

### 8.9 System tickets

Code creates these tickets as urgent (priority 4), in Todo, with assignee and reviewers set.

| Kind | Title | Assignee | Reviewers | When |
|---|---|---|---|---|
| `requirements` | Requirements, Plan change | BA | — (the human approves) | org start; rejected final review |
| `roadmap` | Roadmap | PM | BA, TL | the human approved the requirements |
| `breakdown` | Break down <milestone> | TL | SA | the milestone before completed |
| `acceptance` | Accept <milestone> | TL | PM | all work tickets of the milestone closed (none for a milestone without work tickets) |
| `summary` | Tech summary and repo cleanup after <milestone> | SA | TL | the acceptance closed |
| `final` | Final acceptance | BA | SA | the last milestone completed |

- The requirements sub-tickets (Business requirements, Technical requirements) are normal tickets, also urgent.
- The acceptance and final verdict is the submit summary. It is compact: met or not met for each ticket against its
  acceptance criteria (acceptance) or each requirement id (final), a reason only for not met, the defect tickets. There is no verdict tool.
- A breakdown ticket blocks every ticket it creates, so triage and work start after SA approves the breakdown.

## 9. Sessions and tools

Each session works on one ticket (a triage session on a batch). The status sets the session kind; the kind sets the
tools. Every session also gets `ticket_get`, `ticket_list` and `milestone_list`.

| Status | Kind | Member | Tools | Writes files |
|---|---|---|---|---|
| Triage | triage (§9.1) | PM | `accept`, `reject`, `duplicate`, `ask` (batch tickets only) | no |
| Todo, In Progress | work | assignee | `submit_review`, `ask`, `ticket_create`, `subticket_create` (the last two not PM; `subticket_create` not on a sub-ticket), the role's file tools, the ticket kind's tools | yes (ticket branch) |
| In Review | review | each pending reviewer | `approve`, `request_changes`, `ask`, `review_diff` (normal, requirements and summary tickets), `milestone_diff` (TL/SA on acceptance and summary), `ticket_create` (PM defects on acceptance) | no |
| Needs Reply | reply | the assignee (answerer) | `answer`, `forward` (DEV: `answer` only) | no |

- Kind tools in a work session: breakdown (`ticket_create` to Triage, `ticket_edit`, `ticket_drop`,
  `set_dependencies`), roadmap (milestone tools; their descriptions ask for a short name, two to four words, without the milestone id), acceptance and summary (`milestone_diff` for TL and SA). An SA work
  session has no `exec` on a requirements ticket. A TL breakdown work session has only `read` and `list`: no `exec`.
- Stop tools end the session: `submit_review`, `ask`, `answer`, `forward`, `approve`, `request_changes`. A triage `ask` does not end the session.
- Read-only sessions run on a detached checkout. Code discards their changes and logs `git.discarded`. A work
  session on a requirements parent is also read-only.
- Each session has a step cap (`max_steps` in the definition). At the cap code logs `session.capped` and runs one
  wrap-up step that offers only the session's stop tools (tool choice required). So a capped session can still
  submit, ask, answer or decide its review.
- **Dirty-worktree guard:** in a session without write tools, the first stop call with a dirty worktree fails ("your
  role does not change files; call again to discard them"). The next stop call discards the changes and goes on.
- An invalid tool input fails the call; the session log keeps the full validation error.
- A session ends with `session.ended`, which carries its final text.

### 9.1 Triage in batches

One PM triage session takes every unblocked Triage ticket at once (no cap). So the PM plans a whole breakdown in
one pass and can give a chain of dependent tickets to one member. A Triage ticket blocked only by other Triage tickets joins the batch; one blocked by a ticket outside Triage waits.

- System prompt: the org line, the goal and the members; no grid, documents or active milestone lines.
- Context: the business summary; the roadmap with the active milestone marked; the batch (per ticket: id, title,
  label, creator, preset milestone, the description cut at `limits.triage_chars` (default 300) characters with its continuation lines indented, its dependencies, its comments); the open tickets of
  the batch's milestones with status and assignee; the team load (each DEV with its open tickets).
- `ticket_get` reads a full ticket. The session only triages.
- `ask` sends one ticket to BA or TL in Needs Reply; the PM goes on with the other tickets.
- A ticket left in Triage at the end counts a no-op (§10.2) and goes into the next batch. A ticket that reaches
  Triage during the session waits for the next batch.

## 10. The cycle

### 10.1 Steps

The runner runs the cycle on every tick (about 1 s) with a free session slot. A change from outside a session,
such as a human answer or cancel, is picked up at the next tick.

1. Settle: drain the event bus (flow automation, §12.1). The cycle reads a settled state only.
2. Scan the open tickets in this order and collect the sessions they need: Triage (one PM batch), Needs Reply
   (the answerer), Todo and In Progress (the assignee), In Review (each pending reviewer; skip a ticket whose
   reviewers all approved, the merge is pending).
3. Skip: blocked tickets (any status; a Triage ticket blocked only by other Triage tickets joins the batch, one
   blocked by a ticket outside Triage waits), tickets with open sub-tickets, Todo outside the active milestone, a dev's
   new Todo ticket while it has a ticket In Progress, members and tickets with a running session, backoffs. Two
   reviewers may review one ticket at the same time.
4. Give the free slots in this order: Needs Reply > In Review > In Progress > Todo > Triage. Inside one status:
   priority, then manual order.
5. The rest is the queue (meta `queue`). The board shows it.

### 10.2 Failures, no-ops and idle

- **Transient failure** (HTTP 429, 5xx, a malformed 2xx, a connection error, an empty answer, a stream cut): the
  ticket backs off. Base delay `limits.retry_seconds` (30 s), doubling, at most `limits.retry_max_seconds`
  (600 s). It does not count as a no-op.
- **Stream cut:** a stream that ends with finish reason "other" or "unknown" ends the turn as incomplete. The
  session logs `session.failed` "stream cut: …". Cause seen on live runs: a gateway closes the stream cleanly at
  300 s. undici's own 300 s timeouts raise an error instead.
- **No-op cap:** a session that ends with no transition on its ticket counts a no-op for that member and ticket
  (another failure counts too). After `limits.noop_sessions` (default 3) in a row, the system moves the ticket to Needs Reply for `human` with a
  note: the member, the count and the last session's final text. The human answers (an empty text means "try
  again"); the ticket returns to its stored status and the count resets. Only this ticket waits.
- **Idle:** no session runs and the scan finds nothing to start. When an approval is open or a ticket waits for
  the human, the org waits (meta `waiting`; the board shows "waiting for human"). Otherwise the org pauses
  (reason `idle`) with a digest of the open tickets.

## 11. Instructions

Each role gets a role card written for this design (`prompt.ts`):

- the cell of the role, what it owns, what it decides, and what it never does
- whom it talks to, and the path up the grid. A member with one neighbour routes all else through it. One question line per card (the DEV card has no git line: the file rules hold it)
- what its context contains and what it must not look for (a DEV does not read business documents)
- for BA and SA: keep the summary short, accurate and in step with the full document
- per session kind (triage, work, review, reply): the steps and the stop tool
- per system ticket kind: a process block for the work session and a checklist for the review
- the TL card has no breakdown rules; the breakdown process block holds them

The definition's own `system` prompt comes first and adds style and domain.

## 12. Engine

### 12.1 Event bus

- The event log in SQLite (`~/.maihem/orgs/NAME/org.db`) is the source of truth. Sessions run as separate
  processes and write events to the same file (WAL mode).
- Handlers (`flow.ts`) read the events after a cursor stored in the tracker and return commands as data. The runner
  executes them. They do automation only: starting work, sub-tickets, approvals, merges, milestone completion,
  system tickets, tags, fail-fast review. No handler creates a session; the cycle does (§10).
- The cursor moves past an event only after all its commands ran. A crash re-reads that event; each handler checks
  the current state first, so a re-read has no second effect.
- A command that fails pauses the org on its event. Approve skips the event; reject stops the org.

### 12.2 Changes during work

- **A new blocking link** on an In Progress ticket (not the final ticket, §7): code stops the session, commits the work and moves the ticket
  to Todo with a system note.

## 13. Git

- The org repo must be a git repository. Its current branch at start is main. An empty repo gets an initial
  commit by `maihem`.
- Each member has its own worktree under `~/.maihem/orgs/NAME/worktrees/<member>`. Nobody works in the main
  checkout.
- A work session runs on the ticket branch `t-<n>-<slug>`, created from main at the first work session.
- **Merge from main before rework:** a work session on an existing branch starts with main merged into it. A
  conflict leaves the markers in the files and writes a system comment that names the files and the main commits
  that changed them.
- **Merge from main at submit:** `submit_review` commits the work, then merges main into the branch. A conflict
  refuses the submit and writes the comment "main changed <files> since your branch; MAIHEM merges main into your
  branch at your next session". It asks for no git.
- When a session ends, code commits its changes as the member (`member@org.maihem`).
- **Squash merge:** after all approvals, code squash-merges the branch into main, one ticket at a time. The commit
  is `T-n: title` with a `Reviewed-by:` line, authored by the assignee. Code then deletes the branch.
- A conflict at merge time sends the ticket back to In Progress with the same comment; the rework session starts
  with main merged (above).
- Before a checkout in a member's worktree, code discards leftover changes and logs `git.discarded`; no pause.
- A dirty main checkout pauses the org before a merge. A failed git command pauses the org; approve retries it.
- **Milestone tags:** when a milestone completes (`milestone.completed`, M0 included), code tags main with the
  milestone id (`M0`, `M1`, …), an annotated tag by `maihem` with the message `<id> <name>`, and logs `git.tagged`.
  An existing tag is not recreated. When the repo has a remote named `origin`, code pushes the tag; a failed push
  only logs `git.push_failed` and the org goes on. A failed tag pauses the org like any git command.
- The members never run git.
- **Stray files:** the work prompt says to delete scratch files (test inputs, outputs, scripts) before submit. The
  review prompt says to request changes for stray files. No code guard checks them.

## 14. Limits and pauses

`limits` (§3.1): `parallel`, `tokens`, `review_rounds`, `noop_sessions`, `retry_seconds`, `retry_max_seconds`,
`triage_chars`. A pause opens an approval in the inbox. Approve resumes the org; reject stops it.

| Pause | Trigger | Approve |
|---|---|---|
| Tokens | the run used more than `limits.tokens` | adds another `limits.tokens` |
| Git | a failed checkout, commit, discard or merge; a dirty main checkout | retries |
| Command | a bus command failed on an event | skips the event |
| Idle | nothing can run and nothing waits for the human (§10.2) | resumes |

- One pause at a time. A problem found while paused waits for the resume.
- The board header shows the status, the run time without pauses (⏱), and the tokens used (input + output)
  against the current limit, e.g. `running · ⏱ 1h 02m · tokens 2M / 3M (↑ 2M / ↓ 19.8k)`. The milestones list keeps the active milestone in view and marks a completed one with ✓. A
  busy member shows how long its session has run; a triage session shows "triaging". Todo and Needs Reply share
  one column, "Todo / Reply"; a Needs Reply ticket has the marker `?`. The board shows the queue.
- The board is interactive: a focus moves over milestones, tickets, members and inbox items; Enter opens a ticket,
  a milestone, an approval or question thread (`/approve [note]`, `/reject TEXT`, plain-text answers), or a
  member's session read-only (live over its socket, else a replay of `agents/<id>.events.jsonl`). ANSI colors
  carry the state: green live or approved, yellow waiting, red failed, rejected or stopped.
- `org start` moves the previous run's tracker to `~/.maihem/orgs/NAME/history/`.
- `org resume` continues a stopped org on its tracker: it logs `org.resumed`, keeps the raised token limit and wakes the open tickets. It refuses a done org or an org that never ran.

## 15. The human

- The human approves the requirement documents, answers questions from BA and SA, answers no-op parks, decides
  pauses, and approves the final result.
- `maihem org inbox ORG` lists the approvals and the tickets waiting for the human.
- `maihem org answer ORG T-n TEXT` answers a ticket in Needs Reply (empty text: try again).
- `maihem org cancel ORG T-n REASON` and `maihem org assign ORG T-n MEMBER` act on any open ticket.
- `maihem org approve ORG Q-n` and `maihem org reject ORG Q-n` decide an approval.
- `maihem org board ORG` does the same from the inbox: an approval or a question opens as a thread with an input
  line.
- The org must run for answers to take effect.

## 16. Audit

Every tracker change is an event with its actor and time: status (from, to), assignee (`ticket.assigned {from,
to}`), priority, milestone, description, title (`ticket.title`), reviewers and approvals, summary, question
(`ticket.question`), comment (`ticket.comment`), branch, merge, `session.ended {text}`, `org.paused {reason}`.

- `maihem org log ORG --ticket T-n` shows one ticket's history; `-f` follows the log.
- `maihem org ticket ORG T-n` shows the ticket, its comments and its history.

## 17. Deferred and open

- A waiting `ask`: the session keeps its context and waits for the answer when free slots exist.
- Parallel review: every reviewer decides, then the ticket goes back with all findings together.
- PM reassignment and PM cancel (today only the human reassigns or cancels).
- Work stealing: an idle member of the same role takes a waiting ticket (`issues.md`, Open: one dev takes every ticket).
- Separate step caps per session kind, a token cap per session.
- Description edit history. Other roles, such as QA.
- `ticket_create` in a reply session (not PM): the answerer files work it finds outside the question, then still
  answers. Tried and reverted on 2026-10-20. Drawbacks: more tickets ("investigate X" instead of an answer); no
  link from the asker's ticket to the new ticket, so the asker does not wait for it; while the final ticket is
  open, the new ticket blocks it; the answerer does not see the open tickets, so duplicates reach triage.
- No cap on final acceptance rounds: each round can file new defects. Watch the round count on live runs.
- Open: the slot order puts Triage last. Check on a live run that triage does not starve while Todo work keeps
  the slots full.
- Open: the defaults of the no-op cap, the review-round cap, the backoff and the summary-file caps are first guesses.
