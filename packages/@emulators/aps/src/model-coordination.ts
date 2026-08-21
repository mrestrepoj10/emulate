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
import { documentItemForVersion, folderAncestors, itemTip } from "./dm-tree.js";
import { DEFAULT_USER_EMAIL } from "./helpers.js";
import { putSignedBlob } from "./signed-blobs.js";
import type { ApsStore } from "./store.js";

const TIMING_KEY = "aps.modelCoordinationTiming";
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const CLASH_RESOURCE_TYPES = [
  "scope-version-clash.2.0.0",
  "scope-version-clash-instance.2.0.0",
  "scope-version-document.2.0.0",
] as const;

// The seeded clash groups derive their existing/resolved ids from this fixture.
const CANNED_CLASHES = [
  { id: 1, clash: [0, 1], dist: 0.125, status: "New" },
  { id: 2, clash: [0, 1], dist: 0.25, status: "Existing" },
  { id: 3, clash: [0, 1], dist: 0.5, status: "Resolved" },
];
const RESOLVED_CLASH_IDS = CANNED_CLASHES.filter((clash) => clash.status === "Resolved").map((clash) => clash.id);
const UNRESOLVED_CLASH_IDS = CANNED_CLASHES.filter((clash) => clash.status !== "Resolved").map((clash) => clash.id);

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

function modelSetDocument(aps: ApsStore, version: ApsDocumentVersion): ApsModelSetDocumentVersion {
  const item = documentItemForVersion(aps, version);
  if (!item) throw new Error(`APS document version '${version.version_id}' references an unknown item.`);
  if (!version.bubble_urn) throw new Error(`APS document version '${version.version_id}' has no translated manifest.`);
  const tip = itemTip(aps, item.item_id);
  return {
    stableDocumentId: version.item_id,
    unstableDocumentId: version.version_id,
    documentLineage: {
      lineageUrn: version.item_id,
      parentFolderUrn: item.folder_id,
      isAligned: true,
      tipVersionUrn: tip?.version_id ?? version.version_id,
    },
    alignment: {
      transform: [...IDENTITY_TRANSFORM],
      checksum: checksum(`${version.version_id}:alignment`),
      upAxis: [0, 0, 1],
      distanceUnit: "feet",
    },
    isTipVersion: tip?.version_id === version.version_id,
    documentStatus: "Succeeded",
    forgeType: "versions:autodesk.bim360:Document",
    versionUrn: version.version_id,
    displayName: version.display_name,
    revision: String(version.version_number),
    viewableName: "{3D}",
    createUserId: version.created_by,
    createTime: version.create_time,
    viewableGuid: version.viewable_guid,
    viewableId: version.viewable_id,
    viewableMime: "application/autodesk-svf2",
    bubbleUrn: version.bubble_urn,
    isSvf2Supported: true,
    originalSeedFileVersionSize: version.storage_size,
    originalSeedFileVersionUrn: version.storage_urn,
    originalSeedFileVersionName: version.display_name,
  };
}

export function clashTestPayload(test: ApsClashTest) {
  return {
    id: test.test_id,
    ...(test.completed_on ? { completedOn: test.completed_on } : {}),
    modelSetId: test.model_set_id,
    modelSetVersion: test.model_set_version,
    status: test.status,
  };
}

export function modelSetVersionPayload(version: ApsModelSetVersion) {
  return {
    modelSetId: version.model_set_id,
    version: version.version,
    createTime: version.create_time,
    status: version.status,
    documentVersions: structuredClone(version.document_versions),
  };
}

export function modelSetSummaryPayload(modelSet: ApsModelSet) {
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

export function latestModelSetVersion(aps: ApsStore, modelSetId: string): ApsModelSetVersion | undefined {
  return aps.modelSetVersions.findBy("model_set_id", modelSetId).sort((left, right) => right.version - left.version)[0];
}

export function modelSetPayload(aps: ApsStore, modelSet: ApsModelSet) {
  const tipVersion = latestModelSetVersion(aps, modelSet.model_set_id)?.version ?? 0;
  return {
    ...modelSetSummaryPayload(modelSet),
    modelSetType: "ProjectFiles",
    folders: modelSet.folder_urns.map((folderUrn) => ({ folderUrn })),
    includedFolders: modelSet.folder_urns.map((folderUrn) => {
      const folder = aps.documentFolders.findOneBy("folder_id", folderUrn);
      return {
        folderUrn,
        folderName: folder?.name ?? "",
        parentFolderUrn: folder?.parent_folder_id ?? modelSet.root_folder_urn,
      };
    }),
    accessedTime: modelSet.modified_time,
    isInactive: false,
    tipVersion,
    permission: "Edit",
    contentFilters: [],
    checksum: checksum(`${modelSet.model_set_id}:${tipVersion}`),
  };
}

export function clashResourceBlobId(testId: string, type: string): string {
  return `${testId}.${type}`;
}

export function writeClashArtifacts(aps: ApsStore, version: ApsModelSetVersion, test: ApsClashTest): void {
  const documents = version.document_versions.map((document, id) => ({ id, urn: document.versionUrn }));
  const instances = CANNED_CLASHES.map((clash, index) => ({
    cid: clash.id,
    ldid: 0,
    loid: 1001 + index,
    lvid: 1,
    rdid: 1,
    roid: 2001 + index,
    rvid: 1,
  }));
  const values: Record<(typeof CLASH_RESOURCE_TYPES)[number], unknown> = {
    "scope-version-clash.2.0.0": CANNED_CLASHES,
    "scope-version-clash-instance.2.0.0": instances,
    "scope-version-document.2.0.0": documents,
  };

  for (const type of CLASH_RESOURCE_TYPES) {
    putSignedBlob(aps, {
      blobId: clashResourceBlobId(test.test_id, type),
      filename: `${type}.json.gz`,
      contentType: "application/gzip",
      content: gzipSync(JSON.stringify(values[type])),
    });
  }
}

function seedClashTest(aps: ApsStore, modelSet: ApsModelSet, version: ApsModelSetVersion, testId: string): void {
  const test = aps.clashTests.insert({
    project_id: modelSet.project_id,
    test_id: testId,
    model_set_id: modelSet.model_set_id,
    model_set_version: version.version,
    status: "Success",
    completed_on: version.create_time,
  });
  aps.clashGroups.insert({
    test_id: test.test_id,
    disposition: "assigned",
    group_id: "17171717-1717-4171-8171-171717171717",
    original_clash_test_id: test.test_id,
    created_at_version: version.version,
    existing: [...UNRESOLVED_CLASH_IDS],
    resolved: [...RESOLVED_CLASH_IDS],
  });
  aps.clashGroups.insert({
    test_id: test.test_id,
    disposition: "closed",
    group_id: "18181818-1818-4181-8181-181818181818",
    original_clash_test_id: test.test_id,
    created_at_version: version.version,
    existing: [],
    resolved: [...RESOLVED_CLASH_IDS],
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
      if (!document.bubble_urn || !aps.manifests.findOneBy("urn", document.bubble_urn)) {
        throw new Error(`APS document version '${id}' references unknown manifest '${document.bubble_urn}'.`);
      }
      return document;
    });
    if (documents.length < 2) throw new Error(`APS model set '${seed.id}' requires at least two document versions.`);

    const createdTime = seed.created_time ?? new Date().toISOString();
    const actor = seed.created_by ?? DEFAULT_USER_EMAIL;
    const documentItems = documents.map((document) => documentItemForVersion(aps, document));
    if (documentItems.some((item) => !item)) {
      throw new Error(`APS model set '${seed.id}' references a document with no item.`);
    }
    const firstItem = documentItems[0]!;
    const rootFolderUrn =
      seed.root_folder_urn ??
      folderAncestors(aps, project.project_id, firstItem.folder_id)[0]?.folder_id ??
      firstItem.folder_id;
    const folderUrns = seed.folder_urns ?? [...new Set(documentItems.map((item) => item!.folder_id))];
    for (const folderUrn of [rootFolderUrn, ...folderUrns]) {
      const folder = aps.documentFolders.findOneBy("folder_id", folderUrn);
      if (!folder || folder.project_id !== project.project_id) {
        throw new Error(`APS model set '${seed.id}' references unknown folder '${folderUrn}'.`);
      }
    }
    const modelSet = aps.modelSets.insert({
      project_id: project.project_id,
      model_set_id: seed.id,
      name: seed.name,
      description: seed.description ?? "",
      root_folder_urn: rootFolderUrn,
      folder_urns: [...folderUrns],
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
      document_versions: documents.map((document) => modelSetDocument(aps, document)),
    });
    aps.modelSetViews.insert({
      model_set_id: modelSet.model_set_id,
      version: version.version,
      view_id: "19191919-1919-4191-8191-191919191919",
      document_versions: version.document_versions.map((document) => document.versionUrn),
    });
    seedClashTest(aps, modelSet, version, seed.test_id ?? randomUUID());
  }
}

export function addModelSetVersion(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
  overrides?: { processingMs?: number },
): { version: ApsModelSetVersion; test: ApsClashTest } {
  const previous = latestModelSetVersion(aps, modelSet.model_set_id);
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

  const processingMs = overrides?.processingMs ?? getModelCoordinationTiming(store).processing_ms;
  setTimeout(() => {
    aps.modelSetVersions.update(version.id, { status: "Processing" });
    aps.clashTests.update(test.id, { status: "Processing" });
    setTimeout(() => {
      aps.modelSetVersions.update(version.id, { status: "Successful" });
      aps.clashTests.update(test.id, { status: "Success", completed_on: new Date().toISOString() });
    }, processingMs);
  }, processingMs);

  return { version, test };
}
