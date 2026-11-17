// Publishes the Android APK to Huawei AppGallery through the AppGallery
// Connect Publishing API, signed in with a service account's key (the
// vault's APPGALLERY_CONNECT_SERVICE_ACCOUNT). fastlane has no support for
// service accounts, hence this script.
//
// A release uploads the APK, updates the listing texts and, when they
// changed, the icon and screenshots, then submits the version for review with
// the reviewer notes. AppGallery releases it once approved.
//
// A version still in review can't be changed, and the Publishing API has no
// call to cancel a review, so a release stops before changing anything while
// one is in review: cancel it in AppGallery Connect, then re-run.

import { constants, createHash, createPrivateKey, sign } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { pngs, releaseNotes, type Store } from "./store.ts";

const API = "https://connect-api.cloud.huawei.com/api";
// app-info's releaseState while a version waits for review.
export const REVIEWING = 4;
// app-submit's answer while an uploaded package is still being processed.
const PACKAGE_PROCESSING = 204144660;
const FILE_TYPE = { icon: 0, screenshots: 2, package: 5 } as const;

export type ServiceAccount = {
  key_id: string;
  private_key: string;
  sub_account: string;
  token_uri: string;
};

export type Io = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export class AppGalleryError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

// A service account signs a JWT that AppGallery Connect takes as the access
// token itself.
export function serviceAccountToken(
  account: ServiceAccount,
  now = Date.now(),
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "PS256", kid: account.key_id, typ: "JWT" })}.${encode(
    {
      iss: account.sub_account,
      aud: account.token_uri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
  )}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(account.private_key),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

type Language = {
  lang: string;
  appName?: string;
  appDesc?: string;
  briefInfo?: string;
  newFeatures?: string;
  deviceMaterials?: {
    deviceType: number;
    appIcon?: string;
    screenShots?: string[];
  }[];
};
type AppInfo = {
  appInfo: { releaseState: number; versionNumber?: string };
  languages?: Language[];
};
type UploadUrl = {
  url: string;
  headers: Record<string, string>;
  objectId: string;
};

export class AppGallery {
  constructor(
    private readonly account: ServiceAccount,
    readonly appId: string,
    private readonly io: Io,
  ) {}

  // Every answer carries ret.code, 0 when the call worked.
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.io.fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${serviceAccountToken(this.account)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let json: { ret?: { code?: number; msg?: string } } & Record<
      string,
      unknown
    >;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AppGalleryError(
        `${method} ${path.split("?")[0]}: HTTP ${response.status}, not JSON`,
      );
    }
    const code = json.ret?.code;
    if (!response.ok || code !== 0) {
      throw new AppGalleryError(
        `${method} ${path.split("?")[0]}: HTTP ${response.status}, ${code}: ${json.ret?.msg ?? "no message"}`,
        code,
      );
    }
    return json as T;
  }

  appInfo(): Promise<AppInfo> {
    return this.call("GET", `/publish/v2/app-info?appId=${this.appId}`);
  }

  // Where to PUT a file in Huawei's object storage; the URL lasts minutes.
  async uploadUrl(fileName: string, bytes: Buffer): Promise<UploadUrl> {
    const query = new URLSearchParams({
      appId: this.appId,
      fileName,
      contentLength: String(bytes.length),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      chineseMainlandFlag: "0",
    });
    const { urlInfo } = await this.call<{ urlInfo: UploadUrl }>(
      "GET",
      `/publish/v2/upload-url/for-obs?${query}`,
    );
    return urlInfo;
  }

  // Uploads a file and returns its object id, which app-file-info then binds
  // to the version.
  async upload(fileName: string, bytes: Buffer): Promise<string> {
    const urlInfo = await this.uploadUrl(fileName, bytes);
    const response = await this.io.fetch(urlInfo.url, {
      method: "PUT",
      headers: urlInfo.headers,
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok)
      throw new AppGalleryError(
        `uploading ${fileName}: HTTP ${response.status}`,
      );
    return urlInfo.objectId;
  }

  async bindPackage(fileName: string, objectId: string): Promise<string> {
    const { pkgVersion } = await this.call<{ pkgVersion: string[] }>(
      "PUT",
      `/publish/v2/app-file-info?appId=${this.appId}`,
      {
        fileType: FILE_TYPE.package,
        files: [{ fileName, fileDestUrl: objectId }],
      },
    );
    return pkgVersion[0];
  }

  // Huawei checks an uploaded package before a version can use it.
  async waitForPackage(
    packageId: string,
    timeoutMs = 15 * 60_000,
  ): Promise<void> {
    for (let waited = 0; ; waited += 15_000) {
      const { pkgStateList } = await this.call<{
        pkgStateList: { successStatus?: number }[];
      }>(
        "GET",
        `/publish/v2/package/compile/status?appId=${this.appId}&pkgIds=${packageId}`,
      );
      const status = pkgStateList[0]?.successStatus;
      if (status === 0) return;
      if (status === 2)
        throw new AppGalleryError(
          `AppGallery couldn't process the uploaded package ${packageId}`,
        );
      if (waited >= timeoutMs)
        throw new AppGalleryError(
          `AppGallery is still processing package ${packageId} after ${timeoutMs / 60_000} minutes`,
        );
      this.io.log("AppGallery is processing the package...");
      await this.io.sleep(15_000);
    }
  }

  async bindImages(
    fileType: number,
    lang: string,
    files: { fileName: string; objectId: string }[],
  ): Promise<void> {
    await this.call("PUT", `/publish/v2/app-file-info?appId=${this.appId}`, {
      fileType,
      lang,
      ...(fileType === FILE_TYPE.screenshots ? { imgShowType: 0 } : {}),
      files: files.map(({ fileName, objectId }) => ({
        fileName,
        fileDestUrl: objectId,
      })),
    });
  }

  async setLanguage(
    language: Required<Omit<Language, "deviceMaterials">>,
  ): Promise<void> {
    await this.call(
      "PUT",
      `/publish/v2/app-language-info?appId=${this.appId}`,
      language,
    );
  }

  // Without a release time, the version is released once approved.
  async submit(remark: string, timeoutMs = 10 * 60_000): Promise<void> {
    const path = `/publish/v2/app-submit?appId=${this.appId}&remark=${encodeURIComponent(remark)}`;
    for (let waited = 0; ; waited += 30_000) {
      try {
        await this.call("POST", path);
        return;
      } catch (error) {
        if (
          !(error instanceof AppGalleryError) ||
          error.code !== PACKAGE_PROCESSING ||
          waited >= timeoutMs
        )
          throw error;
        this.io.log(
          "AppGallery is still processing the package; submitting again in 30s.",
        );
        await this.io.sleep(30_000);
      }
    }
  }
}

export type PublishOptions = {
  gallery: AppGallery;
  store: Store;
  version: string;
  apk: { fileName: string; bytes: Buffer };
  dryRun: boolean;
  io: Io;
};

export async function publishToAppGallery({
  gallery,
  store,
  version,
  apk,
  dryRun,
  io,
}: PublishOptions): Promise<void> {
  const act = async (what: string, run: () => Promise<void>) => {
    io.log(
      dryRun ? `Would ${what}.` : `${what[0].toUpperCase()}${what.slice(1)}.`,
    );
    if (!dryRun) await run();
  };

  const current = await gallery.appInfo();
  io.log(
    `AppGallery has ${current.appInfo.versionNumber ?? "no version"} in release state ${current.appInfo.releaseState}.`,
  );
  if (current.appInfo.releaseState === REVIEWING) {
    const reviewing =
      `AppGallery is reviewing ${current.appInfo.versionNumber}, which can't change until its review is cancelled. ` +
      `Cancel it in AppGallery Connect (the version's page, Cancel review), then run this again.`;
    if (!dryRun) throw new AppGalleryError(reviewing);
    io.log(`A release would stop here: ${reviewing}`);
  }

  if (dryRun) {
    // Asking for an upload URL changes nothing, and checks that AppGallery
    // would take the APK.
    await gallery.uploadUrl(apk.fileName, apk.bytes);
    io.log(
      `Would upload ${apk.fileName}; AppGallery issued an upload URL for it.`,
    );
  } else {
    io.log(`Uploading ${apk.fileName}.`);
    const packageId = await gallery.bindPackage(
      apk.fileName,
      await gallery.upload(apk.fileName, apk.bytes),
    );
    await gallery.waitForPackage(packageId);
  }

  for (const [language, locales] of Object.entries(store.config.languages)) {
    const lang = locales.appGallery;
    const listing = store.listings[language];
    const wanted = {
      lang,
      appName: listing.name,
      appDesc: listing.description,
      briefInfo: listing.shortDescription,
      newFeatures: releaseNotes(store, version, language),
    };
    const live = current.languages?.find((l) => l.lang === lang);
    const changed = (
      ["appName", "appDesc", "briefInfo", "newFeatures"] as const
    ).filter((field) => live?.[field] !== wanted[field]);
    if (changed.length > 0)
      await act(`update the ${lang} ${changed.join(", ")}`, () =>
        gallery.setLanguage(wanted),
      );

    const materials = live?.deviceMaterials?.[0];
    const dir = join(store.root, "screenshots", "appgallery", language);
    const images = [
      {
        kind: "icon",
        fileType: FILE_TYPE.icon,
        paths: [join(dir, "icon.png")],
        live: materials?.appIcon ? [materials.appIcon] : [],
      },
      {
        kind: "screenshots",
        fileType: FILE_TYPE.screenshots,
        paths: pngs(join(dir, "phone")).map((file) => join(dir, "phone", file)),
        live: materials?.screenShots ?? [],
      },
    ];
    for (const image of images) {
      const files = image.paths.map((path) => ({
        fileName: path.split("/").pop()!,
        bytes: readFileSync(path),
      }));
      if (await sameFiles(files, image.live, io)) continue;
      await act(`upload the ${lang} ${image.kind}`, async () => {
        const uploaded = [];
        for (const file of files)
          uploaded.push({
            fileName: file.fileName,
            objectId: await gallery.upload(file.fileName, file.bytes),
          });
        await gallery.bindImages(image.fileType, lang, uploaded);
      });
    }
  }

  await act(`submit ${version} for review, to be released once approved`, () =>
    gallery.submit(store.reviewNotes.appGallery),
  );
}

// Whether the live images are the local ones, byte for byte and in order.
async function sameFiles(
  files: { bytes: Buffer }[],
  urls: string[],
  io: Io,
): Promise<boolean> {
  if (files.length !== urls.length) return false;
  for (const [i, url] of urls.entries()) {
    const response = await io.fetch(url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return false;
    if (!Buffer.from(await response.arrayBuffer()).equals(files[i].bytes))
      return false;
  }
  return true;
}
