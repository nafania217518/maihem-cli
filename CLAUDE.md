# CLAUDE.md

## Rules

1. KISS: keep it simple.
2. TDD approach for coding: Requirement -> Test -> Code. The requirement is the test name. New requirement = new test. The task is done when all requirements have tests and all tests pass.
3. Use low-effort sub-agents to write code. Instruct them to follow the TDD approach and give them the necessary set of requirements and instructions.
4. Tests must pass. Coverage must be no less than 90% per core functionality module.
5. Tests for every feature, no exceptions. Every feature ships with its test(s) unless the user explicitly states otherwise for that feature.
6. TDD on bug reports. When the user reports a bug, first add test(s). Only after those tests reproduce the bug, fix it.
7. TDD: tests are the only proof code works. All code must have test coverage via unit tests and/or functional, integration, browser, or end-to-end tests. Frontend: unit and/or browser tests. Backend: unit and/or integration tests. Both are acceptable per surface.
8. You may have outdated information. Do research and check at least 4 sources for each claim you make. Put anything worth noticing under the Caveats section below in the format `SHORT_DESCRIPTION : file_reference.md`.
9. TDD on own findings. Every issue, problem, bug or other finding you find yourself MUST be fixed through the TDD process when you are asked to fix it or decide to fix it: first add test(s) that reproduce it, then fix it.
10. Existing tests change only within a defined scope. Before a change, define its scope and list the existing tests it will break or that need rework or removal (for example: removing a module removes its tests; renaming a label changes the tests that check that label). Give this list to the sub-agent: it may change or remove only the listed tests. A test that fails outside the list most likely points to a newly introduced bug: the sub-agent stops, investigates the root cause, and reports the test with proof that the failure is not its bug. Then decide: if the change is expected and the test was only missing from the scope, add it to the scope; if the change is not expected, escalate to the user before any test changes.

## Caveats
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
