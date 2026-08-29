import { createHash, randomUUID } from "node:crypto";
import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { accessTokenForRequest, apsAuth } from "../auth.js";
import { createDocumentItem, createDocumentVersion, documentFileType, documentMimeType, itemTip } from "../dm-tree.js";
import { emitDocumentVersionAdded } from "../dm-events.js";
import type { ApsDocumentItem, ApsDocumentVersion, ApsStorageObject } from "../entities.js";
import { DEFAULT_USER_EMAIL, jsonObjectBody, optionalString, stableDerivativeGuid } from "../helpers.js";
import { getTranslationConfig, getUploadConfig } from "../ingestion-config.js";
import { asRecord, jsonApiCreated, jsonApiError, relationshipId, resourceAttributes, routeId } from "../jsonapi.js";
import { badInput, forbidden, notFound, payloadTooLarge } from "../problem.js";
import { issueSignedResourceUrl, validateSignedResource } from "../signed-blobs.js";
import { getApsStore, type ApsStore } from "../store.js";
import { enqueueTranslation } from "../translation.js";
import { documentItemData, documentVersionData } from "./data-management.js";

const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SIGNED_URL_TTL_MINUTES = 2;
const MAX_UPLOAD_PARTS = 100;

function storageForWrite(
  c: Context<AppEnv>,
  aps: ApsStore,
  projectId: string,
  folderId: string,
  storageId: string | undefined,
): ApsStorageObject | Response {
  const storage = storageId ? aps.storageObjects.findOneBy("object_id", storageId) : undefined;
  if (!storage || storage.project_id !== projectId || !storage.uploaded_at || storage.content_base64 === null) {
    return jsonApiError(c, 400, "BAD_INPUT", "The storage relationship must reference a finalized object.");
  }
  if (storage.folder_id !== folderId) {
    return jsonApiError(c, 400, "BAD_INPUT", "The storage object must target the item's parent folder.");
  }
  return storage;
}

async function actorForRequest(c: Context<AppEnv>, store: RouteContext["store"], aps: ApsStore) {
  const token = await accessTokenForRequest(c, store);
  const user = token?.apsUserId ? aps.users.findOneBy("user_id", token.apsUserId) : undefined;
  return { id: user?.user_id ?? DEFAULT_USER_EMAIL, name: user?.name ?? "Test User" };
}

function itemVersionId(itemId: string, versionNumber: number): string {
  const lineage = itemId.split(":").at(-1)!;
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
  const bubbleUrn = Buffer.from(storage.object_id).toString("base64url");
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
    bubble_urn: bubbleUrn,
    viewable_id: "emulate-3d-view",
    viewable_guid: stableDerivativeGuid(`${bubbleUrn}:3d`),
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
  const readAuth = apsAuth(store, { scopes: ["data:read"] });
  const writeAuth = apsAuth(store, { scopes: ["data:create", "data:write"] });
  const userWriteAuth = apsAuth(store, { scopes: ["data:create", "data:write"], requireUser: true });

  app.post("/data/v1/projects/:projectId/storage", userWriteAuth, async (c) => {
    const projectId = routeId(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? asRecord(body.data) : null;
    const name = data ? optionalString(resourceAttributes(data).name) : undefined;
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

  const bucketCreateAuth = apsAuth(store, { scopes: ["bucket:create"] });
  const bucketReadAuth = apsAuth(store, { scopes: ["bucket:read"] });

  app.post("/oss/v2/buckets", bucketCreateAuth, async (c) => {
    const body = await jsonObjectBody(c);
    const bucketKey = body ? optionalString(body.bucketKey) : undefined;
    const policyKey = body ? optionalString(body.policyKey) : undefined;
    if (!bucketKey || !/^[-_.a-z0-9]{3,128}$/.test(bucketKey)) {
      return badInput(c, "bucketKey", "bucketKey must be 3-128 lowercase characters.");
    }
    if (!policyKey || !["transient", "temporary", "persistent"].includes(policyKey)) {
      return badInput(c, "policyKey", "policyKey must be transient, temporary, or persistent.");
    }
    if (aps.buckets.findOneBy("bucket_key", bucketKey)) {
      return c.json({ reason: "Bucket already exists" }, 409);
    }
    const createdDate = Date.now();
    aps.buckets.insert({ bucket_key: bucketKey, policy_key: policyKey, created_at: new Date(createdDate).toISOString() });
    return c.json({ bucketKey, policyKey, createdDate }, 200);
  });

  app.get("/oss/v2/buckets/:bucketKey/details", bucketReadAuth, (c) => {
    const bucketKey = routeId(c.req.param("bucketKey"));
    const bucket = aps.buckets.findOneBy("bucket_key", bucketKey);
    if (!bucket) return notFound(c, "The requested bucket");
    return c.json({
      bucketKey: bucket.bucket_key,
      policyKey: bucket.policy_key,
      createdDate: Date.parse(bucket.created_at),
    });
  });

  app.get("/oss/v2/buckets/:bucketKey/objects", readAuth, (c) => {
    const bucketKey = routeId(c.req.param("bucketKey"));
    if (!aps.buckets.findOneBy("bucket_key", bucketKey)) return notFound(c, "The requested bucket");
    const items = aps.storageObjects
      .findBy("bucket_key", bucketKey)
      .filter((candidate) => candidate.uploaded_at !== null)
      .map((candidate) => ({
        bucketKey,
        objectKey: candidate.object_key,
        objectId: candidate.object_id,
        sha1: candidate.sha1,
        size: candidate.size,
      }));
    return c.json({ items });
  });

  app.get("/oss/v2/buckets/:bucketKey/objects/:objectKey/signeds3upload", writeAuth, (c) => {
    const bucketKey = routeId(c.req.param("bucketKey"));
    const objectKey = routeId(c.req.param("objectKey"));
    let storage = aps.storageObjects
      .findBy("bucket_key", bucketKey)
      .find((candidate) => candidate.object_key === objectKey);
    if (!storage && aps.buckets.findOneBy("bucket_key", bucketKey)) {
      // Real OSS creates app-bucket objects on first signed upload; only
      // Data Management storage requires the pre-created object.
      storage = aps.storageObjects.insert({
        object_id: `urn:adsk.objects:os.object:${bucketKey}/${objectKey}`,
        bucket_key: bucketKey,
        object_key: objectKey,
        project_id: "",
        folder_id: "",
        name: objectKey,
        size: 0,
        sha1: "",
        content_base64: null,
        uploaded_at: null,
      });
    }
    if (!storage) return notFound(c, "The requested storage object");
    const partsValue = c.req.query("parts") ?? "1";
    const minutesValue = c.req.query("minutesExpiration") ?? String(DEFAULT_SIGNED_URL_TTL_MINUTES);
    if (!/^\d+$/.test(partsValue) || Number(partsValue) < 1 || Number(partsValue) > MAX_UPLOAD_PARTS) {
      return badInput(c, "parts", `parts must be an integer from 1 through ${MAX_UPLOAD_PARTS}.`);
    }
    if (!/^\d+$/.test(minutesValue) || Number(minutesValue) < 1 || Number(minutesValue) > 60) {
      return badInput(c, "minutesExpiration", "minutesExpiration must be an integer from 1 through 60.");
    }
    const now = Date.now();
    for (const session of aps.uploadSessions.all()) {
      if (Date.parse(session.expires_at) <= now) aps.uploadSessions.delete(session.id);
    }
    const expectedParts = Number(partsValue);
    const uploadKey = randomUUID();
    const expiresAt = new Date(now + UPLOAD_SESSION_TTL_MS).toISOString();
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
      urlExpiration: new Date(now + ttlMs).toISOString(),
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

  app.post("/oss/v2/buckets/:bucketKey/objects/:objectKey/signeds3upload", writeAuth, async (c) => {
    const bucketKey = routeId(c.req.param("bucketKey"));
    const objectKey = routeId(c.req.param("objectKey"));
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

  app.post("/oss/v2/buckets/:bucketKey/objects/:objectKey/signeds3download", readAuth, (c) => {
    const bucketKey = routeId(c.req.param("bucketKey"));
    const objectKey = routeId(c.req.param("objectKey"));
    const storage = aps.storageObjects
      .findBy("bucket_key", bucketKey)
      .find(
        (candidate) => candidate.object_key === objectKey && candidate.uploaded_at && candidate.content_base64 !== null,
      );
    if (!storage) return notFound(c, "The requested storage object");
    const minutesValue = c.req.query("minutesExpiration") ?? String(DEFAULT_SIGNED_URL_TTL_MINUTES);
    if (!/^\d+$/.test(minutesValue) || Number(minutesValue) < 1 || Number(minutesValue) > 60) {
      return badInput(c, "minutesExpiration", "minutesExpiration must be an integer from 1 through 60.");
    }
    const token = Buffer.from(storage.object_id).toString("base64url");
    const issued = issueSignedResourceUrl(
      store,
      baseUrl,
      `/oss/v2/signed-download/${token}`,
      `aps-download:${storage.object_id}`,
      Number(minutesValue) * 60_000,
    );
    return c.json({
      url: issued.url,
      expiration: issued.validUntil,
      size: storage.size,
      sha1: storage.sha1,
    });
  });

  app.get("/oss/v2/signed-download/:token", (c) => {
    let objectId: string;
    try {
      objectId = Buffer.from(c.req.param("token"), "base64url").toString("utf8");
    } catch {
      return forbidden(c, "The signed download URL is invalid or has expired.");
    }
    if (
      !validateSignedResource(store, `aps-download:${objectId}`, {
        expires: c.req.query("expires"),
        nonce: c.req.query("nonce"),
        signature: c.req.query("signature"),
      })
    ) {
      return forbidden(c, "The signed download URL is invalid or has expired.");
    }
    const storage = aps.storageObjects.findOneBy("object_id", objectId);
    if (!storage || !storage.uploaded_at || storage.content_base64 === null) {
      return notFound(c, "The requested storage object");
    }
    const bytes = Buffer.from(storage.content_base64, "base64");
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": documentMimeType(documentFileType(storage.name)),
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${storage.name.replace(/["\r\n]/g, "")}"`,
      },
    });
  });

  app.post("/data/v1/projects/:projectId/items", userWriteAuth, async (c) => {
    const projectId = routeId(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? asRecord(body.data) : null;
    const included = body && Array.isArray(body.included) ? body.included.map(asRecord).filter(Boolean) : [];
    const includedVersion = included.find((entry) => entry?.type === "versions") ?? null;
    const folderId = data ? relationshipId(data, "parent") : undefined;
    const displayName = data
      ? (optionalString(resourceAttributes(data).displayName) ?? optionalString(resourceAttributes(data).name))
      : undefined;
    const versionName = includedVersion ? optionalString(resourceAttributes(includedVersion).name) : undefined;
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
    const storage = storageForWrite(c, aps, projectId, folderId, storageId);
    if (storage instanceof Response) return storage;
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
    const version = createDocumentVersion(aps, versionValues(item, storage, 1, actor, versionName ?? name));
    await finishVersionWrite(aps, store, version);
    const self = `${baseUrl}/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(item.item_id)}`;
    return jsonApiCreated(c, self, documentItemData(baseUrl, aps, item), [documentVersionData(baseUrl, version)]);
  });

  app.post("/data/v1/projects/:projectId/versions", userWriteAuth, async (c) => {
    const projectId = routeId(c.req.param("projectId"));
    if (!aps.projects.findOneBy("project_id", projectId))
      return jsonApiError(c, 404, "NOT_FOUND", "The project was not found.");
    const body = await jsonObjectBody(c);
    const data = body ? asRecord(body.data) : null;
    const itemId = data ? relationshipId(data, "item") : undefined;
    const storageId = data ? relationshipId(data, "storage") : undefined;
    const item = itemId ? aps.documentItems.findOneBy("item_id", itemId) : undefined;
    if (!data || data.type !== "versions" || !itemId || !storageId) {
      return jsonApiError(c, 400, "BAD_INPUT", "A version with item and storage relationships is required.");
    }
    if (!item || item.project_id !== projectId) return jsonApiError(c, 404, "NOT_FOUND", "The item was not found.");
    const storage = storageForWrite(c, aps, projectId, item.folder_id, storageId);
    if (storage instanceof Response) return storage;
    const actor = await actorForRequest(c, store, aps);
    const latest = itemTip(aps, item.item_id);
    const number = (latest?.version_number ?? 0) + 1;
    const name =
      optionalString(resourceAttributes(data).name) ??
      optionalString(resourceAttributes(data).displayName) ??
      storage.name;
    const version = createDocumentVersion(aps, versionValues(item, storage, number, actor, name));
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
