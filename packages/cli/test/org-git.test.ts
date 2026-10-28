import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, checkoutReview, checkoutTicket, commitAll, diff, discard, dropBranch, emptyDirs, mergeMain, outcome, prepareRepo, pushTag, showMain, slug, squashMerge, tag, tree, worktree } from "../src/org/git.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ogit-")); dirs.push(d); return d; };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const dev = { name: "dev", email: "dev@acme.maihem" };
function repo() {
  const r = tmp();
  git(r, "init", "-q", "-b", "main");
  return { r, main: prepareRepo(r).main };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("org git", () => {
  it("prepareRepo makes an initial commit in an empty repo and returns the branch", () => {
    const r = tmp();
    git(r, "init", "-q", "-b", "trunk");
    expect(prepareRepo(r)).toEqual({ main: "trunk", created: true });
    expect(git(r, "log", "--format=%s")).toBe("maihem: start org");
    expect(prepareRepo(r)).toEqual({ main: "trunk", created: false });
  });
  it("prepareRepo rejects a directory that is not a git repo", () => {
    const r = tmp();
    expect(() => prepareRepo(r)).toThrow(`org repo is not a git repository: ${r}; run git init`);
  });
  it("a ticket gets its own branch in the member's worktree", () => {
    const { r, main } = repo();
    const wt = join(tmp(), "dev");
    expect(worktree(r, wt)).toBe(wt);
    checkoutTicket(wt, "t-1-a", main);
    expect(git(wt, "branch", "--show-current")).toBe("t-1-a");
    expect(worktree(r, wt)).toBe(wt);
  });
  it("an existing branch is reused", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1-a", main);
    writeFileSync(join(wt, "a.txt"), "a");
    commitAll(wt, "a", dev);
    checkoutReview(wt, main);
    expect(existsSync(join(wt, "a.txt"))).toBe(false);
    checkoutTicket(wt, "t-1-a", main);
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    checkoutReview(wt, "t-1-a");
    expect(git(wt, "branch", "--show-current")).toBe("");
  });
  it("commitAll commits only when dirty, as the member", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    expect(commitAll(wt, "nothing", dev)).toBe(false);
    writeFileSync(join(wt, "a.txt"), "a");
    expect(commitAll(wt, "dev: T-1 a", dev)).toBe(true);
    expect(git(wt, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe("dev <dev@acme.maihem>|dev <dev@acme.maihem>|dev: T-1 a");
  });
  it("diff shows stat and patch and truncates", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "hello\n".repeat(50));
    commitAll(wt, "a", dev);
    const d = diff(r, main, "t-1");
    expect(d).toMatch(/a\.txt \| 50 \+/);
    expect(d).toContain("+hello");
    const t = diff(r, main, "t-1", 100);
    expect(t.endsWith("\n[truncated]")).toBe(true);
    expect(t.length).toBe(100 + "\n[truncated]".length);
  });
  it("squashMerge makes one commit by the author", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "a");
    commitAll(wt, "one", dev);
    writeFileSync(join(wt, "b.txt"), "b");
    commitAll(wt, "two", dev);
    const m = squashMerge(r, "t-1", "T-1 a\n\nReviewed-by: tl <tl@acme.maihem>", dev);
    expect(m.ok).toBe(true);
    expect(git(r, "rev-parse", "HEAD")).toBe((m as { commit: string }).commit);
    expect(git(r, "log", "--format=%an|%s")).toBe("dev|T-1 a\nmaihem|maihem: start org");
    expect(git(r, "log", "-1", "--format=%b")).toBe("Reviewed-by: tl <tl@acme.maihem>");
  });
  it("a squash with no changes makes no commit", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "a");
    commitAll(wt, "one", dev);
    squashMerge(r, "t-1", "T-1", dev);
    const head = git(r, "rev-parse", "HEAD");
    expect(squashMerge(r, "t-1", "again", dev)).toEqual({ ok: true, commit: null });
    expect(git(r, "rev-parse", "HEAD")).toBe(head);
  });
  it("a conflict aborts and lists the files", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "branch");
    commitAll(wt, "b", dev);
    writeFileSync(join(r, "a.txt"), "main");
    commitAll(r, "m", dev);
    expect(squashMerge(r, "t-1", "x", dev)).toEqual({ ok: false, conflicts: ["a.txt"] });
    expect(git(r, "status", "--porcelain")).toBe("");
  });
  it("a dirty main checkout is reported", () => {
    const { r } = repo();
    writeFileSync(join(r, "x.txt"), "x");
    expect(squashMerge(r, "main", "x", dev)).toEqual({ ok: false, dirty: true });
  });
  it("dropBranch detaches worktrees on that branch and deletes it", () => {
    const { r, main } = repo();
    const a = worktree(r, join(tmp(), "a")), b = worktree(r, join(tmp(), "b"));
    checkoutTicket(a, "t-1", main);
    dropBranch(r, "t-1", [a, b]);
    expect(git(a, "branch", "--show-current")).toBe("");
    expect(git(r, "branch", "--list", "t-1")).toBe("");
    expect(() => dropBranch(r, "t-9", [])).toThrow(/t-9/);
  });
  it("slug makes a short branch-safe name", () => {
    expect(slug("  Add Visa support!! (v2) ")).toBe("add-visa-support-v2");
    expect(slug("x".repeat(40)).length).toBe(30);
    expect(slug("a ".repeat(20))).not.toMatch(/-$/);
  });
  it("changedFiles lists files changed on the branch against main, committed or not", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1-a", main);
    expect(changedFiles(wt, main)).toEqual([]);
    writeFileSync(join(wt, "a.txt"), "a");
    commitAll(wt, "a", dev);
    writeFileSync(join(wt, "b.txt"), "b");
    writeFileSync(join(r, "main.txt"), "m"); git(r, "add", "-A"); git(r, "commit", "-qm", "m");
    expect(changedFiles(wt, main)).toEqual(["a.txt", "b.txt"]);
  });
  it("discard returns the names of the dropped files even when the first status line starts with a space", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "file.txt"), "a");
    commitAll(wt, "a", dev);
    expect(discard(wt)).toEqual([]);
    writeFileSync(join(wt, "file.txt"), "b");
    writeFileSync(join(wt, "new.txt"), "n");
    expect(discard(wt)).toEqual(["file.txt", "new.txt"]);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });
  // a branch t-1 in a worktree that changed a.txt, and main that changed a.txt and b.txt since
  function diverged(branchA: string) {
    const { r, main } = repo();
    writeFileSync(join(r, "a.txt"), "base\n"); commitAll(r, "base", dev);
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), branchA); commitAll(wt, "branch a", dev);
    writeFileSync(join(r, "a.txt"), "main\n"); commitAll(r, "main a", dev);
    writeFileSync(join(r, "b.txt"), "b\n"); commitAll(r, "main b", dev);
    return { r, main, wt };
  }
  it("mergeMain merges main into the branch when it is clean", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "a"); commitAll(wt, "a", dev);
    writeFileSync(join(r, "b.txt"), "b"); commitAll(r, "b", dev);
    expect(mergeMain(wt, main)).toEqual({ ok: true });
    expect(readFileSync(join(wt, "b.txt"), "utf8")).toBe("b");
    expect(git(wt, "branch", "--show-current")).toBe("t-1");
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(wt, "log", "-1", "--format=%an <%ae>|%cn")).toBe("maihem <maihem@localhost>|maihem");
  });
  it("mergeMain leaves the conflict markers and names the files and the main commits that changed them", () => {
    const { wt, main } = diverged("branch\n");
    const m = mergeMain(wt, main);
    const sha = git(wt, "log", "-1", "--format=%h", main + "~1");
    expect(m).toEqual({ ok: false, conflicts: ["a.txt"], commits: [`${sha} main a`] });
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toMatch(/<<<<<<<[\s\S]*branch[\s\S]*=======[\s\S]*main[\s\S]*>>>>>>>/);
  });
  it("mergeMain is a no-op when the branch is up to date", () => {
    const { r, main } = repo();
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "a"); commitAll(wt, "a", dev);
    const head = git(wt, "rev-parse", "HEAD");
    expect(mergeMain(wt, main)).toEqual({ ok: true });
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
  });
  it("commitAll completes a conflicted merge after the markers are resolved", () => {
    const { wt, main } = diverged("branch\n");
    mergeMain(wt, main);
    writeFileSync(join(wt, "a.txt"), "resolved\n");
    expect(commitAll(wt, "dev: T-1 a", dev)).toBe(true);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(git(wt, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(mergeMain(wt, main)).toEqual({ ok: true });
  });
  it("commitAll completes a conflicted merge resolved to the branch's content", () => {
    const { r, main } = repo();
    writeFileSync(join(r, "a.txt"), "base\n"); commitAll(r, "base", dev);
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "a.txt"), "branch\n"); commitAll(wt, "b", dev);
    writeFileSync(join(r, "a.txt"), "main\n"); commitAll(r, "m", dev);
    mergeMain(wt, main);
    writeFileSync(join(wt, "a.txt"), "branch\n");
    expect(commitAll(wt, "dev: T-1 a", dev)).toBe(true);
    expect(mergeMain(wt, main)).toEqual({ ok: true });
  });
  it("showMain returns a file from main or empty", () => {
    const { r, main } = repo();
    mkdirSync(join(r, "docs"));
    writeFileSync(join(r, "docs", "a.md"), "hello\n"); commitAll(r, "docs", dev);
    const wt = worktree(r, join(tmp(), "dev"));
    checkoutTicket(wt, "t-1", main);
    writeFileSync(join(wt, "docs", "a.md"), "branch\n"); commitAll(wt, "b", dev);
    expect(showMain(wt, main, "docs/a.md")).toBe("hello\n");
    expect(showMain(wt, main, "docs/missing.md")).toBe("");
  });
  it("tree lists main's files with a cap", () => {
    const { r, main } = repo();
    for (const f of ["a.py", "b.py", "c.py"]) writeFileSync(join(r, f), f);
    commitAll(r, "files", dev);
    expect(tree(r, main)).toBe("a.py\nb.py\nc.py");
    expect(tree(r, main, 2)).toBe("a.py\nb.py\n… 1 more");
    expect(tree(repo().r, main)).toBe("");
  });
  it("outcome gives the changed files", () => {
    const { r } = repo();
    writeFileSync(join(r, "a.py"), "a"); writeFileSync(join(r, "b.py"), "b");
    commitAll(r, "dev: T-1 Parse CSV", dev);
    expect(outcome(r, git(r, "rev-parse", "HEAD"))).toBe("files (a.py, b.py)");
    expect(outcome(r, "deadbeef")).toBe("");
  });
  it("emptyDirs lists empty directories outside .git", () => {
    const { r } = repo();
    expect(emptyDirs(r)).toEqual([]);
    for (const d of ["tests", "src/pkg/deep", "src/full", "build"]) mkdirSync(join(r, d), { recursive: true });
    writeFileSync(join(r, "src/full/a.py"), "a");
    writeFileSync(join(r, ".gitignore"), "build/\n");
    expect(emptyDirs(r)).toEqual(["build/", "src/pkg/deep/", "tests/"]);
    mkdirSync(join(r, ".git/empty-inside-git"));
    writeFileSync(join(r, "tests/__init__.py"), "");
    expect(emptyDirs(r)).toEqual(["build/", "src/pkg/deep/"]);
  });
  it("tag creates an annotated tag once and pushTag is a no-op without a remote", () => {
    const { r, main } = repo();
    expect(tag(r, main, "M0", "M0 Requirements")).toBe(true);
    expect(git(r, "cat-file", "-t", "M0")).toBe("tag");
    expect(git(r, "tag", "-n1", "-l", "M0")).toMatch(/^M0\s+M0 Requirements$/);
    writeFileSync(join(r, "a.txt"), "a");
    commitAll(r, "a", dev);
    expect(tag(r, main, "M0", "again")).toBe(false);
    expect(git(r, "rev-list", "-n1", "M0")).toBe(git(r, "rev-parse", "HEAD~1"));
    expect(pushTag(r, "M0")).toBe(false);
  });
  it("pushTag pushes to origin", () => {
    const { r, main } = repo();
    const bare = tmp();
    git(bare, "init", "-q", "--bare");
    git(r, "remote", "add", "origin", bare);
    tag(r, main, "M1", "M1 Core");
    expect(pushTag(r, "M1")).toBe(true);
    expect(git(bare, "rev-parse", "M1^{commit}")).toBe(git(r, "rev-parse", main));
    git(r, "remote", "set-url", "origin", join(bare, "missing"));
    expect(() => pushTag(r, "M1")).toThrow();
  });
});
