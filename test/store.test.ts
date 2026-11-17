import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  length,
  pngSize,
  problems,
  readStore,
  writeFastlaneMetadata,
} from "../src/store.ts";
import { LISTINGS, RELEASE_NOTES, makeApp, png } from "./fixture.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// A fresh copy of the fixture app's store folder, at version 0.1.3.
function fixtureStore(): string {
  return join(makeApp(join(temp("store-"), "app")), "store");
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe("problems", () => {
  it("finds none in a store folder ready for the version, in both languages", () => {
    const root = fixtureStore();
    expect(readStore(root).config.name).toBe("Shawared");
    expect(Object.keys(readStore(root).listings)).toEqual(["ar", "en"]);
    expect(problems(readStore(root), "0.1.3")).toEqual([]);
  });

  it("needs each language's release notes for the version", () => {
    const root = fixtureStore();
    expect(problems(readStore(root), "9.9.9")).toEqual([
      `${root}/release-notes/9.9.9/ar.txt is missing or empty`,
      `${root}/release-notes/9.9.9/en.txt is missing or empty`,
    ]);
    rmSync(join(root, "release-notes/0.1.3/en.txt"));
    expect(problems(readStore(root), "0.1.3")).toEqual([
      `${root}/release-notes/0.1.3/en.txt is missing or empty`,
    ]);
  });

  it("reports texts over each store's limits, counting characters", () => {
    const root = fixtureStore();
    writeFileSync(join(root, "ar/name.txt"), "م".repeat(31));
    writeFileSync(join(root, "en/short-description.txt"), "x".repeat(81));
    writeFileSync(join(root, "ar/short-description.txt"), "م".repeat(80));
    writeFileSync(join(root, "ar/keywords.txt"), "");
    writeFileSync(join(root, "release-notes/0.1.3/ar.txt"), "م".repeat(501));
    writeFileSync(join(root, "review-notes/appgallery.txt"), "Too short");
    expect(problems(readStore(root), "0.1.3")).toEqual([
      `${root}/ar/name.txt has 31 characters, over 30: Google Play title (30), AppGallery app name (64)`,
      `${root}/ar/keywords.txt is missing or empty`,
      `${root}/release-notes/0.1.3/ar.txt has 501 characters, over 500: Google Play release notes (500), AppGallery new features (500), App Store (4000)`,
      `${root}/en/short-description.txt has 81 characters, over 80: Google Play short description (80), AppGallery brief introduction (80), App Store promotional text (170)`,
      `${root}/review-notes/appgallery.txt is shorter than 10 characters`,
    ]);
  });

  it("reports missing files", () => {
    const root = fixtureStore();
    rmSync(join(root, "en/subtitle.txt"));
    rmSync(join(root, "review-notes/app-store.txt"));
    expect(problems(readStore(root), "0.1.3")).toEqual([
      `${root}/en/subtitle.txt is missing or empty`,
      `${root}/review-notes/app-store.txt is missing or empty`,
    ]);
  });

  it("reports images each store won't take, in each language", () => {
    const root = fixtureStore();
    const shots = join(root, "screenshots");
    writeFileSync(
      join(shots, "app-store/ar/iphone/01-library.png"),
      png(1080, 1920),
    );
    writeFileSync(
      join(shots, "app-store/en/ipad/02-extra.png"),
      png(2752, 2064),
    ); // landscape is fine
    writeFileSync(join(shots, "google-play/en/icon.png"), png(1024, 1024));
    writeFileSync(
      join(shots, "google-play/ar/phone/03-tall.png"),
      png(1080, 2400),
    );
    writeFileSync(
      join(shots, "google-play/ar/phone/04-text.png"),
      "not an image",
    );
    rmSync(join(shots, "google-play/en/feature-graphic.png"));
    rmSync(join(shots, "appgallery/en/phone/03-reciter.png"));
    expect(problems(readStore(root), "0.1.3")).toEqual([
      `${shots}/app-store/ar/iphone/01-library.png is 1080x1920; app-store takes 1320x2868, 1290x2796, 1206x2622, 1284x2778, 1242x2688`,
      `${shots}/google-play/ar/phone/03-tall.png is 1080x2400; Google Play screenshots are 320 to 3840 pixels a side, at most 2:1`,
      `${shots}/google-play/ar/phone/04-text.png: isn't a PNG`,
      `${shots}/google-play/en/icon.png is 1024x1024; google-play takes 512x512`,
      `${shots}/google-play/en/feature-graphic.png needs 1 PNG file, found 0`,
      `${shots}/appgallery/en/phone needs 3 to 5 PNG files, found 2`,
    ]);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(length("مفيد")).toBe(4);
    expect(length("🕋📖")).toBe(2);
  });

  it("reads PNG sizes", () => {
    expect(pngSize(png(1206, 2622))).toEqual({ width: 1206, height: 2622 });
    expect(() =>
      pngSize(Buffer.from("GIF89a and more bytes than a header")),
    ).toThrow("isn't a PNG");
  });
});

describe("writeFastlaneMetadata", () => {
  it("lays out each language under its own locale for deliver and supply, unmixed", () => {
    const root = fixtureStore();
    const out = temp("fastlane-");
    const store = readStore(root);
    writeFastlaneMetadata(store, "0.1.3", 1003, out);
    const read = (path: string) => readFileSync(join(out, path), "utf8");

    for (const [language, apple, play] of [
      ["ar", "ar-SA", "ar"],
      ["en", "en-US", "en-US"],
    ] as const) {
      const listing = LISTINGS[language];
      const notes = RELEASE_NOTES[language];
      expect(read(`app-store/metadata/${apple}/name.txt`)).toBe(
        listing["app-store-name.txt"],
      );
      expect(read(`app-store/metadata/${apple}/subtitle.txt`)).toBe(
        listing["subtitle.txt"],
      );
      expect(read(`app-store/metadata/${apple}/promotional_text.txt`)).toBe(
        listing["short-description.txt"],
      );
      expect(read(`app-store/metadata/${apple}/description.txt`)).toBe(
        listing["description.txt"],
      );
      expect(read(`app-store/metadata/${apple}/keywords.txt`)).toBe(
        listing["keywords.txt"],
      );
      expect(read(`app-store/metadata/${apple}/release_notes.txt`)).toBe(notes);
      expect(read(`app-store/metadata/${apple}/privacy_url.txt`)).toBe(
        "https://shawared.com/privacy/",
      );
      expect(read(`google-play/metadata/${play}/title.txt`)).toBe(
        listing["name.txt"],
      );
      expect(read(`google-play/metadata/${play}/short_description.txt`)).toBe(
        listing["short-description.txt"],
      );
      expect(read(`google-play/metadata/${play}/full_description.txt`)).toBe(
        listing["description.txt"],
      );
      expect(read(`google-play/metadata/${play}/changelogs/1003.txt`)).toBe(
        notes,
      );
    }
    // The two languages' outputs differ wherever their sources do.
    expect(read("app-store/metadata/ar-SA/description.txt")).not.toBe(
      read("app-store/metadata/en-US/description.txt"),
    );
    expect(read("google-play/metadata/ar/changelogs/1003.txt")).not.toBe(
      read("google-play/metadata/en-US/changelogs/1003.txt"),
    );
    expect(read("app-store/metadata/review_information/notes.txt")).toBe(
      store.reviewNotes.appStore,
    );

    expect(files(join(out, "app-store/screenshots"))).toEqual([
      "ar-SA/ipad-01-library.png",
      "ar-SA/iphone-01-library.png",
      "ar-SA/iphone-02-poem.png",
      "en-US/ipad-01-library.png",
      "en-US/iphone-01-library.png",
      "en-US/iphone-02-poem.png",
    ]);
    for (const play of ["ar", "en-US"]) {
      expect(files(join(out, `google-play/metadata/${play}/images`))).toEqual([
        "featureGraphic.png",
        "icon.png",
        "phoneScreenshots/01-library.png",
        "phoneScreenshots/02-poem.png",
        "sevenInchScreenshots/01-library.png",
      ]);
    }
    // Each image is its own language's, byte for byte.
    for (const [language, apple, play] of [
      ["ar", "ar-SA", "ar"],
      ["en", "en-US", "en-US"],
    ]) {
      expect(
        readFileSync(
          join(out, `app-store/screenshots/${apple}/iphone-02-poem.png`),
        ),
      ).toEqual(
        readFileSync(
          join(root, `screenshots/app-store/${language}/iphone/02-poem.png`),
        ),
      );
      expect(
        readFileSync(
          join(out, `google-play/metadata/${play}/images/featureGraphic.png`),
        ),
      ).toEqual(
        readFileSync(
          join(root, `screenshots/google-play/${language}/feature-graphic.png`),
        ),
      );
    }
    expect(
      readFileSync(join(out, "app-store/screenshots/ar-SA/iphone-02-poem.png")),
    ).not.toEqual(
      readFileSync(join(out, "app-store/screenshots/en-US/iphone-02-poem.png")),
    );
  });
});
