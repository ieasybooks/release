import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appStoreToken,
  auditAppGallery,
  auditAppStore,
  auditGooglePlay,
} from "../src/audit.ts";

type Call = { method: string; url: string; headers: Record<string, string> };

// Stands in for a store's API: answers by "METHOD path" (path without the
// query), and records every call.
function standIn(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const key = `${method} ${url.pathname}`;
    if (!(key in answers))
      return new Response(`no answer for ${key}`, { status: 404 });
    const answer = answers[key];
    return answer === null
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("the App Store", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const key = {
    key_id: "ABC123",
    issuer_id: "issuer-1",
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const APPS = "GET /v1/apps";
  const INFOS = "GET /v1/apps/6831969465/appInfos";
  const app = { data: [{ id: "6831969465" }] };
  const info = (state: string, appStoreAgeRating: string) => ({
    attributes: { state, appStoreAgeRating },
  });

  it("signs an App Store Connect token with the key", () => {
    const [header, payload, signature] = appStoreToken(
      key,
      1_700_000_000_000,
    ).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iss: "issuer-1",
      iat: 1_700_000_000,
      exp: 1_700_000_600,
      aud: "appstoreconnect-v1",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("checks the rating of the version being prepared over the live one", async () => {
    const api = standIn({
      [APPS]: app,
      [INFOS]: {
        data: [
          info("READY_FOR_DISTRIBUTION", "TWELVE_PLUS"),
          info("PREPARE_FOR_SUBMISSION", "FOUR_PLUS"),
        ],
      },
    });
    const expected = { bundleId: "com.mofied.app", ageRating: "FOUR_PLUS" };
    expect(await auditAppStore(expected, key, api)).toEqual([]);
    expect(api.calls[0]!.url).toContain("filter[bundleId]=com.mofied.app");
    expect(api.calls[0]!.headers.authorization).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
  });

  it("reports a live rating that differs when no version is open", async () => {
    const api = standIn({
      [APPS]: app,
      [INFOS]: { data: [info("READY_FOR_DISTRIBUTION", "TWELVE_PLUS")] },
    });
    expect(
      await auditAppStore(
        { bundleId: "com.mofied.app", ageRating: "FOUR_PLUS" },
        key,
        api,
      ),
    ).toEqual([
      'App Store age rating: store.json expects "FOUR_PLUS", the store has "TWELVE_PLUS"',
    ]);
  });

  it("reports an app the account doesn't have", async () => {
    const api = standIn({ [APPS]: { data: [] } });
    expect(
      await auditAppStore({ bundleId: "com.example.none" }, key, api),
    ).toEqual(["the App Store has no app com.example.none"]);
  });
});

describe("Google Play", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    client_email: "release@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const EDITS = "/androidpublisher/v3/applications/com.mofied.app/edits";
  const answers = (details: object) => ({
    "POST /token": { access_token: "token-1" },
    [`POST ${EDITS}`]: { id: "edit-1" },
    [`GET ${EDITS}/edit-1/details`]: details,
    [`DELETE ${EDITS}/edit-1`]: null,
  });
  const expected = {
    packageName: "com.mofied.app",
    contact: {
      email: "easybooksdev@gmail.com",
      website: "https://mofied.com",
      phone: "",
    },
  };

  it("finds no drift when the contact details match, and deletes its edit", async () => {
    const api = standIn(
      answers({
        contactEmail: "easybooksdev@gmail.com",
        contactWebsite: "https://mofied.com",
      }),
    );
    expect(await auditGooglePlay(expected, account, api)).toEqual([]);
    expect(
      api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ).toEqual([
      "POST /token",
      `POST ${EDITS}`,
      `GET ${EDITS}/edit-1/details`,
      `DELETE ${EDITS}/edit-1`,
    ]);
    expect(api.calls[2]!.headers.authorization).toBe("Bearer token-1");
  });

  it("reports each contact detail that differs, still deleting its edit", async () => {
    const api = standIn(
      answers({
        contactEmail: "easybooksdev@gmail.com",
        contactWebsite: "http://mofied.com",
        contactPhone: "+962791504431",
      }),
    );
    expect(await auditGooglePlay(expected, account, api)).toEqual([
      'Google Play contact website: store.json expects "https://mofied.com", the store has "http://mofied.com"',
      'Google Play contact phone: store.json expects "", the store has "+962791504431"',
    ]);
    expect(api.calls.at(-1)!.method).toBe("DELETE");
  });
});

describe("AppGallery", () => {
  const gallery = (appInfo: object) => ({
    appInfo: async () => ({ appInfo }) as never,
  });
  const expected = {
    ageRating: "3+",
    privacyUrl: "https://mofied.com/privacy/",
    dataRightsUrl: "https://mofied.com/support",
  };

  it("finds no drift when the rating and links match", async () => {
    expect(
      await auditAppGallery(
        expected,
        gallery({
          contentRate: '{"HW":"3+","ClassInd":"L"}',
          privacyPolicy: "https://mofied.com/privacy/",
          privacyRightsUrl: "https://mofied.com/support",
        }),
      ),
    ).toEqual([]);
  });

  it("reports the rating and each link that differ", async () => {
    expect(
      await auditAppGallery(
        expected,
        gallery({
          contentRate: '{"HW":"16+"}',
          privacyPolicy: "https://mofied.com/privacy/",
        }),
      ),
    ).toEqual([
      'AppGallery age rating: store.json expects "3+", the store has "16+"',
      'AppGallery data subject right URL: store.json expects "https://mofied.com/support", the store has ""',
    ]);
  });
});
