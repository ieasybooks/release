import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/cli.ts";
import { LISTINGS, makeApp } from "./fixture.ts";

// The command as node_modules/.bin runs it: the file itself, by its #! line.
const BIN = fileURLToPath(
  new URL("../bin/ieasybooks-release.ts", import.meta.url),
);
const dir = mkdtempSync(join(tmpdir(), "cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(
  args: string[],
  { cwd = dir, env = {} }: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync(BIN, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let n = 0;
function app(version = "0.1.3"): string {
  return makeApp(join(dir, `app-${++n}`), version);
}

describe("usage", () => {
  it("prints the usage without a command, failing, and with help, succeeding", () => {
    expect(run([])).toEqual({ code: 2, stdout: `${USAGE}\n`, stderr: "" });
    expect(run(["help"])).toEqual({
      code: 0,
      stdout: `${USAGE}\n`,
      stderr: "",
    });
  });

  it.each([
    [["deploy"], "unknown command deploy"],
    [["store"], "unknown store command (none)"],
    [["store", "publish"], "unknown store command publish"],
    [["appgallery", "upload"], "unknown appgallery command upload"],
    [["release-info"], "--app <folder> is required"],
    [["release-info", "--app"], "--app needs a value"],
    [["release-info", "--app", "x", "extra"], "expected 0 arguments, got 1"],
    [["release-info", "--app", "x", "--tag", "v1"], "unknown option --tag"],
    [
      ["store", "fastlane-metadata", "--app", "x"],
      "expected 1 argument, got 0",
    ],
    [["routing", "a"], "expected 2 arguments, got 1"],
  ])("refuses %j", (args, message) => {
    const result = run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`ieasybooks-release: ${message}`);
    expect(result.stderr).toContain(USAGE);
  });
});

describe("release-info", () => {
  it("prints the version and build numbers as JSON", () => {
    expect(run(["release-info", "--app", app("0.2.5")])).toEqual({
      code: 0,
      stdout:
        '{"version":"0.2.5","iosBuildNumber":"2005","androidVersionCode":2005}\n',
      stderr: "",
    });
  });
});

describe("store check", () => {
  it("says the version is ready, by the store's name", () => {
    expect(run(["store", "check", "--app", app()])).toEqual({
      code: 0,
      stdout:
        "Shawared 0.1.3 (build 1003 on iOS and Android) is ready to release.\n",
      stderr: "",
    });
  });

  it("lists what stops the release, failing", () => {
    const folder = app();
    rmSync(join(folder, "store/release-notes/0.1.3/en.txt"));
    const result = run(["store", "check", "--app", folder, "--tag", "v0.1.4"]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: [
        "Shawared 0.1.3 can't be released yet:",
        `  - the tag v0.1.4 doesn't match ${folder}/package.json's version 0.1.3; tag v0.1.3`,
        `  - ${folder}/store/release-notes/0.1.3/en.txt is missing or empty`,
        "",
      ].join("\n"),
    });
  });

  it("calls the app 'The apps' when store.json has no name", () => {
    const folder = app();
    const config = JSON.parse(
      readFileSync(join(folder, "store/store.json"), "utf8"),
    );
    delete config.name;
    writeFileSync(join(folder, "store/store.json"), JSON.stringify(config));
    expect(run(["store", "check", "--app", folder]).stdout).toBe(
      "The apps 0.1.3 (build 1003 on iOS and Android) is ready to release.\n",
    );
  });
});

describe("store fastlane-metadata", () => {
  it("replaces the output folder with the version's metadata", () => {
    const folder = app();
    const out = join(dir, "metadata");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "stale.txt"), "from an earlier run");
    expect(run(["store", "fastlane-metadata", "--app", folder, out])).toEqual({
      code: 0,
      stdout: `Wrote the 0.1.3 store metadata to ${out}.\n`,
      stderr: "",
    });
    expect(existsSync(join(out, "stale.txt"))).toBe(false);
    expect(
      readFileSync(join(out, "app-store/metadata/en-US/name.txt"), "utf8"),
    ).toBe(LISTINGS.en["app-store-name.txt"]);
    expect(
      readFileSync(
        join(out, "google-play/metadata/ar/changelogs/1003.txt"),
        "utf8",
      ),
    ).toBe("قصائد جديدة وإصلاحات.");
  });
});

describe("appgallery publish", () => {
  it("needs the service account's key", () => {
    const result = run(["appgallery", "publish", "--app", app(), "x.apk"], {
      env: { APPGALLERY_CONNECT_SERVICE_ACCOUNT: "" },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "APPGALLERY_CONNECT_SERVICE_ACCOUNT must hold the service account's key file",
    );
  });
});

describe("routing", () => {
  const repo = mkdtempSync(join(tmpdir(), "cli-routing-"));
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
      { cwd: repo, encoding: "utf8" },
    ).trim();
  const change = (message: string, file: string) => {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), `${message}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };

  it("checks the commits between two refs against the repository's components", () => {
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(repo, "release-please-config.json"),
      JSON.stringify({ packages: { "apps/app": {}, "packages/design": {} } }),
    );
    const base = change("chore: start", "README.md");
    const head = change("fix: a", "apps/app/a.ts");
    expect(
      run(["routing", base, head], { cwd: repo, env: { TITLE: "fix: a" } }),
    ).toEqual({
      code: 0,
      stdout:
        "1 commits checked: each one that would release changes a component.\n",
      stderr: "",
    });
    const bad = change("fix: b", "scripts/b.ts");
    const result = run(["routing", head, bad], {
      cwd: repo,
      env: { TITLE: "chore: b" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `- commit ${bad.slice(0, 7)} "fix: b" would release, but changes no component\n\n` +
        "The components are apps/app, packages/design. Use a type that releases nothing (chore:, build:, ci:, docs:, refactor:, test:), " +
        "or move what ships into the component it belongs to. See docs/releasing.md.\n",
    );
  });
});

describe("verify-commit and not-superseded", () => {
  // A stand-in for gh with one tag, v1.0.0 at a commit.
  const fake = mkdtempSync(join(tmpdir(), "cli-gh-"));
  afterAll(() => rmSync(fake, { recursive: true, force: true }));
  const COMMIT = "1".repeat(40);
  writeFileSync(
    join(fake, "gh"),
    `#!/usr/bin/env bash
case "$2" in
  repos/ieasybooks/app/git/ref/tags/v1.0.0) [ "$3" = --jq ] && echo "commit ${COMMIT}" ;;
  repos/ieasybooks/app/git/matching-refs/tags/v) echo refs/tags/v1.0.0; echo refs/tags/v1.1.0 ;;
  *) echo '{"message":"Not Found"}' >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(fake, "gh"), 0o755);
  const env = {
    PATH: `${fake}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "ieasybooks/app",
  };

  it("runs the checks, passing their output and exit code through", () => {
    expect(run(["verify-commit", "v1.0.0", COMMIT], { env })).toEqual({
      code: 0,
      stdout: `v1.0.0 points at ${COMMIT}.\n`,
      stderr: "",
    });
    expect(run(["verify-commit", "v2.0.0", COMMIT], { env })).toEqual({
      code: 1,
      stdout: "::error::There's no tag v2.0.0.\n",
      stderr: "",
    });
    const superseded = run(["not-superseded", "v1.0.0"], { env });
    expect(superseded.code).toBe(1);
    expect(superseded.stdout).toContain("::error::v1.1.0 is newer than v1.0.0");
    expect(run(["not-superseded", "v1.1.0"], { env })).toEqual({
      code: 0,
      stdout: "No release is newer than v1.1.0.\n",
      stderr: "",
    });
  });
});
