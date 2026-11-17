import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  readReleaseInfo,
  readVersion,
  releaseInfo,
  releaseInfoProblems,
  versionFile,
} from "../src/release-info.ts";
import { makeApp } from "./fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "release-info-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const app = makeApp(join(dir, "apps/mobile"), "0.2.5");

describe("releaseInfo", () => {
  it("numbers both platforms' builds from the version", () => {
    expect(releaseInfo("0.1.3")).toEqual({
      version: "0.1.3",
      iosBuildNumber: "1003",
      androidVersionCode: 1003,
    });
  });

  it("reads the version from the app's package.json", () => {
    expect(versionFile("apps/mobile")).toBe("apps/mobile/package.json");
    expect(readVersion(app)).toBe("0.2.5");
    expect(readReleaseInfo(app)).toEqual({
      version: "0.2.5",
      iosBuildNumber: "2005",
      androidVersionCode: 2005,
    });
  });
});

describe("releaseInfoProblems", () => {
  it("accepts the matching tag, or none", () => {
    expect(releaseInfoProblems("apps/mobile", "0.1.3", "v0.1.3")).toEqual([]);
    expect(releaseInfoProblems("apps/mobile", "0.1.3")).toEqual([]);
  });

  it("reports a tag for another version, naming the app's version file", () => {
    expect(releaseInfoProblems("apps/mobile", "0.1.3", "v0.1.4")).toEqual([
      "the tag v0.1.4 doesn't match apps/mobile/package.json's version 0.1.3; tag v0.1.3",
    ]);
    expect(releaseInfoProblems("apps/app", "0.1.3", "v0.1.4")).toEqual([
      "the tag v0.1.4 doesn't match apps/app/package.json's version 0.1.3; tag v0.1.3",
    ]);
    expect(releaseInfoProblems("apps/mobile", "0.1.3", "0.1.3")).toHaveLength(
      1,
    );
    expect(
      releaseInfoProblems("apps/mobile", "0.1.3", "web-v0.1.3"),
    ).toHaveLength(1);
  });

  it("reports versions the stores can't number", () => {
    expect(releaseInfoProblems("apps/mobile", "0.1")).toEqual([
      "apps/mobile/package.json: the version 0.1 isn't MAJOR.MINOR.PATCH",
    ]);
    expect(releaseInfoProblems("apps/mobile", "0.1.1000")).toHaveLength(1);
  });
});
