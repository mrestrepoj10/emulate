import { gunzipSync } from "node:zlib";
import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MANIFEST_URN,
  DEFAULT_PROJECT_ID,
  DEFAULT_SECOND_DOCUMENT_VERSION_ID,
  DEFAULT_WEBHOOK_VERSION_ID,
} from "../helpers.js";
import { fieldKey, LMV_ID_OFFSET, STANDARD_FIELD_KEYS } from "../model-properties-index.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const projectId = DEFAULT_PROJECT_ID.slice(2);
const root = `${base}/construction/index/v2/projects/${projectId}`;

type Json = Record<string, any>;

async function ndjson(response: Response): Promise<Json[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  expect(response.headers.get("content-encoding")).toBe("gzip");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  return gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
}

describe("APS Model Properties index routes", () => {
  let app: Hono;
  let store: Store;
  let token: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${root}${path}`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (url: string) => app.request(url.startsWith("http") ? url : `${root}${url}`, { headers: bearer(token) });

  async function finishedIndex(versionUrn = DEFAULT_WEBHOOK_VERSION_ID): Promise<Json> {
    const created = (await (await post("/indexes:batch-status", { versions: [{ versionUrn }] })).json()) as Json;
    const status = await get(created.indexes[0].selfUrl);
    const body = (await status.json()) as Json;
    expect(body.state).toBe("FINISHED");
    return body;
  }

  beforeEach(async () => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    token = await issueThreeLeggedToken(app, store);
  });

  it("requires a three-legged data:read token and a bare project id", async () => {
    const twoLegged = await issueTwoLeggedToken(app);
    const denied = await app.request(`${root}/indexes:batch-status`, {
      method: "POST",
      headers: { ...bearer(twoLegged), "Content-Type": "application/json" },
      body: JSON.stringify({ versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] }),
    });
    expect(denied.status).toBe(403);

    const prefixed = await app.request(
      `${base}/construction/index/v2/projects/${DEFAULT_PROJECT_ID}/indexes:batch-status`,
      {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] }),
      },
    );
    expect(prefixed.status).toBe(400);
    expect(prefixed.headers.get("content-type")).toContain("application/problem+json");
    expect(await prefixed.json()).toMatchObject({ type: "BadInput", errors: [{ field: "projectId" }] });

    const missing = await app.request(`${base}/construction/index/v2/projects/nope/indexes:batch-status`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] }),
    });
    expect(missing.status).toBe(404);

    const unsupportedMedia = await app.request(`${root}/indexes:batch-status`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(unsupportedMedia.status).toBe(415);
  });

  it("validates the batch body", async () => {
    expect((await post("/indexes:batch-status", { versions: [] })).status).toBe(400);
    const missingUrn = await post("/indexes:batch-status", { versions: [{}] });
    expect(missingUrn.status).toBe(400);
    expect(await missingUrn.json()).toMatchObject({ errors: [{ field: "versions[0].versionUrn" }] });
  });

  it("reports PROCESSING with retryAt first, then FINISHED with resource URLs, and keeps one indexId per input", async () => {
    const first = await post("/indexes:batch-status", { versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Json;
    expect(firstBody.indexes).toHaveLength(1);
    const status = firstBody.indexes[0];
    expect(status).toMatchObject({
      projectId,
      type: "INDEX",
      state: "PROCESSING",
      versionUrns: [DEFAULT_WEBHOOK_VERSION_ID],
      stats: null,
      manifestUrl: null,
      fieldsUrl: null,
      propertiesUrl: null,
      errors: [],
    });
    expect(typeof status.indexId).toBe("string");
    expect(status.selfUrl).toBe(`${root}/indexes/${status.indexId}`);
    expect(Date.parse(status.retryAt)).toBeGreaterThan(Date.now() - 1_000);

    const again = (await (
      await post("/indexes:batch-status", { versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] })
    ).json()) as Json;
    expect(again.indexes[0].indexId).toBe(status.indexId);

    const other = (await (
      await post("/indexes:batch-status", { versions: [{ versionUrn: DEFAULT_SECOND_DOCUMENT_VERSION_ID }] })
    ).json()) as Json;
    expect(other.indexes[0].indexId).not.toBe(status.indexId);

    const polled = (await (await get(status.selfUrl)).json()) as Json;
    expect(polled).toMatchObject({
      indexId: status.indexId,
      state: "FINISHED",
      stats: { objects: 5 },
      manifestUrl: `${status.selfUrl}/manifest`,
      fieldsUrl: `${status.selfUrl}/fields`,
      propertiesUrl: `${status.selfUrl}/properties`,
    });

    const stable = (await (await get(status.selfUrl)).json()) as Json;
    expect(stable.state).toBe("FINISHED");
  });

  it("returns one status per version in request order", async () => {
    const body = (await (
      await post("/indexes:batch-status", {
        versions: [{ versionUrn: DEFAULT_SECOND_DOCUMENT_VERSION_ID }, { versionUrn: DEFAULT_WEBHOOK_VERSION_ID }],
      })
    ).json()) as Json;
    expect(body.indexes.map((status: Json) => status.versionUrns[0])).toEqual([
      DEFAULT_SECOND_DOCUMENT_VERSION_ID,
      DEFAULT_WEBHOOK_VERSION_ID,
    ]);
  });

  it("finishes FAILED for unknown versions and configured failures", async () => {
    const unknown = (await (
      await post("/indexes:batch-status", { versions: [{ versionUrn: "urn:adsk.wipprod:fs.file:vf.nope?version=1" }] })
    ).json()) as Json;
    const failed = (await (await get(unknown.indexes[0].selfUrl)).json()) as Json;
    expect(failed.state).toBe("FAILED");
    expect(failed.errors[0]).toMatchObject({ type: "IndexingFailed" });
    expect(failed.propertiesUrl).toBeNull();
    expect((await get(`${unknown.indexes[0].selfUrl}/properties`)).status).toBe(404);

    const configured = createTestApp({
      model_properties_index: { processing_polls: 0, fail_version_urns: [DEFAULT_WEBHOOK_VERSION_ID] },
    });
    const configuredToken = await issueThreeLeggedToken(configured.app, configured.store);
    const response = await configured.app.request(`${root}/indexes:batch-status`, {
      method: "POST",
      headers: { ...bearer(configuredToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }, { versionUrn: DEFAULT_SECOND_DOCUMENT_VERSION_ID }],
      }),
    });
    const statuses = ((await response.json()) as Json).indexes;
    expect(statuses.map((status: Json) => status.state)).toEqual(["FAILED", "FINISHED"]);
  });

  it("serves the manifest with seed files, databases, and views", async () => {
    const status = await finishedIndex();
    const response = await get(status.manifestUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age");
    const manifest = (await response.json()) as Json;
    expect(manifest).toMatchObject({
      schema: "2.0.0",
      projectId,
      status: "Succeeded",
      errors: [],
      stats: { objects: 5 },
    });
    expect(manifest.stats.contentLength).toBeGreaterThan(0);
    expect(manifest.seedFiles).toHaveLength(1);
    const seed = manifest.seedFiles[0];
    expect(seed.versionUrn).toBe(DEFAULT_WEBHOOK_VERSION_ID);
    expect(seed.lineageUrn).toBe("urn:adsk.wipprod:dm.lineage:emulate-sample-model");
    expect(seed.lineageId).toMatch(/^[0-9a-f]{7}$/);
    expect(seed.databases[0].id).toMatch(/^[0-9a-f]{8}$/);
    expect(seed.databases[0].offsets).toBe(
      `urn:adsk.viewing:fs.file:${DEFAULT_MANIFEST_URN}/output/Resource/objects_offs.json.gz`,
    );
    expect(seed.views[0]).toMatchObject({ urn: DEFAULT_WEBHOOK_VERSION_ID, is3d: true, viewableName: "{3D}" });
    expect(seed.views[0].id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("serves fields as gzip NDJSON including the synthetic index fields", async () => {
    const status = await finishedIndex();
    const fields = await ndjson(await get(status.fieldsUrl));
    for (const field of fields) {
      expect(field.key).toMatch(/^p[0-9a-f]{8}$/);
      expect(Object.keys(field).sort()).toEqual(["category", "key", "name", "type", "uom"]);
    }
    expect(fields).toContainEqual({
      key: STANDARD_FIELD_KEYS.name,
      category: "__name__",
      type: "String",
      name: "name",
      uom: null,
    });
    expect(fields).toContainEqual({
      key: STANDARD_FIELD_KEYS.category,
      category: "__category__",
      type: "String",
      name: "Category",
      uom: null,
    });
    expect(fields).toContainEqual({
      key: STANDARD_FIELD_KEYS.parent,
      category: "__parent__",
      type: "DbKey",
      name: "parent",
      uom: null,
    });
    expect(fields).toContainEqual({
      key: STANDARD_FIELD_KEYS.revitCategory,
      category: "__category__",
      type: "String",
      name: "_RC",
      uom: null,
    });
    expect(fields.some((field) => field.category === "__document__" && field.name === "schema_name")).toBe(true);
    expect(fields.some((field) => field.category === "Identity Data" && field.name === "Name")).toBe(true);
    expect(new Set(fields.map((field) => field.key)).size).toBe(fields.length);
  });

  it("serves properties whose ids agree with Model Derivative metadata and keep lmvId apart from svf2Id", async () => {
    const status = await finishedIndex();
    const rows = await ndjson(await get(status.propertiesUrl));
    expect(rows).toHaveLength(5);

    const metadata = (await (
      await get(`${base}/modelderivative/v2/designdata/${DEFAULT_MANIFEST_URN}/metadata`)
    ).json()) as Json;
    const guid = metadata.data.metadata[0].guid;
    const properties = (await (
      await get(`${base}/modelderivative/v2/designdata/${DEFAULT_MANIFEST_URN}/metadata/${guid}/properties`)
    ).json()) as Json;
    const expected = new Map<number, string>(
      properties.data.collection.map((entry: Json) => [entry.objectid, entry.externalId] as [number, string]),
    );
    expect(expected.size).toBe(5);

    const manifest = (await (await get(status.manifestUrl)).json()) as Json;
    const viewId = manifest.seedFiles[0].views[0].id;
    const databaseId = manifest.seedFiles[0].databases[0].id;
    const lineageId = manifest.seedFiles[0].lineageId;

    for (const row of rows) {
      expect(expected.get(row.svf2Id)).toBe(row.externalId);
      expect(row.lmvId).toBe(row.svf2Id + LMV_ID_OFFSET);
      expect(row.lmvId).not.toBe(row.svf2Id);
      expect(row).toMatchObject({ lineageId, databaseId });
      expect(typeof row.propsHash).toBe("string");
      expect(typeof row.props[STANDARD_FIELD_KEYS.name]).toBe("string");
      expect(row.props[fieldKey("Identity Data", "Name")]).toBe(row.props[STANDARD_FIELD_KEYS.name]);
      expect(row.props[fieldKey("Emulate", "Source URN")]).toBe(DEFAULT_MANIFEST_URN);
    }

    const document = rows.find((row) => row.props[STANDARD_FIELD_KEYS.category] === "Revit Document")!;
    expect(document.views).toEqual([]);
    expect(document.propsIgnored).toEqual({});
    expect(document.props[STANDARD_FIELD_KEYS.schemaName]).toBe("rvt");

    const instances = rows.filter((row) => row.views.length > 0);
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance.views).toEqual([viewId]);
      expect(instance.propsIgnored[STANDARD_FIELD_KEYS.parent]).toBeGreaterThan(0);
      expect(instance.props[STANDARD_FIELD_KEYS.revitCategory]).toBe("Model Elements");
      expect(instance.bboxMin.z).toBeLessThan(instance.bboxMax.z);
      expect(typeof instance.geomHash).toBe("string");
    }
  });

  it("runs queries with filtering and column projection, and rejects unsupported operators", async () => {
    const status = await finishedIndex();
    const rows = await ndjson(await get(status.propertiesUrl));
    const instance = rows.find((row) => row.views.length > 0)!;

    const created = await post(`/indexes/${status.indexId}/queries`, {
      query: {
        $and: [
          { $gt: [{ $count: "s.views" }, 0] },
          { $eq: [`s.props.${STANDARD_FIELD_KEYS.revitCategory}`, "'Model Elements'"] },
          { $notnull: `s.props.${STANDARD_FIELD_KEYS.name}` },
          { $in: ["s.svf2Id", instance.svf2Id, -1] },
        ],
      },
      columns: {
        frame_external_id: "s.externalId",
        frame_svf2_id: "s.svf2Id",
        frame_lmv_id: "s.lmvId",
        frame_database_id: "s.databaseId",
        frame_lineage_id: "s.lineageId",
        frame_name: `s.props.${STANDARD_FIELD_KEYS.name}`,
      },
    });
    expect(created.status).toBe(200);
    const query = (await created.json()) as Json;
    expect(query).toMatchObject({
      indexId: status.indexId,
      type: "INDEX",
      state: "PROCESSING",
      queryResultsUrl: null,
      propertiesUrl: null,
    });
    expect(query.selfUrl).toBe(`${root}/indexes/${status.indexId}/queries/${query.queryId}`);

    const finished = (await (await get(query.selfUrl)).json()) as Json;
    expect(finished.state).toBe("FINISHED");
    expect(finished.queryResultsUrl).toBe(`${query.selfUrl}/properties`);
    expect(finished.propertiesUrl).toBe(status.propertiesUrl);

    const results = await ndjson(await get(finished.queryResultsUrl));
    expect(results).toEqual([
      {
        frame_external_id: instance.externalId,
        frame_svf2_id: instance.svf2Id,
        frame_lmv_id: instance.lmvId,
        frame_database_id: instance.databaseId,
        frame_lineage_id: instance.lineageId,
        frame_name: instance.props[STANDARD_FIELD_KEYS.name],
      },
    ]);

    const everything = (await (
      await post(`/indexes/${status.indexId}/queries`, { query: { $and: [true] } })
    ).json()) as Json;
    expect(everything.queryId).not.toBe(query.queryId);
    const repeated = (await (
      await post(`/indexes/${status.indexId}/queries`, { query: { $and: [true] } })
    ).json()) as Json;
    expect(repeated.queryId).toBe(everything.queryId);
    expect(repeated.state).toBe("FINISHED");
    expect(await ndjson(await get(repeated.queryResultsUrl))).toEqual(rows);

    const unsupported = await post(`/indexes/${status.indexId}/queries`, {
      query: { $regex: ["s.externalId", "'.*'"] },
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ type: "BadInput", errors: [{ field: "query" }] });

    const missingQuery = await post(`/indexes/${status.indexId}/queries`, { columns: { a: "s.svf2Id" } });
    expect(missingQuery.status).toBe(400);
  });

  it("creates a query job from batch-status when query and columns are present", async () => {
    const body = (await (
      await post("/indexes:batch-status", {
        versions: [
          {
            versionUrn: DEFAULT_WEBHOOK_VERSION_ID,
            query: { $gt: [{ $count: "s.views" }, 0] },
            columns: { id: "s.svf2Id" },
          },
        ],
      })
    ).json()) as Json;
    const status = body.indexes[0];
    expect(status.queryId).toBeTruthy();
    expect(status.state).toBe("PROCESSING");
    expect(status.selfUrl).toBe(`${root}/indexes/${status.indexId}/queries/${status.queryId}`);

    const finished = (await (await get(status.selfUrl)).json()) as Json;
    expect(finished.state).toBe("FINISHED");
    const results = await ndjson(await get(finished.queryResultsUrl));
    expect(results).toHaveLength(2);
    expect(results.every((row) => typeof row.id === "number" && Object.keys(row).length === 1)).toBe(true);

    const invalid = await post("/indexes:batch-status", {
      versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID, query: { $nope: [] } }],
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ errors: [{ field: "versions[0].query" }] });
  });

  it("finishes immediately when processing_polls is zero", async () => {
    const setup = createTestApp({ model_properties_index: { processing_polls: 0 } });
    const immediateToken = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${root}/indexes:batch-status`, {
      method: "POST",
      headers: { ...bearer(immediateToken), "Content-Type": "application/json" },
      body: JSON.stringify({ versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] }),
    });
    const status = ((await response.json()) as Json).indexes[0];
    expect(status.state).toBe("FINISHED");
    expect(status.propertiesUrl).toBeTruthy();
  });

  it("builds DIFF indexes for a version pair with typed rows", async () => {
    const created = await post("/diffs:batch-status", {
      diffs: [{ prevVersionUrn: DEFAULT_WEBHOOK_VERSION_ID, curVersionUrn: DEFAULT_SECOND_DOCUMENT_VERSION_ID }],
    });
    expect(created.status).toBe(200);
    const status = ((await created.json()) as Json).diffs[0];
    expect(status).toMatchObject({
      type: "DIFF",
      state: "PROCESSING",
      prevVersionUrns: [DEFAULT_WEBHOOK_VERSION_ID],
      curVersionUrns: [DEFAULT_SECOND_DOCUMENT_VERSION_ID],
    });
    expect(status.diffId).toBeTruthy();
    expect(status.indexId).toBeUndefined();
    expect(status.selfUrl).toBe(`${root}/diffs/${status.diffId}`);

    const finished = (await (await get(status.selfUrl)).json()) as Json;
    expect(finished.state).toBe("FINISHED");
    expect(finished.stats).toEqual({ added: 5, removed: 5, modified: 0 });

    const manifest = (await (await get(finished.manifestUrl)).json()) as Json;
    expect(manifest.seedFiles.map((seed: Json) => seed.versionUrn)).toEqual([
      DEFAULT_WEBHOOK_VERSION_ID,
      DEFAULT_SECOND_DOCUMENT_VERSION_ID,
    ]);

    const rows = await ndjson(await get(finished.propertiesUrl));
    expect(rows.map((row) => row.type).sort()).toEqual([
      ...Array(5).fill("OBJECT_ADDED"),
      ...Array(5).fill("OBJECT_REMOVED"),
    ]);
    const removed = rows.find((row) => row.type === "OBJECT_REMOVED")!;
    expect(removed.props).toBeNull();
    expect(removed.prev.props[STANDARD_FIELD_KEYS.name]).toBeTruthy();
    expect(removed.prev.lmvId).toBe(removed.svf2Id + LMV_ID_OFFSET);
    const added = rows.find((row) => row.type === "OBJECT_ADDED")!;
    expect(added.prev).toBeNull();
    expect(added.lmvId).toBe(added.svf2Id + LMV_ID_OFFSET);

    const same = (await (
      await post("/diffs:batch-status", {
        diffs: [{ prevVersionUrn: DEFAULT_WEBHOOK_VERSION_ID, curVersionUrn: DEFAULT_WEBHOOK_VERSION_ID }],
      })
    ).json()) as Json;
    const sameFinished = (await (await get(same.diffs[0].selfUrl)).json()) as Json;
    expect(sameFinished.stats).toEqual({ added: 0, removed: 0, modified: 0 });

    const query = (await (
      await post(`/diffs/${status.diffId}/queries`, {
        query: { $eq: ["s.type", "'OBJECT_ADDED'"] },
        columns: { id: "s.externalId" },
      })
    ).json()) as Json;
    const queryFinished = (await (await get(query.selfUrl)).json()) as Json;
    expect(queryFinished.state).toBe("FINISHED");
    expect(await ndjson(await get(queryFinished.queryResultsUrl))).toHaveLength(5);

    expect((await get(`/indexes/${status.diffId}`)).status).toBe(404);
  });

  it("returns 404 for unknown indexes, queries, and unfinished resources", async () => {
    expect((await get("/indexes/missing")).status).toBe(404);
    expect((await get("/indexes/missing/properties")).status).toBe(404);
    const created = (
      (await (
        await post("/indexes:batch-status", { versions: [{ versionUrn: DEFAULT_WEBHOOK_VERSION_ID }] })
      ).json()) as Json
    ).indexes[0];
    expect((await get(`${created.selfUrl}/properties`)).status).toBe(404);
    expect((await get(`${created.selfUrl}/queries/missing`)).status).toBe(404);
  });
});
