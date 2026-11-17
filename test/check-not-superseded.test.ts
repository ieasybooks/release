import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../scripts/check-not-superseded.sh", import.meta.url),
);

// A stand-in for gh that answers `gh api repos/ieasybooks/mofied/git/matching-refs/tags/PREFIX
// --paginate --jq '.[].ref'` as GitHub does, from the tags in its tags file:
// every ref starting with refs/tags/PREFIX. It fails for anything else.
const fake = mkdtempSync(join(tmpdir(), "check-not-superseded-"));
afterAll(() => rmSync(fake, { recursive: true, force: true }));
const MATCHING = "repos/ieasybooks/mofied/git/matching-refs/tags/";
writeFileSync(
  join(fake, "gh"),
  `#!/usr/bin/env bash
[ "$1 $3 $4 $5" = "api --paginate --jq .[].ref" ] || { echo "unexpected: $*" >&2; exit 2; }
case $2 in
  ${MATCHING}*) prefix=\${2#${MATCHING}} ;;
  *) echo '{"message":"Not Found"}' >&2; exit 1 ;;
esac
[ -f "${fake}/fail" ] && { echo 'HTTP 502' >&2; exit 1; }
while read -r tag; do
  [ -n "$tag" ] && case $tag in "$prefix"*) echo "refs/tags/$tag" ;; esac
done < "${fake}/tags"
exit 0
`,
);
chmodSync(join(fake, "gh"), 0o755);

function check(tag: string, tags: string[], { fail = false } = {}) {
  writeFileSync(join(fake, "tags"), tags.join("\n") + "\n");
  if (fail) writeFileSync(join(fake, "fail"), "");
  else rmSync(join(fake, "fail"), { force: true });
  const result = spawnSync("bash", [SCRIPT, tag], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "ieasybooks/mofied",
    },
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

const superseded = (newest: string, tag: string) => ({
  code: 1,
  out: `::error::${newest} is newer than ${tag}, so releasing ${tag} would replace it. Re-run ${newest}'s release if it failed, or release a newer version; to go back to ${tag} on purpose, roll back (docs/releasing.md).\n`,
});

describe("check-not-superseded.sh", () => {
  it("lets the newest release of a component go on", () => {
    const tags = ["v0.1.2", "v0.1.3", "web-v0.1.2", "web-v0.1.3"];
    expect(check("v0.1.3", tags)).toEqual({
      code: 0,
      out: "No release is newer than v0.1.3.\n",
    });
    expect(check("web-v0.1.3", tags)).toEqual({
      code: 0,
      out: "No release is newer than web-v0.1.3.\n",
    });
  });

  it("stops a release with a newer one of the same component", () => {
    const tags = ["v0.1.3", "v0.1.4", "web-v0.1.3", "web-v0.1.4"];
    expect(check("v0.1.3", tags)).toEqual(superseded("v0.1.4", "v0.1.3"));
    expect(check("web-v0.1.3", tags)).toEqual(
      superseded("web-v0.1.4", "web-v0.1.3"),
    );
  });

  it("names the newest of several newer releases", () => {
    const tags = ["v0.1.3", "v0.2.0", "v0.1.4", "v1.0.0", "v0.9.9"];
    expect(check("v0.1.3", tags)).toEqual(superseded("v1.0.0", "v0.1.3"));
  });

  it("compares versions as numbers, not text", () => {
    expect(check("v0.1.10", ["v0.1.9", "v0.1.10", "v0.9.0"])).toEqual(
      superseded("v0.9.0", "v0.1.10"),
    );
    expect(check("v0.1.10", ["v0.1.9", "v0.1.10", "v0.0.99"]).code).toBe(0);
    expect(check("v0.1.9", ["v0.1.9", "v0.1.10"])).toEqual(
      superseded("v0.1.10", "v0.1.9"),
    );
    expect(check("v0.10.0", ["v0.9.9", "v0.10.0"]).code).toBe(0);
    expect(check("v2.0.0", ["v10.0.0"])).toEqual(
      superseded("v10.0.0", "v2.0.0"),
    );
  });

  it("only counts the component's own version tags", () => {
    // The web's tags don't count for the apps, nor the apps' for the web, nor
    // the dry-run, pre-release and other tags that start alike.
    const tags = [
      "v0.1.3",
      "web-v0.9.0",
      "session-v0.9.0",
      "v0-dry-run",
      "v0.1.4-rc.1",
      "vault-v9.0.0",
      "v9",
      "web-v0.1.3",
      "v0.9.0",
      "web-v0-dry-run",
    ];
    expect(check("v0.1.3", tags)).toEqual(superseded("v0.9.0", "v0.1.3"));
    expect(check("web-v0.1.3", tags)).toEqual(
      superseded("web-v0.9.0", "web-v0.1.3"),
    );
    expect(check("v0.9.0", tags).code).toBe(0);
    expect(check("web-v0.9.0", tags).code).toBe(0);
  });

  it("compares with the tags there are, even without its own", () => {
    expect(check("v0.1.3", []).code).toBe(0);
    expect(check("v0.1.3", ["v0.1.2"]).code).toBe(0);
    expect(check("v0.1.3", ["v0.1.4"])).toEqual(superseded("v0.1.4", "v0.1.3"));
  });

  it("refuses a tag that isn't a version tag", () => {
    for (const tag of ["v0-dry-run", "web-v0-dry-run", "0.1.3", "v0.1"]) {
      expect(check(tag, ["v0.1.3"]), tag).toEqual({
        code: 1,
        out: `::error::${tag} isn't a version tag, such as v0.1.3 or web-v0.1.3.\n`,
      });
    }
  });

  it("fails when GitHub doesn't answer", () => {
    const result = check("v0.1.3", ["v0.1.3"], { fail: true });
    expect(result.code).toBe(1);
    expect(result.out).toBe("HTTP 502\n");
  });
});

describe("check-not-superseded.sh without GITHUB_REPOSITORY", () => {
  it("names what's missing instead of guessing a repository", () => {
    const result = spawnSync("bash", [SCRIPT, ...["v0.1.3"]], {
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
