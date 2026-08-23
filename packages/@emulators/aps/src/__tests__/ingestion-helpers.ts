import type { Hono } from "@emulators/core";
import { expect } from "vitest";
import { DEFAULT_WEBHOOK_CHILD_FOLDER_ID } from "../helpers.js";
import { bearer, base } from "./test-helpers.js";

export async function createStorage(app: Hono, token: string, name: string) {
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

export async function uploadObject(
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

export async function createItem(app: Hono, token: string, objectId: string, name: string) {
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
