# MAIHEM

Multiple Agent In Harness Execution Manager. A CLI that runs AI agents the way Docker runs containers.

- A **provider** holds the connection to a model API: kind, endpoint, key.
- A **definition** is a stored agent configuration: provider, model, prompt, tools, limits.
- An **agent** is a running instance of a definition, like a container.
- An **org** is a declared development department: members with fixed roles, a ticket tracker with milestones and review, and an inbox for you.
- The agent loop runs on your machine. Its sandbox is a [cloudflare/computer](https://github.com/cloudflare/computer) workspace: a durable filesystem plus a `just-bash` shell inside a local `wrangler dev` worker. No Docker needed.

## Requirements

- Node 26 or newer. The CLI runs TypeScript directly, there is no build step.
- For an `ollama` provider, a running Ollama. For `openai` or `anthropic`, an API key.

## Install

```bash
npm install
npm link -w @maihem/cli   # puts `maihem` on PATH
maihem --version
```

`npm link` creates a symlink to this checkout. There is no build step, so `git pull` or any local change takes effect at once.

## Uninstall

```bash
maihem ps                       # stop running agents first: maihem stop <id>
maihem worker stop              # stop the sandbox worker, if it runs
npm uninstall -g @maihem/cli    # removes `maihem` from PATH
rm -rf ~/.maihem                # optional: delete definitions, providers, agent state and logs
```

## Quick start

```bash
# load the example providers and definitions (local-helper, reviewer, writer, translator)
maihem apply -f examples/stack.yaml

# one-shot task, sandboxed, in the current directory
maihem run local-helper "summarise README.md into SUMMARY.md"

# same, but with real bash and real files in the current directory
maihem run --no-sandbox local-helper "run the tests and fix the failing one"

# task from a pipe, answer to a file
cat task.md | maihem run local-helper > answer.md

# chain agents: the second gets the first answer as its input
maihem run local-helper "write a haiku about pipes" | maihem run translator "French"

# task argument plus piped input
git diff | maihem run reviewer "review this diff"

# task in the background; the agent stops itself when the task ends
maihem run -d local-helper "add tests for src/util.ts"

# chat with an agent; the first message is optional (reviewer needs ANTHROPIC_API_KEY)
maihem launch reviewer "review the last commit"
maihem launch -d reviewer       # start it without opening the chat

maihem ps
maihem attach <id>
maihem logs <id>
maihem stop <id>                # copies sandbox work back; --discard skips that
maihem prune                    # remove stopped agents and their data
```

## Providers

A provider holds the connection settings. Definitions refer to it by name.

```bash
maihem provider add --name ollama --kind ollama
maihem provider add --name lab --kind openai --base-url http://gpu-box:8000/v1 --api-key '$LAB_KEY'
maihem provider add --name work --kind anthropic --api-key sk-ant-... --header X-Team=infra
maihem provider update lab --header 'Authorization=Bearer ${LAB_TOKEN}'
maihem provider update lab --unset base_url     # repeatable; base_url | api_key | headers
maihem provider ls
maihem provider inspect work                    # plain keys and header values are masked
maihem provider rm lab                          # refuses while a definition uses it; -f forces
```

| Option | Meaning |
|---|---|
| `--kind` | `openai`, `anthropic` or `ollama`. Fixed after `add`. |
| `--base-url` | Endpoint, e.g. an Ollama host or an OpenAI-compatible server |
| `--api-key` | A key or a reference, stored in `~/.maihem/providers/<name>.yaml` (mode 0600) |
| `--header K=V` | Extra HTTP header, repeatable |

- References: `$VAR` or `${VAR}` in `--api-key` and `--header` values reads the env var at run time. `$$` is a literal `$`. An unset var fails the run and names it.
- To store a reference, put it in single quotes: `--api-key '$OPENAI_API_KEY'`. Without quotes, the shell inlines the value, and the key is stored in plain text.
- Without `--api-key`, the key comes from `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Ollama needs no key.
- Definitions store only the provider name. A `provider update` applies to every definition at its next run.

## Definitions

A definition is a stored agent configuration. `run` and `launch` start an agent from it by name.

```bash
maihem definition add --name reviewer --provider anthropic --model claude-sonnet-5-5 --tools read,list --max-steps 30
maihem definition update reviewer --reasoning medium --no-sandbox
maihem definition update reviewer --unset sandbox # repeatable; the default applies again
maihem definition ls
maihem definition inspect reviewer
maihem definition rm reviewer
```

- `add` and `update` take one option per field (see the reference below): `--system`, `--tools a,b`, `--no-sandbox`, `--max-steps`, `--reasoning`, `--context`, `--on-context-full`, `--compact-at`, `--sandbox-exclude a,b`.
- The provider must exist. Else `add` and `update` fail with the `maihem provider add` command to fix it.

### Tools

| Tool | Does |
|---|---|
| `read` | Read a text file |
| `write` | Write a text file, creating parent directories |
| `edit` | Replace one unique occurrence of a text in a file |
| `list` | List a directory (`ls -la`) |
| `exec` | Run a shell command. In the sandbox, the shell is `just-bash` (see Sandbox mode). |

A definition without `tools` gets all five. Paths are relative to the working directory (`/workspace` in the sandbox).

## Configuration file

`maihem apply -f FILE` loads providers, definitions and orgs from one YAML or JSON file:

- `providers:`, `definitions:` and `orgs:` are maps. Each key is the name; its value holds the settings. All maps are optional, but one must have entries.
- `apply` creates each entry, or replaces it fully if it exists.
- It checks all entries before it saves one. Unknown fields are errors.
- It saves the providers first, then the definitions, then the orgs. A definition can use a provider from the same file. The `orgs:` shape is in Orgs.
- A plain `api_key` works but prints a warning. Use a reference like `$LAB_KEY` in files under version control.

Every field, with its default:

```yaml
providers:
  lab:
    kind: openai                  # required: openai | anthropic | ollama
    base_url: http://gpu-box:8000/v1   # optional
    api_key: $LAB_KEY             # optional: a key or a $VAR reference; default OPENAI_API_KEY / ANTHROPIC_API_KEY
    headers:                      # optional; values may hold $VAR references
      X-Team: infra

definitions:
  reviewer:
    provider: lab                 # required: a registered provider or one from this file
    model: gpt-6-luna             # required
    system: |                     # optional system prompt
      You review code in the working directory.
    tools: [read, list, exec]     # default: all five
    sandbox: true                 # default true
    max_steps: 50                 # default 50
    reasoning: medium             # optional: none | minimal | low | medium | high | xhigh | max
    context: 64k                  # optional: token budget that MAIHEM tracks; not sent to the provider; 64000 or 64k
    on_context_full: compact      # compact (default) | fail
    compact_at: 0.8               # default 0.8: compact at this part of the budget
    sandbox_exclude: [dist/]      # optional: more paths to keep out of the sandbox (see Sandbox mode)
```

- `reasoning` is the AI SDK reasoning level. Each provider maps it to its own setting. Models without reasoning ignore it.
- `context` sets the budget for the chat's context gauge and for compaction. Without it, MAIHEM compacts only when the provider reports an overflow.
- Compaction: the same model summarises the older messages. The newest messages (about 25% of the budget) stay unchanged.
- `on_context_full: fail` ends the turn with "context full" instead.

```bash
maihem apply -f examples/stack.yaml
```

## Running agents

```bash
maihem run NAME [TASK] [-d] [--no-sandbox] [--workdir DIR] [--max-steps N] [--allow-empty]
maihem launch NAME [FIRST_MESSAGE] [-d] [--no-sandbox] [--workdir DIR] [--max-steps N]
```

- `run` does one task and stops. The task comes from the argument or from a pipe. `run -d` runs it in the background; `attach` then shows a read-only view.
- `launch` starts a chat agent and opens the chat. `launch -d` starts it without the chat.
- The working directory is `--workdir` or the current directory. `--no-sandbox` and `--max-steps` apply to this run only. They do not change the definition.
- A running agent keeps a copy of its definition and provider settings. Later `update` or `rm` commands do not affect it.

| Command | Does |
|---|---|
| `maihem ps` | List agents: ID, name, status, sandbox, workdir, start time |
| `maihem attach ID` | Open the chat of a running agent |
| `maihem logs ID` | Print the agent's log |
| `maihem stop [--discard] ID` | Stop the agent. A sandboxed agent copies its work back first, unless `--discard`. |
| `maihem prune [-f]` | Remove stopped agents, their state and their sandbox data. Asks first; `-f` skips the question. |

### Pipes

`run` reads a task argument, piped input, or both. With both, the agent gets one message: the task, then the piped text in an `<input>` block.
In a pipe, `run` writes only the final answer to stdout. If the final step has no text, the run ends with exit code 2 and `agent finished without output` on stderr. `--allow-empty` makes that a success (exit 0), for agents that only change files. With a task argument, empty piped input is an error (exit 1). So a failed agent earlier in a chain stops the next one. The agent ID, tool lines and notices go to stderr.
The `translator` definition has no tools and a strict prompt, so its answer is always the reply text. Use the same pattern for other pipe steps.
With a task argument, `run` reads stdin only from a pipe or a file (`< FILE`).

### Limits and exit codes

| Limit | Chat (`launch`) | One-shot (`run`, `run -d`) |
|---|---|---|
| `max_steps` | Notice in the chat. Send a message to continue. | One last step without tools summarises the work. Exit code 2. In an org session the last step offers only the stop tools, so the session can still submit (models that reject forced tool use, such as Claude Fable 5.1 and Opus 5.5, get them as a normal choice). |
| Stream cut (the stream ends without a finish reason) | Notice in the chat | Exit code 2 |
| Output limit (answer cut) | Notice in the chat | Exit code 2 |
| Context full (`fail` policy or after a failed compaction) | Notice in the chat | Exit code 2 |
| No output (final step without text) | — | Exit code 2, unless `--allow-empty` |

- Exit codes: 0 done, 1 error, 2 incomplete. The reason goes to stderr.
- `maihem ps` shows the reason, for example `idle (step limit)` or `exited (step limit)`.
- Provider errors show the HTTP status and the number of attempts.
- MAIHEM retries rate limits, server errors and broken streams 2 times. A failed turn keeps its finished steps.

## Orgs

An org is a small development department of agents. You give it a goal. The members write the requirements, plan a roadmap of milestones, break each milestone into tickets, and build the result. Every change lives on its own ticket branch. The ticket's reviewers check it, and an approved branch is squash-merged into main. Through the inbox, you answer the questions that reach you and approve the requirements and the final result.

The full design is in [docs/org-design.md](docs/org-design.md).

```bash
maihem apply -f examples/org.yaml                 # providers, definitions and the demo org
mkdir -p ~/maihem-demo && git -C ~/maihem-demo init
maihem org start demo "a CLI that converts CSV to JSON"
maihem org board demo                             # live board
```

### The grid

Each role sits in one cell of a grid. The level sets the scope. The track sets the kind of content.

| Level | Business track | Technical track |
|---|---|---|
| Strategic: the whole product | `ba` | `sa` |
| Project: all milestones | `pm` | `tl` |
| Cycle: one task inside a milestone | — | `dev` |

| Role | Owns and decides |
|---|---|
| `ba` | Business requirements and the business summary. The final acceptance. |
| `sa` | Technical requirements and the tech summary. Blocking links. Reviews every breakdown. |
| `pm` | The roadmap and Triage: milestone, priority and assignee of each new ticket (the grid sets the reviewer), in one batch session. Writes no files. |
| `tl` | The breakdown of each milestone into tickets. Reviews every dev ticket. The technical milestone acceptance. Writes no code. |
| `dev` | The code of one ticket, its tests and its documentation. |

- Every org has all five roles. BA, SA and PM have one member each. TL and DEV can have several.
- A member asks a grid neighbour with `ask`: up and down its track and across its level. The ticket goes to Needs Reply. The answerer answers, or forwards up the track: DEV → TL → SA → you, PM → BA → you. You answer with `maihem org answer`.
- Each role loads a small context at session start: its own documents and short summaries of its neighbours. A DEV never sees the business documents.
- The role sets the duties, the tools and the rules. They are built in.
- The definition sets the model, the style prompt and the step cap. The level sets the default reasoning: strategic `high`, project `medium`, cycle `low`. A `reasoning` field in the definition overrides it.

```yaml
orgs:
  demo:
    repo: ~/maihem-demo             # a git repository; its current branch is main
    members:                        # name: { role, definition }
      ba: { role: ba, definition: business-analyst }
      sa: { role: sa, definition: solution-architect }
      pm: { role: pm, definition: project-manager }
      tl: { role: tl, definition: tech-lead }
      dev1: { role: dev, definition: developer }
      dev2: { role: dev, definition: developer }
    limits: { parallel: 2, tokens: 2M }   # defaults: 1, no token limit
```

`limits` also takes `review_rounds` (3), `noop_sessions` (3), `retry_seconds` (30), `retry_max_seconds` (600) and `triage_chars` (300). A token count (`context`, `limits.tokens`, `--context`) takes a case-insensitive short form: `10k` = 10,000, `1.5M` = 1,500,000.

The grid sets the reporting line, so there is no `reports_to`. One exception: with several TLs, each DEV names its TL, for example `dev1: { role: dev, definition: developer, reports_to: tl2 }`.

### Lifecycle

1. **Requirements.** `org start` creates milestone M0. BA writes `docs/business-requirements.md` and `docs/business-summary.txt`; SA reviews. Then SA writes `docs/technical-requirements.md` and `docs/tech-summary.txt`; BA reviews. A summary has at most 4,000 characters.
2. **Your approval.** You approve the four files in one inbox item. Reject sends your text to BA and SA as two urgent update tickets.
3. **Roadmap.** PM writes the milestones in order, each with its business scope and the requirement ids it covers. BA reviews coverage, TL reviews feasibility. A done milestone cannot change.
4. **Each milestone:**
   1. TL breaks the milestone into tickets with dependencies. SA reviews the breakdown.
   2. The breakdown tickets wait in Triage. PM triages them in one batch: milestone and assignee. The grid sets the reviewer: DEV → TL, BA → SA, SA → BA. The devs build them. TL reviews each ticket.
   3. When the work is done, TL accepts the milestone technically and PM reviews it against the business requirements. Defects become new tickets. A milestone whose breakdown creates no tickets still gets this acceptance: TL checks that main already serves its requirements.
   4. If the milestone had work, SA updates the tech summary and cleans runtime data out of the repo (`.gitignore`). TL reviews.
5. **Final acceptance.** BA checks the product against the business requirements; SA does the technical check. Then you approve. Approve ends the org. Reject starts a "Plan change" milestone: BA and SA update the documents, you approve them, and PM extends the roadmap. A changed requirement or a defect gets a new id (the old one is marked replaced), and PM plans the new ids in new milestones.

Code creates these steps as urgent tickets, so the flow does not depend on the models.

### Tickets

A ticket has a status, a label (`bug` or `other`), a priority, an assignee, reviewers, a milestone, an optional parent, and relations (blocks, related, duplicate). Each action has its own tool, and the tool checks the guards. A member cannot set a wrong status by accident.

| Status | Who moves the ticket here |
|---|---|
| Triage | A member creates a ticket, or a TL breakdown creates it. It waits for the PM's triage batch. |
| Needs Reply | The assignee or a reviewer asks a question (`ask`). The ticket goes to the answerer and returns after `answer`. The system also parks a ticket here for you after 3 sessions with no progress. |
| Todo | PM accepts a Triage ticket with a milestone and an assignee. Sub-tickets and system tickets start here. |
| In Progress | The system, when the assignee's work session starts. A change request or a merge conflict also sends the ticket back here. |
| In Review | The assignee submits with a summary. There must be a reviewer. |
| Done | The system, after every reviewer approves. It squash-merges the branch first. |
| Canceled | PM rejects a Triage ticket, or you cancel any open ticket with `maihem org cancel`. |
| Duplicate | PM, in Triage. |

- Done, Canceled and Duplicate are final. Nobody reopens a closed ticket.
- Comments are a flat list. Only transitions and system notes write them: questions, answers, findings, reasons.
- A blocked ticket gets no work session and cannot be submitted.
- A milestone is a set of tickets with a completion percentage. The active milestone is the first one that is not complete. Work runs only on its tickets.
- A dev's ticket always has a TL reviewer. Only the owner changes a requirements document or a summary.
- Each submit resets all approvals. One change request sends the ticket back at once and stops the other reviews.

### Commands

```bash
maihem org start demo "GOAL"                       # start the org daemon
maihem org stop demo
maihem org resume demo                             # continue a stopped org on its tracker, with the first goal
maihem org board demo                              # timers, tokens vs limit, milestones, tickets, members, inbox, events
maihem org log demo -f                             # event feed
maihem org log demo --ticket T-3                   # one ticket's history
maihem org inbox demo                              # approvals and the tickets waiting for you
maihem org answer demo T-3 "plain commas only"     # answer a question; empty text: try again
maihem org cancel demo T-3 "out of scope"
maihem org assign demo T-3 dev2
maihem org approve demo Q-2                        # or: maihem org reject demo Q-2 -m "add error handling"
maihem org ticket demo T-3                         # fields, reviewers, relations, description, comments and history
maihem org tickets demo --milestone M1 --status todo
maihem org milestones demo                         # completion per milestone; marks the active one
maihem org ls | inspect NAME | rm NAME
```

- The org must run for `answer`, `approve` and `reject` to take effect.
- `--status` takes `triage`, `needs_reply`, `todo`, `in_progress`, `in_review`, `done`, `canceled` or `duplicate`.

### Sessions, limits and pauses

- Each member has its own worktree under `~/.maihem/orgs/NAME/worktrees/<member>`. Work happens on one branch per ticket (`t-3-login-form`). Nobody works in the main checkout, and the members never run git.
- The ticket status sets the session kind and its tools: triage (PM, one batch of Triage tickets), work (Todo, In Progress: the assignee), review (In Review: each pending reviewer), reply (Needs Reply: the answerer). Only a work session can write files. The changes of other sessions are discarded.
- A session ends with its stop tool: `submit_review`, `ask`, `answer`, `forward`, `approve` or `request_changes`.
- MAIHEM merges main into the branch at submit and before a rework session. A conflict leaves the markers in the files and writes a comment for the assignee.
- `exec` in an org session runs with `HOME` set to `~/.maihem/orgs/NAME/home`, so a product under test never touches your real home directory. `PATH` stays.
- When a session ends, MAIHEM commits its changes as the member. An approved branch is squash-merged into main with a `Reviewed-by:` line.
- The cycle runs on every tick with a free slot. It scans the open tickets and starts the sessions they need. Slot order: Needs Reply, In Review, In Progress, Todo, Triage; then priority. The rest waits in the queue on the board.
- The cycle skips blocked tickets, parents with open sub-tickets, Todo outside the active milestone, a dev's new ticket while it has one In Progress, and busy members and tickets. A member runs one session at a time. At most `parallel` sessions run in the org.
- A transient provider failure (429, 5xx, an empty answer, a stream cut) backs the ticket off: `retry_seconds`, doubling, at most `retry_max_seconds`.
- No-op cap: after `noop_sessions` sessions in a row with no transition, the ticket goes to Needs Reply for you with a note. Answer it (empty text: try again) or cancel it.
- Review-round cap: after `review_rounds` change requests since the last answer, the ticket goes to Needs Reply for the reviewer's manager (SA and BA: you).
- Before a checkout in a member's worktree, MAIHEM discards leftover changes. A session without write tools that left changes must call its stop tool twice: the second call discards them.
- Idle: when an approval or a ticket waits for you, the org waits ("waiting for human" on the board). Otherwise it pauses with a digest of the open tickets.
- These pause the org with an approval in your inbox: a run over `tokens`, a failed bus command, a dirty main checkout or a failed git command, and idle. Approve continues. Reject stops the org.
- `org start` moves the previous run's tracker to `~/.maihem/orgs/NAME/history/`.

Use strong models for org members. Results on the same goal (a CLI todo app; details in `issues.md`):

| Models | Result |
|---|---|
| Claude Fable 5.1 (BA, SA) and Opus 5.5 (PM, TL, DEV) | Done in 40 min, 5.5M input tokens; requirements and final result approved at once |
| Nemotron 3.5 Super (all roles) | Done in 4.5 h, 4.3M input tokens, one plan change |
| Nemotron 3.5 Lightning, Qwen 3.5 9B | Stuck: shallow reviews, duplicate tickets, breakdown loops, hand debugging instead of tests |

## Chat

The chat is full screen. The header shows the agent, the footer shows key hints, and `?` lists all keys.

| Key | Action |
|---|---|
| Enter | send the message |
| Esc | interrupt the running turn; when idle, leave the chat |
| Ctrl+C | stop question: stop the agent or leave it running |
| Ctrl+D | detach; the agent keeps running |
| Ctrl+O | switch between the simplified and the detailed view |
| PgUp / PgDn, Shift+↑ / ↓, Home / End | scroll the chat |

- The detailed view adds full tool input and output, model thinking, timestamps, model steps, tokens, time and generation speed (tok/s) per turn, and rate limits.
- The spinner shows the elapsed time, output tokens and the current generation speed.
- The footer shows the context gauge, for example `ctx 12.3k/64k · 19%`. It turns yellow at 70% and red at 90%.

Leaving the chat asks `Stop agent <id>? [y/N]`.
Any answer other than y detaches, and the agent keeps running.
For a sandboxed agent, y then asks `Apply changes to <workdir>? [Y/n]`.
n discards the sandbox work.

## Sandbox mode

- `maihem run` and `maihem launch` start the worker on first use (`maihem worker start|stop|status` to manage it).
- At start, every regular file of the working directory is copied to `/workspace`. The directory does not have to be a git repository.
- Symlinks are skipped and never followed. A link to a file outside the working directory cannot leak.
- More than 20,000 files or 1 GB stops the start with the counts. Exclude paths or use `--no-sandbox`.
- At exit, only the files that the agent changed are copied back. Files are never deleted on the host.
- If you change a file on the host while the agent changes it too, your copy stays. The agent's copy goes next to it as `<file>.sandbox`, and the run prints a `conflict:` line.
- The shell is `just-bash` in an isolate: `cat`, `grep`, `sed`, `awk`, `jq`, `curl` work. `npm`, `node`, `python` do not. Use `--no-sandbox` for those.

### Excludes

Put the paths to keep out of the sandbox in `.maihemignore` in the working directory. Add per-agent paths with the definition field `sandbox_exclude`.

```
# .maihemignore
node_modules/
.venv/
target/
.env*
# with a slash: only from the working directory root
docs/tmp
```

- A pattern without a slash matches at any depth. A pattern with a slash starts at the working directory. A trailing `/` makes no difference.
- Patterns are globs (`*`, `**`, `?`). A line that starts with `#` is a comment; there are no comments after a pattern. There is no `!` negation.
- Excluded paths are not copied in, not counted, and never copied back, even when the agent creates them.
- Secrets: the agent can read every copied file and send it to the model provider. Exclude `.env` files and keys.

## State

Everything lives under `~/.maihem` (override with `MAIHEM_HOME`):

- `providers/<name>.yaml`, `definitions/<name>.yaml`, `orgs/<name>.yaml`
- `orgs/<name>/org.db` (tickets, milestones, comments, inbox, events), `orgs/<name>/org.log`, `orgs/<name>/worktrees/<member>`, `orgs/<name>/home` (the `HOME` of org sessions), `orgs/<name>/history/`
- `agents/<id>.json` (state), `agents/<id>.log`, `agents/<id>.run.json` (while the agent runs)
- `worker.json`, `worker.log`

Agent sockets live in the system temp directory (`maihem-<id>.sock`), because macOS limits socket paths to 104 bytes.

## Development

```bash
npm test                 # unit tests with coverage
npm run test:integration # spawns wrangler dev, needs network for workerd on first run
npm run typecheck
```

## Caveats

- `@cloudflare/computer` is a preview package (v0.x). Its API may change.
- Docker Agent (`docker agent run`) covers a similar CLI surface. MAIHEM's point is the Cloudflare workspace sandbox.
