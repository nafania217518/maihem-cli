# CLAUDE.md

## Rules

1. Write replies and documentation "80% of the way to ASD-STE100" (Simplified Technical English): short sentences (about 20 words max), one idea per sentence, active voice, present tense, one approved meaning per word, no idioms, no filler. Do not go full STE: keep natural phrasing and domain terms where strict STE would read awkwardly.
2. KISS: keep it simple.
3. TDD approach for coding: Requirement -> Test -> Code. The requirement is the test name. New requirement = new test. The task is done when all requirements have tests and all tests pass.
4. Use low-effort sub-agents to write code. Instruct them to follow the TDD approach and give them the necessary set of requirements and instructions.
5. Tests must pass. Coverage must be no less than 90% per core functionality module.
6. Tests for every feature, no exceptions. Every feature ships with its test(s) unless the user explicitly states otherwise for that feature.
7. TDD on bug reports. When the user reports a bug, first add test(s). Only after those tests reproduce the bug, fix it.
8. TDD: tests are the only proof code works. All code must have test coverage via unit tests and/or functional, integration, browser, or end-to-end tests. Frontend: unit and/or browser tests. Backend: unit and/or integration tests. Both are acceptable per surface.
9. NEVER use `nohup` or `command &` to start a background task. Such tasks cannot be tracked and cause unexpected errors. ALWAYS start background tasks through the tools (`run_in_background=true`) so the task stays tracked and can be stopped with the corresponding stop tools.
10. Do not use the built-in web search. It is broken. Use the `mcp-browser` MCP tools to search the web and read sites.
11. You may have outdated information. Do research with `mcp-browser` and check at least 4 sources for each claim you make. Put anything worth noticing under the Caveats section below in the format `SHORT_DESCRIPTION : file_reference.md`.

## Caveats
- cloudflare/computer is PREVIEW ONLY (v0.x, APIs unstable) : packages/worker/README.md
- worker-shell is just-bash, not bash; no npm/node/python inside the sandbox : packages/worker/README.md
- Docker Agent covers the same CLI surface; MAIHEM's point is the Cloudflare workspace : README.md
- Node 26 strips types but does not compile JSX; the Ink UI uses React.createElement in .ts : packages/cli/src/ui/App.ts
- macOS caps unix socket paths at 104 bytes; agent sockets live in os.tmpdir(), not MAIHEM_HOME : packages/cli/src/state.ts
