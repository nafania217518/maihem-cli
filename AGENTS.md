At session start, load the armory `core` skill when its rules are not in your context.

# maihem-cli

## What this is

MAIHEM (Multiple Agent In Harness Execution Manager) is a CLI that runs AI agents the way Docker runs containers: providers, definitions, agents and orgs work like a Docker-style registry. The agent loop runs on your machine; its sandbox is a cloudflare/computer workspace inside a local `wrangler dev` worker.

## Commands

Format: `<check>: <command>`; `implement` section Gates per commit says how to run
them.

- lint: npm run typecheck
- unit: npm test
- integration: npm run test:integration
- coverage: npm test
- run: node packages/cli/bin/maihem.js

## Gates

Format: `<gate>: on`, or `<gate>: off <reason>`.

- lint: on
- owasp: off no command
- unit: on
- integration: on
- coverage: on
- contract: off (not chosen)
- functional: off (not chosen)
- e2e: off (not chosen)

## Test levels

Only what this project adds to or changes in the armory `test` skill, section Levels.

Unit style: sociable

## Tracker

Format: `<verb>: <binding>`, one line per bound verb of the armory `core` skill,
section Host terms, term `tracker`, then `target: <the project's own tracker>`, then
`closes by PR merge: <no | the closing reference form, e.g. Closes #<id>>`, then,
with the label verbs bound, `label <role>: <label>`, one per role of the armory
`triage` skill.

- read an item: gh issue view <n> --repo nafania217518/maihem-cli --comments --json number,title,body,labels,state,assignees,comments
- list an item's children: gh api repos/nafania217518/maihem-cli/issues/<n>/sub_issues (order, state, assignees); blockers per child: gh api repos/nafania217518/maihem-cli/issues/<child>/dependencies/blocked_by
- create an item: gh issue create --repo nafania217518/maihem-cli --title <title> --body-file <file>
- edit an item body: gh issue edit <n> --repo nafania217518/maihem-cli --body-file <file>
- link a child to its parent: gh api -X POST repos/nafania217518/maihem-cli/issues/<parent>/sub_issues -F sub_issue_id=<child issue id>
- add a blocked-by edge: gh api -X POST repos/nafania217518/maihem-cli/issues/<n>/dependencies/blocked_by -F issue_id=<blocker issue id>
- claim: gh issue edit <n> --repo nafania217518/maihem-cli --add-assignee @me
- comment: gh issue comment <n> --repo nafania217518/maihem-cli --body-file <file>
- set status open: gh issue reopen <n> --repo nafania217518/maihem-cli
- set status done: gh issue close <n> --repo nafania217518/maihem-cli --reason completed
- set status dropped: gh issue close <n> --repo nafania217518/maihem-cli --reason "not planned"
- list items: gh issue list --repo nafania217518/maihem-cli --state <open|closed|all> --label <label>
- list labels: gh label list --repo nafania217518/maihem-cli
- set labels: gh issue edit <n> --repo nafania217518/maihem-cli --add-label <label> --remove-label <label>
- create label: gh label create <label> --repo nafania217518/maihem-cli
- target: GitHub Issues, nafania217518/maihem-cli
- closes by PR merge: Closes #<id>
- label needs-triage: needs-triage
- label needs-info: question
- label accepted: accepted
- label bug: bug
- label enhancement: enhancement

## Rules

Project-only rules. The armory skills hold the rest.

- Documentation lives in docs/
- Each researched claim MUST rest on at least 4 sources.

## Glossary

Format: `Term : one-line meaning`, plus `. Avoid: <synonyms>` when a synonym was rejected.
A line MUST hold only a term of the project's domain, with no implementation detail.

- Skill : a folder of instructions, scripts and reference files that an agent loads on demand

## Caveats

Format: the caveat line of the armory `core` skill, section Reports

- cloudflare/computer is PREVIEW ONLY (v0.x, APIs unstable) : packages/worker/README.md
- worker-shell is just-bash, not bash; no npm/node/python inside the sandbox : packages/worker/README.md
- Docker Agent covers the same CLI surface; MAIHEM's point is the Cloudflare workspace : README.md
- Node 26 strips types but does not compile JSX; the Ink UI uses React.createElement in .ts : packages/cli/src/ui/App.ts
- macOS caps unix socket paths at 104 bytes; agent sockets live in os.tmpdir(), not MAIHEM_HOME : packages/cli/src/state.ts
- marked-terminal 7 needs marked <16, and @types/marked-terminal pins marked <12; marked is pinned to 15 with a local type declaration : packages/cli/src/types/marked-terminal.d.ts
- Ink 8 alternateScreen hides terminal scrollback; the attach TUI scrolls the chat itself (PgUp/PgDn, Home/End) : packages/cli/src/ui/App.ts
- ollama@0.6.4 ignores the abort signal that ai-sdk-ollama passes; model.ts calls client.abort() through stream middleware so an interrupt cancels the request : packages/cli/src/model.ts
- Ollama MLX models ignore num_ctx and never report an overflow; MAIHEM tracks the context budget itself (`context` field) : packages/cli/src/compact.ts
- ToolLoopAgent cannot take streamRetries or per-step toolChoice; the agent loop calls streamText directly : packages/cli/src/agent.ts
- Sandbox copy goes file by file over the worker HTTP API (~2 ms per file); a 20,000-file / 1 GB guard and .maihemignore keep it usable : packages/cli/src/sync.ts
- The org tracker uses node:sqlite (built in, no flag on Node 26) in WAL mode; sessions and the org daemon write to one file : packages/cli/src/org/tracker.ts
- Small local models (9B) do not follow org roles: they skip the PM, leave tickets unassigned, act on others' tickets : README.md
- Claude Fable 5.1 / Opus 5.5 reject forced tool use and budget thinking; @ai-sdk/anthropic 4.0.79 turns toolChoice "required" into "auto" and reasoning into adaptive thinking + effort : packages/cli/src/agent.ts
- Org exec runs with HOME = ~/.maihem/orgs/NAME/home, so products under test never write the user's real home : packages/cli/src/backend-host.ts
- Retries: 5 per request with exponential backoff (base 10 s, doubling) and jitter in model.ts; the AI SDK's own maxRetries is 0 (its streamRetries only re-runs mid-stream errors) : packages/cli/src/model.ts
- Each agent event is appended to ~/.maihem/agents/ID.events.jsonl for the board's replay; one line per text delta : packages/cli/src/daemon.ts
- The lint gate runs the TypeScript type check; the project has no linter : package.json
- The git remote is named upstream, not origin; armory `<base>` falls back to the local master : —
- The sub-issue and blocked-by tracker bindings were not tried on a live item; the repo had no issues at setup : AGENTS.md
- Coverage thresholds apply per file (perFile), so each module must reach 90% on its own : vitest.config.ts
- Skills are frozen per agent at start into ~/.maihem/agents/<id>.skills/; skill update and rm never touch a running agent : packages/cli/src/skills.ts
- The skill tool reads files on the host, also in sandbox mode; skill scripts run only in host mode : packages/cli/src/skills.ts
- Skill folders are copied with verbatimSymlinks, because Node's default rewrites relative symlinks to absolute paths into the source folder : packages/cli/src/skills.ts
- The skill catalog is appended in buildAgent, so org sessions get it although the org replaces def.system : packages/cli/src/run.ts
- Compaction re-inserts the latest result of each skill call after the summary, so a large skill can keep the context above compact_at : packages/cli/src/compact.ts
- definition update fails while a listed skill is missing (as for a missing provider), even when the update does not touch skills : packages/cli/src/main.ts
- An empty front matter block parses to null under yaml 2.9.1; skills.ts reads it as no fields : packages/cli/src/skills.ts
- skill rm -f during an org run stops the org daemon at the next session spawn; org/daemon.ts spawn has no catch : packages/cli/src/org/daemon.ts
- loadSkill checks the name against SKILL_NAME before it touches the disk, so skill inspect ../x reports "no such skill" instead of reading outside the registry : packages/cli/src/skills.ts
- skill add and skill update copy through the hidden sibling folder .NAME.new (update also .NAME.old), and skill ls skips dot-folders : packages/cli/src/skills.ts
- A fresh worktree needs the ignored, generated packages/worker/worker-configuration.d.ts before the lint gate passes : packages/worker/tsconfig.json
- One registered SKILL.md that fails to parse makes skill ls fail, along with skill rm and skill update for that skill; only a manual delete clears it : packages/cli/src/skills.ts
- The TR-15 tests make a copy fail with a chmod 000 file, so they fail when the tests run as root : packages/cli/test/skills.test.ts
- The skill tool accepts file: "" and answers that the skill folder is a directory : packages/cli/src/skills.ts
- The skill catalog joins its <skill> entries with no newline between them : packages/cli/src/skills.ts
- A missing skill at run start reaches the user as exit code 1 and an error line on stderr; main catches the throw : packages/cli/src/main.ts
- A state saved with pid 0 always reads "running", because process.kill(0, 0) succeeds on the process group : packages/cli/src/state.ts
- The vitest text coverage report leaves out files at 100%; a module missing from it is fully covered : vitest.config.ts
- The AI SDK keeps input: null on an invalid tool call, because its non-object fallback treats null as an object : packages/cli/src/compact.ts
- spawnAgent closes the log fd in a finally block and removes the whole state when deps.spawn throws : packages/cli/src/run.ts
- Node spawn reports ENOENT, EACCES, EAGAIN and EMFILE through a later error event, so the spawnAgent catch covers only rare spawn errors that throw at once : packages/cli/src/run.ts
- When the update rollback rename also fails, the skill stays only at the hidden .NAME.old, and ls and update no longer see it : packages/cli/src/skills.ts
