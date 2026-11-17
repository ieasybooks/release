import {
  constants,
  createHash,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AppGallery,
  AppGalleryError,
  publishToAppGallery,
  REVIEWING,
  serviceAccountToken,
  type Io,
} from "../src/appgallery.ts";
import { readStore } from "../src/store.ts";
import { LISTINGS, RELEASE_NOTES, makeApp } from "./fixture.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const account = {
  key_id: "key-1",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  sub_account: "1234567890",
  token_uri: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
};

// The fixture app's store folder, in Arabic and English (AppGallery's ar and
// en-US).
const dir = mkdtempSync(join(tmpdir(), "appgallery-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const root = join(makeApp(join(dir, "app")), "store");
const store = readStore(root);
const LANGS = { ar: "ar", en: "en-US" } as const;
const shots = ["01-library.png", "02-poem.png", "03-reciter.png"];
const image = (language: string, file: string) =>
  readFileSync(join(root, "screenshots/appgallery", language, file));

type Call = { method: string; url: string; body?: unknown };

// Stands in for AppGallery Connect and Huawei's object storage. Answers are
// picked by method and path; an answer list is used in order, its last
// entry repeating.
function standIn(answers: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const io: Io = {
    log: () => {},
    sleep: async () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const { pathname, host } = new URL(url);
      const key =
        host === "connect-api.cloud.huawei.com"
          ? `${method} ${pathname.replace("/api", "")}`
          : `${method} ${host}${pathname}`;
      const list = answers[key];
      if (!list) throw new Error(`unexpected ${key}`);
      const answer = list.length > 1 ? list.shift() : list[0];
      if (answer instanceof Buffer) return new Response(new Uint8Array(answer));
      if (answer instanceof Response) return answer;
      return Response.json(answer);
    }) as typeof fetch,
  };
  return { calls, io };
}

const ok = { ret: { code: 0, msg: "success" } };
type Live = { newFeatures?: string; screenShots?: string[]; appIcon?: string };
// AppGallery's current listing: each language's texts and images, as given.
const live = (
  releaseState = 0,
  overrides: Partial<Record<keyof typeof LANGS, Live>> = {},
) => ({
  ...ok,
  appInfo: { releaseState, versionNumber: "0.1.2" },
  languages: (Object.entries(LANGS) as [keyof typeof LANGS, string][]).map(
    ([language, lang]) => ({
      lang,
      appName: LISTINGS[language]["name.txt"],
      appDesc: LISTINGS[language]["description.txt"],
      briefInfo: LISTINGS[language]["short-description.txt"],
      newFeatures: overrides[language]?.newFeatures ?? RELEASE_NOTES[language],
      deviceMaterials: [
        {
          deviceType: 4,
          appIcon:
            overrides[language]?.appIcon ??
            `https://obs.example/${language}/icon.png`,
          screenShots:
            overrides[language]?.screenShots ??
            shots.map((file) => `https://obs.example/${language}/${file}`),
        },
      ],
    }),
  ),
});
const liveImages = Object.fromEntries(
  Object.keys(LANGS).flatMap((language) => [
    [`GET obs.example/${language}/icon.png`, [image(language, "icon.png")]],
    ...shots.map((file) => [
      `GET obs.example/${language}/${file}`,
      [image(language, `phone/${file}`)],
    ]),
  ]),
);
const uploadUrl = {
  ...ok,
  urlInfo: {
    url: "https://bucket.example/object",
    headers: { "x-amz-date": "now" },
    objectId: "object-1",
  },
};
const apk = {
  fileName: "shawared-0.1.3-1003.apk",
  bytes: Buffer.from("apk bytes"),
};
const route = (call: Call) =>
  `${call.method} ${new URL(call.url).host}${new URL(call.url).pathname}`;

describe("serviceAccountToken", () => {
  it("signs a PS256 JWT that AppGallery takes as the access token", () => {
    const token = serviceAccountToken(account, Date.UTC(2026, 10, 16) + 500);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "PS256",
      kid: "key-1",
      typ: "JWT",
    });
    const now = Date.UTC(2026, 10, 16) / 1000;
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "1234567890",
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    });
    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(signature, "base64url"),
    );
    expect(valid).toBe(true);
  });
});

describe("publishToAppGallery", () => {
  it("uploads the APK, updates what changed and submits", async () => {
    const { calls, io } = standIn({
      "GET /publish/v2/app-info": [
        live(0, {
          ar: {
            newFeatures: "older notes",
            appIcon: "https://obs.example/old-icon.png",
          },
        }),
      ],
      "GET obs.example/old-icon.png": [Buffer.from("an older icon")],
      ...liveImages,
      "GET /publish/v2/upload-url/for-obs": [uploadUrl],
      "PUT bucket.example/object": [new Response("")],
      "PUT /publish/v2/app-file-info": [{ ...ok, pkgVersion: ["pkg-1"] }, ok],
      "GET /publish/v2/package/compile/status": [
        { ...ok, pkgStateList: [{ successStatus: 1 }] },
        { ...ok, pkgStateList: [{ successStatus: 0 }] },
      ],
      "PUT /publish/v2/app-language-info": [ok],
      "POST /publish/v2/app-submit": [
        { ret: { code: 204144660, msg: "It may take 2-5 minutes" } },
        ok,
      ],
    });
    await publishToAppGallery({
      gallery: new AppGallery(account, "1234567", io),
      store,
      version: "0.1.3",
      apk,
      dryRun: false,
      io,
    });

    expect(calls.map(route)).toEqual([
      "GET connect-api.cloud.huawei.com/api/publish/v2/app-info",
      "GET connect-api.cloud.huawei.com/api/publish/v2/upload-url/for-obs",
      "PUT bucket.example/object",
      "PUT connect-api.cloud.huawei.com/api/publish/v2/app-file-info",
      "GET connect-api.cloud.huawei.com/api/publish/v2/package/compile/status",
      "GET connect-api.cloud.huawei.com/api/publish/v2/package/compile/status",
      // Arabic: new release notes and a new icon.
      "PUT connect-api.cloud.huawei.com/api/publish/v2/app-language-info",
      "GET obs.example/old-icon.png",
      "GET connect-api.cloud.huawei.com/api/publish/v2/upload-url/for-obs",
      "PUT bucket.example/object",
      "PUT connect-api.cloud.huawei.com/api/publish/v2/app-file-info",
      ...shots.map((file) => `GET obs.example/ar/${file}`),
      // English: nothing changed.
      "GET obs.example/en/icon.png",
      ...shots.map((file) => `GET obs.example/en/${file}`),
      "POST connect-api.cloud.huawei.com/api/publish/v2/app-submit",
      "POST connect-api.cloud.huawei.com/api/publish/v2/app-submit",
    ]);

    expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({
      appId: "1234567",
      fileName: "shawared-0.1.3-1003.apk",
      contentLength: "9",
      sha256: createHash("sha256").update("apk bytes").digest("hex"),
      chineseMainlandFlag: "0",
    });
    expect(calls[3].body).toEqual({
      fileType: 5,
      files: [{ fileName: "shawared-0.1.3-1003.apk", fileDestUrl: "object-1" }],
    });
    expect(calls[6].body).toEqual({
      lang: "ar",
      appName: LISTINGS.ar["name.txt"],
      appDesc: LISTINGS.ar["description.txt"],
      briefInfo: LISTINGS.ar["short-description.txt"],
      newFeatures: RELEASE_NOTES.ar,
    });
    expect(calls[10].body).toEqual({
      fileType: 0,
      lang: "ar",
      files: [{ fileName: "icon.png", fileDestUrl: "object-1" }],
    });
    const submit = new URL(calls.at(-1)!.url);
    expect(submit.searchParams.get("remark")).toBe(
      store.reviewNotes.appGallery,
    );
    expect(submit.searchParams.has("releaseTime")).toBe(false);
    for (const call of calls.filter(
      (c) => new URL(c.url).host === "connect-api.cloud.huawei.com",
    )) {
      expect(new URL(call.url).searchParams.get("appId")).toBe("1234567");
    }
  });

  it("sends English changes in English to en-US, leaving Arabic alone", async () => {
    const changed = shots.map((file, i) =>
      i === 1
        ? "https://obs.example/changed.png"
        : `https://obs.example/en/${file}`,
    );
    const { calls, io } = standIn({
      "GET /publish/v2/app-info": [
        live(0, { en: { newFeatures: "Older notes.", screenShots: changed } }),
      ],
      ...liveImages,
      "GET obs.example/changed.png": [Buffer.from("different")],
      "GET /publish/v2/upload-url/for-obs": [uploadUrl],
      "PUT bucket.example/object": [new Response("")],
      "PUT /publish/v2/app-file-info": [{ ...ok, pkgVersion: ["pkg-1"] }, ok],
      "GET /publish/v2/package/compile/status": [
        { ...ok, pkgStateList: [{ successStatus: 0 }] },
      ],
      "PUT /publish/v2/app-language-info": [ok],
      "POST /publish/v2/app-submit": [ok],
    });
    await publishToAppGallery({
      gallery: new AppGallery(account, "1234567", io),
      store,
      version: "0.1.3",
      apk,
      dryRun: false,
      io,
    });

    const texts = calls.filter((c) => c.url.includes("app-language-info"));
    expect(texts.map((c) => c.body)).toEqual([
      {
        lang: "en-US",
        appName: LISTINGS.en["name.txt"],
        appDesc: LISTINGS.en["description.txt"],
        briefInfo: LISTINGS.en["short-description.txt"],
        newFeatures: RELEASE_NOTES.en,
      },
    ]);
    const binds = calls.filter(
      (c) => c.method === "PUT" && c.url.includes("app-file-info"),
    );
    expect(binds.map((c) => c.body)).toEqual([
      {
        fileType: 5,
        files: [
          { fileName: "shawared-0.1.3-1003.apk", fileDestUrl: "object-1" },
        ],
      },
      {
        fileType: 2,
        lang: "en-US",
        imgShowType: 0,
        files: shots.map((fileName) => ({ fileName, fileDestUrl: "object-1" })),
      },
    ]);
  });

  it("stops before changing anything while a version is in review", async () => {
    const { calls, io } = standIn({
      "GET /publish/v2/app-info": [live(REVIEWING)],
    });
    await expect(
      publishToAppGallery({
        gallery: new AppGallery(account, "1234567", io),
        store,
        version: "0.1.3",
        apk,
        dryRun: false,
        io,
      }),
    ).rejects.toThrow(
      "AppGallery is reviewing 0.1.2, which can't change until its review is cancelled. Cancel it in AppGallery Connect",
    );
    expect(calls).toHaveLength(1);
  });

  it("changes nothing in a dry run, and says what it would change in each language", async () => {
    const lines: string[] = [];
    const { calls, io } = standIn({
      "GET /publish/v2/app-info": [
        live(REVIEWING, {
          ar: { newFeatures: "older notes" },
          en: { newFeatures: "Older notes." },
        }),
      ],
      ...liveImages,
      "GET /publish/v2/upload-url/for-obs": [uploadUrl],
    });
    io.log = (line) => lines.push(line);
    await publishToAppGallery({
      gallery: new AppGallery(account, "1234567", io),
      store,
      version: "0.1.3",
      apk,
      dryRun: true,
      io,
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(lines).toEqual([
      "AppGallery has 0.1.2 in release state 4.",
      "A release would stop here: AppGallery is reviewing 0.1.2, which can't change until its review is cancelled. Cancel it in AppGallery Connect (the version's page, Cancel review), then run this again.",
      "Would upload shawared-0.1.3-1003.apk; AppGallery issued an upload URL for it.",
      "Would update the ar newFeatures.",
      "Would update the en-US newFeatures.",
      "Would submit 0.1.3 for review, to be released once approved.",
    ]);
  });
});

describe("AppGallery", () => {
  it("reports an answer whose ret.code isn't 0", async () => {
    const { io } = standIn({
      "GET /publish/v2/app-info": [
        { ret: { code: 204144647, msg: "app not found" } },
      ],
    });
    const error = await new AppGallery(account, "1", io)
      .appInfo()
      .catch((e) => e);
    expect(error).toBeInstanceOf(AppGalleryError);
    expect(error.message).toBe(
      "GET /publish/v2/app-info: HTTP 200, 204144647: app not found",
    );
    expect(error.code).toBe(204144647);
  });

  it("reports HTTP failures and bodies that aren't JSON", async () => {
    const { io } = standIn({
      "GET /publish/v2/app-info": [
        new Response("<html>bad gateway</html>", { status: 502 }),
        Response.json({ ret: { code: 0 } }, { status: 403 }),
      ],
    });
    const gallery = new AppGallery(account, "1", io);
    await expect(gallery.appInfo()).rejects.toThrow(
      "GET /publish/v2/app-info: HTTP 502, not JSON",
    );
    await expect(gallery.appInfo()).rejects.toThrow(
      "GET /publish/v2/app-info: HTTP 403, 0: no message",
    );
  });

  it("fails when Huawei can't process the package, or takes too long", async () => {
    const failed = standIn({
      "GET /publish/v2/package/compile/status": [
        { ...ok, pkgStateList: [{ successStatus: 2 }] },
      ],
    });
    await expect(
      new AppGallery(account, "1", failed.io).waitForPackage("pkg-1"),
    ).rejects.toThrow("couldn't process the uploaded package pkg-1");
    const slow = standIn({
      "GET /publish/v2/package/compile/status": [
        { ...ok, pkgStateList: [{ successStatus: 1 }] },
      ],
    });
    await expect(
      new AppGallery(account, "1", slow.io).waitForPackage("pkg-1", 30_000),
    ).rejects.toThrow("still processing package pkg-1 after 0.5 minutes");
    expect(slow.calls).toHaveLength(3);
  });

  it("retries a submission only while the package is processing", async () => {
    const other = standIn({
      "POST /publish/v2/app-submit": [
        { ret: { code: 204144700, msg: "remark too long" } },
      ],
    });
    await expect(
      new AppGallery(account, "1", other.io).submit("notes"),
    ).rejects.toThrow("204144700: remark too long");
    expect(other.calls).toHaveLength(1);
    const stuck = standIn({
      "POST /publish/v2/app-submit": [
        { ret: { code: 204144660, msg: "It may take 2-5 minutes" } },
      ],
    });
    await expect(
      new AppGallery(account, "1", stuck.io).submit("notes", 60_000),
    ).rejects.toThrow("204144660");
    expect(stuck.calls).toHaveLength(3);
  });

  it("fails when the upload to object storage fails", async () => {
    const { io } = standIn({
      "GET /publish/v2/upload-url/for-obs": [uploadUrl],
      "PUT bucket.example/object": [new Response("denied", { status: 403 })],
    });
    await expect(
      new AppGallery(account, "1", io).upload("a.apk", Buffer.from("x")),
    ).rejects.toThrow("uploading a.apk: HTTP 403");
  });
});
