# Plan: Add skills

Parent: [Add skills](https://github.com/nafania217518/maihem-cli/issues/1) (no milestone).

## Goal

Agents can use Agent Skills: folders of instructions, scripts and reference files. The user registers them once, and a definition names them. The agent loads them on demand.

## Requirements

The BR list is in the task item. Each test that proves a TR carries `// req: 1-add-skills/TR-n`. The items are in execution order. Gates: lint and unit on each commit (coverage 90% per file, `skills.ts` included); integration at task end, with no new case.

- TR-1 (BR-2): MUST parse a skill folder in the new `packages/cli/src/skills.ts`. `parseSkill(dir)` returns `{ name, description, body, dir }`.
  - **Front matter.** It is the block between a leading `---` line and the next `---` line. A BOM and CRLF line ends are accepted. It is parsed with `yaml`. An empty block means no fields. Unknown fields are ignored.
  - **Name.** It defaults to the folder's basename. The resolved name MUST match `SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/`, which is exported from `definition.ts`, and MUST be at most 64 characters.
  - **Description.** It defaults to the first non-empty body line, trimmed, with leading `#` characters and spaces removed.
  - **Errors.** It rejects:
    - `skill: no SKILL.md in DIR`
    - `skill: DIR/SKILL.md: front matter has no closing --- line`
    - `skill: DIR/SKILL.md: invalid front matter: <yaml message>; quote values that contain a colon, e.g. description: "Use when: ..."`
    - `skill: DIR/SKILL.md: front matter must be a map of field: value`
    - `skill: DIR/SKILL.md: "name" must be text`, and the same for `"description"`
    - `skill: invalid name "X": use lowercase letters, digits and single hyphens, at most 64 characters`
    - `skill "X": no description; add description: to the front matter or a first line to the body of SKILL.md`
  - tests: `test/skills.test.ts`, describe "parseSkill":
    - front matter with name and description gives both and the body without the front matter
    - no front matter: the folder name, and the first non-empty body line as the description
    - no description: the first body line, with a leading `# ` stripped
    - unknown fields accepted
    - an empty block counts as no fields
    - CRLF and BOM accepted
    - a name of 64 characters accepted, 65 refused
    - uppercase, double hyphen and leading hyphen refused
    - a bad folder name refused when the front matter has no name
    - no description and an empty body refused
    - invalid YAML refused with the YAML message and the colon hint (`description: Use when: x`)
    - an unclosed front matter refused
    - a list front matter refused
    - a non-text name refused
    - no SKILL.md refused
- TR-2 (BR-1): MUST make `maihem skill add PATH` parse PATH (TR-1) and copy the folder to `home()/skills/<name>/` with `fs.cpSync(…, { recursive: true, verbatimSymlinks: true })`, then print `added NAME`.
  - An existing name MUST fail with `skill "X" already exists; use maihem skill update X PATH`.
  - USAGE MUST list `skill add PATH`, `skill update NAME PATH`, `skill rm [-f] NAME`, `skill ls` and `skill inspect NAME`.
  - A missing argument MUST print the usage.
  - tests: `test/main.test.ts`, describe "skill":
    - add copies the folder with its subfolders under the resolved name
    - an existing name is refused with the update hint
    - a folder without SKILL.md fails and copies nothing
    - a relative symlink inside the folder stays relative
    - usage lists the subcommands
    - add without PATH prints the usage
- TR-3 (BR-3): MUST make `skill ls` print `NAME DESCRIPTION` through `pad`, sorted by name, with only the header for an empty registry. `skill inspect NAME` MUST print YAML with `name`, `description` and `files`: every file's relative path, sorted, `/` separators. An unknown name MUST fail with `no such skill: X; add it: maihem skill add PATH`.
  - tests: `main.test.ts`:
    - ls sorted
    - ls empty prints only the header
    - inspect shows the fields and the files
    - inspect of an unknown name fails with the add hint
- TR-4 (BR-3): MUST make `skill update NAME PATH` replace the registry copy (old files gone, new files present) and print `updated NAME`.
  - The parsed name MUST equal NAME, else `skill update: PATH holds skill "Y", not "X"`.
  - An unknown NAME MUST fail with the TR-3 error.
  - A refused PATH MUST leave the old copy unchanged: parse first, copy to a temp sibling, then swap.
  - tests: `main.test.ts`:
    - update replaces the copy and drops removed files
    - a different name is refused
    - an unknown name fails
    - a refused update keeps the old copy
- TR-5 (BR-4): MUST add the optional field `skills?: string[]` to `Definition`.
  - `validate` takes a list of distinct names that match `SKILL_NAME`, and sets the field only when given.
  - Errors: `definition: skills must be a list of skill names` and `definition: duplicate skill "X"`.
  - `skills` goes in `FIELDS`.
  - `definition add` and `update` take `--skills a,b` through `splitTools`. `skills` goes at the END of `DEF_UNSET`.
  - `definition add` and `update` call `loadSkill` for each name, next to `loadProvider` (main.ts:177).
  - `applyAll` checks every listed skill before it saves anything (main.ts:125).
  - `definition inspect` shows the field.
  - tests:
    - `definition.test.ts`:
      - a skills list is kept
      - a non-list is rejected
      - a duplicate is rejected
      - a bad name is rejected
      - no skills means no field
    - `main.test.ts`:
      - `--skills` and `--unset skills` work on add and update
      - add fails for an unregistered skill with the add hint
      - inspect shows skills
      - apply rejects an unregistered skill and saves nothing
    - `registry.test.ts`: `checkDefinitions` accepts `skills`
- TR-6 (BR-3): MUST make `skill rm [-f] NAME` refuse while a saved definition lists the skill: `skill "X" is used by definitions: a, b; use -f to remove it anyway`. `-f` MUST remove it. It prints `removed NAME`. An unknown name fails with the TR-3 error.
  - tests: `main.test.ts`:
    - refused while used, and `-f` forces
    - an unused skill is removed
    - an unknown name fails
- TR-7 (BR-5, BR-7): MUST add `freezeSkills(names, id)`.
  - It loads every named skill from the registry first. A missing one throws the TR-3 error.
  - It then copies each one to `home()/agents/<id>.skills/<name>/`, with `verbatimSymlinks`.
  - With no names, it creates no folder. A failure leaves no `<id>.skills` folder.
  - `runCommand` and `spawnAgent` MUST call it before `saveState`, so a missing skill leaves no state and spawns no child.
  - tests:
    - `skills.test.ts`:
      - copies under agents/ID.skills
      - no skills creates nothing
      - one missing skill copies nothing and names it
      - a later update does not change the frozen copy
    - `run.test.ts`:
      - run with a missing skill fails before the start and leaves no state
      - run -d and launch with a missing skill spawn nothing
      - spawnAgent freezes the named skills
- TR-8 (BR-5): MUST make `loadRunnable` (`org start`/`resume`, org/daemon.ts:49) refuse a member definition with a missing skill, with the TR-3 error, before the org daemon spawns.
  - tests: `org-daemon.test.ts`: loadRunnable refuses a member definition whose skill is missing.
- TR-9 (BR-10): MUST make `removeState` delete `agents/<id>.skills/` (state.ts:75, `recursive: true`).
  - tests: `state.test.ts`: removeState removes the frozen skills folder.
- TR-10 (BR-6, BR-7): MUST add `skillCatalog(skills)` and a last parameter `skills: Skill[] = []` on `buildAgent` (run.ts:67).
  - **Prompt.** `system` is `def.system` and the catalog, joined by a blank line, or the catalog alone when `def.system` is unset.
  - **Catalog text.** One instruction line: call the `skill` tool with a skill's name before a task that matches its description. Then `<available_skills><skill><name>…</name><description>…</description></skill>…</available_skills>`, with `& < > " '` escaped.
  - **No skills.** `system` stays exactly `def.system`.
  - **Callers.** `runCommand` passes the frozen skills. `serveAgent` reads them with `frozenSkills(id, def.skills ?? [])` from `agents/<id>.skills/`, never from the registry.
  - tests:
    - `skills.test.ts`: escaping
    - `run.test.ts`:
      - catalog after the system prompt
      - catalog alone without a system prompt
      - no skills leaves the system prompt unchanged
    - `daemon.test.ts`:
      - the daemon reads the frozen copy, not the registry
      - an org session gets the catalog after the org system prompt
- TR-11 (BR-6, BR-7): MUST add `createSkillTool(skills, …)`. It returns a `skill` tool with input `{ name: z.enum(names), file?: string }`. `buildAgent` adds it only when skills is non-empty, whatever `def.tools` holds. It reads only the frozen copy.
  - **Without `file`.** It returns `<skill_content name="N">`, the body without front matter, the location note (TR-12), then `<skill_resources>` with one `<file>rel/path</file>` per other file (sorted, not read), then `</skill_content>`. The resources block is left out when there are no other files.
  - **With `file`.** It returns the file's text.
  - **Errors.** Each is a string that starts with `error:`, never a throw (agent.ts:74 stop-tool check):
    - `error: file must be a path relative to the skill folder`
    - `error: FILE is outside the skill folder` (`..`, or a symlink whose realpath leaves the skill's realpath)
    - `error: FILE does not exist in skill "N"`
    - `error: FILE is a directory`
    - `error: FILE is not a text file` (the file holds a NUL byte)
  - tests:
    - `skills.test.ts`, describe "skill tool":
      - body in skill_content with resources
      - no resources block for a SKILL.md alone
      - returns a reference file
      - refuses an absolute path
      - refuses `..`
      - refuses a symlink that points outside
      - reports a missing file
      - reports a directory
      - refuses a binary file
      - the name schema accepts only the definition's skills
    - `run.test.ts`:
      - skill tool present even when tools lists none
      - no skill tool without skills
- TR-12 (BR-8): MUST add a location note to the skill content, chosen by the final `def` (after `--no-sandbox`; orgs force `sandbox: false`):
  - **`def.sandbox` false:** `Skill folder: <absolute frozen path>. Relative paths in this skill resolve against this folder; run its scripts there with exec.`
  - **`def.sandbox` true:** `Scripts in this skill cannot run in this sandbox. Load its reference files with skill({ name: "N", file: "<path>" }).`
  - tests:
    - `skills.test.ts`:
      - host mode names the frozen folder
      - sandbox mode says scripts cannot run and names the file argument
    - `run.test.ts`: run --no-sandbox gives the host note
- TR-13 (BR-9): MUST make `compact` (compact.ts:34) keep skill results from the summarized part.
  - **What it keeps.** For each key `name` + `file`, the latest `skill` tool-call part (from the assistant messages) and its tool-result part (matched by `toolCallId`).
  - **Where it puts them.** Right after the summary message: one assistant message with those tool-call parts, in original order, then one tool message with their results.
  - **What it drops.** A call without a result. With no skill result, it adds nothing.
  - **Constant.** The tool name comes from `SKILL_TOOL` in `skills.ts`.
  - tests:
    - `compact.test.ts`:
      - latest result per name and file kept after the summary
      - kept parts form an assistant tool-call message, then a tool message
      - another file of the same skill is kept too
      - a call without a result is dropped
      - results survive a second compaction
      - no skill calls gives the summary and the tail only (the existing case stays green)
    - `agent.test.ts`: after compaction, the next model request still holds the skill content
- TR-14 (BR-11): MUST add a `## Skills` section to README.md after `### Tools`. It covers:
  - the folder format and the lenient rules
  - the five commands
  - the `skills:` field and `--skills`
  - freeze at start
  - host-only scripts
  - trust: in host mode, a skill's scripts run with the user's rights

  It MUST also add `skills` to the Configuration file field list, and `skills/<name>/` and `agents/<id>.skills/` to State.
  - tests: none, prose; checked in review.

- TR-15 (BR-1): MUST make `skill add` copy to the hidden `.NAME.new` sibling and rename it to the target only after the copy succeeds; a failed copy MUST leave no `skills/NAME` folder and no `.NAME.new`. `addSkill` and `updateSkill` share one copy-then-rename helper. (Defect found in review of TR-2.)
  - tests: `skills.test.ts`:
    - a failed add copy leaves nothing registered and a retry succeeds
    - a failed update copy keeps the old copy and leaves no `.NAME.new` (covers skills.ts:82-83)
- TR-16 (BR-2): MUST treat a front-matter `name` or `description` whose value is null (`description:` with no value) as absent, so the defaults apply; MUST trim a given description, and an empty trimmed description MUST fall back to the first body line, else be refused with the TR-1 no-description error. (Defect found in review of TR-1.)
  - tests: `skills.test.ts`:
    - a blank `description:` falls back to the first body line
    - a blank `name:` falls back to the folder name
    - a whitespace-only description falls back, or is refused when the body is empty
    - a block (`|`) description loses its trailing newline

- TR-17 (BR-9): MUST make `compact` tolerate a `skill` tool call whose `input` is `null` (the AI SDK keeps it on an invalid call): read `name`/`file` from `p.input ?? {}`, so compaction still returns the summary. (Defect found in the final review of TR-13.)
  - tests: `compact.test.ts`: a skill call with `input: null` and a result does not break compaction

- TR-18 (BR-3): MUST make `skill update` roll back when the rename of `.NAME.new` to NAME fails: rename `.NAME.old` back to NAME and rethrow, so the old copy stays registered. (Amendment approved at the recorded-items quiz.)
  - tests: `skills.test.ts`: a failed final rename in update keeps the old copy registered
- TR-19 (BR-10): MUST make `spawnAgent` leave no state file and no `agents/<id>.skills` folder when `deps.spawn` throws: call `removeState` and rethrow. (Amendment approved at the recorded-items quiz.)
  - tests: `run.test.ts`: a spawn that throws leaves no state and no frozen skills folder

- TR-20 (BR-12): MUST attach an `error` listener to the child in `spawnAgent` that saves the state as exited with exitCode 1 and detail `spawn failed: <message>`. (Amendment approved during the task; BR-12 is in the task item.)
  - tests: `run.test.ts`: an async spawn error marks the state exited with the detail and does not throw

- TR-21 (BR-12): MUST make the org daemon's reap treat a session whose state is exited with detail `spawn failed: …` as a transient failure, with the same backoff as a `session.failed` event. The park message MUST name that detail. (Amendment approved during the task.)
  - tests: `org-daemon.test.ts`: a session that failed to spawn is reaped as a transient failure with backoff; after 3 failures, the park message names the spawn error
- TR-22 (BR-12): MUST make `maihem stop ID` on a state with no pid send no signal, exit 0, and leave the state exited. (Amendment approved during the task.)
  - tests: `main.test.ts`: stop of a state without a pid exits 0 and the state reads exited

- TR-23 (BR-10): MUST make `spawnAgent` save no placeholder pid before the child exists. It MUST also remove the state when any step before the spawn throws (run file write, log open), as TR-19 does for the spawn itself, so no state reads "running" forever. (Amendment approved during the task.)
  - tests: `run.test.ts`: a run-file write failure leaves no state; a log-open failure leaves no state; a state saved before the spawn has no pid

## Test scope

No existing case breaks, reworks or is removed. Three close calls:

- `main.test.ts` "definition update patches flags and --unset restores defaults" : rework only if `skills` is not last in DEF_UNSET : it matches the `--unset takes …` prefix
- `main.test.ts:120` saved-definition `toEqual` : no change : `skills` is set only when given
- `run.test.ts` "spawnAgent writes the org reference and the display name" : no change : no skills means no folder

## Risks

- **Compaction cost.** Large kept skill results can keep `used` above `compact_at × context`, so each step compacts again.
- **Disk.** Every agent and org session copies all its skills. The copies stay until `maihem prune`.
- **Folder size.** No size guard: a skill with a big `assets/` or `node_modules` is copied at every start.
- **Forced remove during an org run.** `skill rm -f` while an org runs stops the org daemon at the next session spawn, with the error in org.log (accepted by the user).
- **Trust.** A third-party skill is prompt input and, in host mode, runnable code.

## Stack choices

- `yaml` 2.9.1 `YAML.parse` for the front matter; no new dependency. agent-skills-ts-sdk was rejected: its lenient path gives only the split and the parse.
- `fs.cpSync` with `recursive: true, verbatimSymlinks: true`.
- `fs.realpathSync` plus a prefix check with `path.sep` for the escape guard.
- zod `z.enum` for the tool's `name`.
- **Modules.** The new `packages/cli/src/skills.ts` holds parse, registry, freeze, catalog, tool and `SKILL_TOOL`. `SKILL_NAME` lives in `definition.ts`, to avoid the import cycle registry → definition → skills.
- **`buildAgent`.** It gets a 9th positional parameter; it has only two callers (run.ts:133, daemon.ts:44).

## Out of scope

- Discovery in the project dir or in `.claude`/`.agents`.
- Per-role org skills.
- Scripts in the sandbox.
- YAML repair.
- Add from a git URL.
- An `apply` `skills:` section.
- Preload or inline of skill bodies.
- Deduplicating repeat activations.
- Description length caps.
- A SKILLS column in `definition ls`.
- A size guard on skill folders.
- Cleanup of frozen copies at agent exit (prune does it).
- Catching the org spawn error.

## Accepted tech debt

None.

## Overrides

None.

## Caveats

- Skills are frozen per agent at start into ~/.maihem/agents/<id>.skills/; skill update and rm never touch a running agent : packages/cli/src/skills.ts
- The skill tool reads files on the host, also in sandbox mode; skill scripts run only in host mode : packages/cli/src/skills.ts
- Skill folders are copied with verbatimSymlinks, because Node's default rewrites relative symlinks to absolute paths into the source folder : packages/cli/src/skills.ts
- The skill catalog is appended in buildAgent, so org sessions get it although the org replaces def.system : packages/cli/src/run.ts
- Compaction re-inserts the latest result of each skill call after the summary, so a large skill can keep the context above compact_at : packages/cli/src/compact.ts
- definition update fails while a listed skill is missing (as for a missing provider), even when the update does not touch skills : packages/cli/src/main.ts
- An empty front matter block parses to null under yaml 2.9.1; skills.ts reads it as no fields : packages/cli/src/skills.ts
- skill rm -f during an org run stops the org daemon at the next session spawn; org/daemon.ts spawn has no catch : packages/cli/src/org/daemon.ts

