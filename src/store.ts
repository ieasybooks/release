// An app's store folder (<app>/store/) holds what its release workflow sends
// to the App Store, Google Play and AppGallery besides the apps themselves:
// the listing texts, the release notes, the reviewer notes and the images.
// This module reads it, checks it against each store's limits, and writes the
// folder layouts fastlane reads. README.md describes the folder.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type StoreName = "appStore" | "googlePlay" | "appGallery";
export const STORES: readonly StoreName[] = [
  "appStore",
  "googlePlay",
  "appGallery",
];
const STORE_TITLES: Record<StoreName, string> = {
  appStore: "the App Store",
  googlePlay: "Google Play",
  appGallery: "AppGallery",
};

// Each language's locale code in each store the app is released to.
export type Locales = Partial<Record<StoreName, string>>;

export type Config = {
  // The app's name in messages, such as "Mofied".
  name?: string;
  // The stores the app is released to; all three when left out.
  stores?: StoreName[];
  languages: Record<string, Locales>;
  // copyrightHolder makes the App Store's copyright line, "<year> <holder>",
  // with the year of the release.
  appStore?: {
    supportUrl: string;
    marketingUrl: string;
    privacyUrl: string;
    copyrightHolder: string;
  };
  appGallery?: { appId: string };
};

export function storesOf(config: Config): readonly StoreName[] {
  return config.stores ?? STORES;
}

export function releasesTo(config: Config, store: StoreName): boolean {
  return storesOf(config).includes(store);
}

// The App Store's copyright line for a release in the given year.
export function copyright(config: Config, year: number): string {
  return `${year} ${config.appStore?.copyrightHolder ?? ""}`.trim();
}

export const LISTING_FIELDS = {
  name: "name.txt",
  appStoreName: "app-store-name.txt",
  subtitle: "subtitle.txt",
  shortDescription: "short-description.txt",
  description: "description.txt",
  keywords: "keywords.txt",
} as const;

export type Listing = Record<keyof typeof LISTING_FIELDS, string>;

// The stores that show each text; a text is needed only when the app is
// released to one of them.
export const LISTING_STORES: Record<keyof Listing, readonly StoreName[]> = {
  name: ["googlePlay", "appGallery"],
  appStoreName: ["appStore"],
  subtitle: ["appStore"],
  shortDescription: STORES,
  description: STORES,
  keywords: ["appStore"],
};

// The tightest limit among the stores that use each text, in characters.
export const LIMITS: Record<
  keyof Listing | "releaseNotes",
  { max: number; stores: string }
> = {
  name: { max: 30, stores: "Google Play title (30), AppGallery app name (64)" },
  appStoreName: { max: 30, stores: "App Store name (30)" },
  subtitle: { max: 30, stores: "App Store subtitle (30)" },
  shortDescription: {
    max: 80,
    stores:
      "Google Play short description (80), AppGallery brief introduction (80), App Store promotional text (170)",
  },
  description: {
    max: 4000,
    stores:
      "App Store and Google Play description (4000), AppGallery introduction (8000)",
  },
  keywords: { max: 100, stores: "App Store keywords (100)" },
  releaseNotes: {
    max: 500,
    stores:
      "Google Play release notes (500), AppGallery new features (500), App Store (4000)",
  },
};

export const REVIEW_NOTES = {
  appStore: { file: "app-store.txt", min: 1, max: 4000 },
  appGallery: { file: "appgallery.txt", min: 10, max: 300 },
} as const;

// Image folders under <app>/store/screenshots/<store>/<language>/ and what each
// store accepts there. Apple tells devices apart by size, so its folders list
// the sizes fastlane maps to a display type.
type ImageRule = {
  min: number;
  max: number;
  sizes?: string[];
  playScreenshot?: boolean;
};
// The store each image folder is for.
export const IMAGE_STORES: Record<string, StoreName> = {
  "app-store": "appStore",
  "google-play": "googlePlay",
  appgallery: "appGallery",
};
export const IMAGES: Record<string, Record<string, ImageRule>> = {
  "app-store": {
    iphone: {
      min: 1,
      max: 10,
      sizes: ["1320x2868", "1290x2796", "1206x2622", "1284x2778", "1242x2688"],
    },
    ipad: { min: 0, max: 10, sizes: ["2064x2752", "2048x2732"] },
  },
  "google-play": {
    "icon.png": { min: 1, max: 1, sizes: ["512x512"] },
    "feature-graphic.png": { min: 1, max: 1, sizes: ["1024x500"] },
    phone: { min: 2, max: 8, playScreenshot: true },
    "seven-inch": { min: 0, max: 8, playScreenshot: true },
    "ten-inch": { min: 0, max: 8, playScreenshot: true },
  },
  appgallery: {
    "icon.png": { min: 1, max: 1, sizes: ["216x216"] },
    phone: { min: 3, max: 5 },
  },
};

export type Store = {
  root: string;
  config: Config;
  listings: Record<string, Listing>;
  reviewNotes: Record<keyof typeof REVIEW_NOTES, string>;
};

export function readStore(root: string): Store {
  const config = JSON.parse(
    readFileSync(join(root, "store.json"), "utf8"),
  ) as Config;
  const listings: Record<string, Listing> = {};
  for (const language of Object.keys(config.languages)) {
    const listing = {} as Listing;
    for (const [field, file] of Object.entries(LISTING_FIELDS)) {
      listing[field as keyof Listing] = readText(join(root, language, file));
    }
    listings[language] = listing;
  }
  const reviewNotes = {} as Store["reviewNotes"];
  for (const [store, { file }] of Object.entries(REVIEW_NOTES)) {
    reviewNotes[store as keyof typeof REVIEW_NOTES] = readText(
      join(root, "review-notes", file),
    );
  }
  return { root, config, listings, reviewNotes };
}

// A missing file reads as empty, so the checks report it with the others.
export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

export function releaseNotesPath(
  store: Store,
  version: string,
  language: string,
): string {
  return join(store.root, "release-notes", version, `${language}.txt`);
}

export function releaseNotes(
  store: Store,
  version: string,
  language: string,
): string {
  return readText(releaseNotesPath(store, version, language));
}

// Characters as people count them, not UTF-16 units.
export function length(text: string): number {
  return [...text].length;
}

export function problems(store: Store, version: string): string[] {
  const found: string[] = [];
  const check = (
    label: string,
    text: string,
    min: number,
    max: number,
    why: string,
  ) => {
    if (length(text) < min)
      found.push(
        text === ""
          ? `${label} is missing or empty`
          : `${label} is shorter than ${min} characters`,
      );
    if (length(text) > max)
      found.push(
        `${label} has ${length(text)} characters, over ${max}: ${why}`,
      );
  };
  found.push(...configProblems(store));
  const stores = storesOf(store.config);
  for (const [language, listing] of Object.entries(store.listings)) {
    for (const [field, file] of Object.entries(LISTING_FIELDS)) {
      if (
        !LISTING_STORES[field as keyof Listing].some((s) => stores.includes(s))
      )
        continue;
      const limit = LIMITS[field as keyof Listing];
      check(
        join(store.root, language, file),
        listing[field as keyof Listing],
        1,
        limit.max,
        limit.stores,
      );
    }
    const notes = releaseNotesPath(store, version, language);
    check(
      notes,
      releaseNotes(store, version, language),
      1,
      LIMITS.releaseNotes.max,
      LIMITS.releaseNotes.stores,
    );
  }
  for (const [name, rule] of Object.entries(REVIEW_NOTES)) {
    if (!stores.includes(name as StoreName)) continue;
    check(
      join(store.root, "review-notes", rule.file),
      store.reviewNotes[name as keyof typeof REVIEW_NOTES],
      rule.min,
      rule.max,
      name,
    );
  }
  found.push(...imageProblems(store));
  return found;
}

// What store.json is missing for the stores the app is released to.
function configProblems(store: Store): string[] {
  const found: string[] = [];
  const file = join(store.root, "store.json");
  const { config } = store;
  for (const name of config.stores ?? []) {
    if (!STORES.includes(name))
      found.push(`${file}: "${name}" isn't a store; use ${STORES.join(", ")}`);
  }
  if (config.stores && config.stores.length === 0)
    found.push(
      `${file}: stores is empty; leave it out to release to all three`,
    );
  const stores = storesOf(config);
  for (const name of stores) {
    for (const [language, locales] of Object.entries(config.languages)) {
      if (!locales[name])
        found.push(
          `${file}: the ${language} language has no ${name} locale, which ${STORE_TITLES[name]} needs`,
        );
    }
  }
  if (stores.includes("appStore")) {
    const fields = [
      "supportUrl",
      "marketingUrl",
      "privacyUrl",
      "copyrightHolder",
    ] as const;
    for (const field of fields) {
      if (!config.appStore?.[field]?.trim())
        found.push(`${file}: appStore.${field} is missing or empty`);
    }
  }
  if (stores.includes("appGallery") && !config.appGallery?.appId?.trim())
    found.push(`${file}: appGallery.appId is missing or empty`);
  return found;
}

function imageProblems(store: Store): string[] {
  const found: string[] = [];
  for (const [storeName, folders] of Object.entries(IMAGES)) {
    if (!releasesTo(store.config, IMAGE_STORES[storeName]!)) continue;
    for (const language of Object.keys(store.config.languages)) {
      for (const [entry, rule] of Object.entries(folders)) {
        const path = join(
          store.root,
          "screenshots",
          storeName,
          language,
          entry,
        );
        const files = entry.endsWith(".png")
          ? existsSync(path)
            ? [path]
            : []
          : pngs(path).map((f) => join(path, f));
        if (files.length < rule.min || files.length > rule.max) {
          const range =
            rule.min === rule.max
              ? `${rule.min}`
              : `${rule.min} to ${rule.max}`;
          found.push(
            `${path} needs ${range} PNG ${rule.max === 1 ? "file" : "files"}, found ${files.length}`,
          );
        }
        for (const file of files) {
          let size: { width: number; height: number };
          try {
            size = pngSize(readFileSync(file));
          } catch (error) {
            found.push(`${file}: ${(error as Error).message}`);
            continue;
          }
          const { width, height } = size;
          if (
            rule.sizes &&
            !rule.sizes.includes(`${width}x${height}`) &&
            !rule.sizes.includes(`${height}x${width}`)
          ) {
            found.push(
              `${file} is ${width}x${height}; ${storeName} takes ${rule.sizes.join(", ")}`,
            );
          }
          // Google Play: each side 320 to 3840 pixels, the long one at most twice the short one.
          if (
            rule.playScreenshot &&
            (Math.min(width, height) < 320 ||
              Math.max(width, height) > 3840 ||
              Math.max(width, height) > 2 * Math.min(width, height))
          ) {
            found.push(
              `${file} is ${width}x${height}; Google Play screenshots are 320 to 3840 pixels a side, at most 2:1`,
            );
          }
        }
      }
    }
  }
  return found;
}

// The PNG files in a folder, in the order the stores show them.
export function pngs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith(".png"))
    .sort();
}

export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== signature ||
    bytes.subarray(12, 16).toString() !== "IHDR"
  ) {
    throw new Error("isn't a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// The metadata folders fastlane's deliver (App Store) and supply (Google
// Play) read, under out/app-store and out/google-play, for the stores the app
// is released to. The copyright line takes the release's year.
export function writeFastlaneMetadata(
  store: Store,
  version: string,
  versionCode: number,
  out: string,
  year = new Date().getUTCFullYear(),
): void {
  const { config } = store;
  if (releasesTo(config, "appStore")) {
    const metadata = join(out, "app-store", "metadata");
    const reviewDir = join(metadata, "review_information");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, "notes.txt"), store.reviewNotes.appStore);
    writeFileSync(join(metadata, "copyright.txt"), copyright(config, year));
  }

  for (const [language, locales] of Object.entries(config.languages)) {
    const listing = store.listings[language]!;
    const notes = releaseNotes(store, version, language);
    if (releasesTo(config, "appStore"))
      writeAppStoreLanguage(
        store,
        language,
        locales.appStore!,
        listing,
        notes,
        out,
      );
    if (releasesTo(config, "googlePlay"))
      writeGooglePlayLanguage(
        store,
        language,
        locales.googlePlay!,
        listing,
        notes,
        versionCode,
        out,
      );
  }
}

function writeAppStoreLanguage(
  store: Store,
  language: string,
  locale: string,
  listing: Listing,
  notes: string,
  out: string,
): void {
  const appStore = store.config.appStore!;
  const apple = join(out, "app-store", "metadata", locale);
  mkdirSync(apple, { recursive: true });
  const appleFiles: Record<string, string> = {
    "name.txt": listing.appStoreName,
    "subtitle.txt": listing.subtitle,
    "promotional_text.txt": listing.shortDescription,
    "description.txt": listing.description,
    "keywords.txt": listing.keywords,
    "release_notes.txt": notes,
    "support_url.txt": appStore.supportUrl,
    "marketing_url.txt": appStore.marketingUrl,
    "privacy_url.txt": appStore.privacyUrl,
  };
  for (const [file, text] of Object.entries(appleFiles))
    writeFileSync(join(apple, file), text);

  // deliver reads one folder per language and tells devices apart by size.
  const appleShots = join(out, "app-store", "screenshots", locale);
  mkdirSync(appleShots, { recursive: true });
  for (const device of Object.keys(IMAGES["app-store"])) {
    const dir = join(store.root, "screenshots", "app-store", language, device);
    for (const file of pngs(dir))
      copyFileSync(join(dir, file), join(appleShots, `${device}-${file}`));
  }
}

function writeGooglePlayLanguage(
  store: Store,
  language: string,
  locale: string,
  listing: Listing,
  notes: string,
  versionCode: number,
  out: string,
): void {
  const play = join(out, "google-play", "metadata", locale);
  mkdirSync(join(play, "changelogs"), { recursive: true });
  writeFileSync(join(play, "title.txt"), listing.name);
  writeFileSync(join(play, "short_description.txt"), listing.shortDescription);
  writeFileSync(join(play, "full_description.txt"), listing.description);
  writeFileSync(join(play, "changelogs", `${versionCode}.txt`), notes);

  const playShots = join(store.root, "screenshots", "google-play", language);
  const images = join(play, "images");
  mkdirSync(images, { recursive: true });
  copyFileSync(join(playShots, "icon.png"), join(images, "icon.png"));
  copyFileSync(
    join(playShots, "feature-graphic.png"),
    join(images, "featureGraphic.png"),
  );
  const playFolders = {
    phone: "phoneScreenshots",
    "seven-inch": "sevenInchScreenshots",
    "ten-inch": "tenInchScreenshots",
  };
  for (const [folder, type] of Object.entries(playFolders)) {
    const files = pngs(join(playShots, folder));
    if (files.length === 0) continue;
    mkdirSync(join(images, type), { recursive: true });
    for (const file of files)
      copyFileSync(join(playShots, folder, file), join(images, type, file));
  }
}
