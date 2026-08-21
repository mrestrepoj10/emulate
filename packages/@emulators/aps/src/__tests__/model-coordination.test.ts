import { gunzipSync } from "node:zlib";
import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_SECOND_DOCUMENT_VERSION_ID,
  DEFAULT_WEBHOOK_CHILD_FOLDER_ID,
  DEFAULT_WEBHOOK_VERSION_ID,
} from "../helpers.js";
import { getApsStore } from "../store.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const containerId = DEFAULT_PROJECT_ID.slice(2);
const modelSetId = "13131313-1313-4131-8131-131313131313";

describe("APS Model Coordination routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires three-legged data:read access and a bare container ID", async () => {
    const twoLegged = await issueTwoLeggedToken(app);
    const denied = await app.request(`${base}/bim360/modelset/v3/containers/${containerId}/modelsets`, {
      headers: bearer(twoLegged),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ errorCode: "AUTH-010" });

    const threeLegged = await issueThreeLeggedToken(app, store);
    const prefixed = await app.request(`${base}/bim360/modelset/v3/containers/${DEFAULT_PROJECT_ID}/modelsets`, {
      headers: bearer(threeLegged),
    });
    expect(prefixed.status).toBe(400);
    expect(prefixed.headers.get("content-type")).toContain("application/problem+json");
    expect(await prefixed.json()).toEqual({
      type: "BadInput",
      title: "One or more input values in the request were bad",
      detail: "The following parameters are invalid: containerId",
      errors: [
        {
          field: "containerId",
          title: "Invalid parameter",
          detail: `The value '${DEFAULT_PROJECT_ID}' must not include the 'b.' prefix.`,
          type: "BadInput",
        },
      ],
    });
  });

  it("paginates model sets with opaque continuation tokens and enforces the 20 item cap", async () => {
    const seeds = Array.from({ length: 21 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      project_id: DEFAULT_PROJECT_ID,
      name: `Coordination ${String(index).padStart(2, "0")}`,
      folder_urns: [DEFAULT_WEBHOOK_CHILD_FOLDER_ID],
      document_version_ids: [DEFAULT_WEBHOOK_VERSION_ID, DEFAULT_SECOND_DOCUMENT_VERSION_ID],
    }));
    const setup = createTestApp({ model_sets: seeds });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const first = await setup.app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets?pageLimit=20&name=Coordination`,
      { headers: bearer(token) },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, any>;
    expect(firstBody.modelSets).toHaveLength(20);
    expect(firstBody.page.continuationToken).toBeTruthy();

    const second = await setup.app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets?pageLimit=20&name=Coordination&continuationToken=${encodeURIComponent(firstBody.page.continuationToken)}`,
      { headers: bearer(token) },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, any>;
    expect(secondBody.modelSets).toHaveLength(2);
    expect(secondBody.page).toEqual({});

    const tooLarge = await setup.app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets?pageLimit=21`,
      { headers: bearer(token) },
    );
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toMatchObject({ type: "BadInput", errors: [{ field: "pageLimit" }] });
  });

  it("cross-resolves model set documents to Data Management versions and Model Derivative manifests", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${modelSetId}/versions/latest`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ modelSetId, version: 1, status: "Successful" });
    expect(body.documentVersions).toHaveLength(2);

    const aps = getApsStore(store);
    for (const document of body.documentVersions) {
      const dmVersion = aps.documentVersions.findOneBy("version_id", document.versionUrn);
      expect(dmVersion).toBeDefined();
      expect(document.stableDocumentId).toBe(dmVersion?.item_id);
      expect(document.documentLineage.parentFolderUrn).toBe(
        dmVersion ? aps.documentItems.findOneBy("item_id", dmVersion.item_id)?.folder_id : undefined,
      );
      expect(document.originalSeedFileVersionUrn).toBe(dmVersion?.storage_urn);
      expect(aps.manifests.findOneBy("urn", document.bubbleUrn)).toBeDefined();

      const manifest = await app.request(
        `${base}/modelderivative/v2/designdata/${encodeURIComponent(document.bubbleUrn)}/manifest`,
        { headers: bearer(token) },
      );
      expect(manifest.status).toBe(200);
    }
  });

  it("serves the version, view, test, groups, and deterministic gzip resource triplet", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const testsResponse = await app.request(
      `${base}/bim360/clash/v3/containers/${containerId}/modelsets/${modelSetId}/tests?status=Success`,
      { headers },
    );
    expect(testsResponse.status).toBe(200);
    const testsBody = (await testsResponse.json()) as Record<string, any>;
    expect(testsBody.tests).toHaveLength(1);
    const test = testsBody.tests[0];
    expect(test).toMatchObject({ modelSetId, modelSetVersion: 1, status: "Success" });

    const views = await app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${modelSetId}/versions/1/views`,
      { headers },
    );
    expect(views.status).toBe(200);
    expect(((await views.json()) as Record<string, any>).modelSetViewVersions[0].documentVersions).toHaveLength(2);

    for (const disposition of ["assigned", "closed"]) {
      const groups = await app.request(
        `${base}/bim360/clash/v3/containers/${containerId}/tests/${test.id}/clashes/${disposition}`,
        { headers },
      );
      expect(groups.status).toBe(200);
      expect(await groups.json()).toMatchObject({
        modelSetId,
        modelSetVersion: 1,
        groups: [{ id: expect.any(String) }],
      });
    }

    const resourcesResponse = await app.request(
      `${base}/bim360/clash/v3/containers/${containerId}/tests/${test.id}/resources`,
      { headers },
    );
    expect(resourcesResponse.status).toBe(200);
    const resourcesBody = (await resourcesResponse.json()) as Record<string, any>;
    expect(resourcesBody.resources.map((resource: Record<string, unknown>) => resource.type)).toEqual([
      "scope-version-clash.2.0.0",
      "scope-version-clash-instance.2.0.0",
      "scope-version-document.2.0.0",
    ]);
    expect(resourcesBody.resources.every((resource: Record<string, unknown>) => resource.extension === "json.gz")).toBe(
      true,
    );

    const documentsResource = resourcesBody.resources[2];
    const download = await app.request(documentsResource.url, { headers: documentsResource.headers });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/gzip");
    const documents = JSON.parse(gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8"));
    expect(documents).toEqual([
      { id: 0, urn: DEFAULT_WEBHOOK_VERSION_ID },
      { id: 1, urn: DEFAULT_SECOND_DOCUMENT_VERSION_ID },
    ]);
  });

  it("expires stale blob URLs with 403 and reissues fresh URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const setup = createTestApp({ model_coordination_timing: { signed_url_ttl_ms: 10 } });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const headers = bearer(token);
    const test = getApsStore(setup.store).clashTests.all()[0];
    const path = `${base}/bim360/clash/v3/containers/${containerId}/tests/${test.test_id}/resources`;

    const firstResponse = await setup.app.request(path, { headers });
    const first = (await firstResponse.json()) as Record<string, any>;
    const staleUrl = first.resources[0].url;
    vi.setSystemTime(new Date("2026-08-21T12:00:00.011Z"));
    const stale = await setup.app.request(staleUrl);
    expect(stale.status).toBe(403);
    expect(stale.headers.get("content-type")).toContain("application/problem+json");

    const secondResponse = await setup.app.request(path, { headers });
    const second = (await secondResponse.json()) as Record<string, any>;
    expect(second.resources[0].url).not.toBe(staleUrl);
    expect((await setup.app.request(second.resources[0].url)).status).toBe(200);
  });

  it("simulates Pending to Processing to Success with one clash test for the new version", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const setup = createTestApp();
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${base}/_aps/simulate/modelset-version-added`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelSetId, processingMs: 10 }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as Record<string, any>;
    expect(created.modelSetVersion).toMatchObject({ version: 2, status: "Pending" });
    expect(created.clashTest).toMatchObject({ modelSetVersion: 2, status: "Pending" });

    const aps = getApsStore(setup.store);
    expect(aps.clashTests.findBy("model_set_id", modelSetId)).toHaveLength(2);
    expect(aps.modelSetVersions.findBy("model_set_id", modelSetId)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(aps.clashTests.findOneBy("test_id", created.clashTest.id)?.status).toBe("Processing");
    expect(
      aps.modelSetVersions.findBy("model_set_id", modelSetId).find((version) => version.version === 2)?.status,
    ).toBe("Processing");

    await vi.advanceTimersByTimeAsync(10);
    expect(aps.clashTests.findOneBy("test_id", created.clashTest.id)?.status).toBe("Success");
    const resources = await setup.app.request(
      `${base}/bim360/clash/v3/containers/${containerId}/tests/${created.clashTest.id}/resources`,
      { headers: bearer(token) },
    );
    expect(resources.status).toBe(200);
    expect(((await resources.json()) as Record<string, any>).resources).toHaveLength(3);
  });

  it("returns RFC 7807 not-found errors", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(
      `${base}/bim360/clash/v3/containers/${containerId}/tests/00000000-0000-4000-8000-000000000000`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      type: "NotFound",
      title: "The requested resource was not found",
      detail: "The requested clash test was not found.",
      errors: [],
    });
  });
});
