# MAIHEM

Multiple Agent In Harness Execution Manager. A CLI that runs AI agents the way Docker runs containers.

- A **definition** (YAML or JSON) is the image.
- A **running agent** is the container.
- The agent loop runs on your machine. Its sandbox is a [cloudflare/computer](https://github.com/cloudflare/computer) workspace: a durable filesystem plus a `just-bash` shell inside a local `wrangler dev` worker. No Docker needed.

## Requirements

- Node 26 or newer. The CLI runs TypeScript directly, there is no build step.
- `git` on PATH. Sandbox mode copies the working directory with `git ls-files`.
- For an `ollama` provider, a running Ollama. For `openai` or `anthropic`, an API key.

## Install

```bash
npm install
npm link -w @maihem/cli   # puts `maihem` on PATH
```

`npm link` creates a symlink to this checkout. There is no build step, so `git pull` or any local change takes effect at once.

## Uninstall

```bash
maihem ps                       # stop running agents first: maihem stop <id>
maihem worker stop              # stop the sandbox worker, if it runs
npm uninstall -g @maihem/cli    # removes `maihem` from PATH
rm -rf ~/.maihem                # optional: delete images, providers, agent state and logs
```

## Quick start

```bash
# load the example providers and images (local-helper, reviewer, writer)
maihem apply -f examples/stack.yaml

# one-shot task, sandboxed, in the current git repo
maihem run local-helper "summarise README.md into SUMMARY.md"

# same, but with real bash and real files in the current directory
maihem run --no-sandbox local-helper "run the tests and fix the failing one"

# task from a pipe
cat task.md | maihem run local-helper

# chain agents: a piped run writes only its final answer to stdout
echo "write a haiku about pipes" | maihem run local-helper | maihem run local-helper

# task in the background; the agent stops itself when the task ends
maihem run -d local-helper "add tests for src/util.ts"
maihem attach <id>        # read-only view while the task runs

# chat with an agent; the first message is optional (reviewer needs ANTHROPIC_API_KEY)
maihem launch reviewer "review the last commit"
maihem launch -d reviewer             # start it without opening the chat
maihem ps
maihem --version
maihem attach <id>
maihem logs <id>
maihem stop <id>          # copies sandbox work back; --discard skips that
```

In a pipe, `run` writes only the final answer to stdout. The agent ID, tool lines and notices go to stderr.

The chat is full screen. The header shows the agent, the footer shows key hints, and `?` lists all keys.

| Key | Action |
|---|---|
| Enter | send the message |
| Esc | interrupt the running turn; when idle, leave the chat |
| Ctrl+C | stop question: stop the agent or leave it running |
| Ctrl+D | detach; the agent keeps running |
| Ctrl+O | switch between the simplified and the detailed view |
| PgUp / PgDn, Shift+↑ / ↓, Home / End | scroll the chat |

The detailed view adds full tool input and output, model thinking, timestamps, model steps, tokens, time and generation speed (tok/s) per turn, and rate limits.
The footer shows the context gauge, for example `ctx 12.3k/64k · 19%`. It turns yellow at 70% and red at 90%.

Leaving the chat asks `Stop agent <id>? [y/N]`.
Any answer other than y detaches, and the agent keeps running.
For a sandboxed agent, y then asks `Apply changes to <workdir>? [Y/n]`.
n discards the sandbox work.

## Definitions

```yaml
name: reviewer
provider: anthropic            # name of a registered provider
model: claude-sonnet-5-5
system: |
  You review code in the working directory.
tools: [read, write, edit, list, exec]   # pick any subset
sandbox: true                  # default true
max_steps: 50                  # default 50
reasoning: medium              # optional: none | minimal | low | medium | high | xhigh | max
context: 64000                 # optional: token budget that MAIHEM tracks; not sent to the provider
on_context_full: compact       # compact (default) | fail
compact_at: 0.8                # compact when the context reaches this part of the budget
```

- `reasoning` is the AI SDK reasoning level. Each provider maps it to its own setting. Models without reasoning ignore it.
- `context` sets the budget for the footer gauge and for compaction. Without it, MAIHEM compacts only when the provider reports an overflow.
- Compaction: the same model summarises the older messages. The newest messages (about 25% of the budget) stay unchanged.
- `on_context_full: fail` ends the turn with "context full" instead.

### Limits

| Limit | Chat (`launch`) | One-shot (`run`, `run -d`) |
|---|---|---|
| `max_steps` | Notice in the chat. Send a message to continue. | One last step without tools summarises the work. Exit code 2. |
| Output limit (answer cut) | Notice in the chat | Exit code 2 |
| Context full (`fail` policy or after a failed compaction) | Notice in the chat | Exit code 2 |

Exit codes: 0 done, 1 error, 2 incomplete. The reason goes to stderr.
`maihem ps` shows the reason, for example `idle (step limit)` or `exited (step limit)`.
Provider errors show the HTTP status and the number of attempts.
MAIHEM retries rate limits, server errors and broken streams 2 times. A failed turn keeps its finished steps.

`provider` must name a registered provider, else the run fails with the `maihem provider add` command to fix it.
Definitions hold no endpoint and no key. A definition with `base_url` or `api_key` fails with a hint to move them to a provider.

## Providers

A provider holds the connection settings. Definitions and images refer to it by name.

```bash
maihem provider add --name ollama --kind ollama
maihem provider add --name lab --kind openai --base-url http://gpu-box:8000/v1 --api-key '$LAB_KEY'
maihem provider add --name work --kind anthropic --api-key sk-ant-... --header X-Team=infra
maihem provider update lab --header 'Authorization=Bearer ${LAB_TOKEN}'
maihem provider ls
maihem provider inspect work            # api_key and header values are masked
maihem provider update lab --base-url http://gpu-box:9000/v1
maihem provider update lab --unset base_url    # repeatable; base_url | api_key | headers
maihem provider rm lab                  # refuses while an image uses it; -f forces
```

To read a value from the env at run time, put it in single quotes: `--api-key '$OPENAI_API_KEY'`. Without quotes, the shell inlines the value, and the key is stored in plain text.

Providers can also come from a file; see "One file for everything" below.

A plain `api_key` in an apply file works but prints a warning; use a reference like `$LAB_KEY` instead.

| Setting | Meaning |
|---|---|
| `--kind` | `openai`, `anthropic` or `ollama`. Fixed after `add`. |
| `--base-url` | Endpoint, e.g. an Ollama host or an OpenAI-compatible server |
| `--api-key` | A key or a reference, stored in `~/.maihem/providers/<name>.yaml` (mode 0600) |
| `--header K=V` | Extra HTTP header, repeatable |
| References | `$VAR` or `${VAR}` in `--api-key` and `--header` values reads the env var at run time. `$$` is a literal `$`. |

- Without `--api-key`, the key comes from `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Ollama needs no key.
- An unset referenced env var fails the run and names the var.
- Images store only the provider name. A `provider update` applies to every image at its next run. A running agent keeps the settings it started with.

## Images

An image is a stored definition. `run` and `launch` start an agent from it by name.

```bash
maihem image add --name reviewer --provider anthropic --model claude-sonnet-5-5 --tools read,list --max-steps 30
maihem image update reviewer --reasoning medium --no-sandbox
maihem image update reviewer --unset sandbox   # repeatable; the default applies again
maihem image ls
maihem image inspect reviewer
maihem run reviewer "review the last commit"
maihem image rm reviewer
```

- The provider must exist. `add` and `update` fail with the `maihem provider add` command to fix it.
- `update --unset FIELD` removes the field. The definition default applies again.
- A running agent keeps a copy of its image. `image rm` does not affect it.

`run` and `launch` start an image by name. Add images with `maihem image add` or `maihem apply -f FILE`. Run-time options: `-d`, `--no-sandbox`, `--workdir DIR`, `--max-steps N`; they do not change the image.

### One file for everything

`maihem apply -f FILE` reads a `providers:` map and an `images:` map. Both are optional, but one must have entries.
Each key is the name; its value holds the settings.
It creates each entry, or replaces it fully if it exists. It checks all entries before it saves one.
It saves the providers first, then the images. An image can use a provider from the same file.
Unknown fields are errors.

```yaml
providers:
  ollama:
    kind: ollama
images:
  local-helper:
    provider: ollama
    model: qwen3.5:9b-mlx
    tools: [read, write, edit, list, exec]
    max_steps: 30
```

```bash
maihem apply -f examples/stack.yaml
maihem launch local-helper
```

## Sandbox mode

- `maihem run` and `maihem launch` start the worker on first use (`maihem worker start|stop|status` to manage it).
- At start, every file that `git ls-files --cached --others --exclude-standard` lists is copied to `/workspace`.
- At exit, new and changed files are copied back, unless you discard them. Files are never deleted on the host.
- The shell is `just-bash` in an isolate: `cat`, `grep`, `sed`, `awk`, `jq`, `curl` work. `npm`, `node`, `python` do not. Use `--no-sandbox` for those.

## State

Everything lives under `~/.maihem` (override with `MAIHEM_HOME`): `images/`, `providers/`, `agents/<id>.json|.log|.sock`, `worker.json`, `worker.log`.

## Development

```bash
npm test                 # unit tests with coverage
npm run test:integration # spawns wrangler dev, needs network for workerd on first run
npm run typecheck
```

## Caveats

- `@cloudflare/computer` is a preview package (v0.x). Its API may change.
- Docker Agent (`docker agent run`) covers a similar CLI surface. MAIHEM's point is the Cloudflare workspace sandbox.
