import { createHash, randomUUID } from "node:crypto";
import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { accessTokenForRequest, apsAuth } from "../auth.js";
import { createDocumentItem, createDocumentVersion, documentFileType, documentMimeType, itemTip } from "../dm-tree.js";
import { emitDocumentVersionAdded } from "../dm-events.js";
import type { ApsDocumentItem, ApsDocumentVersion, ApsStorageObject } from "../entities.js";
import { DEFAULT_USER_EMAIL, isRecordObject, jsonObjectBody, optionalString } from "../helpers.js";
import { getTranslationConfig, getUploadConfig } from "../ingestion-config.js";
import { badInput, forbidden, notFound, payloadTooLarge } from "../problem.js";
import { issueSignedResourceUrl, validateSignedResource } from "../signed-blobs.js";
import { getApsStore, type ApsStore } from "../store.js";
import { enqueueTranslation } from "../translation.js";
import { documentItemData, documentVersionData } from "./data-management.js";

const JSON_API_TYPE = "application/vnd.api+json";
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SIGNED_URL_TTL_MINUTES = 2;
const MAX_UPLOAD_PARTS = 100;

function decodeRouteValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecordObject(value) ? value : null;
}

function relationshipId(resource: Record<string, unknown>, name: string): string | undefined {
  const relationships = record(resource.relationships);
  const relationship = relationships ? record(relationships[name]) : null;
  const data = relationship ? record(relationship.data) : null;
  return data ? optionalString(data.id) : undefined;
}

function attributes(resource: Record<string, unknown>): Record<string, unknown> {
  return record(resource.attributes) ?? {};
}

function jsonApiError(c: Context<AppEnv>, status: 400 | 404 | 409, code: string, detail: string): Response {
  c.header("Content-Type", JSON_API_TYPE);
  return c.json(
    { jsonapi: { version: "1.0" }, errors: [{ id: randomUUID(), status: String(status), code, detail }] },
    status,
  );
}

function jsonApiCreated(c: Context<AppEnv>, self: string, data: unknown, included?: unknown[]): Response {
  c.header("Content-Type", JSON_API_TYPE);
  return c.json(
    {
      jsonapi: { version: "1.0" },
      links: { self: { href: self } },
      data,
      ...(included ? { included } : {}),
    },
    201,
  );
}

function storageForId(aps: ApsStore, objectId: string): ApsStorageObject | undefined {
  return aps.storageObjects.findOneBy("object_id", objectId);
}

function finalizedStorageForProject(
  aps: ApsStore,
  projectId: string,
  objectId: string | undefined,
): ApsStorageObject | undefined {
  if (!objectId) return undefined;
  const storage = storageForId(aps, objectId);
  return storage?.project_id === projectId && storage.uploaded_at && storage.content_base64 !== null
    ? storage
    : undefined;
}

async function actorForRequest(c: Context<AppEnv>, store: RouteContext["store"], aps: ApsStore) {
  const token = await accessTokenForRequest(c, store);
  const user = token?.apsUserId ? aps.users.findOneBy("user_id", token.apsUserId) : undefined;
  return { id: user?.user_id ?? DEFAULT_USER_EMAIL, name: user?.name ?? "Test User" };
}

function itemVersionId(itemId: string, versionNumber: number): string {
  const lineage = itemId.split(":").at(-1) ?? randomUUID();
  return `urn:adsk.wipprod:fs.file:vf.${lineage}?version=${versionNumber}`;
}

function versionValues(
  item: ApsDocumentItem,
  storage: ApsStorageObject,
  versionNumber: number,
  actor: { id: string; name: string },
  displayName: string,
): Omit<ApsDocumentVersion, "id" | "created_at" | "updated_at"> {
  const now = new Date().toISOString();
  const extension = documentFileType(displayName);
  return {
    version_id: itemVersionId(item.item_id, versionNumber),
    item_id: item.item_id,
    project_id: item.project_id,
    version_number: versionNumber,
    display_name: displayName,
    file_type: extension,
    mime_type: documentMimeType(extension),
    storage_size: storage.size,
    storage_urn: storage.object_id,
    region: "US",
    bubble_urn: Buffer.from(storage.object_id).toString("base64url"),
    viewable_id: "emulate-3d-view",
    viewable_guid: "d8e734a8-6e9e-4f4d-9a4f-000000000001",
    created_by: actor.id,
    created_by_name: actor.name,
    create_time: now,
    last_modified_by: actor.id,
    last_modified_by_name: actor.name,
    last_modified_time: now,
  };
}

async function finishVersionWrite(
  aps: ApsStore,
  store: RouteContext["store"],
  version: ApsDocumentVersion,
): Promise<void> {
  if (version.bubble_urn && getTranslationConfig(store).autoTranslateOnVersionAdd) {
    enqueueTranslation(aps, store, {
      urn: version.bubble_urn,
      sourceName: version.display_name,
      region: version.region,
    });
  }
  await emitDocumentVersionAdded(aps, store, version);
}

export function ingestionRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  const writeAuth = apsAuth(store, { scopes: ["data:create", "data:write"] });
  const userWriteAuth = apsAuth(store, { scopes: ["data:create", "data:write"], requireUser: true });

  app.use("/data/v1/*", (c, next) => (c.req.method === "POST" ? userWriteAuth(c, next) : next()));
  app.use("/oss/v2/buckets/*", writeAuth);

  app.post("/data/v1/projects/:projectId/storage", async (c) => {
    const projectId = decodeRouteValue(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? record(body.data) : null;
    const name = data ? optionalString(attributes(data).name) : undefined;
    const folderId = data ? relationshipId(data, "target") : undefined;
    const folder = folderId ? aps.documentFolders.findOneBy("folder_id", folderId) : undefined;
    if (!data || data.type !== "objects" || !name || !folderId) {
      return jsonApiError(c, 400, "BAD_INPUT", "An objects resource with a name and target folder is required.");
    }
    if (!folder || folder.project_id !== projectId) {
      return jsonApiError(c, 404, "NOT_FOUND", "The target folder was not found in this project.");
    }
    const bucketKey = `wip.dm.emulate-${createHash("sha1").update(projectId).digest("hex").slice(0, 16)}`;
    const safeName = name.replace(/[\\/]/g, "_");
    const objectKey = `${randomUUID()}-${safeName}`;
    const objectId = `urn:adsk.objects:os.object:${bucketKey}/${objectKey}`;
    aps.storageObjects.insert({
      object_id: objectId,
      bucket_key: bucketKey,
      object_key: objectKey,
      project_id: projectId,
      folder_id: folderId,
      name,
      size: 0,
      sha1: "",
      content_base64: null,
      uploaded_at: null,
    });
    const self = `${baseUrl}/data/v1/projects/${encodeURIComponent(projectId)}/storage`;
    return jsonApiCreated(c, self, {
      type: "objects",
      id: objectId,
      attributes: { name },
      relationships: { target: { data: { type: "folders", id: folderId } } },
    });
  });

  app.get("/oss/v2/buckets/:bucketKey/objects/:objectKey/signeds3upload", (c) => {
    const bucketKey = decodeRouteValue(c.req.param("bucketKey"));
    const objectKey = decodeRouteValue(c.req.param("objectKey"));
    const storage = aps.storageObjects
      .findBy("bucket_key", bucketKey)
      .find((candidate) => candidate.object_key === objectKey);
    if (!storage) return notFound(c, "The requested storage object");
    const partsValue = c.req.query("parts") ?? "1";
    const minutesValue = c.req.query("minutesExpiration") ?? String(DEFAULT_SIGNED_URL_TTL_MINUTES);
    if (!/^\d+$/.test(partsValue) || Number(partsValue) < 1 || Number(partsValue) > MAX_UPLOAD_PARTS) {
      return badInput(c, "parts", `parts must be an integer from 1 through ${MAX_UPLOAD_PARTS}.`);
    }
    if (!/^\d+$/.test(minutesValue) || Number(minutesValue) < 1 || Number(minutesValue) > 60) {
      return badInput(c, "minutesExpiration", "minutesExpiration must be an integer from 1 through 60.");
    }
    const expectedParts = Number(partsValue);
    const uploadKey = randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
    const ttlMs = Number(minutesValue) * 60_000;
    aps.uploadSessions.insert({
      upload_key: uploadKey,
      object_key: objectKey,
      bucket_key: bucketKey,
      parts_base64: Array.from({ length: expectedParts }, () => null),
      expected_parts: expectedParts,
      expires_at: expiresAt,
    });
    const urls = Array.from({ length: expectedParts }, (_, index) => {
      const part = index + 1;
      return issueSignedResourceUrl(
        store,
        baseUrl,
        `/oss/v2/signed-upload/${encodeURIComponent(uploadKey)}/${part}`,
        `aps-upload:${uploadKey}:${part}`,
        ttlMs,
      ).url;
    });
    return c.json({
      uploadKey,
      urls,
      urlExpiration: new Date(Date.now() + ttlMs).toISOString(),
      uploadExpiration: expiresAt,
    });
  });

  app.put("/oss/v2/signed-upload/:uploadKey/:part", async (c) => {
    const uploadKey = c.req.param("uploadKey");
    const part = Number(c.req.param("part"));
    if (
      !validateSignedResource(store, `aps-upload:${uploadKey}:${part}`, {
        expires: c.req.query("expires"),
        nonce: c.req.query("nonce"),
        signature: c.req.query("signature"),
      })
    ) {
      return forbidden(c, "The signed upload URL is invalid or has expired.");
    }
    const session = aps.uploadSessions.findOneBy("upload_key", uploadKey);
    if (!session || Date.parse(session.expires_at) <= Date.now()) {
      return forbidden(c, "The upload session is invalid or has expired.");
    }
    if (!Number.isInteger(part) || part < 1 || part > session.expected_parts) {
      return badInput(c, "part", "The part number is outside the issued upload range.");
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    const existingSize = session.parts_base64.reduce(
      (total, value, index) => total + (index === part - 1 || !value ? 0 : Buffer.byteLength(value, "base64")),
      0,
    );
    if (existingSize + bytes.length > getUploadConfig(store).maxObjectBytes) {
      return payloadTooLarge(c, `The uploaded object exceeds the ${getUploadConfig(store).maxObjectBytes} byte limit.`);
    }
    const parts = [...session.parts_base64];
    parts[part - 1] = bytes.toString("base64");
    aps.uploadSessions.update(session.id, { parts_base64: parts });
    return c.body(null, 200, { ETag: createHash("sha1").update(bytes).digest("hex") });
  });

  app.post("/oss/v2/buckets/:bucketKey/objects/:objectKey/signeds3upload", async (c) => {
    const bucketKey = decodeRouteValue(c.req.param("bucketKey"));
    const objectKey = decodeRouteValue(c.req.param("objectKey"));
    const body = await jsonObjectBody(c);
    const uploadKey = body ? optionalString(body.uploadKey) : undefined;
    if (!uploadKey) return badInput(c, "uploadKey", "uploadKey is required.");
    const session = aps.uploadSessions.findOneBy("upload_key", uploadKey);
    if (!session || session.bucket_key !== bucketKey || session.object_key !== objectKey) {
      return badInput(c, "uploadKey", "uploadKey does not belong to this object.");
    }
    if (Date.parse(session.expires_at) <= Date.now()) return forbidden(c, "The upload session has expired.");
    if (session.parts_base64.some((part) => part === null)) {
      return badInput(c, "uploadKey", "Every issued upload part must be uploaded before completion.");
    }
    const storage = aps.storageObjects
      .findBy("bucket_key", bucketKey)
      .find((candidate) => candidate.object_key === objectKey);
    if (!storage) return notFound(c, "The requested storage object");
    const bytes = Buffer.concat(session.parts_base64.map((part) => Buffer.from(part ?? "", "base64")));
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    aps.storageObjects.update(storage.id, {
      size: bytes.length,
      sha1,
      content_base64: bytes.toString("base64"),
      uploaded_at: new Date().toISOString(),
    });
    aps.uploadSessions.delete(session.id);
    const location = `${baseUrl}/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}`;
    return c.json({
      objectId: storage.object_id,
      objectKey,
      bucketKey,
      size: bytes.length,
      sha1,
      location,
    });
  });

  app.post("/data/v1/projects/:projectId/items", async (c) => {
    const projectId = decodeRouteValue(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? record(body.data) : null;
    const included = body && Array.isArray(body.included) ? body.included.map(record).filter(Boolean) : [];
    const includedVersion = included.find((entry) => entry?.type === "versions") ?? null;
    const folderId = data ? relationshipId(data, "parent") : undefined;
    const displayName = data
      ? (optionalString(attributes(data).displayName) ?? optionalString(attributes(data).name))
      : undefined;
    const versionName = includedVersion ? optionalString(attributes(includedVersion).name) : undefined;
    const storageId = includedVersion ? relationshipId(includedVersion, "storage") : undefined;
    if (!data || data.type !== "items" || !includedVersion || !folderId || !(displayName ?? versionName)) {
      return jsonApiError(c, 400, "BAD_INPUT", "An item with a parent folder and included first version is required.");
    }
    const name = displayName ?? versionName!;
    const folder = aps.documentFolders.findOneBy("folder_id", folderId);
    if (!folder || folder.project_id !== projectId)
      return jsonApiError(c, 404, "NOT_FOUND", "The parent folder was not found.");
    if (aps.documentItems.findBy("folder_id", folderId).some((item) => item.display_name === name)) {
      return jsonApiError(c, 409, "CONFLICT", "An item with this name already exists in the folder.");
    }
    const storage = finalizedStorageForProject(aps, projectId, storageId);
    if (!storage)
      return jsonApiError(c, 400, "BAD_INPUT", "The storage relationship must reference a finalized object.");
    if (storage.folder_id !== folderId) {
      return jsonApiError(c, 400, "BAD_INPUT", "The storage object must target the item's parent folder.");
    }
    const actor = await actorForRequest(c, store, aps);
    const now = new Date().toISOString();
    const item = createDocumentItem(aps, {
      item_id: `urn:adsk.wipprod:dm.lineage:${randomUUID().replaceAll("-", "")}`,
      project_id: projectId,
      folder_id: folderId,
      display_name: name,
      hidden: false,
      reserved: false,
      reserved_time: null,
      reserved_by: null,
      reserved_by_name: null,
      created_by: actor.id,
      created_by_name: actor.name,
      create_time: now,
      last_modified_by: actor.id,
      last_modified_by_name: actor.name,
      last_modified_time: now,
      extension_type: "items:autodesk.bim360:File",
    });
    const version = createDocumentVersion(aps, versionValues(item, storage, 1, actor, versionName ?? name), {
      requireDerivative: false,
    });
    await finishVersionWrite(aps, store, version);
    const self = `${baseUrl}/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(item.item_id)}`;
    return jsonApiCreated(c, self, documentItemData(baseUrl, aps, item), [documentVersionData(baseUrl, version)]);
  });

  app.post("/data/v1/projects/:projectId/versions", async (c) => {
    const projectId = decodeRouteValue(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? record(body.data) : null;
    const itemId = data ? relationshipId(data, "item") : undefined;
    const storageId = data ? relationshipId(data, "storage") : undefined;
    const item = itemId ? aps.documentItems.findOneBy("item_id", itemId) : undefined;
    if (!data || data.type !== "versions" || !itemId || !storageId) {
      return jsonApiError(c, 400, "BAD_INPUT", "A version with item and storage relationships is required.");
    }
    if (!item || item.project_id !== projectId) return jsonApiError(c, 404, "NOT_FOUND", "The item was not found.");
    const storage = finalizedStorageForProject(aps, projectId, storageId);
    if (!storage)
      return jsonApiError(c, 400, "BAD_INPUT", "The storage relationship must reference a finalized object.");
    if (storage.folder_id !== item.folder_id) {
      return jsonApiError(c, 400, "BAD_INPUT", "The storage object must target the item's parent folder.");
    }
    const actor = await actorForRequest(c, store, aps);
    const latest = itemTip(aps, item.item_id);
    const number = (latest?.version_number ?? 0) + 1;
    const name = optionalString(attributes(data).name) ?? optionalString(attributes(data).displayName) ?? storage.name;
    const version = createDocumentVersion(aps, versionValues(item, storage, number, actor, name), {
      requireDerivative: false,
    });
    aps.documentItems.update(item.id, {
      display_name: name,
      last_modified_by: actor.id,
      last_modified_by_name: actor.name,
      last_modified_time: version.create_time,
    });
    await finishVersionWrite(aps, store, version);
    const self = `${baseUrl}/data/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(version.version_id)}`;
    return jsonApiCreated(c, self, documentVersionData(baseUrl, version));
  });
}
