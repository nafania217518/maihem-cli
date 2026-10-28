// Git plumbing for orgs: worktrees per member, a branch per ticket, squash merges into main.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";

export interface Author { name: string; email: string }
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const MAIHEM: Author = { name: "maihem", email: "maihem@localhost" }; // the system's own commits
function raw(cwd: string, ...args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message).trim()); }
}
const git = (cwd: string, ...args: string[]): string => raw(cwd, ...args).trim();
const ok = (cwd: string, ...args: string[]) => { try { git(cwd, ...args); return true; } catch { return false; } };
const as = (a: Author) => ["-c", `user.name=${a.name}`, "-c", `user.email=${a.email}`];
const commit = (cwd: string, a: Author, ...args: string[]) => git(cwd, ...as(a), "commit", "-q", "--author", `${a.name} <${a.email}>`, ...args);

export function prepareRepo(repo: string): { main: string; created: boolean } {
  if (!ok(repo, "rev-parse", "--is-inside-work-tree")) throw new Error(`org repo is not a git repository: ${repo}; run git init`);
  const created = !ok(repo, "rev-parse", "--verify", "HEAD");
  if (created) commit(repo, MAIHEM, "--allow-empty", "-m", "maihem: start org");
  return { main: git(repo, "branch", "--show-current"), created };
}

export function worktree(repo: string, dir: string): string {
  const listed = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  if (existsSync(dir) && listed.includes(realpathSync(dir))) return dir;
  git(repo, "worktree", "prune");
  git(repo, "worktree", "add", "-q", "--detach", dir);
  return dir;
}

export const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/^-+|-+$/g, "");

export function checkoutTicket(wt: string, branch: string, main: string): void {
  if (ok(wt, "rev-parse", "--verify", `refs/heads/${branch}`)) git(wt, "checkout", "-q", branch);
  else git(wt, "checkout", "-q", "-b", branch, main);
}

export const checkoutReview = (wt: string, branch: string): void => void git(wt, "checkout", "-q", "--detach", branch);

// drop a worktree's uncommitted changes; returns the changed files
// changed and untracked paths of a worktree, not ignored ones
export const dirtyFiles = (wt: string): string[] => raw(wt, "status", "--porcelain", "-z", "-uall").split("\0").filter(Boolean).map((l) => l.slice(3));

export function discard(wt: string): string[] {
  const files = dirtyFiles(wt);
  if (files.length) { git(wt, "reset", "-q", "--hard"); git(wt, "clean", "-qfd"); }
  return files;
}

// commits everything; also completes a merge in progress, even one that changed nothing
export function commitAll(wt: string, message: string, author: Author): boolean {
  git(wt, "add", "-A");
  if (ok(wt, "diff", "--cached", "--quiet") && !ok(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")) return false;
  commit(wt, author, "-m", message);
  return true;
}

// merges main into the worktree's branch as maihem; a conflict leaves the markers in the files for the member to resolve
export function mergeMain(wt: string, main: string): { ok: true } | { ok: false; conflicts: string[]; commits: string[] } {
  try { git(wt, ...as(MAIHEM), "merge", "-q", "--no-edit", main); return { ok: true }; }
  catch (e) {
    const conflicts = git(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (!conflicts.length) throw e;
    const commits = git(wt, "log", main, "^HEAD", "--format=%h %s", "--", ...conflicts).split("\n").filter(Boolean);
    return { ok: false, conflicts, commits };
  }
}

export function diff(repo: string, main: string, branch: string, max = 20000): string {
  const r = `${main}...${branch}`;
  const d = git(repo, "diff", "--stat", r) + "\n" + git(repo, "diff", r);
  return d.length > max ? d.slice(0, max) + "\n[truncated]" : d;
}

// the short diff stat of the worktree's branch against main; "" when nothing changed
export const branchStat = (wt: string, main: string): string => git(wt, "diff", "--stat", `${main}...HEAD`);

// files changed on the worktree's branch against main: committed, staged, unstaged or untracked
export function changedFiles(wt: string, main: string): string[] {
  const out = [git(wt, "diff", "--name-only", `${main}...HEAD`), git(wt, "diff", "--name-only", "HEAD"), git(wt, "ls-files", "--others", "--exclude-standard")];
  return [...new Set(out.join("\n").split("\n").filter(Boolean))].sort();
}

// directories with no entries ("tests/"), outside .git, ignored ones included: git drops them from a commit
// ponytail: walks the whole tree (node_modules too); skip ignored dirs if a large tree makes submit slow
export function emptyDirs(wt: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const es = readdirSync(rel ? `${wt}/${rel}` : wt, { withFileTypes: true }).filter((e) => e.name !== ".git");
    if (rel && !es.length) out.push(`${rel}/`);
    for (const e of es) if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
  };
  walk("");
  return out.sort();
}

export function squashMerge(repo: string, branch: string, message: string, author: Author):
  { ok: true; commit: string | null } | { ok: false; conflicts: string[] } | { ok: false; dirty: true } {
  if (git(repo, "status", "--porcelain")) return { ok: false, dirty: true };
  try { git(repo, "merge", "-q", "--squash", branch); }
  catch (e) {
    const conflicts = git(repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (!conflicts.length) throw e;
    git(repo, "reset", "-q", "--merge");
    return { ok: false, conflicts };
  }
  if (ok(repo, "diff", "--cached", "--quiet")) return { ok: true, commit: null }; // the branch's content is already on main
  commit(repo, author, "-m", message);
  return { ok: true, commit: git(repo, "rev-parse", "HEAD") };
}

export function dropBranch(repo: string, branch: string, worktrees: string[]): void {
  for (const wt of worktrees) if (existsSync(wt) && ok(wt, "symbolic-ref", "-q", "HEAD") && git(wt, "branch", "--show-current") === branch) git(wt, "checkout", "-q", "--detach");
  git(repo, "branch", "-q", "-D", branch);
}

// context loaded at session start (docs/org-design.md §5): read from main, never from the member's branch
export const showMain = (repo: string, main: string, file: string): string => { try { return raw(repo, "show", `${main}:${file}`); } catch { return ""; } };

export function tree(repo: string, main: string, max = 200): string {
  const fs = git(repo, "ls-tree", "-r", "--name-only", main).split("\n").filter(Boolean);
  return [...fs.slice(0, max), ...(fs.length > max ? [`… ${fs.length - max} more`] : [])].join("\n");
}

// "subject (a.py, b.py)" of one commit; "" when the commit is missing
export function outcome(repo: string, commit: string): string {
  try {
    const files = git(repo, "show", "--name-only", "--format=", commit).split("\n").filter(Boolean);
    return files.length ? `files (${files.join(", ")})` : "(no changes)";
  } catch { return ""; }
}

// milestone tags (docs/org-design.md §13): an annotated tag on main, once; false when it exists
export function tag(repo: string, main: string, name: string, message: string): boolean {
  if (ok(repo, "rev-parse", "-q", "--verify", `refs/tags/${name}`)) return false;
  git(repo, ...as(MAIHEM), "tag", "-a", name, "-m", message, main);
  return true;
}

// pushes a tag to origin; false (no-op) without an origin remote; throws on a failed push
// ponytail: synchronous, blocks the runner up to the timeout; move it off the tick if pushes get slow
export function pushTag(repo: string, name: string): boolean {
  if (!ok(repo, "remote", "get-url", "origin")) return false;
  try { execFileSync("git", ["push", "-q", "origin", `refs/tags/${name}`], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }); }
  catch (e) { throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message).trim()); }
  return true;
}

// what main changed since the latest existing tag of `tags` (the earlier milestone ids, in order), optionally for one path
export function milestoneDiff(repo: string, main: string, tags: string[], path?: string, max = 40_000): string {
  const from = tags.findLast((x) => ok(repo, "rev-parse", "-q", "--verify", `refs/tags/${x}`));
  if (!from) return "No earlier milestone tag: everything on main is new. Use list to see the files.";
  const r = `${from}..${main}`, p = path ? ["--", path] : [];
  const d = `Changes since ${from}:\n${git(repo, "diff", "--stat", r, ...p)}\n${git(repo, "diff", r, ...p)}`;
  return d.length > max ? d.slice(0, max) + "\n… truncated; read the files you need" : d;
}
