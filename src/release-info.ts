// An app's version being released and its build numbers: the version in the
// app's package.json (or, for a Flutter app, its pubspec.yaml), which
// release-please raises and the app reports, and the iOS buildNumber and
// Android versionCode that follow from it
// (build-number.cjs). `ieasybooks-release release-info --app <folder>` prints
// them as JSON for fastlane:
//
//   {"version":"0.1.3","iosBuildNumber":"1003","androidVersionCode":1003}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNumber } from "../build-number.cjs";

export type ReleaseInfo = {
  version: string;
  iosBuildNumber: string;
  androidVersionCode: number;
};

// The file that holds an app's version: a Flutter app's pubspec.yaml, or
// else package.json, such as apps/mobile/package.json. A Flutter app's
// package.json only installs this tooling, so its pubspec.yaml wins.
export function versionFile(app: string): string {
  const pubspec = join(app, "pubspec.yaml");
  return existsSync(pubspec) ? pubspec : join(app, "package.json");
}

// The version as written, so a pubspec.yaml's +build suffix, which the build
// numbers replace, shows up as a problem instead of being dropped quietly.
export function readVersion(app: string): string {
  const file = versionFile(app);
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".yaml")) {
    const match = /^version:\s*["']?([^\s"'#]+)/m.exec(text);
    if (!match) throw new Error(`${file} has no version`);
    return match[1]!;
  }
  return (JSON.parse(text) as { version: string }).version;
}

export function releaseInfo(version: string): ReleaseInfo {
  const code = buildNumber(version);
  return { version, iosBuildNumber: String(code), androidVersionCode: code };
}

export function readReleaseInfo(app: string): ReleaseInfo {
  return releaseInfo(readVersion(app));
}

// Why the version can't be released under the tag, if given. App tags are
// v<version>.
export function releaseInfoProblems(
  app: string,
  version: string,
  tag?: string,
): string[] {
  const found: string[] = [];
  try {
    buildNumber(version);
  } catch (error) {
    found.push(`${versionFile(app)}: ${(error as Error).message}`);
  }
  if (tag !== undefined && tag !== `v${version}`) {
    found.push(
      `the tag ${tag} doesn't match ${versionFile(app)}'s version ${version}; tag v${version}`,
    );
  }
  return found;
}
