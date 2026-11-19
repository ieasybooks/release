// A made-up app with a complete store folder in Arabic and English, for the
// tests and for the consumer check in CI (test/make-fixture.ts). The two
// languages' texts and images differ on purpose, so copying one language's
// content into the other's place shows. No binary files are committed: each
// image is a PNG header with its size, followed by its own path, so each file
// differs from the others.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LANGUAGES = {
  ar: { appStore: "ar-SA", googlePlay: "ar", appGallery: "ar" },
  en: { appStore: "en-US", googlePlay: "en-US", appGallery: "en-US" },
} as const;

export const LISTINGS = {
  ar: {
    "name.txt": "شوارد",
    "app-store-name.txt": "شوارد: الشعر كما يُلقى",
    "subtitle.txt": "اسمع القصيدة واقرأها",
    "short-description.txt":
      "قصائد عربية بأصوات قرّائها، تضيء أبياتها شطرًا شطرًا.",
    "description.txt": "شوارد يجمع الشعر العربي مسموعًا ومقروءًا ومشروحًا.",
    "keywords.txt": "شعر,قصائد,إلقاء",
  },
  en: {
    "name.txt": "Shawared",
    "app-store-name.txt": "Shawared: Poetry Recited",
    "subtitle.txt": "Hear it, read it",
    "short-description.txt":
      "Arabic poems in their reciters' voices, lit up half by half.",
    "description.txt":
      "Shawared brings Arabic poetry to hear, read and understand.",
    "keywords.txt": "poetry,poems,recitation",
  },
} as const;

export const RELEASE_NOTES = {
  ar: "قصائد جديدة وإصلاحات.",
  en: "New poems and fixes.",
};
export const REVIEW_NOTES = {
  "app-store.txt": "No account is needed: open any poem and press play.",
  "appgallery.txt": "No account is needed; open any poem and press play.",
};

// The image files of each language, with their sizes.
export const IMAGES: Record<string, [number, number]> = {
  "app-store/LANG/iphone/01-library.png": [1320, 2868],
  "app-store/LANG/iphone/02-poem.png": [1320, 2868],
  "app-store/LANG/ipad/01-library.png": [2064, 2752],
  "google-play/LANG/icon.png": [512, 512],
  "google-play/LANG/feature-graphic.png": [1024, 500],
  "google-play/LANG/phone/01-library.png": [1080, 1920],
  "google-play/LANG/phone/02-poem.png": [1080, 1920],
  "google-play/LANG/seven-inch/01-library.png": [1200, 1920],
  "appgallery/LANG/icon.png": [216, 216],
  "appgallery/LANG/phone/01-library.png": [1080, 1920],
  "appgallery/LANG/phone/02-poem.png": [1080, 1920],
  "appgallery/LANG/phone/03-reciter.png": [1080, 1920],
};

// A PNG header with the size, then a tag that makes the file unique.
export function png(width: number, height: number, tag = ""): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return Buffer.concat([bytes, Buffer.from(tag)]);
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Writes the app into `app`: its package.json with the version, and its
// store folder ready to release that version.
export function makeApp(app: string, version = "0.1.3"): string {
  write(
    join(app, "package.json"),
    JSON.stringify({ name: "@shawared/app", version }, null, 2),
  );
  const store = join(app, "store");
  write(
    join(store, "store.json"),
    JSON.stringify(
      {
        name: "Shawared",
        languages: LANGUAGES,
        appStore: {
          supportUrl: "https://shawared.com/support/",
          marketingUrl: "https://shawared.com/",
          privacyUrl: "https://shawared.com/privacy/",
          copyrightHolder: "الكتب المُيسّرة",
        },
        appGallery: { appId: "1234567" },
      },
      null,
      2,
    ),
  );
  for (const [language, files] of Object.entries(LISTINGS)) {
    for (const [file, text] of Object.entries(files))
      write(join(store, language, file), `${text}\n`);
    write(
      join(store, "release-notes", version, `${language}.txt`),
      `${RELEASE_NOTES[language as keyof typeof RELEASE_NOTES]}\n`,
    );
    for (const [pattern, [width, height]] of Object.entries(IMAGES)) {
      const path = pattern.replace("LANG", language);
      write(join(store, "screenshots", path), png(width, height, path));
    }
  }
  for (const [file, text] of Object.entries(REVIEW_NOTES))
    write(join(store, "review-notes", file), `${text}\n`);
  return app;
}
