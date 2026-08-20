import { SignJWT, generateKeyPair } from "jose";
import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APS_TOKEN_AUDIENCE, APS_TOKEN_ISSUER, getAccessTokens } from "../auth.js";
import { DEFAULT_MANIFEST_URN } from "../helpers.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

describe("APS Model Derivative routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("lists current representative translation formats for a 2-legged token", async () => {
    const token = await issueTwoLeggedToken(app);
    const response = await app.request(`${base}/modelderivative/v2/designdata/formats`, {
      headers: bearer(token),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.formats.dwg).toEqual(["f2d", "f3d", "rvt", "slddrw"]);
    expect(body.formats.svf2).toContain("rvt");
    expect(body.formats.thumbnail).toContain("f2d");
  });

  it("returns the fully translated default manifest to 2-legged and 3-legged tokens", async () => {
    const twoLegged = await issueTwoLeggedToken(app);
    const threeLegged = await issueThreeLeggedToken(app, store);
    const path = `${base}/modelderivative/v2/designdata/${DEFAULT_MANIFEST_URN}/manifest`;

    for (const token of [twoLegged, threeLegged]) {
      const response = await app.request(path, { headers: bearer(token) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body).toMatchObject({
        type: "manifest",
        hasThumbnail: "true",
        status: "success",
        progress: "complete",
        region: "US",
        urn: DEFAULT_MANIFEST_URN,
        version: "1.0",
      });
      expect(body.derivatives).toHaveLength(2);
      expect(body.derivatives[0]).toMatchObject({ outputType: "svf2", status: "success" });
      expect(body.derivatives[0].children[1]).toMatchObject({ type: "geometry", role: "3d" });
    }
  });

  it("rejects tokens without data:read using the APS AUTH-010 shape", async () => {
    const token = await issueTwoLeggedToken(app, "user-profile:read");
    const response = await app.request(`${base}/modelderivative/v2/designdata/formats`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      developerMessage: "Token does not have the privilege for this request.",
      moreInfo: "https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/error_handling/",
      errorCode: "AUTH-010",
    });
  });

  it("returns the APS AUTH-006 shape for missing and registered foreign-signed tokens", async () => {
    const missing = await app.request(`${base}/modelderivative/v2/designdata/formats`);
    expect(missing.status).toBe(401);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-006" });

    const { privateKey } = await generateKeyPair("RS256");
    const foreign = await new SignJWT({ scope: ["data:read"] })
      .setProtectedHeader({ alg: "RS256", kid: "foreign" })
      .setIssuer(APS_TOKEN_ISSUER)
      .setAudience(APS_TOKEN_AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
    const now = Math.floor(Date.now() / 1000);
    getAccessTokens(store).set(foreign, {
      clientId: "aps-test-client",
      scope: "data:read",
      issuedAt: now,
      expiresAt: now + 3600,
      apsUserId: null,
      familyId: null,
    });
    const response = await app.request(`${base}/modelderivative/v2/designdata/formats`, {
      headers: bearer(foreign),
    });
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-006" });
  });

  it("rejects framework static tokens because APS data routes require APS-issued JWTs", async () => {
    const setup = createTestApp();
    setup.tokenMap.set("static-token", {
      login: "testuser@autodesk.local",
      id: 1,
      scopes: ["data:read"],
    });

    const response = await setup.app.request(`${base}/modelderivative/v2/designdata/formats`, {
      headers: bearer("static-token"),
    });
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-006" });
  });

  it("rejects an expired emulator token", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = await issueTwoLeggedToken(app);
      vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
      const response = await app.request(`${base}/modelderivative/v2/designdata/formats`, {
        headers: bearer(token),
      });
      expect(response.status).toBe(401);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-006" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty 404 for an unknown manifest URN", async () => {
    const token = await issueTwoLeggedToken(app);
    const response = await app.request(`${base}/modelderivative/v2/designdata/dXJuOmVtdWxhdGU6bWlzc2luZw/manifest`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("serves manifests keyed by URN from seed config", async () => {
    const customUrn = "dXJuOmVtdWxhdGU6Y3VzdG9t";
    const setup = createTestApp({
      manifests: {
        [customUrn]: {
          status: "pending",
          progress: "25%",
          region: "EMEA",
          derivatives: [{ outputType: "svf", status: "inprogress", progress: "25%" }],
        },
      },
    });
    const token = await issueTwoLeggedToken(setup.app);
    const response = await setup.app.request(
      `${base}/modelderivative/v2/designdata/${customUrn}/manifest?region=EMEA`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ urn: customUrn, status: "pending", progress: "25%", region: "EMEA" });
    expect(body.derivatives[0]).toMatchObject({ outputType: "svf", status: "inprogress" });
  });
});
