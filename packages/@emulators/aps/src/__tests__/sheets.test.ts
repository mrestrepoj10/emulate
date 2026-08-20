import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { getApsStore } from "../index.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const sheetsBase = `${base}/construction/sheets/v1/projects/emulate-project`;
const prefixedSheetsBase = `${base}/construction/sheets/v1/projects/b.emulate-project`;

describe("APS ACC Sheets routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("accepts two-legged tokens and both project ID forms", async () => {
    const token = await issueTwoLeggedToken(app);
    for (const routeBase of [sheetsBase, prefixedSheetsBase]) {
      const response = await app.request(`${routeBase}/sheets`, { headers: bearer(token) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.pagination.totalResults).toBe(2);
      expect(body.results[0]).toMatchObject({
        number: "A-101",
        title: "Level 1 Floor Plan",
        isCurrent: true,
      });
    }
  });

  it("returns previous and next URLs in the Sheets pagination envelope", async () => {
    const token = await issueTwoLeggedToken(app);
    const firstResponse = await app.request(`${sheetsBase}/sheets?limit=1`, { headers: bearer(token) });
    const first = (await firstResponse.json()) as Record<string, any>;
    expect(first.pagination).toEqual({
      limit: 1,
      offset: 0,
      previousUrl: "",
      nextUrl: `${sheetsBase}/sheets?limit=1&offset=1`,
      totalResults: 2,
    });

    const secondResponse = await app.request(first.pagination.nextUrl, { headers: bearer(token) });
    const second = (await secondResponse.json()) as Record<string, any>;
    expect(second.results[0].number).toBe("S-101");
    expect(second.pagination.previousUrl).toBe(`${sheetsBase}/sheets?limit=1&offset=0`);
    expect(second.pagination.nextUrl).toBe("");
  });

  it("filters sheets by version set, tag, collection, and search text", async () => {
    const token = await issueTwoLeggedToken(app);
    const response = await app.request(
      `${sheetsBase}/sheets?filter[versionSetId]=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&filter[tags]=structural&collectionId=99999999-9999-4999-8999-999999999999&searchText=foundation&currentOnly=true`,
      { headers: bearer(token) },
    );
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination.totalResults).toBe(1);
    expect(body.results[0]).toMatchObject({ number: "S-101", title: "Foundation Plan" });
  });

  it("batch gets sheets in requested order without a pagination member", async () => {
    const token = await issueTwoLeggedToken(app);
    const response = await app.request(`${sheetsBase}/sheets:batch-get`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "00000000-0000-4000-8000-000000000000",
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).not.toHaveProperty("pagination");
    expect(body.results.map((sheet: Record<string, unknown>) => sheet.number)).toEqual(["S-101", "A-101"]);
  });

  it("lists version sets and collections and gets one collection", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = { ...bearer(token), "x-ads-region": "EMEA" };

    const versionResponse = await app.request(`${sheetsBase}/version-sets`, { headers });
    const versions = (await versionResponse.json()) as Record<string, any>;
    expect(versions.pagination.totalResults).toBe(1);
    expect(versions.results[0]).toMatchObject({ name: "August 2026 Issue", issuanceDate: "2026-08-19" });

    const collectionsResponse = await app.request(`${sheetsBase}/collections`, { headers });
    const collections = (await collectionsResponse.json()) as Record<string, any>;
    expect(collections.pagination.totalResults).toBe(1);
    expect(collections.results[0]).toMatchObject({ name: "Issued for Construction" });

    const collectionResponse = await app.request(`${sheetsBase}/collections/99999999-9999-4999-8999-999999999999`, {
      headers,
    });
    expect(collectionResponse.status).toBe(200);
    expect((await collectionResponse.json()) as Record<string, unknown>).toMatchObject({
      id: "99999999-9999-4999-8999-999999999999",
      name: "Issued for Construction",
    });
  });

  it("supports x-user-id impersonation for a two-legged token", async () => {
    const token = await issueTwoLeggedToken(app);
    const userId = getApsStore(store).users.all()[0]?.user_id ?? "";
    const valid = await app.request(`${sheetsBase}/sheets`, {
      headers: { ...bearer(token), "x-user-id": userId },
    });
    expect(valid.status).toBe(200);

    const invalid = await app.request(`${sheetsBase}/sheets`, {
      headers: { ...bearer(token), "x-user-id": "MISSING_USER" },
    });
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toEqual({
      errorCode: "ERR_NOT_ALLOWED",
      message: "The x-user-id does not identify a seeded user.",
    });
  });

  it("requires data:read and returns the Sheets error shape", async () => {
    const wrongScope = await issueTwoLeggedToken(app, "user-profile:read");
    const withoutScope = await app.request(`${sheetsBase}/sheets`, { headers: bearer(wrongScope) });
    expect(withoutScope.status).toBe(403);
    expect((await withoutScope.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });

    const token = await issueTwoLeggedToken(app);
    const invalidPage = await app.request(`${sheetsBase}/sheets?limit=201`, { headers: bearer(token) });
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toEqual({
      errorCode: "ERR_BAD_INPUT",
      message: "limit must be an integer between 1 and 200.",
    });

    const missing = await app.request(`${sheetsBase}/collections/00000000-0000-4000-8000-000000000000`, {
      headers: bearer(token),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({
      errorCode: "ERR_RESOURCE_NOT_EXIST",
    });

    const missingProject = await app.request(`${base}/construction/sheets/v1/projects/b.missing-project/sheets`, {
      headers: bearer(token),
    });
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toEqual({
      errorCode: "ERR_RESOURCE_NOT_EXIST",
      message: "The requested project was not found.",
    });
  });

  it("loads linked Sheet resources from seed config", async () => {
    const setup = createTestApp({
      sheet_collections: [
        {
          id: "15151515-1515-4151-8151-151515151515",
          project_id: "b.emulate-project",
          name: "Permit Set",
        },
      ],
      sheet_version_sets: [
        {
          id: "16161616-1616-4161-8161-161616161616",
          project_id: "b.emulate-project",
          name: "Permit Issue",
          issuance_date: "2026-09-01",
          collection_id: "15151515-1515-4151-8151-151515151515",
        },
      ],
      sheets: [
        {
          id: "17171717-1717-4171-8171-171717171717",
          project_id: "b.emulate-project",
          number: "P-001",
          title: "Permit Cover",
          version_set_id: "16161616-1616-4161-8161-161616161616",
          collection_id: "15151515-1515-4151-8151-151515151515",
          tags: ["permit"],
        },
      ],
    });
    const token = await issueTwoLeggedToken(setup.app);
    const response = await setup.app.request(`${sheetsBase}/sheets?filter[tags]=permit`, {
      headers: bearer(token),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination.totalResults).toBe(1);
    expect(body.results[0]).toMatchObject({ number: "P-001", title: "Permit Cover" });
  });

  it("rejects ACC seed resources with broken project links", () => {
    expect(() =>
      createTestApp({
        sheet_collections: [
          {
            id: "18181818-1818-4181-8181-181818181818",
            project_id: "b.missing-project",
            name: "Orphaned collection",
          },
        ],
      }),
    ).toThrow("APS ACC resource references unknown project 'b.missing-project'.");
  });
});
