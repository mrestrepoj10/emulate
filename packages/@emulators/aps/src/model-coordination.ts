import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Store } from "@emulators/core";
import {
  DEFAULT_MODEL_COORDINATION_TIMING,
  type ApsModelCoordinationTimingConfig,
  type ApsSeedConfig,
} from "./config.js";
import type {
  ApsClashTest,
  ApsDocumentVersion,
  ApsModelSet,
  ApsModelSetDocumentVersion,
  ApsModelSetVersion,
} from "./entities.js";
import { bareProjectId } from "./acc.js";
import { putSignedBlob } from "./signed-blobs.js";
import type { ApsStore } from "./store.js";

const TIMING_KEY = "aps.modelCoordinationTiming";
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const CLASH_RESOURCE_TYPES = [
  "scope-version-clash.2.0.0",
  "scope-version-clash-instance.2.0.0",
  "scope-version-document.2.0.0",
] as const;

export function getModelCoordinationTiming(store: Store): ApsModelCoordinationTimingConfig {
  return store.getData<ApsModelCoordinationTimingConfig>(TIMING_KEY) ?? { ...DEFAULT_MODEL_COORDINATION_TIMING };
}

export function setModelCoordinationTiming(store: Store, timing: Partial<ApsModelCoordinationTimingConfig>): void {
  const next = { ...getModelCoordinationTiming(store), ...timing };
  if (!Number.isFinite(next.processing_ms) || next.processing_ms < 0) {
    throw new Error("APS Model Coordination processing_ms must be a non-negative number.");
  }
  if (!Number.isFinite(next.signed_url_ttl_ms) || next.signed_url_ttl_ms < 1) {
    throw new Error("APS Model Coordination signed_url_ttl_ms must be a positive number.");
  }
  store.setData(TIMING_KEY, next);
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function modelSetDocument(version: ApsDocumentVersion, createTime: string): ApsModelSetDocumentVersion {
  return {
    stableDocumentId: version.item_id,
    unstableDocumentId: version.version_id,
    documentLineage: {
      lineageUrn: version.item_id,
      parentFolderUrn: version.folder_id,
      isAligned: true,
      tipVersionUrn: version.version_id,
    },
    alignment: {
      transform: [...IDENTITY_TRANSFORM],
      checksum: checksum(`${version.version_id}:alignment`),
      upAxis: [0, 0, 1],
      distanceUnit: "feet",
    },
    isTipVersion: true,
    documentStatus: "Succeeded",
    forgeType: "versions:autodesk.bim360:Document",
    versionUrn: version.version_id,
    displayName: version.display_name,
    revision: "1",
    viewableName: "{3D}",
    createUserId: "testuser@autodesk.local",
    createTime,
    viewableGuid: version.viewable_guid,
    viewableId: version.viewable_id,
    viewableMime: "application/autodesk-svf2",
    bubbleUrn: version.bubble_urn,
    isSvf2Supported: true,
    originalSeedFileVersionSize: 0,
    originalSeedFileVersionUrn: version.storage_urn,
    originalSeedFileVersionName: version.display_name,
  };
}

export function clashTestPayload(test: ApsClashTest): Record<string, unknown> {
  return {
    id: test.test_id,
    ...(test.completed_on ? { completedOn: test.completed_on } : {}),
    modelSetId: test.model_set_id,
    modelSetVersion: test.model_set_version,
    status: test.status,
  };
}

export function modelSetVersionPayload(version: ApsModelSetVersion): Record<string, unknown> {
  return {
    modelSetId: version.model_set_id,
    version: version.version,
    createTime: version.create_time,
    status: version.status,
    documentVersions: structuredClone(version.document_versions),
  };
}

export function modelSetSummaryPayload(modelSet: ApsModelSet): Record<string, unknown> {
  return {
    modifiedBy: modelSet.modified_by,
    modifiedTime: modelSet.modified_time,
    modelSetId: modelSet.model_set_id,
    containerId: bareProjectId(modelSet.project_id),
    name: modelSet.name,
    description: modelSet.description,
    createdBy: modelSet.created_by,
    createdTime: modelSet.created_time,
    isDisabled: modelSet.disabled,
    isDeleted: modelSet.deleted,
    includedFolderCount: modelSet.folder_urns.length,
    rootFolder: { folderUrn: modelSet.root_folder_urn },
    hasContentFilters: false,
    clashEngineVersion: "2.0.0",
    isDocumentLimitReached: false,
  };
}

export function modelSetPayload(aps: ApsStore, modelSet: ApsModelSet): Record<string, unknown> {
  const versions = aps.modelSetVersions
    .findBy("model_set_id", modelSet.model_set_id)
    .sort((left, right) => right.version - left.version);
  return {
    ...modelSetSummaryPayload(modelSet),
    modelSetType: "ProjectFiles",
    folders: modelSet.folder_urns.map((folderUrn) => ({ folderUrn })),
    includedFolders: modelSet.folder_urns.map((folderUrn) => ({
      folderUrn,
      folderName: "Plans",
      parentFolderUrn: modelSet.root_folder_urn,
    })),
    accessedTime: modelSet.modified_time,
    isInactive: false,
    tipVersion: versions[0]?.version ?? 0,
    permission: "Edit",
    contentFilters: [],
    checksum: checksum(`${modelSet.model_set_id}:${versions[0]?.version ?? 0}`),
  };
}

function artifactBlobId(testId: string, type: string): string {
  return `${testId}.${type}`;
}

export function ensureClashArtifacts(aps: ApsStore, version: ApsModelSetVersion, test: ApsClashTest): void {
  const documents = version.document_versions.map((document, id) => ({ id, urn: document.versionUrn }));
  const clashes = [
    { id: 1, clash: [0, 1], dist: 0.125, status: "New" },
    { id: 2, clash: [0, 1], dist: 0.25, status: "Existing" },
    { id: 3, clash: [0, 1], dist: 0.5, status: "Resolved" },
  ];
  const instances = clashes.map((clash, index) => ({
    cid: clash.id,
    ldid: 0,
    loid: 1001 + index,
    lvid: 1,
    rdid: 1,
    roid: 2001 + index,
    rvid: 1,
  }));
  const values: Record<(typeof CLASH_RESOURCE_TYPES)[number], unknown> = {
    "scope-version-clash.2.0.0": clashes,
    "scope-version-clash-instance.2.0.0": instances,
    "scope-version-document.2.0.0": documents,
  };

  for (const type of CLASH_RESOURCE_TYPES) {
    putSignedBlob(aps, {
      blobId: artifactBlobId(test.test_id, type),
      ownerId: test.test_id,
      filename: `${type}.json.gz`,
      contentType: "application/gzip",
      content: gzipSync(JSON.stringify(values[type])),
    });
  }
}

function seedTestAndArtifacts(aps: ApsStore, modelSet: ApsModelSet, version: ApsModelSetVersion, testId: string): void {
  const test = aps.clashTests.insert({
    project_id: modelSet.project_id,
    test_id: testId,
    model_set_id: modelSet.model_set_id,
    model_set_version: version.version,
    status: "Success",
    completed_on: version.create_time,
  });
  ensureClashArtifacts(aps, version, test);
  aps.clashGroups.insert({
    test_id: test.test_id,
    disposition: "assigned",
    group_id: "17171717-1717-4171-8171-171717171717",
    original_clash_test_id: test.test_id,
    created_at_version: version.version,
    existing: [1, 2],
    resolved: [3],
  });
  aps.clashGroups.insert({
    test_id: test.test_id,
    disposition: "closed",
    group_id: "18181818-1818-4181-8181-181818181818",
    original_clash_test_id: test.test_id,
    created_at_version: version.version,
    existing: [],
    resolved: [3],
  });
}

export function seedModelCoordinationFromConfig(aps: ApsStore, store: Store, config: ApsSeedConfig): void {
  if (config.model_coordination_timing) setModelCoordinationTiming(store, config.model_coordination_timing);

  for (const seed of config.model_sets ?? []) {
    if (aps.modelSets.findOneBy("model_set_id", seed.id)) continue;
    const project = aps.projects.findOneBy("project_id", seed.project_id);
    if (!project) throw new Error(`APS model set '${seed.id}' references unknown project '${seed.project_id}'.`);
    const documentIds = seed.document_version_ids ?? [];
    const documents = documentIds.map((id) => {
      const document = aps.documentVersions.findOneBy("version_id", id);
      if (!document) throw new Error(`APS model set '${seed.id}' references unknown document version '${id}'.`);
      if (document.project_id !== project.project_id) {
        throw new Error(`APS model set '${seed.id}' references a document version from another project.`);
      }
      if (!aps.manifests.findOneBy("urn", document.bubble_urn)) {
        throw new Error(`APS document version '${id}' references unknown manifest '${document.bubble_urn}'.`);
      }
      return document;
    });
    if (documents.length < 2) throw new Error(`APS model set '${seed.id}' requires at least two document versions.`);

    const createdTime = seed.created_time ?? new Date().toISOString();
    const actor = seed.created_by ?? "testuser@autodesk.local";
    const modelSet = aps.modelSets.insert({
      project_id: project.project_id,
      model_set_id: seed.id,
      name: seed.name,
      description: seed.description ?? "",
      root_folder_urn: seed.root_folder_urn ?? documents[0].ancestor_folder_ids[0] ?? documents[0].folder_id,
      folder_urns: [...(seed.folder_urns ?? [...new Set(documents.map((item) => item.folder_id))])],
      created_by: actor,
      created_time: createdTime,
      modified_by: actor,
      modified_time: createdTime,
      disabled: seed.disabled ?? false,
      deleted: seed.deleted ?? false,
    });
    const version = aps.modelSetVersions.insert({
      model_set_id: modelSet.model_set_id,
      version: 1,
      create_time: createdTime,
      status: "Successful",
      document_versions: documents.map((document) => modelSetDocument(document, createdTime)),
    });
    aps.modelSetViews.insert({
      model_set_id: modelSet.model_set_id,
      version: version.version,
      view_id: "19191919-1919-4191-8191-191919191919",
      document_versions: version.document_versions.map((document) => document.versionUrn),
    });
    seedTestAndArtifacts(aps, modelSet, version, seed.test_id ?? randomUUID());
  }
}

export function addModelSetVersion(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
): { version: ApsModelSetVersion; test: ApsClashTest } {
  const previous = aps.modelSetVersions
    .findBy("model_set_id", modelSet.model_set_id)
    .sort((left, right) => right.version - left.version)[0];
  if (!previous) throw new Error(`APS model set '${modelSet.model_set_id}' has no source version.`);
  const createTime = new Date().toISOString();
  const version = aps.modelSetVersions.insert({
    model_set_id: modelSet.model_set_id,
    version: previous.version + 1,
    create_time: createTime,
    status: "Pending",
    document_versions: structuredClone(previous.document_versions),
  });
  aps.modelSetViews.insert({
    model_set_id: modelSet.model_set_id,
    version: version.version,
    view_id: randomUUID(),
    document_versions: version.document_versions.map((document) => document.versionUrn),
  });
  const test = aps.clashTests.insert({
    project_id: modelSet.project_id,
    test_id: randomUUID(),
    model_set_id: modelSet.model_set_id,
    model_set_version: version.version,
    status: "Pending",
    completed_on: null,
  });
  aps.modelSets.update(modelSet.id, { modified_time: createTime });

  const { processing_ms: processingMs } = getModelCoordinationTiming(store);
  setTimeout(() => {
    aps.modelSetVersions.update(version.id, { status: "Processing" });
    aps.clashTests.update(test.id, { status: "Processing" });
  }, processingMs);
  setTimeout(() => {
    const completedOn = new Date().toISOString();
    const completeVersion = aps.modelSetVersions.update(version.id, { status: "Successful" });
    const completeTest = aps.clashTests.update(test.id, { status: "Success", completed_on: completedOn });
    if (completeVersion && completeTest) ensureClashArtifacts(aps, completeVersion, completeTest);
  }, processingMs * 2);

  return { version, test };
}

export function clashResourceBlobId(testId: string, type: string): string {
  return artifactBlobId(testId, type);
}
