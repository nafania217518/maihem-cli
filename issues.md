# Org issues and live runs

This file holds the open items, the deferred items, the model observations and the live-run history. The design
is in [docs/org-design.md](docs/org-design.md); its §17 lists the deferred design items.

## Open

1. **No prompt caching.** MAIHEM sets no cache breakpoints, so every step re-sends the whole conversation at full
   input price. Run 28 (Claude) cost about $45 at list price; the SA's summary and review sessions took 2.62M of
   the 5.53M input tokens. Fix: cache breakpoints for providers that support them (Anthropic).
2. **Owned files are checked only at submit (run 25).** The write and edit tools let a role change a file another
   role owns; `submit_review` then refuses, and a member without git cannot revert it (a 1.27M-token loop). The
   SA review rule (judge only the business documents) removed the trigger in runs 26–28. Fix if it comes back:
   refuse the write at write time, or let `submit_review` revert foreign files.
3. **Questions that need `exec` reach the human (runs 25, 27).** Reply and review sessions have no `exec`, so
   "run the tests" questions get forwarded up to the human. The rule "an answer cannot run commands" did not stop
   it on lightning (run 27). Option: `exec` for the TL breakdown work.
4. **The BA's final verdict is not checked (run 24).** The BA marked a BR "met" without running the command; the
   live test found it unbuilt. The final acceptance has no `exec` for the BA; the SA's technical check is the only
   run.
5. **One dev takes every ticket (runs 18, 28).** dev2 never ran: triage assigned all work to dev1, so `parallel: 2`
   gave no parallel dev work.
6. **Weak models debug by hand (runs 25, 27).** Lightning devs looped on `exec` (add, export, read, edit) instead
   of writing a unit test: up to 7.5M tokens in one session. Option: a step or token cap per session kind.
7. **Final acceptance rounds have no cap.** Each round can file new defects. No run has looped on it yet.
8. **Reply sessions have no own step cap (run 16).** Reply sessions have no `exec` and the rule "use the fewest
   tool calls". Option if it comes back: a lower step cap for reply sessions.

## Deferred

- **Confine `exec` (run 16).** `exec` runs on the host with no path limit: a member can run git or read another
  member's worktree. Org sessions get a scratch `HOME`, but only the rules forbid the rest. Fix: confine `exec`
  and the file tools to the member's worktree and refuse git commands.
- **Grouped sessions (run 11).** One session for several tickets of the same kind (for example, the TL reviews all
  waiting tickets at once). Trade-off: one worktree per session against fewer sessions and less re-sent context.
- **Request budget per minute (run 14).** Today 429s are handled with 5 retries, base 10 s, doubling, with jitter.
- **Work stealing, a waiting `ask`, parallel review, PM reassignment and cancel, `ticket_create` in reply
  sessions:** see docs/org-design.md §17.

## Model observations

- **Claude Fable 5.1 (BA, SA) + Opus 5.5 (PM, TL, dev)** (run 28): the only setup with the requirements and the
  final result approved at once. Complete first-draft documents (exact command syntax, error contract, test data
  setting, edge cases), 105 tests, every live-test case passed, 40 min. Both models reject forced tool use and
  budget thinking; @ai-sdk/anthropic 4.0.79 maps them (see CLAUDE.md caveats).
- **nemotron-3.5-super** finishes, but needs the human: thin first drafts (one-line TRs, no command syntax, no
  error contract), 1–2 gate rejections and live-test defects. Rate-limited above about 2 parallel sessions.
- **nemotron-3.5-lightning** cannot run an org: shallow reviews (3–4k tokens), re-creates milestones and tickets
  instead of editing them, breakdown loops (the TL tried to write code), hand-debugging dev sessions of millions of
  tokens. Runs 20, 21, 25 and 27.
- GLM (z-ai/glm-5.3-flash) follows the rules but is slow (sessions of 6–50 min). gemma4:12b loops in tool-heavy
  sessions. gpt-oss-20b drifts and hits harmony parse errors. Small local models (9B) do not follow the roles.

## Lessons that shaped the design

- **The ticket status decides who acts** (runs 14–17): threads, mentions, PM turns and wake repair cost more than
  the work. A cycle reads the tracker; a question is a status (Needs Reply).
- **Code drives the lifecycle** (runs 11–13): the requirements gate, roadmap, breakdown, acceptance, summary and
  final are system tickets, so the flow does not depend on the model.
- **Every defect needs a path to a ticket** (runs 22, 24, 26): a changed requirement gets a new id, new ids go to
  new milestones, and a done milestone cannot change. Before this, run 24 needed four plan changes (10.44M
  tokens); after it, run 26 needed one (4.26M).
- **A milestone with an empty breakdown still gets the acceptance** (run 24): the missing `filter` command reached
  the final review because nobody checked the milestone's TRs.
- **Products under test must not touch the user's home** (runs 24, 25): agents opened `~/.todo.db`. Org `exec`
  runs with a scratch `HOME`, and the SA names the test data setting.
- **Name commands that run on this host** (runs 22, 26): `python` vs `python3` cost 19 failed calls in run 22.
- **The human's live test finds what the reviews miss** (runs 22, 24, 26): every non-Claude run that reached the
  final review had defects that all reviews and acceptances had passed.

## Live runs

Runs 11–18: "a CLI that converts CSV to JSON". Runs 19–28: "a CLI todo app with SQLite storage: tags, due dates,
recurring tasks, search, CSV and JSON export". Parallel 2.

| Run | Date | Model | Time | Input tokens | Result |
|---|---|---|---|---|---|
| 11 | 2026-10-18 | nemotron-3.5-super | 68 min | 2.6M | stopped, M1 at 4 of 5 tickets |
| 12 | 2026-10-18 | nemotron-3.5-super | 94 min | 2.15M | stopped, M0–M2 done |
| 13 | 2026-10-18 | nemotron-3.5-super | 44 min | 1.11M | org.done |
| 14 | 2026-10-20 | nemotron-3.5-super | 32 min | 0.46M | stopped on a 429 loop |
| 15 | 2026-10-20 | nemotron-3.5-super | 80 min | 1.49M | stopped, M2 repeated M1 |
| 16 | 2026-10-20 | nemotron-3.5-super | 2 h 17 min | 3.10M | org.done |
| 17 | 2026-10-20 | GLM glm-5.3-flash | 10 h 19 min | 2.52M | stopped in M3 of 4 |
| 18 | 2026-10-20 | nemotron-3.5-super | 37 min | 0.77M | org.done (status workflow) |
| 19 | 2026-10-20 | nemotron-3.5-super | 107 min | 6.27M | org.done (7 milestones, 42 tickets) |
| 20 | 2026-10-20 | nemotron-3.5-lightning | 7 h 11 min | 32.41M | org.done (6 milestones, 41 tickets) |
| 21 | 2026-10-20 | nemotron-3.5-lightning | 3 h 27 min | 9.0M | stopped in M1 (TL acceptance loop) |
| 22 | 2026-10-20 | nemotron-3.5-super | 3 h 27 min | 4.94M | M0–M5 done; final rejected (2 defects); stopped in the plan change |
| 23 | 2026-10-21 | nemotron-3.5-super | 58 min | 0.97M | stopped in M1 (prompt review run) |
| 24 | 2026-10-22 | nemotron-3.5-super | 314 min | 10.44M | done after 4 plan changes; defects had no path to a ticket |
| 25 | 2026-10-22 | nemotron-3.5-lightning | 183 min | 26.54M | stopped in M2 (breakdown loop) |
| 26 | 2026-10-22 | nemotron-3.5-super | 265 min | 4.26M | done after 1 plan change (fixes after runs 24–25) |
| 27 | 2026-10-22 | nemotron-3.5-lightning | 74 min | 11.54M | stopped in M2 (breakdown loop) |
| 28 | 2026-10-22 | fable-5-1 (BA, SA), opus-5-5 (PM, TL, dev) | 40 min | 5.53M | done; gate and final approved at once; ~$45 at list price |
