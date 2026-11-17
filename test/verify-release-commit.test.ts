import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../scripts/verify-release-commit.sh", import.meta.url),
);
const COMMIT = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const TAG_OBJECT = "3333333333333333333333333333333333333333";
const INNER_TAG_OBJECT = "4444444444444444444444444444444444444444";

// A stand-in for gh that answers `gh api PATH --jq EXPR` from the files under
// its own api/ folder, shaped like GitHub's answers, and fails for others.
const fake = mkdtempSync(join(tmpdir(), "verify-release-commit-"));
afterAll(() => rmSync(fake, { recursive: true, force: true }));
writeFileSync(
  join(fake, "gh"),
  `#!/usr/bin/env bash
[ "$1" = api ] || exit 2
file="${fake}/api/$2.json"
[ -f "$file" ] || { echo '{"message":"Not Found"}' >&2; exit 1; }
[ "$3" = --jq ] && exec jq -r "$4" "$file"
cat "$file"
`,
);
chmodSync(join(fake, "gh"), 0o755);

function answer(path: string, body: unknown) {
  const file = join(fake, "api", `${path}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

const repo = "repos/ieasybooks/mofied";
answer(`${repo}/git/ref/tags/v1.0.0`, {
  ref: "refs/tags/v1.0.0",
  object: { type: "commit", sha: COMMIT },
});
answer(`${repo}/git/ref/tags/v1.0.1`, {
  ref: "refs/tags/v1.0.1",
  object: { type: "tag", sha: TAG_OBJECT },
});
answer(`${repo}/git/tags/${TAG_OBJECT}`, {
  tag: "v1.0.1",
  object: { type: "commit", sha: COMMIT },
});
answer(`${repo}/git/ref/tags/v1.0.2`, {
  ref: "refs/tags/v1.0.2",
  object: { type: "tag", sha: INNER_TAG_OBJECT },
});
answer(`${repo}/git/tags/${INNER_TAG_OBJECT}`, {
  tag: "v1.0.2",
  object: { type: "tag", sha: TAG_OBJECT },
});
answer(`${repo}/git/ref/tags/v1.0.3`, {
  ref: "refs/tags/v1.0.3",
  object: { type: "tree", sha: COMMIT },
});
const status = (statuses: { context: string; state: string }[]) => ({
  state: "pending",
  statuses,
});
answer(
  `${repo}/commits/${COMMIT}/status`,
  status([
    { context: "Release check", state: "failure" },
    { context: "Checks", state: "success" },
  ]),
);
answer(
  `${repo}/commits/${OTHER}/status`,
  status([{ context: "Checks", state: "failure" }]),
);

function verify(...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "ieasybooks/mofied",
    },
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

describe("verify-release-commit.sh", () => {
  it("accepts a lightweight or annotated tag, even nested, at the commit", () => {
    for (const tag of ["v1.0.0", "v1.0.1", "v1.0.2"]) {
      expect(verify(tag, COMMIT), tag).toEqual({
        code: 0,
        out: `${tag} points at ${COMMIT}.\n`,
      });
    }
  });

  it("refuses a tag at another commit, or at something else", () => {
    expect(verify("v1.0.1", OTHER)).toMatchObject({ code: 1 });
    expect(verify("v1.0.1", OTHER).out).toContain(
      `points at commit ${COMMIT}, not at ${OTHER}`,
    );
    expect(verify("v1.0.3", COMMIT).out).toContain(`points at tree ${COMMIT}`);
    expect(verify("v1.0.3", COMMIT).code).toBe(1);
  });

  it("refuses a tag that doesn't exist", () => {
    expect(verify("v9.9.9", COMMIT)).toEqual({
      code: 1,
      out: "::error::There's no tag v9.9.9.\n",
    });
  });

  it("with --checked, needs a successful Checks status on the commit", () => {
    expect(verify("v1.0.0", COMMIT, "--checked")).toEqual({
      code: 0,
      out: `v1.0.0 points at ${COMMIT}.\nMain's checks passed on ${COMMIT}.\n`,
    });
    answer(`${repo}/git/ref/tags/v2.0.0`, {
      object: { type: "commit", sha: OTHER },
    });
    expect(verify("v2.0.0", OTHER, "--checked")).toMatchObject({ code: 1 });
    expect(verify("v2.0.0", OTHER, "--checked").out).toContain(
      "its Checks status is failure",
    );
    expect(verify("v2.0.0", OTHER).code).toBe(0);
  });

  it("with --checked, refuses a commit with no Checks status", () => {
    const none = "5555555555555555555555555555555555555555";
    answer(`${repo}/git/ref/tags/v3.0.0`, {
      object: { type: "commit", sha: none },
    });
    answer(`${repo}/commits/${none}/status`, status([]));
    expect(verify("v3.0.0", none, "--checked").out).toContain(
      "its Checks status is missing",
    );
    expect(verify("v3.0.0", none, "--checked").code).toBe(1);
  });
});

describe("verify-release-commit.sh without GITHUB_REPOSITORY", () => {
  it("names what's missing instead of guessing a repository", () => {
    const result = spawnSync("bash", [SCRIPT, ...["v1.0.0", COMMIT]], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("set GITHUB_REPOSITORY to the repository");
  });
});
