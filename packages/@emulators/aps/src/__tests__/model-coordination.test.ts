import { gunzipSync } from "node:zlib";
import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApsSeedConfig } from "../config.js";
import { replayClashScenario } from "../clash-scenario.js";
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_SECOND_DOCUMENT_VERSION_ID,
  DEFAULT_WEBHOOK_CHILD_FOLDER_ID,
  DEFAULT_WEBHOOK_ITEM_ID,
  DEFAULT_WEBHOOK_VERSION_ID,
} from "../helpers.js";
import { LMV_ID_OFFSET, versionClashData } from "../model-coordination.js";
import { getApsStore } from "../store.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const containerId = DEFAULT_PROJECT_ID.slice(2);
const modelSetId = "13131313-1313-4131-8131-131313131313";
const seededIssueId = "33333333-3333-4333-8333-333333333333";
const assignedGroupId = "17171717-1717-4171-8171-171717171717";
const closedGroupId = "18181818-1818-4181-8181-181818181818";
const allModelsViewId = "19191919-1919-4191-8191-191919191919";
const architectureViewId = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const SAMPLE_V2_ID = "urn:adsk.wipprod:fs.file:vf.emulate-sample-model?version=2";

const clashBase = `${base}/bim360/clash/v3/containers/${containerId}`;
const modelSetBase = `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${modelSetId}`;

type Json = Record<string, any>;

async function getJson(app: Hono, url: string, headers: Record<string, string>): Promise<Json> {
  const response = await app.request(url, { headers });
  expect(response.status, `${url} → ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as Json;
}

/** Parses a clash result file the way Autodesk's sample does: gunzip, strip the BOM, read the wrapper. */
async function downloadResource(app: Hono, resource: Json): Promise<{ raw: Buffer; body: Json }> {
  const response = await app.request(resource.url, { headers: resource.headers });
  expect(response.status).toBe(200);
  const raw = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(raw).toString("utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  return { raw, body: JSON.parse(text.slice(1)) as Json };
}

async function resourcesFor(app: Hono, headers: Record<string, string>, testId: string) {
  const body = await getJson(app, `${clashBase}/tests/${testId}/resources`, headers);
  const byType = Object.fromEntries(body.resources.map((resource: Json) => [resource.type, resource]));
  const clashes = await downloadResource(app, byType["scope-version-clash.2.0.0"]);
  const instances = await downloadResource(app, byType["scope-version-clash-instance.2.0.0"]);
  const documents = await downloadResource(app, byType["scope-version-document.2.0.0"]);
  return {
    resources: body.resources as Json[],
    clashes: clashes.body.clashes as Json[],
    instances: instances.body.instances as Json[],
    documents: documents.body.documents as Json[],
    raw: [clashes.raw, instances.raw, documents.raw],
  };
}

async function testsByVersion(app: Hono, headers: Record<string, string>, id = modelSetId): Promise<Map<number, Json>> {
  const body = await getJson(app, `${clashBase}/modelsets/${id}/tests`, headers);
  return new Map(body.tests.map((test: Json) => [test.modelSetVersion, test]));
}

function statusCounts(clashes: Json[]): Record<string, number> {
  return clashes.reduce<Record<string, number>>((counts, clash) => {
    counts[clash.status] = (counts[clash.status] ?? 0) + 1;
    return counts;
  }, {});
}

function leafObjectIds(objects: Json[]): number[] {
  return objects.flatMap((object) => (object.objects ? leafObjectIds(object.objects) : [object.objectid]));
}

const sampleV2Seed: ApsSeedConfig = {
  document_versions: [
    {
      version_id: SAMPLE_V2_ID,
      item_id: DEFAULT_WEBHOOK_ITEM_ID,
      project_id: DEFAULT_PROJECT_ID,
      version_number: 2,
      display_name: "sample.rvt",
    },
  ],
};

function scenarioModelSet(id: string, overrides: Partial<NonNullable<ApsSeedConfig["model_sets"]>[number]>) {
  return {
    id,
    project_id: DEFAULT_PROJECT_ID,
    name: `Scenario ${id.slice(0, 4)}`,
    folder_urns: [DEFAULT_WEBHOOK_CHILD_FOLDER_ID],
    document_version_ids: [DEFAULT_WEBHOOK_VERSION_ID, DEFAULT_SECOND_DOCUMENT_VERSION_ID],
    created_time: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("APS Model Coordination routes", () => {
  let app: Hono;
  let store: Store;
  let headers: Record<string, string>;

  beforeEach(async () => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
    headers = bearer(await issueThreeLeggedToken(app, store));
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

    const prefixed = await app.request(`${base}/bim360/modelset/v3/containers/${DEFAULT_PROJECT_ID}/modelsets`, {
      headers,
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
    const firstBody = (await first.json()) as Json;
    expect(firstBody.modelSets).toHaveLength(20);
    expect(firstBody.page.continuationToken).toBeTruthy();

    const second = await setup.app.request(
      `${base}/bim360/modelset/v3/containers/${containerId}/modelsets?pageLimit=20&name=Coordination&continuationToken=${encodeURIComponent(firstBody.page.continuationToken)}`,
      { headers: bearer(token) },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Json;
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
    const body = await getJson(app, `${modelSetBase}/versions/latest`, headers);
    expect(body).toMatchObject({ modelSetId, version: 3, status: "Successful" });
    expect(body.documentVersions).toHaveLength(2);

    const aps = getApsStore(store);
    for (const document of body.documentVersions) {
      const dmVersion = aps.documentVersions.findOneBy("version_id", document.versionUrn);
      expect(dmVersion).toBeDefined();
      expect(document.stableDocumentId).toBe(dmVersion?.item_id);
      expect(document.documentStatus).toBe("Succeeded");
      expect(document.alignment.distanceUnit).toBe("autodesk.unit.unit:feet-2.0.0");
      expect(document.documentLineage.parentFolderUrn).toBe(
        dmVersion ? aps.documentItems.findOneBy("item_id", dmVersion.item_id)?.folder_id : undefined,
      );
      expect(document.originalSeedFileVersionUrn).toBe(dmVersion?.storage_urn);
      expect(aps.manifests.findOneBy("urn", document.bubbleUrn)).toBeDefined();

      const manifest = await app.request(
        `${base}/modelderivative/v2/designdata/${encodeURIComponent(document.bubbleUrn)}/manifest`,
        { headers },
      );
      expect(manifest.status).toBe(200);
    }
  });

  describe("clash tests", () => {
    it("lists one successful test per version, newest first, and filters by version", async () => {
      const list = await getJson(app, `${clashBase}/modelsets/${modelSetId}/tests?status=Success`, headers);
      expect(list.tests.map((test: Json) => test.modelSetVersion)).toEqual([3, 2, 1]);
      expect(list.tests[2]).toMatchObject({
        id: "16161616-1616-4161-8161-161616161616",
        modelSetId,
        modelSetVersion: 1,
        status: "Success",
        completedOn: expect.any(String),
      });

      const byVersion = await getJson(app, `${clashBase}/modelsets/${modelSetId}/versions/2/tests`, headers);
      expect(byVersion.tests).toHaveLength(1);
      expect(byVersion.tests[0]).toMatchObject({ modelSetVersion: 2, status: "Success" });
      expect(byVersion.tests[0].id).toBe(list.tests[1].id);

      const missing = await app.request(`${clashBase}/modelsets/${modelSetId}/versions/9/tests`, { headers });
      expect(missing.status).toBe(404);
      const invalid = await app.request(`${clashBase}/modelsets/${modelSetId}/versions/zero/tests`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ errors: [{ field: "version" }] });
    });

    it("serves BOM-prefixed gzip wrapper files whose statuses follow the seeded scenario", async () => {
      const tests = await testsByVersion(app, headers);
      const v1 = await resourcesFor(app, headers, tests.get(1)!.id);
      const v2 = await resourcesFor(app, headers, tests.get(2)!.id);
      const v3 = await resourcesFor(app, headers, tests.get(3)!.id);

      expect(v1.resources.map((resource) => [resource.type, resource.extension])).toEqual([
        ["scope-version-clash.2.0.0", "json.gz"],
        ["scope-version-clash-instance.2.0.0", "json.gz"],
        ["scope-version-document.2.0.0", "json.gz"],
      ]);
      expect(v1.resources[0].validUntil).toEqual(expect.any(String));

      expect(statusCounts(v1.clashes)).toEqual({ New: 40 });
      expect(statusCounts(v2.clashes)).toEqual({ New: 10, Existing: 25, Resolved: 15 });
      expect(statusCounts(v3.clashes)).toEqual({ New: 3, Existing: 30, Resolved: 5 });

      const ids = (rows: Json[], status?: string) =>
        new Set(rows.filter((row) => !status || row.status === status).map((row) => row.id as number));
      const v1Ids = ids(v1.clashes);
      for (const id of ids(v2.clashes, "Existing")) expect(v1Ids.has(id)).toBe(true);
      for (const id of ids(v2.clashes, "Resolved")) expect(v1Ids.has(id)).toBe(true);
      for (const id of ids(v2.clashes, "New")) expect(v1Ids.has(id)).toBe(false);
      const v3Ids = ids(v3.clashes);
      for (const id of ids(v2.clashes, "Resolved")) expect(v3Ids.has(id)).toBe(false);

      // Stable clash and object identities survive across versions; viewer ids may not.
      const v1ByClash = new Map(v1.clashes.map((clash) => [clash.id, clash]));
      for (const clash of v2.clashes.filter((row) => row.status !== "New")) {
        expect(clash.clash).toEqual(v1ByClash.get(clash.id)!.clash);
        expect(clash.dist).toBe(v1ByClash.get(clash.id)!.dist);
      }
      for (const instance of v2.instances) {
        const clash = v2.clashes.find((row) => row.id === instance.cid)!;
        expect([instance.loid, instance.roid]).toEqual(clash.clash);
        expect(instance.ldid).not.toBe(instance.rdid);
      }
      expect(v2.documents).toEqual([
        { id: 0, urn: DEFAULT_WEBHOOK_VERSION_ID, viewableName: "{3D}" },
        { id: 1, urn: DEFAULT_SECOND_DOCUMENT_VERSION_ID, viewableName: "{3D}" },
      ]);
    });

    it("uses LMV viewer ids offset from the Model Derivative object tree of each document version", async () => {
      const tests = await testsByVersion(app, headers);
      const { instances, documents } = await resourcesFor(app, headers, tests.get(3)!.id);
      const version = await getJson(app, `${modelSetBase}/versions/3`, headers);
      const leavesByDocument = new Map<number, Set<number>>();
      for (const document of documents) {
        const modelSetDocument = version.documentVersions.find((entry: Json) => entry.versionUrn === document.urn);
        expect(modelSetDocument).toBeDefined();
        const tree = await getJson(
          app,
          `${base}/modelderivative/v2/designdata/${encodeURIComponent(modelSetDocument.bubbleUrn)}/metadata/${modelSetDocument.viewableGuid}`,
          headers,
        );
        leavesByDocument.set(document.id, new Set(leafObjectIds(tree.data.objects)));
      }
      expect(instances.length).toBeGreaterThan(0);
      for (const instance of instances) {
        expect(leavesByDocument.get(instance.ldid)!.has(instance.lvid - LMV_ID_OFFSET)).toBe(true);
        expect(leavesByDocument.get(instance.rdid)!.has(instance.rvid - LMV_ID_OFFSET)).toBe(true);
        // Stable object ids are their own id space, distinct from both LMV and SVF2 viewer ids.
        expect(leavesByDocument.get(instance.ldid)!.has(instance.loid)).toBe(false);
        expect(instance.loid).not.toBe(instance.lvid);
      }
    });

    it("produces byte-identical files for the same seed and different files for another seed", async () => {
      const seedFor = (id: string, seed: number) =>
        scenarioModelSet(id, { clash_scenario: { seed, versions: [{ added: 12 }, { added: 4, resolved: 3 }] } });
      const sameA = "30000000-0000-4000-8000-000000000001";
      const sameB = "30000000-0000-4000-8000-000000000002";
      const other = "30000000-0000-4000-8000-000000000003";
      const setup = createTestApp({
        model_sets: [seedFor(sameA, 7), seedFor(sameB, 7), seedFor(other, 8)],
      });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const files = async (id: string) => {
        const tests = await testsByVersion(setup.app, token, id);
        return resourcesFor(setup.app, token, tests.get(2)!.id);
      };
      const [a, b, c] = await Promise.all([files(sameA), files(sameB), files(other)]);
      expect(a.raw.map((buffer) => buffer.toString("base64"))).toEqual(
        b.raw.map((buffer) => buffer.toString("base64")),
      );
      expect(a.raw[0].equals(c.raw[0])).toBe(false);
      expect(statusCounts(c.clashes)).toEqual({ New: 4, Existing: 9, Resolved: 3 });

      const twice = replayClashScenario(
        getApsStore(setup.store).modelSets.findOneBy("model_set_id", sameA)!.clash_scenario,
      );
      expect(twice).toEqual(
        replayClashScenario(getApsStore(setup.store).modelSets.findOneBy("model_set_id", sameB)!.clash_scenario),
      );
    });

    it("emits roughly 200k clashes for a large scenario without holding them in the seed", async () => {
      const largeId = "31000000-0000-4000-8000-000000000001";
      const setup = createTestApp({
        model_sets: [
          scenarioModelSet(largeId, { clash_scenario: { seed: 3, large: true, versions: [{ added: 10 }] } }),
        ],
      });
      const aps = getApsStore(setup.store);
      const modelSet = aps.modelSets.findOneBy("model_set_id", largeId)!;
      expect(modelSet.clash_scenario.versions[0]?.added).toBe(200_000);
      expect(aps.signedBlobs.all().filter((blob) => blob.blob_id.includes("scope-version"))).toHaveLength(0);
      const data = versionClashData(aps, setup.store, modelSet, 1);
      expect(data.clashes).toHaveLength(200_000);
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const tests = await testsByVersion(setup.app, token, largeId);
      const resources = await getJson(setup.app, `${clashBase}/tests/${tests.get(1)!.id}/resources`, token);
      const download = await setup.app.request(resources.resources[0].url);
      expect(download.status).toBe(200);
      expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
    });

    it("expires stale blob URLs with 403 and reissues fresh URLs", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      const setup = createTestApp({ model_coordination_timing: { signed_url_ttl_ms: 10 } });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const test = getApsStore(setup.store).clashTests.all()[0];
      const path = `${clashBase}/tests/${test.test_id}/resources`;

      const first = (await (await setup.app.request(path, { headers: token })).json()) as Json;
      const staleUrl = first.resources[0].url;
      vi.setSystemTime(new Date("2026-08-21T12:00:00.011Z"));
      const stale = await setup.app.request(staleUrl);
      expect(stale.status).toBe(403);
      expect(stale.headers.get("content-type")).toContain("application/problem+json");

      const second = (await (await setup.app.request(path, { headers: token })).json()) as Json;
      expect(second.resources[0].url).not.toBe(staleUrl);
      expect((await setup.app.request(second.resources[0].url)).status).toBe(200);
    });

    it("returns RFC 7807 not-found errors", async () => {
      const response = await app.request(`${clashBase}/tests/00000000-0000-4000-8000-000000000000`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        type: "NotFound",
        title: "The requested resource was not found",
        detail: "The requested clash test was not found.",
        errors: [],
      });
    });
  });

  describe("clash groups", () => {
    it("lists assigned and closed groups with the documented payloads", async () => {
      const tests = await testsByVersion(app, headers);
      const assigned = await getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/assigned`, headers);
      expect(assigned.page).toEqual({});
      expect(assigned.groups).toHaveLength(1);
      expect(Object.keys(assigned.groups[0])).toEqual([
        "id",
        "clashTestId",
        "issueId",
        "createdBy",
        "createdOn",
        "clashes",
      ]);
      expect(assigned.groups[0]).toMatchObject({
        id: assignedGroupId,
        clashTestId: tests.get(2)!.id,
        issueId: seededIssueId,
        createdBy: getApsStore(store).users.all()[0].user_id,
        createdOn: expect.any(String),
      });
      expect(assigned.groups[0].clashes).toHaveLength(8);

      const closed = await getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/closed`, headers);
      expect(closed.groups).toHaveLength(1);
      expect(Object.keys(closed.groups[0])).toEqual([
        "id",
        "clashTestId",
        "title",
        "description",
        "reason",
        "screenShots",
        "createdBy",
        "createdOn",
        "clashes",
      ]);
      expect(closed.groups[0]).toMatchObject({
        id: closedGroupId,
        clashTestId: tests.get(2)!.id,
        reason: "VALID_INTERFACE",
        screenShots: [],
      });
      expect(closed.groups[0].clashes).toHaveLength(5);
      const overlap = closed.groups[0].clashes.filter((clash: number) => assigned.groups[0].clashes.includes(clash));
      expect(overlap).toEqual([]);

      const grouped = await getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/grouped`, headers);
      expect(grouped).toEqual({
        clashes: [...assigned.groups[0].clashes, ...closed.groups[0].clashes].sort((a: number, b: number) => a - b),
      });
    });

    it("filters, sorts, and pages container-level group searches", async () => {
      const tests = await testsByVersion(app, headers);
      const search = (path: string) => getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/${path}`, headers);
      expect((await search(`assigned?clashTestId=${tests.get(2)!.id}`)).groups).toHaveLength(1);
      expect((await search(`assigned?clashTestId=${tests.get(1)!.id}`)).groups).toHaveLength(0);
      expect((await search(`assigned?issueId=${seededIssueId}`)).groups).toHaveLength(1);
      expect((await search("assigned?issueId=00000000-0000-4000-8000-000000000000")).groups).toHaveLength(0);
      expect((await search("closed?reason=VALID_INTERFACE")).groups).toHaveLength(1);
      expect((await search("closed?reason=FIELD_FIX")).groups).toHaveLength(0);
      const userId = getApsStore(store).users.all()[0].user_id;
      expect((await search(`closed?createdBy=${userId}`)).groups).toHaveLength(1);
      expect((await search("closed?createdBy=nobody")).groups).toHaveLength(0);

      const createdOn = (await search("closed")).groups[0].createdOn as string;
      expect((await search(`closed?after=${encodeURIComponent(createdOn)}`)).groups).toHaveLength(0);
      expect((await search("closed?after=2000-01-01T00:00:00Z")).groups).toHaveLength(1);
      expect((await search(`closed?before=${encodeURIComponent(createdOn)}`)).groups).toHaveLength(0);
      expect((await search("closed?before=2999-01-01T00:00:00Z")).groups).toHaveLength(1);

      for (const [path, field] of [
        ["closed?reason=NOPE", "reason"],
        ["assigned?after=yesterday", "after"],
        ["assigned?sort=Sideways", "sort"],
      ] as const) {
        const response = await app.request(`${clashBase}/modelsets/${modelSetId}/clashes/${path}`, { headers });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ type: "BadInput", errors: [{ field }] });
      }

      // Create three more closed groups at different times and check ordering and paging.
      for (const [index, version] of [1, 3, 3].entries()) {
        const response = await app.request(`${base}/_aps/simulate/clash-group-closed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelSetId, version, clashes: 2, reason: "FIELD_FIX", title: `Extra ${index}` }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const ascending = await search("closed?sort=Asc");
      const times = ascending.groups.map((group: Json) => Date.parse(group.createdOn));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const descending = await search("closed?sort=Desc");
      expect(descending.groups.map((group: Json) => group.id)).toEqual(
        [...ascending.groups.map((g: Json) => g.id)].reverse(),
      );
      expect((await search("closed?reason=FIELD_FIX")).groups).toHaveLength(3);

      const firstPage = await search("closed?pageLimit=3");
      expect(firstPage.groups).toHaveLength(3);
      expect(firstPage.page.continuationToken).toBeTruthy();
      const secondPage = await search(
        `closed?pageLimit=3&continuationToken=${encodeURIComponent(firstPage.page.continuationToken)}`,
      );
      expect(secondPage.groups).toHaveLength(1);
      expect(secondPage.page).toEqual({});
    });

    it("intersects groups with a requested test through GET and batch POST", async () => {
      const tests = await testsByVersion(app, headers);
      const v3 = await resourcesFor(app, headers, tests.get(3)!.id);
      const live = new Set(v3.clashes.filter((clash) => clash.status !== "Resolved").map((clash) => clash.id));
      const groups = await getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/assigned`, headers);
      const assigned = groups.groups[0];

      const intersection = await getJson(app, `${clashBase}/tests/${tests.get(3)!.id}/clashes/assigned`, headers);
      expect(intersection).toMatchObject({ page: {}, modelSetId, modelSetVersion: 3 });
      expect(intersection.groups).toHaveLength(1);
      expect(Object.keys(intersection.groups[0])).toEqual([
        "id",
        "originalClashTestId",
        "createdAtVersion",
        "existing",
        "resolved",
      ]);
      expect(intersection.groups[0]).toMatchObject({
        id: assignedGroupId,
        originalClashTestId: tests.get(2)!.id,
        createdAtVersion: 2,
      });
      expect([...intersection.groups[0].existing, ...intersection.groups[0].resolved].sort()).toEqual(
        [...assigned.clashes].sort(),
      );
      for (const id of intersection.groups[0].existing) expect(live.has(id)).toBe(true);
      for (const id of intersection.groups[0].resolved) expect(live.has(id)).toBe(false);

      // Against its own test every grouped clash still exists.
      const own = await getJson(app, `${clashBase}/tests/${tests.get(2)!.id}/clashes/closed`, headers);
      expect(own.groups[0].resolved).toEqual([]);
      expect(own.groups[0].existing).toHaveLength(5);

      const batch = await app.request(`${clashBase}/tests/${tests.get(3)!.id}/clashes/assigned?issues=true`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify([seededIssueId]),
      });
      expect(batch.status).toBe(200);
      const batchBody = (await batch.json()) as Json[];
      expect(batchBody).toHaveLength(1);
      expect(Object.keys(batchBody[0])).toEqual([
        "id",
        "clashTestId",
        "issueId",
        "createdBy",
        "createdOn",
        "clashData",
      ]);
      expect(Object.keys(batchBody[0].clashData)).toEqual(["documents", "clashes", "clashInstances"]);
      const batchClashIds = batchBody[0].clashData.clashes.map((clash: Json) => clash.id).sort();
      expect(batchClashIds).toEqual([...assigned.clashes].sort());
      expect(batchBody[0].clashData.clashInstances.map((instance: Json) => instance.cid).sort()).toEqual(batchClashIds);
      expect(batchBody[0].clashData.documents.length).toBeGreaterThan(0);
      expect(batchBody[0].clashData.documents[0]).toEqual({
        id: expect.any(Number),
        urn: expect.any(String),
        viewableName: "{3D}",
      });

      const byId = await app.request(`${clashBase}/tests/${tests.get(2)!.id}/clashes/closed`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify([closedGroupId, "00000000-0000-4000-8000-000000000000"]),
      });
      const byIdBody = (await byId.json()) as Json[];
      expect(byIdBody).toHaveLength(1);
      expect(byIdBody[0]).toMatchObject({ id: closedGroupId, reason: "VALID_INTERFACE" });
      expect(byIdBody[0].clashData.clashes).toHaveLength(5);

      const wrongType = await app.request(`${clashBase}/tests/${tests.get(2)!.id}/clashes/closed`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "text/plain" },
        body: JSON.stringify([closedGroupId]),
      });
      expect(wrongType.status).toBe(415);
      const empty = await app.request(`${clashBase}/tests/${tests.get(2)!.id}/clashes/closed`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });
      expect(empty.status).toBe(400);
    });

    it("creates groups through the simulators and validates close reasons", async () => {
      const tests = await testsByVersion(app, headers);
      const assigned = await app.request(`${base}/_aps/simulate/clash-group-assigned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId: tests.get(3)!.id, clashes: 3, issueId: "44444444-4444-4444-8444-444444444444" }),
      });
      expect(assigned.status).toBe(200);
      const assignedBody = (await assigned.json()) as Json;
      expect(assignedBody).toMatchObject({
        clashTestId: tests.get(3)!.id,
        issueId: "44444444-4444-4444-8444-444444444444",
      });
      expect(assignedBody.clashes).toHaveLength(3);

      const explicit = await app.request(`${base}/_aps/simulate/clash-group-closed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelSetId,
          clashes: assignedBody.clashes,
          reason: "MINIMAL_OVERLAP",
          title: "Overlap",
        }),
      });
      expect(explicit.status).toBe(200);
      expect(await explicit.json()).toMatchObject({
        reason: "MINIMAL_OVERLAP",
        title: "Overlap",
        clashes: assignedBody.clashes,
      });

      const badReason = await app.request(`${base}/_aps/simulate/clash-group-closed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSetId, clashes: 1, reason: "BECAUSE" }),
      });
      expect(badReason.status).toBe(400);
      expect(((await badReason.json()) as Json).error).toContain("VALID_INTERFACE");

      const unknownClash = await app.request(`${base}/_aps/simulate/clash-group-assigned`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSetId, clashes: [1] }),
      });
      expect(unknownClash.status).toBe(400);

      const all = await getJson(app, `${clashBase}/modelsets/${modelSetId}/clashes/assigned`, headers);
      expect(all.groups).toHaveLength(2);
    });
  });

  describe("model set versions and views", () => {
    it("serves named view subsets per version and single view versions", async () => {
      const views = await getJson(app, `${modelSetBase}/views`, headers);
      expect(views.modelSetViews.map((view: Json) => [view.viewId, view.name])).toEqual([
        [allModelsViewId, "All models"],
        [architectureViewId, "Architecture only"],
      ]);
      expect(views.modelSetViews[1]).toMatchObject({
        isPrivate: false,
        definition: [{ lineageUrn: DEFAULT_WEBHOOK_ITEM_ID, viewableName: "{3D}" }],
        createdBy: expect.any(String),
        createdTime: expect.any(String),
      });

      const versionViews = await getJson(app, `${modelSetBase}/versions/3/views`, headers);
      expect(versionViews.modelSetViewVersions).toHaveLength(2);
      expect(versionViews.modelSetViewVersions[0]).toMatchObject({ viewId: allModelsViewId, modelSetId, version: 3 });
      expect(versionViews.modelSetViewVersions[0].documentVersions).toHaveLength(2);
      expect(versionViews.modelSetViewVersions[1].documentVersions).toHaveLength(1);

      const single = await getJson(app, `${modelSetBase}/versions/3/views/${architectureViewId}`, headers);
      expect(Object.keys(single)).toEqual(["viewId", "modelSetId", "documentVersions", "version"]);
      expect(single.documentVersions).toHaveLength(1);
      expect(single.documentVersions[0]).toMatchObject({
        versionUrn: DEFAULT_WEBHOOK_VERSION_ID,
        stableDocumentId: DEFAULT_WEBHOOK_ITEM_ID,
        documentStatus: "Succeeded",
        bubbleUrn: expect.any(String),
      });
      expect(single.documentVersions[0].alignment.transform).toHaveLength(16);

      const missing = await app.request(`${modelSetBase}/versions/3/views/00000000-0000-4000-8000-000000000000`, {
        headers,
      });
      expect(missing.status).toBe(404);
    });

    it("reports document statuses, Partial and Failed versions, and Failed tests without resources", async () => {
      const id = "32000000-0000-4000-8000-000000000001";
      const setup = createTestApp({
        model_sets: [
          scenarioModelSet(id, {
            clash_scenario: {
              seed: 5,
              versions: [
                { added: 6 },
                { added: 2, document_status: { [DEFAULT_SECOND_DOCUMENT_VERSION_ID]: "Failed" } },
                { added: 4, status: "Failed" },
                { added: 1, resolved: 1 },
              ],
            },
          }),
        ],
      });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const versions = await getJson(
        setup.app,
        `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${id}/versions`,
        token,
      );
      expect(versions.modelSetVersions.map((version: Json) => [version.version, version.status])).toEqual([
        [4, "Successful"],
        [3, "Failed"],
        [2, "Partial"],
        [1, "Successful"],
      ]);
      const partial = await getJson(
        setup.app,
        `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${id}/versions/2`,
        token,
      );
      expect(partial.documentVersions.map((document: Json) => document.documentStatus)).toEqual([
        "Succeeded",
        "Failed",
      ]);

      const tests = await testsByVersion(setup.app, token, id);
      expect(tests.get(3)).toMatchObject({ status: "Failed" });
      const failed = await setup.app.request(`${clashBase}/tests/${tests.get(3)!.id}/resources`, { headers: token });
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ type: "Conflict" });

      // A Partial version clashes only its Succeeded documents; a Failed version does not advance the pool.
      const v2 = await resourcesFor(setup.app, token, tests.get(2)!.id);
      expect(v2.documents).toEqual([{ id: 0, urn: DEFAULT_WEBHOOK_VERSION_ID, viewableName: "{3D}" }]);
      expect(v2.clashes).toEqual([]);
      const v4 = await resourcesFor(setup.app, token, tests.get(4)!.id);
      expect(statusCounts(v4.clashes)).toEqual({ New: 1, Existing: 5, Resolved: 1 });
    });

    it("changes document membership between versions", async () => {
      const id = "33000000-0000-4000-8000-000000000001";
      const setup = createTestApp({
        ...sampleV2Seed,
        model_sets: [
          scenarioModelSet(id, {
            clash_scenario: {
              seed: 9,
              versions: [
                { added: 5 },
                { added: 2, documents_added: [SAMPLE_V2_ID] },
                { added: 3, documents_removed: [DEFAULT_SECOND_DOCUMENT_VERSION_ID] },
              ],
            },
          }),
        ],
      });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const tests = await testsByVersion(setup.app, token, id);
      const v1 = await resourcesFor(setup.app, token, tests.get(1)!.id);
      const v2 = await resourcesFor(setup.app, token, tests.get(2)!.id);
      const v3 = await resourcesFor(setup.app, token, tests.get(3)!.id);

      expect(v1.documents.map((document) => document.urn)).toEqual([
        DEFAULT_WEBHOOK_VERSION_ID,
        DEFAULT_SECOND_DOCUMENT_VERSION_ID,
      ]);
      expect(v2.documents.map((document) => document.urn)).toEqual([SAMPLE_V2_ID, DEFAULT_SECOND_DOCUMENT_VERSION_ID]);
      expect(statusCounts(v2.clashes)).toEqual({ New: 2, Existing: 5 });
      expect(v3.documents.map((document) => document.urn)).toEqual([SAMPLE_V2_ID]);
      expect(v3.clashes).toEqual([]);

      const version2 = await getJson(
        setup.app,
        `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${id}/versions/2`,
        token,
      );
      expect(version2.documentVersions.map((document: Json) => [document.versionUrn, document.revision])).toEqual([
        [SAMPLE_V2_ID, "2"],
        [DEFAULT_SECOND_DOCUMENT_VERSION_ID, "1"],
      ]);
      const view = await getJson(
        setup.app,
        `${base}/bim360/modelset/v3/containers/${containerId}/modelsets/${id}/versions/3/views`,
        token,
      );
      expect(view.modelSetViewVersions[0].documentVersions.map((document: Json) => document.versionUrn)).toEqual([
        SAMPLE_V2_ID,
      ]);
    });

    it("echoes the region header and rejects unknown regions", async () => {
      const echoed = await app.request(`${modelSetBase}/versions/latest`, { headers: { ...headers, region: "EMEA" } });
      expect(echoed.status).toBe(200);
      expect(echoed.headers.get("x-emulate-region")).toBe("EMEA");
      const legacy = await app.request(`${clashBase}/modelsets/${modelSetId}/tests`, {
        headers: { ...headers, "x-ads-region": "us" },
      });
      expect(legacy.status).toBe(200);
      expect(legacy.headers.get("x-emulate-region")).toBe("US");
      const plain = await app.request(`${clashBase}/modelsets/${modelSetId}/tests`, { headers });
      expect(plain.headers.get("x-emulate-region")).toBeNull();
      const invalid = await app.request(`${clashBase}/modelsets/${modelSetId}/tests`, {
        headers: { ...headers, region: "APAC" },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ type: "BadInput", errors: [{ field: "region" }] });
    });
  });

  describe("simulated versions", () => {
    it("simulates Pending to Processing to Success and applies a scenario step", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      const setup = createTestApp();
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const response = await setup.app.request(`${base}/_aps/simulate/modelset-version-added`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSetId, processingMs: 10, added: 7, resolved: 2 }),
      });
      expect(response.status).toBe(200);
      const created = (await response.json()) as Json;
      expect(created.modelSetVersion).toMatchObject({ version: 4, status: "Pending" });
      expect(created.clashTest).toMatchObject({ modelSetVersion: 4, status: "Pending" });

      const aps = getApsStore(setup.store);
      expect(aps.clashTests.findBy("model_set_id", modelSetId)).toHaveLength(4);
      expect(aps.modelSetVersions.findBy("model_set_id", modelSetId)).toHaveLength(4);
      expect(aps.modelSetViews.findBy("model_set_id", modelSetId).filter((view) => view.version === 4)).toHaveLength(2);
      const pending = await setup.app.request(`${clashBase}/tests/${created.clashTest.id}/resources`, {
        headers: token,
      });
      expect(pending.status).toBe(409);

      await vi.advanceTimersByTimeAsync(10);
      expect(aps.clashTests.findOneBy("test_id", created.clashTest.id)?.status).toBe("Processing");
      expect(
        aps.modelSetVersions.findBy("model_set_id", modelSetId).find((version) => version.version === 4)?.status,
      ).toBe("Processing");

      await vi.advanceTimersByTimeAsync(10);
      expect(aps.clashTests.findOneBy("test_id", created.clashTest.id)?.status).toBe("Success");
      const v4 = await resourcesFor(setup.app, token, created.clashTest.id);
      expect(statusCounts(v4.clashes)).toEqual({ New: 7, Existing: 31, Resolved: 2 });
      const latest = await getJson(setup.app, `${modelSetBase}/versions/latest`, token);
      expect(latest).toMatchObject({ version: 4, status: "Successful" });
    });

    it("clones the previous membership when no step is given and can fail a version", async () => {
      const setup = createTestApp();
      const failed = await setup.app.request(`${base}/_aps/simulate/modelset-version-added`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSetId, processingMs: 0, status: "Failed" }),
      });
      expect(failed.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const aps = getApsStore(setup.store);
      expect(
        aps.clashTests.findBy("model_set_id", modelSetId).find((test) => test.model_set_version === 4)?.status,
      ).toBe("Failed");
      const bad = await setup.app.request(`${base}/_aps/simulate/modelset-version-added`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelSetId, documents_removed: ["urn:nope"] }),
      });
      expect(bad.status).toBe(400);
    });
  });

  describe("faults", () => {
    it("rate limits per user with a sliding window and Retry-After", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
      const setup = createTestApp({
        users: [{ email: "second@autodesk.local", name: "Second User" }],
        model_coordination_faults: { rate_limit_per_minute: 2 },
      });
      const aps = getApsStore(setup.store);
      const first = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const second = bearer(
        await issueThreeLeggedToken(
          setup.app,
          setup.store,
          "data:read",
          aps.users.findOneBy("email", "second@autodesk.local")!.user_id,
        ),
      );
      const url = `${clashBase}/modelsets/${modelSetId}/tests`;
      expect((await setup.app.request(url, { headers: first })).status).toBe(200);
      expect((await setup.app.request(`${modelSetBase}/versions/latest`, { headers: first })).status).toBe(200);
      const limited = await setup.app.request(url, { headers: first });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("content-type")).toContain("application/problem+json");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({ type: "TooManyRequests" });
      expect((await setup.app.request(url, { headers: second })).status).toBe(200);

      vi.setSystemTime(new Date("2026-08-21T12:01:00.500Z"));
      expect((await setup.app.request(url, { headers: first })).status).toBe(200);
    });

    it("returns the entitlement 403 for projects without Model Coordination", async () => {
      const setup = createTestApp({ model_coordination_faults: { entitlement: { [DEFAULT_PROJECT_ID]: false } } });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      for (const url of [`${modelSetBase}/versions/latest`, `${clashBase}/modelsets/${modelSetId}/tests`]) {
        const response = await setup.app.request(url, { headers: token });
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expect(await response.json()).toMatchObject({
          type: "Forbidden",
          title: "Model Coordination is not enabled for this project",
        });
      }
      const other = await setup.app.request(`${base}/bim360/modelset/v3/containers/emulate-infrastructure/modelsets`, {
        headers: token,
      });
      expect(other.status).toBe(200);

      const global = createTestApp({ model_coordination_faults: { entitlement: false } });
      const globalToken = bearer(await issueThreeLeggedToken(global.app, global.store));
      expect(
        (
          await global.app.request(`${base}/bim360/modelset/v3/containers/emulate-infrastructure/modelsets`, {
            headers: globalToken,
          })
        ).status,
      ).toBe(403);
    });

    it("serves sqlite resources as empty files for a configured test", async () => {
      const testId = "16161616-1616-4161-8161-161616161616";
      const setup = createTestApp({ model_coordination_faults: { resources_extension: { [testId]: "sqlite" } } });
      const token = bearer(await issueThreeLeggedToken(setup.app, setup.store));
      const resources = await getJson(setup.app, `${clashBase}/tests/${testId}/resources`, token);
      expect(resources.resources.every((resource: Json) => resource.extension === "sqlite")).toBe(true);
      const download = await setup.app.request(resources.resources[0].url);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain("scope-version-clash.2.0.0.sqlite");
      expect((await download.arrayBuffer()).byteLength).toBe(0);

      const tests = await testsByVersion(setup.app, token);
      const other = await getJson(setup.app, `${clashBase}/tests/${tests.get(2)!.id}/resources`, token);
      expect(other.resources[0].extension).toBe("json.gz");
    });
  });
});
