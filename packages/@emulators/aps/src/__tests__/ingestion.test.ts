import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEBHOOK_CHILD_FOLDER_ID } from "../helpers.js";
import { getApsStore } from "../store.js";
import { bearer, base, createTestApp, issueThreeLeggedToken } from "./test-helpers.js";

const openServers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function callbackServer() {
  const received: Array<Record<string, any>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>);
      response.statusCode = 204;
      response.end();
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Callback server did not bind to a port");
  return { url: `http://127.0.0.1:${address.port}/callback`, received };
}

async function createStorage(app: Hono, token: string, name: string) {
  const response = await app.request(`${base}/data/v1/projects/b.emulate-project/storage`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      jsonapi: { version: "1.0" },
      data: {
        type: "objects",
        attributes: { name },
        relationships: { target: { data: { type: "folders", id: DEFAULT_WEBHOOK_CHILD_FOLDER_ID } } },
      },
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, any>;
  const objectId = body.data.id as string;
  const match = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(objectId);
  if (!match) throw new Error("Storage response did not contain an OSS object ID");
  return { objectId, bucketKey: match[1]!, objectKey: match[2]! };
}

async function uploadObject(
  app: Hono,
  token: string,
  storage: Awaited<ReturnType<typeof createStorage>>,
  parts: Uint8Array[],
) {
  const objectPath = `${base}/oss/v2/buckets/${encodeURIComponent(storage.bucketKey)}/objects/${encodeURIComponent(storage.objectKey)}/signeds3upload`;
  const signed = await app.request(`${objectPath}?parts=${parts.length}`, { headers: bearer(token) });
  expect(signed.status).toBe(200);
  const signedBody = (await signed.json()) as Record<string, any>;
  expect(signedBody.urls).toHaveLength(parts.length);
  for (const [index, bytes] of parts.entries()) {
    const put = await app.request(signedBody.urls[index], { method: "PUT", body: bytes });
    expect(put.status).toBe(200);
  }
  const complete = await app.request(objectPath, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ uploadKey: signedBody.uploadKey }),
  });
  expect(complete.status).toBe(200);
  return (await complete.json()) as Record<string, any>;
}

async function createItem(app: Hono, token: string, objectId: string, name: string) {
  const response = await app.request(`${base}/data/v1/projects/b.emulate-project/items`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      jsonapi: { version: "1.0" },
      data: {
        type: "items",
        attributes: { displayName: name },
        relationships: { parent: { data: { type: "folders", id: DEFAULT_WEBHOOK_CHILD_FOLDER_ID } } },
      },
      included: [
        {
          type: "versions",
          id: "1",
          attributes: { name },
          relationships: { storage: { data: { type: "objects", id: objectId } } },
        },
      ],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, any>;
}

describe("APS ingestion routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("uploads multipart bytes, creates an item, updates the DM tree, translates it, and emits both webhooks", async () => {
    const callback = await callbackServer();
    const setup = createTestApp({
      webhook_timing: { max_retries: 0, delivery_timeout_ms: 500 },
      webhooks: [
        {
          system: "data",
          event: "dm.version.added",
          callback_url: callback.url,
          scope: { folder: DEFAULT_WEBHOOK_CHILD_FOLDER_ID },
        },
        {
          system: "derivative",
          event: "extraction.finished",
          callback_url: callback.url,
          scope: { workflow: "emulate-translation" },
        },
      ],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store, "data:read data:create data:write");
    const storage = await createStorage(setup.app, token, "uploaded-model.rvt");
    const first = new TextEncoder().encode("first-");
    const second = new TextEncoder().encode("second");
    const completed = await uploadObject(setup.app, token, storage, [first, second]);
    const bytes = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
    expect(completed).toMatchObject({
      objectId: storage.objectId,
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
    });

    const itemDocument = await createItem(setup.app, token, storage.objectId, "uploaded-model.rvt");
    const itemId = itemDocument.data.id as string;
    const version = itemDocument.included[0] as Record<string, any>;
    const urn = version.relationships.derivatives.data.id as string;
    expect(version.attributes).toMatchObject({ versionNumber: 1, storageSize: bytes.length });

    const contents = await setup.app.request(
      `${base}/data/v1/projects/b.emulate-project/folders/${encodeURIComponent(DEFAULT_WEBHOOK_CHILD_FOLDER_ID)}/contents`,
      { headers: bearer(token) },
    );
    expect(contents.status).toBe(200);
    const contentsBody = (await contents.json()) as Record<string, any>;
    expect(contentsBody.data.some((entry: Record<string, any>) => entry.id === itemId)).toBe(true);
    expect(contentsBody.included.some((entry: Record<string, any>) => entry.id === version.id)).toBe(true);

    const pending = await setup.app.request(
      `${base}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`,
      { headers: bearer(token) },
    );
    expect(pending.status).toBe(200);
    expect((await pending.json()) as Record<string, unknown>).toMatchObject({
      status: "pending",
      progress: "0% complete",
    });

    const simulated = await setup.app.request(`${base}/_aps/simulate/translation-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urn }),
    });
    expect(simulated.status).toBe(200);
    expect((await simulated.json()) as Record<string, unknown>).toMatchObject({
      status: "success",
      progress: "complete",
    });

    const success = await setup.app.request(
      `${base}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`,
      { headers: bearer(token) },
    );
    expect((await success.json()) as Record<string, any>).toMatchObject({
      status: "success",
      derivatives: [{ outputType: "svf2", status: "success" }],
    });
    expect(callback.received).toHaveLength(2);
    expect(callback.received.map((event) => event.hook.event)).toEqual(["dm.version.added", "extraction.finished"]);
  });

  it("creates the next version and updates the item tip", async () => {
    const token = await issueThreeLeggedToken(app, store, "data:read data:create data:write");
    const firstStorage = await createStorage(app, token, "revision.rvt");
    await uploadObject(app, token, firstStorage, [new TextEncoder().encode("v1")]);
    const itemDocument = await createItem(app, token, firstStorage.objectId, "revision.rvt");
    const itemId = itemDocument.data.id as string;

    const secondStorage = await createStorage(app, token, "revision.rvt");
    await uploadObject(app, token, secondStorage, [new TextEncoder().encode("v2")]);
    const created = await app.request(`${base}/data/v1/projects/b.emulate-project/versions`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: {
          type: "versions",
          attributes: { name: "revision.rvt" },
          relationships: {
            item: { data: { type: "items", id: itemId } },
            storage: { data: { type: "objects", id: secondStorage.objectId } },
          },
        },
      }),
    });
    expect(created.status).toBe(201);
    const version = (await created.json()) as Record<string, any>;
    expect(version.data.attributes.versionNumber).toBe(2);

    const tip = await app.request(
      `${base}/data/v1/projects/b.emulate-project/items/${encodeURIComponent(itemId)}/tip`,
      { headers: bearer(token) },
    );
    expect((await tip.json()) as Record<string, any>).toMatchObject({ data: { id: version.data.id } });
  });

  it("enforces the object cap, signed URL expiry, and upload key ownership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    const setup = createTestApp({ upload: { maxObjectBytes: 3 } });
    const token = await issueThreeLeggedToken(setup.app, setup.store, "data:create data:write");
    const storage = await createStorage(setup.app, token, "small.rvt");
    const path = `${base}/oss/v2/buckets/${encodeURIComponent(storage.bucketKey)}/objects/${encodeURIComponent(storage.objectKey)}/signeds3upload`;
    const signed = await setup.app.request(`${path}?minutesExpiration=1`, { headers: bearer(token) });
    const issued = (await signed.json()) as Record<string, any>;
    const tooLarge = await setup.app.request(issued.urls[0], {
      method: "PUT",
      body: new TextEncoder().encode("four"),
    });
    expect(tooLarge.status).toBe(413);

    const wrongKey = await setup.app.request(path, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ uploadKey: randomKey() }),
    });
    expect(wrongKey.status).toBe(400);

    vi.setSystemTime(new Date("2026-08-22T12:01:01Z"));
    const expired = await setup.app.request(issued.urls[0], {
      method: "PUT",
      body: new TextEncoder().encode("ok"),
    });
    expect(expired.status).toBe(403);
  });

  it("fails deny-listed zip translations and resets a successful job when forced", async () => {
    const setup = createTestApp({ translation: { durationMs: 0, failForExtensions: ["zip"] } });
    const token = await issueThreeLeggedToken(setup.app, setup.store, "data:read data:create data:write");
    const zipStorage = await createStorage(setup.app, token, "archive.zip");
    await uploadObject(setup.app, token, zipStorage, [new TextEncoder().encode("zip")]);
    const zipItem = await createItem(setup.app, token, zipStorage.objectId, "archive.zip");
    const zipUrn = zipItem.included[0].relationships.derivatives.data.id as string;
    const failed = await setup.app.request(
      `${base}/modelderivative/v2/designdata/${encodeURIComponent(zipUrn)}/manifest`,
      { headers: bearer(token) },
    );
    const failedBody = (await failed.json()) as Record<string, any>;
    expect(failedBody.status).toBe("failed");
    expect(failedBody.derivatives[0].messages[0]).toMatchObject({ code: "TranslationFailed" });

    const rvtStorage = await createStorage(setup.app, token, "force.rvt");
    await uploadObject(setup.app, token, rvtStorage, [new TextEncoder().encode("rvt")]);
    const rvtItem = await createItem(setup.app, token, rvtStorage.objectId, "force.rvt");
    const urn = rvtItem.included[0].relationships.derivatives.data.id as string;
    await setup.app.request(`${base}/_aps/simulate/translation-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urn }),
    });
    const forced = await setup.app.request(`${base}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json", "x-ads-force": "true" },
      body: JSON.stringify({ input: { urn }, output: { formats: [{ type: "svf2", views: ["2d", "3d"] }] } }),
    });
    expect(forced.status).toBe(200);
    expect(getApsStore(setup.store).translationJobs.findOneBy("urn", urn)).toMatchObject({
      status: "pending",
      force_count: 1,
      webhook_emitted: false,
    });
  });

  it("advances jobs lazily and rejects unsupported job inputs and outputs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    const setup = createTestApp({ translation: { durationMs: 1000 } });
    const token = await issueThreeLeggedToken(setup.app, setup.store, "data:read data:create data:write");
    const storage = await createStorage(setup.app, token, "clock.model.rvt");
    await uploadObject(setup.app, token, storage, [new TextEncoder().encode("clock")]);
    const item = await createItem(setup.app, token, storage.objectId, "clock.model.rvt");
    const urn = item.included[0].relationships.derivatives.data.id as string;
    const manifestUrl = `${base}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`;
    const explicit = await setup.app.request(`${base}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { urn },
        output: { formats: [{ type: "svf2", views: ["3d"] }, { type: "thumbnail" }] },
      }),
    });
    expect(explicit.status).toBe(201);
    expect((await explicit.json()) as Record<string, unknown>).toMatchObject({ result: "created", urn });

    vi.setSystemTime(new Date("2026-08-22T12:00:00.200Z"));
    const active = (await (await setup.app.request(manifestUrl, { headers: bearer(token) })).json()) as Record<
      string,
      unknown
    >;
    expect(active).toMatchObject({ status: "inprogress", progress: "25% complete" });
    expect((active.derivatives as Array<Record<string, unknown>>).map((derivative) => derivative.outputType)).toEqual([
      "svf2",
      "thumbnail",
    ]);

    vi.setSystemTime(new Date("2026-08-22T12:00:01Z"));
    const complete = (await (await setup.app.request(manifestUrl, { headers: bearer(token) })).json()) as Record<
      string,
      unknown
    >;
    expect(complete).toMatchObject({ status: "success", progress: "complete" });

    const badOutput = await setup.app.request(`${base}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ input: { urn }, output: { formats: [{ type: "obj" }] } }),
    });
    expect(badOutput.status).toBe(400);

    const textStorage = await createStorage(setup.app, token, "notes.txt");
    await uploadObject(setup.app, token, textStorage, [new TextEncoder().encode("text")]);
    const textUrn = Buffer.from(textStorage.objectId).toString("base64url");
    const badInput = await setup.app.request(`${base}/modelderivative/v2/designdata/job`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ input: { urn: textUrn }, output: { formats: [{ type: "svf2", views: ["3d"] }] } }),
    });
    expect(badInput.status).toBe(400);
  });

  it("rejects read-only tokens on every bearer-authenticated write surface", async () => {
    const writeToken = await issueThreeLeggedToken(app, store, "data:create data:write");
    const readToken = await issueThreeLeggedToken(app, store, "data:read");
    const storage = await createStorage(app, writeToken, "scopes.rvt");
    const objectPath = `${base}/oss/v2/buckets/${encodeURIComponent(storage.bucketKey)}/objects/${encodeURIComponent(storage.objectKey)}/signeds3upload`;
    const signed = await app.request(objectPath, { headers: bearer(writeToken) });
    const upload = (await signed.json()) as Record<string, any>;

    const requests = [
      app.request(`${base}/data/v1/projects/b.emulate-project/storage`, { method: "POST", headers: bearer(readToken) }),
      app.request(objectPath, { headers: bearer(readToken) }),
      app.request(objectPath, { method: "POST", headers: bearer(readToken) }),
      app.request(`${base}/data/v1/projects/b.emulate-project/items`, { method: "POST", headers: bearer(readToken) }),
      app.request(`${base}/data/v1/projects/b.emulate-project/versions`, {
        method: "POST",
        headers: bearer(readToken),
      }),
      app.request(`${base}/modelderivative/v2/designdata/job`, { method: "POST", headers: bearer(readToken) }),
    ];
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);

    const signedPut = await app.request(upload.urls[0], {
      method: "PUT",
      body: new TextEncoder().encode("signed-only"),
    });
    expect(signedPut.status).toBe(200);
  });
});

function randomKey(): string {
  return "00000000-0000-4000-8000-000000000000";
}
