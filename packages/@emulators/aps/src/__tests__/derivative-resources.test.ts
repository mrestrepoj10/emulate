import type { Hono, Store } from "@emulators/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MANIFEST_URN } from "../helpers.js";
import { createItem, createStorage, uploadObject } from "./ingestion-helpers.js";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

afterEach(() => vi.useRealTimers());

async function uploadModel(app: Hono, store: Store, name: string, content = "model bytes") {
  const token = await issueThreeLeggedToken(app, store, "data:read data:create data:write");
  const storage = await createStorage(app, token, name);
  await uploadObject(app, token, storage, [new TextEncoder().encode(content)]);
  const item = await createItem(app, token, storage.objectId, name);
  return {
    token,
    storage,
    urn: item.included[0].relationships.derivatives.data.id as string,
  };
}

function derivativePath(urn: string, suffix: string): string {
  return `${base}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/${suffix}`;
}

describe("APS derivative read resources", () => {
  it("serves a placeholder thumbnail only after translation completes", async () => {
    const setup = createTestApp({ translation: { durationMs: 60_000 } });
    const model = await uploadModel(setup.app, setup.store, "thumbnail.rvt");
    const headers = bearer(model.token);

    const pending = await setup.app.request(derivativePath(model.urn, "thumbnail?width=400&height=400"), { headers });
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("1");

    await setup.app.request(`${base}/_aps/simulate/translation-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urn: model.urn }),
    });
    const thumbnail = await setup.app.request(derivativePath(model.urn, "thumbnail"), { headers });
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await thumbnail.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const missing = await setup.app.request(derivativePath("dXJuOmVtdWxhdGU6bWlzc2luZw", "thumbnail"), { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ type: "NotFound", title: "The requested resource was not found" });
  });

  it("returns stable views, an object tree, and narrowable properties", async () => {
    const setup = createTestApp({ translation: { durationMs: 60_000 } });
    const model = await uploadModel(setup.app, setup.store, "metadata.rvt");
    const headers = bearer(model.token);
    const metadataUrl = derivativePath(model.urn, "metadata");
    expect((await setup.app.request(metadataUrl, { headers })).status).toBe(202);

    await setup.app.request(`${base}/_aps/simulate/translation-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urn: model.urn }),
    });
    const first = (await (await setup.app.request(metadataUrl, { headers })).json()) as Record<string, any>;
    const second = (await (await setup.app.request(metadataUrl, { headers })).json()) as Record<string, any>;
    expect(first.data.metadata).toEqual(second.data.metadata);
    expect(first.data.metadata).toMatchObject([{ name: "metadata.rvt", role: "3d" }]);
    const guid = first.data.metadata[0].guid as string;

    const treeResponse = await setup.app.request(derivativePath(model.urn, `metadata/${guid}`), { headers });
    expect(treeResponse.status).toBe(200);
    const tree = (await treeResponse.json()) as Record<string, any>;
    expect(tree.data).toMatchObject({ type: "objects", objects: [{ name: "metadata.rvt" }] });
    const objectId = tree.data.objects[0].objects[0].objects[0].objects[0].objectid as number;

    const propertiesResponse = await setup.app.request(
      derivativePath(model.urn, `metadata/${guid}/properties?objectid=${objectId}`),
      { headers },
    );
    expect(propertiesResponse.status).toBe(200);
    const properties = (await propertiesResponse.json()) as Record<string, any>;
    expect(properties.data.collection).toHaveLength(1);
    expect(properties.data.collection[0]).toMatchObject({
      objectid: objectId,
      properties: { "Identity Data": { Category: "Instance" } },
    });

    const unknownView = await setup.app.request(derivativePath(model.urn, "metadata/unknown"), { headers });
    expect(unknownView.status).toBe(404);
  });

  it("adds one deterministic 2D view for a sheet-bearing seeded source", async () => {
    const setup = createTestApp({
      sheets: [
        {
          id: "abababab-abab-4bab-8bab-abababababab",
          project_id: "b.emulate-project",
          number: "M-101",
          title: "Model Sheet",
          version_set_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          upload_file_name: "sample.rvt",
          viewable_guid: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        },
      ],
    });
    const token = await issueTwoLeggedToken(setup.app);
    const response = await setup.app.request(derivativePath(DEFAULT_MANIFEST_URN, "metadata"), {
      headers: bearer(token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.data.metadata.map((view: Record<string, unknown>) => view.role)).toEqual(["3d", "2d"]);
    expect(body.data.metadata[1]).toMatchObject({
      name: "M-101 - Model Sheet",
      guid: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    });
  });

  it("deletes a manifest idempotently and allows a new job to restore it", async () => {
    const setup = createTestApp();
    const model = await uploadModel(setup.app, setup.store, "delete.rvt");
    const headers = bearer(model.token);
    await setup.app.request(`${base}/_aps/simulate/translation-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urn: model.urn }),
    });
    const manifestUrl = derivativePath(model.urn, "manifest");

    const readOnly = await issueTwoLeggedToken(setup.app, "data:read");
    expect((await setup.app.request(manifestUrl, { method: "DELETE", headers: bearer(readOnly) })).status).toBe(403);
    const deleted = await setup.app.request(manifestUrl, { method: "DELETE", headers });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ result: "success" });
    expect((await setup.app.request(manifestUrl, { headers })).status).toBe(404);
    expect((await setup.app.request(manifestUrl, { method: "DELETE", headers })).status).toBe(200);

    const restored = await setup.app.request(`${base}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { urn: model.urn },
        output: { formats: [{ type: "svf2", views: ["3d"] }] },
      }),
    });
    expect(restored.status).toBe(201);
    expect((await setup.app.request(manifestUrl, { headers })).status).toBe(200);
  });
});

describe("APS signed S3 downloads", () => {
  it("round-trips uploaded bytes and rejects invalid or expired signatures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00Z"));
    const setup = createTestApp();
    const writeToken = await issueThreeLeggedToken(setup.app, setup.store, "data:create data:write");
    const readToken = await issueTwoLeggedToken(setup.app, "data:read");
    const storage = await createStorage(setup.app, writeToken, "download.rvt");
    const expected = new TextEncoder().encode("download round trip");
    await uploadObject(setup.app, writeToken, storage, [expected]);
    const objectPath = `${base}/oss/v2/buckets/${encodeURIComponent(storage.bucketKey)}/objects/${encodeURIComponent(storage.objectKey)}/signeds3download`;

    const issued = await setup.app.request(`${objectPath}?minutesExpiration=1`, {
      method: "POST",
      headers: bearer(readToken),
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as Record<string, any>;
    expect(body).toMatchObject({ size: expected.length });
    const downloaded = await setup.app.request(body.url);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-length")).toBe(String(expected.length));
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(expected);

    const invalidUrl = new URL(body.url);
    invalidUrl.searchParams.set("signature", "invalid");
    expect((await setup.app.request(invalidUrl.toString())).status).toBe(403);
    vi.setSystemTime(new Date("2026-08-23T12:01:01Z"));
    expect((await setup.app.request(body.url)).status).toBe(403);

    const missing = await setup.app.request(`${base}/oss/v2/buckets/missing/objects/missing/signeds3download`, {
      method: "POST",
      headers: bearer(readToken),
    });
    expect(missing.status).toBe(404);
  });
});
