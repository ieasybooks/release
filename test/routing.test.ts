import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collect,
  components,
  releases,
  routingProblems,
  type Commit,
} from "../src/routing.ts";

// A repository's release-please-config.json, laid out like Mofied's.
const configRoot = mkdtempSync(join(tmpdir(), "routing-config-"));
afterAll(() => rmSync(configRoot, { recursive: true, force: true }));
writeFileSync(
  join(configRoot, "release-please-config.json"),
  JSON.stringify({
    packages: {
      "apps/web": { component: "web" },
      "apps/mobile": { component: "apps" },
      "packages/session": { component: "session" },
      "packages/contracts": { component: "contracts" },
    },
  }),
);

describe("releases", () => {
  it("counts the types release-please lists in a changelog", () => {
    for (const title of [
      "feat: a",
      "fix: a",
      "fix(store): a",
      "perf: a",
      "revert: a",
      "deps: a",
      "feature: a",
      "Fix: a",
    ]) {
      expect(releases(title), title).toBe(true);
    }
  });

  it("ignores the types it hides, and titles that aren't Conventional Commits", () => {
    for (const title of [
      "chore: a",
      "docs: a",
      "ci: a",
      "build(deps): a",
      "test: a",
      "refactor: a",
      "style: a",
      "chore: release main",
    ]) {
      expect(releases(title), title).toBe(false);
    }
    for (const title of [
      "Update README",
      "fix a bug",
      "fix:missing space",
      "",
      'Revert "fix: a"',
    ]) {
      expect(releases(title), title).toBe(false);
    }
  });

  it("counts breaking changes of any type, by ! or footer", () => {
    expect(releases("chore!: drop a")).toBe(true);
    expect(releases("refactor(api)!: a")).toBe(true);
    expect(releases("chore: a\n\nBREAKING CHANGE: b")).toBe(true);
    expect(releases("chore: a\n\nBREAKING-CHANGE: b")).toBe(true);
    expect(releases("chore: a\n\nnot a BREAKING CHANGE: b")).toBe(false);
  });
});

describe("routingProblems", () => {
  const folders = components(configRoot);
  const commit = (message: string, ...files: string[]): Commit => ({
    sha: "abcdef0123456789",
    message,
    files,
  });

  it("counts every file in a component at the repository's root", () => {
    const pr = {
      title: "fix: the privacy policy",
      commits: [commit("fix: the privacy policy", "lib/constants.dart")],
      files: ["lib/constants.dart"],
    };
    expect(routingProblems(pr, ["."])).toEqual([]);
  });

  it("reads the components from release-please-config.json, sorted", () => {
    expect(folders).toEqual([
      "apps/mobile",
      "apps/web",
      "packages/contracts",
      "packages/session",
    ]);
  });

  it("accepts releasing commits that change a component, and others that change anything", () => {
    const pr = {
      title: "fix: playback",
      commits: [
        commit("fix(web): a", "apps/web/src/App.tsx"),
        commit("feat: b", "packages/session/src/index.ts", "bun.lock"),
        commit("ci: c", ".github/workflows/check.yml"),
        commit("chore(deps): d", "bun.lock", "package.json"),
      ],
      files: [
        "apps/web/src/App.tsx",
        "packages/session/src/index.ts",
        "bun.lock",
        "package.json",
        ".github/workflows/check.yml",
      ],
    };
    expect(routingProblems(pr, folders)).toEqual([]);
  });

  it("names a releasing commit that changes no component", () => {
    const pr = {
      title: "chore: tidy",
      commits: [
        commit("fix: cache headers", "scripts/write-asset-headers.ts"),
        commit("docs: b", "apps/web/README.md"),
      ],
      files: ["scripts/write-asset-headers.ts", "apps/web/README.md"],
    };
    // A squash merge titled chore: releases nothing either way, but a rebase
    // merge lands the fix: on its own, where it releases nothing.
    expect(routingProblems(pr, folders)).toEqual([
      'commit abcdef0 "fix: cache headers" would release, but changes no component',
    ]);
  });

  it("checks the title against all the files, as a squash merge lands it", () => {
    const rootOnly = {
      title: "fix: deploy config",
      commits: [commit("chore: a", "wrangler.jsonc")],
      files: ["wrangler.jsonc"],
    };
    expect(routingProblems(rootOnly, folders)).toEqual([
      'the title "fix: deploy config" would release when squash-merged, but the pull request changes no component',
    ]);
    const reachesWeb = {
      ...rootOnly,
      files: ["wrangler.jsonc", "apps/web/wrangler.jsonc"],
    };
    expect(routingProblems(reachesWeb, folders)).toEqual([]);
  });

  it("doesn't take a folder that only starts like a component for it", () => {
    const pr = {
      title: "",
      commits: [
        commit("fix: a", "apps/webview/x.ts", "packages/session-old/y.ts"),
      ],
      files: [],
    };
    expect(routingProblems(pr, folders)).toHaveLength(1);
  });
});

describe("collect", () => {
  const repo = mkdtempSync(join(tmpdir(), "release-routing-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
      },
    ).trim();
  const change = (message: string, ...files: string[]) => {
    for (const file of files) {
      mkdirSync(join(repo, dirname(file)), { recursive: true });
      writeFileSync(join(repo, file), `${message}\n`);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  it("reads each commit's message and files, leaving merges out", () => {
    git("init", "-q", "-b", "main");
    const base = change("chore: start", "README.md");
    git("checkout", "-q", "-b", "topic");
    const fix = change(
      "fix: headers\n\nBREAKING CHANGE: new paths",
      "scripts/x.ts",
    );
    const feat = change("feat: web", "apps/web/a.ts");
    git("checkout", "-q", "main");
    // main moves on, and the pull request merges it in. GitHub then passes
    // main's tip as the base.
    const mainTip = change("docs: other", "docs/b.md");
    git("checkout", "-q", "topic");
    git("merge", "-q", "--no-edit", "main");
    const head = git("rev-parse", "HEAD");
    expect(git("merge-base", "--is-ancestor", base, mainTip)).toBe("");

    const pr = collect(mainTip, head, "feat: web", repo);
    expect(pr.commits.map((c) => c.sha)).toEqual([fix, feat]);
    expect(pr.commits[0]).toEqual({
      sha: fix,
      message: "fix: headers\n\nBREAKING CHANGE: new paths",
      files: ["scripts/x.ts"],
    });
    expect(pr.commits[1].files).toEqual(["apps/web/a.ts"]);
    expect(pr.files.sort()).toEqual(["apps/web/a.ts", "scripts/x.ts"]);
    expect(routingProblems(pr, components(configRoot))).toEqual([
      `commit ${fix.slice(0, 7)} "fix: headers" would release, but changes no component`,
    ]);
  });
});
