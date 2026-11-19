// Checks that what a pull request would release reaches a component.
// release-please counts a commit only for the components whose folders it
// changes (release-please-config.json), so a fix: that changes only files
// outside them releases nothing. Each commit is checked on its own, as a rebase
// merge lands them, and the title against all the changed files, as a squash
// merge lands it. The CLI runs it as `ieasybooks-release routing <base> <head>`,
// with the pull request's title in TITLE.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Commit = { sha: string; message: string; files: string[] };
export type PullRequest = { title: string; commits: Commit[]; files: string[] };

// The types release-please lists in a changelog, which raise a version; the
// others (chore, docs, ci, build, test, refactor, style) don't.
const RELEASING_TYPES = new Set([
  "feat",
  "feature",
  "fix",
  "perf",
  "revert",
  "deps",
]);
const HEADER = /^(\w+)(?:\([^)]*\))?(!)?: \S/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;

// Whether release-please would release a commit with this message.
export function releases(message: string): boolean {
  const [subject = "", ...body] = message.split("\n");
  const header = HEADER.exec(subject);
  if (!header) return false;
  const [, type, bang] = header;
  return (
    Boolean(bang) ||
    BREAKING_FOOTER.test(body.join("\n")) ||
    RELEASING_TYPES.has(type.toLowerCase())
  );
}

export function components(root = "."): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  );
  return Object.keys(config.packages).sort();
}

// A component at the repository's root (".", as a single-package app like a
// Flutter app has) contains every file.
function touches(files: string[], folders: string[]): boolean {
  return files.some((file) =>
    folders.some((folder) => folder === "." || file.startsWith(`${folder}/`)),
  );
}

export function routingProblems(pr: PullRequest, folders: string[]): string[] {
  const problems: string[] = [];
  for (const commit of pr.commits) {
    if (releases(commit.message) && !touches(commit.files, folders)) {
      const subject = commit.message.split("\n")[0];
      problems.push(
        `commit ${commit.sha.slice(0, 7)} "${subject}" would release, but changes no component`,
      );
    }
  }
  if (releases(pr.title) && !touches(pr.files, folders)) {
    problems.push(
      `the title "${pr.title}" would release when squash-merged, but the pull request changes no component`,
    );
  }
  return problems;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

// The pull request's own commits (merges left out) and files, from git.
export function collect(
  base: string,
  head: string,
  title: string,
  cwd = ".",
): PullRequest {
  const commits = lines(
    git(cwd, "rev-list", "--no-merges", "--reverse", `${base}..${head}`),
  ).map((sha) => ({
    sha,
    message: git(cwd, "log", "-1", "--format=%B", sha).trim(),
    files: lines(
      git(
        cwd,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--root",
        sha,
      ),
    ),
  }));
  return {
    title,
    commits,
    files: lines(git(cwd, "diff", "--name-only", `${base}...${head}`)),
  };
}
