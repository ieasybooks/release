// ieasybooks-release: the release commands ieasybooks apps share. Workflows
// run it from node_modules/.bin, never through bunx, which would download
// whatever npm has under the name when the package is missing. README.md
// describes each command.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppGallery,
  publishToAppGallery,
  type Io,
  type ServiceAccount,
} from "./appgallery.ts";
import {
  readReleaseInfo,
  readVersion,
  releaseInfo,
  releaseInfoProblems,
} from "./release-info.ts";
import { collect, components, routingProblems } from "./routing.ts";
import {
  AUDITED_STORES,
  type AppStoreKey,
  type AuditedStore,
  type GoogleServiceAccount,
  auditAppGallery,
  auditAppStore,
  auditConfig,
  auditGooglePlay,
} from "./audit.ts";
import {
  problems,
  readStore,
  releasesTo,
  storesOf,
  writeFastlaneMetadata,
} from "./store.ts";

export const USAGE = `usage: ieasybooks-release <command>

  release-info --app <folder>
      Prints the app's version and build numbers as JSON, for fastlane.
  store check --app <folder> [--tag <tag>]
      Checks that the version can be released: its build numbers, the tag if
      given, and <folder>/store/ with the version's release notes.
  store fastlane-metadata --app <folder> <out>
      Writes <folder>/store/ in the layouts fastlane's deliver and supply read.
  store audit --app <folder> --store <appStore|googlePlay|appGallery>
      Compares the store's settings a release doesn't set with store.json's
      audit, failing on a difference. Uses APPLE_API_KEY_FILE,
      GOOGLE_PLAY_SERVICE_ACCOUNT_FILE or APPGALLERY_CONNECT_SERVICE_ACCOUNT.
  appgallery publish --app <folder> <apk> [--dry-run]
      Publishes the APK to AppGallery, with APPGALLERY_CONNECT_SERVICE_ACCOUNT.
  routing <base> <head>
      Checks that every commit (and TITLE) that would release changes a
      component in release-please-config.json.
  verify-commit <tag> <sha> [--checked]
      Checks that the tag points at the commit, and with --checked that its
      Checks status passed. Uses gh and GITHUB_REPOSITORY.
  not-superseded <tag>
      Stops a release that a newer one of its component superseded. Uses gh
      and GITHUB_REPOSITORY.`;

class UsageError extends Error {}

type Args = {
  positional: string[];
  app?: string;
  tag?: string;
  store?: string;
  flags: Set<string>;
};

function parse(argv: string[], options: string[], flags: string[]): Args {
  const args: Args = { positional: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (flags.includes(name)) {
        args.flags.add(name);
      } else if (options.includes(name)) {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--"))
          throw new UsageError(`${arg} needs a value`);
        (args as Record<string, unknown>)[name] = value;
      } else {
        throw new UsageError(`unknown option ${arg}`);
      }
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function app(args: Args): string {
  if (!args.app) throw new UsageError("--app <folder> is required");
  return args.app;
}

function positional(args: Args, count: number): string[] {
  if (args.positional.length !== count)
    throw new UsageError(
      `expected ${count} argument${count === 1 ? "" : "s"}, got ${args.positional.length}`,
    );
  return args.positional;
}

function script(name: string, argv: string[]): number {
  const path = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
  const result = spawnSync("bash", [path, ...argv], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function storeCheck(argv: string[]): number {
  const args = parse(argv, ["app", "tag"], []);
  positional(args, 0);
  const folder = app(args);
  const store = readStore(join(folder, "store"));
  const name = store.config.name ?? "The apps";
  const version = readVersion(folder);
  const found = [
    ...releaseInfoProblems(folder, version, args.tag),
    ...problems(store, version),
  ];
  if (found.length > 0) {
    console.error(`${name} ${version} can't be released yet:`);
    for (const problem of found) console.error(`  - ${problem}`);
    return 1;
  }
  const info = releaseInfo(version);
  const stores = storesOf(store.config);
  const platforms = [
    ...(stores.includes("appStore") ? ["iOS"] : []),
    ...(stores.some((s) => s !== "appStore") ? ["Android"] : []),
  ].join(" and ");
  console.log(
    `${name} ${version} (build ${info.iosBuildNumber} on ${platforms}) is ready to release.`,
  );
  return 0;
}

function fastlaneMetadata(argv: string[]): number {
  const args = parse(argv, ["app"], []);
  const [out] = positional(args, 1);
  const folder = app(args);
  const info = readReleaseInfo(folder);
  rmSync(out, { recursive: true, force: true });
  writeFastlaneMetadata(
    readStore(join(folder, "store")),
    info.version,
    info.androidVersionCode,
    out,
  );
  console.log(`Wrote the ${info.version} store metadata to ${out}.`);
  return 0;
}

async function appgalleryPublish(argv: string[]): Promise<number> {
  const args = parse(argv, ["app"], ["dry-run"]);
  const [apkPath] = positional(args, 1);
  const folder = app(args);
  const key = process.env.APPGALLERY_CONNECT_SERVICE_ACCOUNT;
  if (!key)
    throw new UsageError(
      "APPGALLERY_CONNECT_SERVICE_ACCOUNT must hold the service account's key file",
    );
  const io: Io = {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  };
  const store = readStore(join(folder, "store"));
  const appId = store.config.appGallery?.appId;
  if (!releasesTo(store.config, "appGallery") || !appId)
    throw new UsageError(
      `${store.config.name ?? "The app"} isn't released to AppGallery: store.json has no appGallery.appId, or its stores leave AppGallery out`,
    );
  const gallery = new AppGallery(JSON.parse(key) as ServiceAccount, appId, io);
  await publishToAppGallery({
    gallery,
    store,
    version: readReleaseInfo(folder).version,
    apk: { fileName: basename(apkPath), bytes: readFileSync(apkPath) },
    dryRun: args.flags.has("dry-run"),
    io,
  });
  return 0;
}

function routing(argv: string[]): number {
  const args = parse(argv, [], []);
  const [base, head] = positional(args, 2);
  const folders = components();
  const pr = collect(base, head, process.env.TITLE ?? "");
  const found = routingProblems(pr, folders);
  if (found.length === 0) {
    console.log(
      `${pr.commits.length} commits checked: each one that would release changes a component.`,
    );
    return 0;
  }
  console.error(found.map((problem) => `- ${problem}`).join("\n"));
  console.error(
    `\nThe components are ${folders.join(", ")}. Use a type that releases nothing (chore:, build:, ci:, docs:, refactor:, test:), ` +
      "or move what ships into the component it belongs to. See docs/releasing.md.",
  );
  return 1;
}

// The credentials each store job already has for its release.
function secretJson<T>(name: string, file = true): T {
  const value = process.env[name];
  if (!value)
    throw new UsageError(
      `${name} must hold ${file ? "the path of the key file" : "the key file's contents"}`,
    );
  return JSON.parse(file ? readFileSync(value, "utf8") : value) as T;
}

async function storeAudit(argv: string[]): Promise<number> {
  const args = parse(argv, ["app", "store"], []);
  positional(args, 0);
  const folder = app(args);
  const which = args.store as AuditedStore | undefined;
  if (!which || !AUDITED_STORES.includes(which))
    throw new UsageError(`--store must be one of ${AUDITED_STORES.join(", ")}`);
  const store = readStore(join(folder, "store"));
  const name = store.config.name ?? "The app";
  if (!releasesTo(store.config, which))
    throw new UsageError(`${name} isn't released to ${which}`);
  const audit = auditConfig(store.config);
  const io = { fetch };
  let found: string[];
  if (which === "appStore") {
    if (!audit.appStore) return nothingToAudit(name, which);
    found = await auditAppStore(
      audit.appStore,
      secretJson<AppStoreKey>("APPLE_API_KEY_FILE"),
      io,
    );
  } else if (which === "googlePlay") {
    if (!audit.googlePlay) return nothingToAudit(name, which);
    found = await auditGooglePlay(
      audit.googlePlay,
      secretJson<GoogleServiceAccount>("GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"),
      io,
    );
  } else {
    if (!audit.appGallery) return nothingToAudit(name, which);
    const appId = store.config.appGallery?.appId;
    if (!appId) throw new UsageError(`${name} has no appGallery.appId`);
    found = await auditAppGallery(
      audit.appGallery,
      new AppGallery(
        secretJson<ServiceAccount>("APPGALLERY_CONNECT_SERVICE_ACCOUNT", false),
        appId,
        {
          fetch,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log: (line) => console.log(line),
        },
      ),
    );
  }
  if (found.length > 0) {
    console.error(
      `${name}'s ${which} settings differ from store.json; fix them in the store's console or in store.json:`,
    );
    for (const line of found) console.error(`  - ${line}`);
    return 1;
  }
  console.log(`${name}'s ${which} settings match store.json.`);
  return 0;
}

function nothingToAudit(name: string, which: string): number {
  console.log(
    `${name}'s store.json has no audit for ${which}; nothing to check.`,
  );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "release-info": {
        const args = parse(rest, ["app"], []);
        positional(args, 0);
        console.log(JSON.stringify(readReleaseInfo(app(args))));
        return 0;
      }
      case "store": {
        const [sub, ...more] = rest;
        if (sub === "check") return storeCheck(more);
        if (sub === "fastlane-metadata") return fastlaneMetadata(more);
        if (sub === "audit") return await storeAudit(more);
        throw new UsageError(`unknown store command ${sub ?? "(none)"}`);
      }
      case "appgallery": {
        const [sub, ...more] = rest;
        if (sub === "publish") return await appgalleryPublish(more);
        throw new UsageError(`unknown appgallery command ${sub ?? "(none)"}`);
      }
      case "routing":
        return routing(rest);
      case "verify-commit":
        return script("verify-release-commit.sh", rest);
      case "not-superseded":
        return script("check-not-superseded.sh", rest);
      case undefined:
      case "help":
      case "--help":
        console.log(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`ieasybooks-release: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}
