// The drift check a release runs before sending anything: the store settings
// a release doesn't set, read from each store and compared with store.json's
// `audit`. A release writes the listing texts, images, links and copyright
// itself, so those can't drift; the age ratings, Google Play's contact details
// and AppGallery's privacy links are set by hand in each console, and this is
// where a difference shows up. Each store job audits its own store, with the
// credentials it already has for the release.

import { createPrivateKey, sign } from "node:crypto";
import type { AppGallery, Io } from "./appgallery.ts";
import type { Config } from "./store.ts";

export type AuditConfig = {
  appStore?: {
    // The app's bundle ID, to find it in App Store Connect.
    bundleId: string;
    // The App Store age rating, as App Store Connect names it: FOUR_PLUS.
    ageRating?: string;
  };
  googlePlay?: {
    packageName: string;
    // The store listing's contact details; an empty phone means none shown.
    contact?: { email?: string; website?: string; phone?: string };
  };
  appGallery?: {
    // AppGallery's own rating, such as "3+".
    ageRating?: string;
    privacyUrl?: string;
    dataRightsUrl?: string;
  };
};

export type AuditedStore = keyof AuditConfig;
export const AUDITED_STORES: readonly AuditedStore[] = [
  "appStore",
  "googlePlay",
  "appGallery",
];

export function auditConfig(config: Config): AuditConfig {
  return config.audit ?? {};
}

// One line per setting that differs: what it is, what store.json expects,
// and what the store has.
function differs(label: string, expected: string, found: string | undefined) {
  return `${label}: store.json expects ${JSON.stringify(expected)}, the store has ${JSON.stringify(found ?? "")}`;
}

const b64 = (value: object | Buffer) =>
  (Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value))
  ).toString("base64url");

// fastlane's App Store Connect API key file.
export type AppStoreKey = { key_id: string; issuer_id: string; key: string };

export function appStoreToken(key: AppStoreKey, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: "ES256", kid: key.key_id, typ: "JWT" })}.${b64(
    {
      iss: key.issuer_id,
      iat: issuedAt,
      exp: issuedAt + 600,
      aud: "appstoreconnect-v1",
    },
  )}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(key.key),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

// App Store Connect's appInfo states of the live app, and of the ones a newer
// version replaced. Any other appInfo belongs to the next version, whether it's
// being prepared, waiting for review, in review or waiting to be released.
const LIVE = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE"]);
const SETTLED = new Set([...LIVE, "REPLACED_WITH_NEW_INFO"]);

export async function auditAppStore(
  expected: NonNullable<AuditConfig["appStore"]>,
  key: AppStoreKey,
  io: Pick<Io, "fetch">,
): Promise<string[]> {
  const get = async (path: string) => {
    const response = await io.fetch(
      `https://api.appstoreconnect.apple.com${path}`,
      { headers: { authorization: `Bearer ${appStoreToken(key)}` } },
    );
    if (!response.ok)
      throw new Error(
        `App Store Connect ${path.split("?")[0]}: HTTP ${response.status}`,
      );
    return (await response.json()) as { data: any };
  };
  const apps = await get(
    `/v1/apps?filter[bundleId]=${encodeURIComponent(expected.bundleId)}`,
  );
  const app = apps.data?.[0];
  if (!app) return [`the App Store has no app ${expected.bundleId}`];
  const found: string[] = [];
  if (expected.ageRating) {
    const infos = (await get(`/v1/apps/${app.id}/appInfos`)).data as {
      attributes: {
        appStoreState?: string;
        state?: string;
        appStoreAgeRating?: string;
      };
    }[];
    // The rating the next version carries, or the live one when there's no
    // next version.
    const stateOf = (i: (typeof infos)[number]) =>
      i.attributes.state ?? i.attributes.appStoreState ?? "";
    const info =
      infos.find((i) => !SETTLED.has(stateOf(i))) ??
      infos.find((i) => LIVE.has(stateOf(i))) ??
      infos[0];
    if (info?.attributes.appStoreAgeRating !== expected.ageRating)
      found.push(
        differs(
          "App Store age rating",
          expected.ageRating,
          info?.attributes.appStoreAgeRating,
        ),
      );
  }
  return found;
}

// A Google service account key file.
export type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
};

export async function auditGooglePlay(
  expected: NonNullable<AuditConfig["googlePlay"]>,
  account: GoogleServiceAccount,
  io: Pick<Io, "fetch">,
): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  })}`;
  const assertion = `${unsigned}.${sign("sha256", Buffer.from(unsigned), createPrivateKey(account.private_key)).toString("base64url")}`;
  const tokenResponse = await io.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!tokenResponse.ok)
    throw new Error(`Google sign-in: HTTP ${tokenResponse.status}`);
  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${expected.packageName}/edits`;
  const call = async (method: string, url: string) => {
    const response = await io.fetch(url, {
      method,
      headers: { authorization: `Bearer ${access_token}` },
    });
    if (!response.ok)
      throw new Error(
        `Google Play ${method} ${url.slice(base.length) || "/edits"}: HTTP ${response.status}`,
      );
    return response.status === 204 ? {} : ((await response.json()) as any);
  };
  // Reading needs an edit; it's deleted again, so nothing changes.
  const edit = await call("POST", base);
  try {
    const details = (await call("GET", `${base}/${edit.id}/details`)) as {
      contactEmail?: string;
      contactWebsite?: string;
      contactPhone?: string;
    };
    const found: string[] = [];
    const contact = expected.contact ?? {};
    const pairs = [
      ["email", contact.email, details.contactEmail],
      ["website", contact.website, details.contactWebsite],
      ["phone", contact.phone, details.contactPhone],
    ] as const;
    for (const [field, want, have] of pairs) {
      if (want !== undefined && want !== (have ?? ""))
        found.push(differs(`Google Play contact ${field}`, want, have));
    }
    return found;
  } finally {
    await call("DELETE", `${base}/${edit.id}`);
  }
}

export async function auditAppGallery(
  expected: NonNullable<AuditConfig["appGallery"]>,
  gallery: Pick<AppGallery, "appInfo">,
): Promise<string[]> {
  const info = (await gallery.appInfo()) as {
    appInfo: {
      contentRate?: string;
      privacyPolicy?: string;
      privacyRightsUrl?: string;
    };
  };
  const a = info.appInfo;
  const found: string[] = [];
  if (expected.ageRating) {
    let rating: string | undefined;
    try {
      rating = (JSON.parse(a.contentRate ?? "{}") as { HW?: string }).HW;
    } catch {
      rating = a.contentRate;
    }
    if (rating !== expected.ageRating)
      found.push(differs("AppGallery age rating", expected.ageRating, rating));
  }
  if (expected.privacyUrl && a.privacyPolicy !== expected.privacyUrl)
    found.push(
      differs(
        "AppGallery privacy policy URL",
        expected.privacyUrl,
        a.privacyPolicy,
      ),
    );
  if (expected.dataRightsUrl && a.privacyRightsUrl !== expected.dataRightsUrl)
    found.push(
      differs(
        "AppGallery data subject right URL",
        expected.dataRightsUrl,
        a.privacyRightsUrl,
      ),
    );
  return found;
}
