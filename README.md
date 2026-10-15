# MAIHEM

Multiple Agent In Harness Execution Manager. A CLI that runs AI agents the way Docker runs containers.

- A **provider** holds the connection to a model API: kind, endpoint, key.
- An **image** is a stored agent definition: provider, model, prompt, tools, limits.
- An **agent** is a running instance of an image, like a container.
- The agent loop runs on your machine. Its sandbox is a [cloudflare/computer](https://github.com/cloudflare/computer) workspace: a durable filesystem plus a `just-bash` shell inside a local `wrangler dev` worker. No Docker needed.

## Requirements

- Node 26 or newer. The CLI runs TypeScript directly, there is no build step.
- `git` on PATH. Sandbox mode copies the working directory with `git ls-files`.
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
rm -rf ~/.maihem                # optional: delete images, providers, agent state and logs
```

## Quick start

```bash
# load the example providers and images (local-helper, reviewer, writer, translator)
maihem apply -f examples/stack.yaml

# one-shot task, sandboxed, in the current git repo
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

A provider holds the connection settings. Images refer to it by name.

```bash
maihem provider add --name ollama --kind ollama
maihem provider add --name lab --kind openai --base-url http://gpu-box:8000/v1 --api-key '$LAB_KEY'
maihem provider add --name work --kind anthropic --api-key sk-ant-... --header X-Team=infra
maihem provider update lab --header 'Authorization=Bearer ${LAB_TOKEN}'
maihem provider update lab --unset base_url     # repeatable; base_url | api_key | headers
maihem provider ls
maihem provider inspect work                    # plain keys and header values are masked
maihem provider rm lab                          # refuses while an image uses it; -f forces
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
- Images store only the provider name. A `provider update` applies to every image at its next run.

## Images

An image is a stored agent definition. `run` and `launch` start an agent from it by name.

```bash
maihem image add --name reviewer --provider anthropic --model claude-sonnet-5-5 --tools read,list --max-steps 30
maihem image update reviewer --reasoning medium --no-sandbox
maihem image update reviewer --unset sandbox    # repeatable; the default applies again
maihem image ls
maihem image inspect reviewer
maihem image rm reviewer
```

- `add` and `update` take one option per field (see the reference below): `--system`, `--tools a,b`, `--no-sandbox`, `--max-steps`, `--reasoning`, `--context`, `--on-context-full`, `--compact-at`.
- The provider must exist. Else `add` and `update` fail with the `maihem provider add` command to fix it.

### Tools

| Tool | Does |
|---|---|
| `read` | Read a text file |
| `write` | Write a text file, creating parent directories |
| `edit` | Replace one unique occurrence of a text in a file |
| `list` | List a directory (`ls -la`) |
| `exec` | Run a shell command. In the sandbox, the shell is `just-bash` (see Sandbox mode). |

An image without `tools` gets all five. Paths are relative to the working directory (`/workspace` in the sandbox).

## Configuration file

`maihem apply -f FILE` loads providers and images from one YAML or JSON file:

- `providers:` and `images:` are maps. Each key is the name; its value holds the settings. Both maps are optional, but one must have entries.
- `apply` creates each entry, or replaces it fully if it exists.
- It checks all entries before it saves one. Unknown fields are errors.
- It saves the providers first, then the images. An image can use a provider from the same file.
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

images:
  reviewer:
    provider: lab                 # required: a registered provider or one from this file
    model: gpt-6-luna             # required
    system: |                     # optional system prompt
      You review code in the working directory.
    tools: [read, list, exec]     # default: all five
    sandbox: true                 # default true
    max_steps: 50                 # default 50
    reasoning: medium             # optional: none | minimal | low | medium | high | xhigh | max
    context: 64000                # optional: token budget that MAIHEM tracks; not sent to the provider
    on_context_full: compact      # compact (default) | fail
    compact_at: 0.8               # default 0.8: compact at this part of the budget
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
- The working directory is `--workdir` or the current directory. `--no-sandbox` and `--max-steps` apply to this run only. They do not change the image.
- A running agent keeps a copy of its image and provider settings. Later `update` or `rm` commands do not affect it.

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
The `translator` image has no tools and a strict prompt, so its answer is always the reply text. Use the same pattern for other pipe steps.
With a task argument, `run` reads stdin only from a pipe or a file (`< FILE`).

### Limits and exit codes

| Limit | Chat (`launch`) | One-shot (`run`, `run -d`) |
|---|---|---|
| `max_steps` | Notice in the chat. Send a message to continue. | One last step without tools summarises the work. Exit code 2. |
| Output limit (answer cut) | Notice in the chat | Exit code 2 |
| Context full (`fail` policy or after a failed compaction) | Notice in the chat | Exit code 2 |
| No output (final step without text) | — | Exit code 2, unless `--allow-empty` |

- Exit codes: 0 done, 1 error, 2 incomplete. The reason goes to stderr.
- `maihem ps` shows the reason, for example `idle (step limit)` or `exited (step limit)`.
- Provider errors show the HTTP status and the number of attempts.
- MAIHEM retries rate limits, server errors and broken streams 2 times. A failed turn keeps its finished steps.

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
- At start, every file that `git ls-files --cached --others --exclude-standard` lists is copied to `/workspace`.
- At exit, new and changed files are copied back, unless you discard them. Files are never deleted on the host.
- The shell is `just-bash` in an isolate: `cat`, `grep`, `sed`, `awk`, `jq`, `curl` work. `npm`, `node`, `python` do not. Use `--no-sandbox` for those.

## State

Everything lives under `~/.maihem` (override with `MAIHEM_HOME`):

- `providers/<name>.yaml`, `images/<name>.yaml`
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
