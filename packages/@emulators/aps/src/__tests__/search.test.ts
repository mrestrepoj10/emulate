import type { Hono, Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WEBHOOK_FOLDER_ID } from "../helpers.js";
import { createItem, createStorage, uploadObject } from "./ingestion-helpers.js";
import { bearer, base, createTestApp, issueThreeLeggedToken } from "./test-helpers.js";

function searchPath(folderId = DEFAULT_WEBHOOK_FOLDER_ID): string {
  return `${base}/data/v1/projects/b.emulate-project/folders/${encodeURIComponent(folderId)}/search`;
}

describe("APS Data Management recursive search", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("finds nested items by case-insensitive name and file type", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const byName = await app.request(`${searchPath()}?filter%5Battributes.displayName%5D=SaMpLe`, { headers });
    expect(byName.status).toBe(200);
    const nameBody = (await byName.json()) as Record<string, any>;
    expect(nameBody.data).toHaveLength(1);
    expect(nameBody.data[0]).toMatchObject({ type: "items", attributes: { displayName: "sample.rvt" } });
    expect(nameBody.included).toMatchObject([{ type: "versions", attributes: { fileType: "rvt" } }]);

    const byType = await app.request(`${searchPath()}?filter%5BfileType%5D=.PDF`, { headers });
    const typeBody = (await byType.json()) as Record<string, any>;
    expect(typeBody.data.map((entry: Record<string, any>) => entry.attributes.displayName)).toEqual([
      "coordination-report.pdf",
    ]);
    expect(typeBody.included[0].attributes.versionNumber).toBe(3);
  });

  it("paginates recursive results and returns a valid empty document", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const firstResponse = await app.request(`${searchPath()}?page%5Bnumber%5D=0&page%5Blimit%5D=1`, { headers });
    const first = (await firstResponse.json()) as Record<string, any>;
    expect(first.data).toHaveLength(1);
    expect(first.included).toHaveLength(1);
    expect(first.links.next.href).toContain("page%5Bnumber%5D=1");
    const second = (await (await app.request(first.links.next.href, { headers })).json()) as Record<string, any>;
    expect(second.data).toHaveLength(1);
    expect(second.links.prev.href).toContain("page%5Bnumber%5D=0");

    const empty = await app.request(`${searchPath()}?filter%5Battributes.displayName%5D=does-not-exist`, {
      headers,
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ data: [], included: [] });
  });

  it("rejects a foreign-project folder and a token without data:read", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const foreignFolder = "urn:adsk.wipprod:fs.folder:co.emulate-infrastructure-root";
    const foreign = await app.request(searchPath(foreignFolder), { headers: bearer(token) });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ errors: [{ code: "NOT_FOUND", status: "404" }] });

    const wrongScope = await issueThreeLeggedToken(app, store, "user-profile:read");
    const forbidden = await app.request(searchPath(), { headers: bearer(wrongScope) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ errorCode: "AUTH-010" });
  });

  it("finds a newly uploaded item without rebuilding the search index", async () => {
    const token = await issueThreeLeggedToken(app, store, "data:read data:create data:write");
    const storage = await createStorage(app, token, "Deep Search Model.rvt");
    await uploadObject(app, token, storage, [new TextEncoder().encode("uploaded model")]);
    await createItem(app, token, storage.objectId, "Deep Search Model.rvt");

    const response = await app.request(
      `${searchPath()}?filter%5Battributes.displayName%5D=search%20model&filter%5BfileType%5D=rvt`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].attributes.displayName).toBe("Deep Search Model.rvt");
    expect(body.included).toMatchObject([{ attributes: { fileType: "rvt", storageSize: 14 } }]);
  });
});
