# MAIHEM

Multiple Agent In Harness Execution Manager. A CLI that runs AI agents the way Docker runs containers.

- A **definition** (YAML or JSON) is the image.
- A **running agent** is the container.
- The agent loop runs on your machine. Its sandbox is a [cloudflare/computer](https://github.com/cloudflare/computer) workspace: a durable filesystem plus a `just-bash` shell inside a local `wrangler dev` worker. No Docker needed.

## Requirements

- Node 26 or newer. The CLI runs TypeScript directly, there is no build step.
- `git` on PATH. Sandbox mode copies the working directory with `git ls-files`.
- For `provider: ollama`, a running Ollama. For `openai` or `anthropic`, an API key.

## Install

```bash
npm install
npm link -w @maihem/cli   # puts `maihem` on PATH
```

## Quick start

```bash
# one-shot task, sandboxed, in the current git repo
maihem run -f examples/ollama.yaml "summarise README.md into SUMMARY.md"

# same, but with real bash and real files in the current directory
maihem run --no-sandbox -f examples/ollama.yaml "run the tests and fix the failing one"

# task from a pipe
cat task.md | maihem run -f examples/ollama.yaml

# task in the background; the agent stops itself when the task ends
maihem run -d -f examples/ollama.yaml "add tests for src/util.ts"
maihem attach <id>        # read-only view while the task runs

# chat with an agent; the first message is optional
maihem launch -f examples/anthropic.yaml --api-key sk-ant-... "review the last commit"
maihem launch -d reviewer # start it without opening the chat
maihem ps
maihem attach <id>
maihem logs <id>
maihem stop <id>          # copies sandbox work back; --discard skips that
```

The chat is full screen. The header shows the agent, the footer shows key hints, and `?` lists all keys.

| Key | Action |
|---|---|
| Enter | send the message |
| Esc | interrupt the running turn; when idle, leave the chat |
| Ctrl+C | stop question: stop the agent or leave it running |
| Ctrl+D | detach; the agent keeps running |
| Ctrl+O | switch between the simplified and the detailed view |
| PgUp / PgDn, Shift+↑ / ↓, Home / End | scroll the chat |

The detailed view adds full tool input and output, timestamps, model steps, and tokens and time per turn.

Leaving the chat asks `Stop agent <id>? [y/N]`.
Any answer other than y detaches, and the agent keeps running.
For a sandboxed agent, y then asks `Apply changes to <workdir>? [Y/n]`.
n discards the sandbox work.

## Definitions

```yaml
name: reviewer
provider: anthropic            # openai | anthropic | ollama
model: claude-sonnet-5-5
base_url: http://localhost:11434   # optional, for ollama or openai-compatible servers
system: |
  You review code in the working directory.
tools: [read, write, edit, list, exec]   # pick any subset
sandbox: true                  # default true
max_steps: 50                  # default 50
api_key: sk-...                # optional
```

API key precedence: `--api-key` flag, then `api_key` in the definition, then `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

## Registry

```bash
maihem build -f examples/anthropic.yaml --api-key sk-ant-...   # store under its name
maihem images
maihem inspect reviewer     # api_key is masked
maihem run reviewer "review the last commit"
maihem rmi reviewer
```

`run` and `launch` accept three sources: `-f FILE`, a registry `NAME`, or inline flags
`--provider P --model M [--system S] [--tools a,b] [--base-url U]`.

## Sandbox mode

- `maihem run` and `maihem launch` start the worker on first use (`maihem worker start|stop|status` to manage it).
- At start, every file that `git ls-files --cached --others --exclude-standard` lists is copied to `/workspace`.
- At exit, new and changed files are copied back, unless you discard them. Files are never deleted on the host.
- The shell is `just-bash` in an isolate: `cat`, `grep`, `sed`, `awk`, `jq`, `curl` work. `npm`, `node`, `python` do not. Use `--no-sandbox` for those.

## State

Everything lives under `~/.maihem` (override with `MAIHEM_HOME`): `images/`, `agents/<id>.json|.log|.sock`, `worker.json`, `worker.log`.

## Development

```bash
npm test                 # unit tests with coverage
npm run test:integration # spawns wrangler dev, needs network for workerd on first run
npm run typecheck
```

## Caveats

- `@cloudflare/computer` is a preview package (v0.x). Its API may change.
- Docker Agent (`docker agent run`) covers a similar CLI surface. MAIHEM's point is the Cloudflare workspace sandbox.
