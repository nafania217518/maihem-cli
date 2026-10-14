# @maihem/worker

Cloudflare Worker + Durable Object. It hosts one `@cloudflare/computer` Workspace per agent id, with the `worker-shell` backend.
The CLI talks to it over HTTP on localhost through `wrangler dev`.

Run: `npm run dev -w @maihem/worker`

Routes:
- `GET /health` -> `ok`
- `PUT|GET /w/:id/file/workspace/<path>` -> write bytes (204) / read bytes (404 when missing)
- `GET /w/:id/files` -> `[{path, size, mtime}]` for every file under `/workspace`
- `POST /w/:id/exec` `{command, cwd?}` -> `{stdout, stderr, exitCode}`

Caveats:
- `@cloudflare/computer` is PREVIEW ONLY (v0.x, APIs unstable).
- `worker-shell` is just-bash, not bash: no npm/node/python binaries inside the sandbox.
