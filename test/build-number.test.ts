import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildNumber } from "../build-number.cjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("buildNumber", () => {
  it("gives each version its own number, rising with the version", () => {
    expect(buildNumber("0.1.3")).toBe(1003);
    expect(buildNumber("0.2.0")).toBe(2000);
    expect(buildNumber("1.0.0")).toBe(1_000_000);
    expect(buildNumber("1.2.3")).toBe(1_002_003);
    expect(buildNumber("2100.0.0")).toBe(2_100_000_000);
    const ordered = [
      "0.0.1",
      "0.1.3",
      "0.1.999",
      "0.2.0",
      "0.999.999",
      "1.0.0",
    ];
    const numbers = ordered.map(buildNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("refuses versions the stores can't number", () => {
    for (const version of ["0.1", "v0.1.3", "0.1.3-beta.1", "01.2.3", ""])
      expect(() => buildNumber(version)).toThrow("isn't MAJOR.MINOR.PATCH");
    expect(() => buildNumber("0.1000.0")).toThrow("go up to 999");
    expect(() => buildNumber("0.1.1000")).toThrow("go up to 999");
    expect(() => buildNumber("0.0.0")).toThrow("from 0.0.1 to 2100.0.0");
    expect(() => buildNumber("2100.0.1")).toThrow("from 0.0.1 to 2100.0.0");
  });

  // An app's app.config.ts imports it, and Expo loads that with Node's
  // require: the package's export must load there, as plain CommonJS that
  // runs nothing else.
  it("loads with Node's require, through the package's export", () => {
    const out = execFileSync(
      "node",
      [
        "-e",
        `const { buildNumber } = require("@ieasybooks/release/build-number"); console.log(buildNumber("1.2.3"), Object.keys(require("@ieasybooks/release/build-number")).join())`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(out).toBe("1002003 buildNumber\n");
  });

  it("loads in Bun too", () => {
    const out = execFileSync(
      "bun",
      [
        "-e",
        `import { buildNumber } from "@ieasybooks/release/build-number"; console.log(buildNumber("0.1.3"))`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(out).toBe("1003\n");
  });
});
