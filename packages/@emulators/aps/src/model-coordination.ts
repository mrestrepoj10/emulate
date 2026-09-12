import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Store } from "@emulators/core";
import {
  replayClashScenario,
  viewerObjectId,
  LARGE_SCENARIO_CLASH_COUNT,
  type ClashPoolVersion,
} from "./clash-scenario.js";
import {
  CLASH_CLOSE_REASONS,
  DEFAULT_MODEL_COORDINATION_FAULTS,
  DEFAULT_MODEL_COORDINATION_TIMING,
  type ApsClashScenarioGroupSeed,
  type ApsClashScenarioSeed,
  type ApsClashScenarioVersionSeed,
  type ApsModelCoordinationFaultsConfig,
  type ApsModelCoordinationTimingConfig,
  type ApsModelSetDocumentStatus,
  type ApsModelSetViewSeed,
  type ApsSeedConfig,
} from "./config.js";
import type {
  ApsClashGroup,
  ApsClashGroupDisposition,
  ApsClashTest,
  ApsDocumentVersion,
  ApsModelSet,
  ApsModelSetDocumentVersion,
  ApsModelSetVersion,
  ApsModelSetVersionStatus,
  ApsModelSetView,
} from "./entities.js";
import { bareProjectId } from "./acc.js";
import { derivativeLeafObjectIds } from "./derivative-resources.js";
import { documentItemForVersion, folderAncestors, itemTip } from "./dm-tree.js";
import { DEFAULT_USER_EMAIL, stableDerivativeGuid } from "./helpers.js";
import { putSignedBlob } from "./signed-blobs.js";
import type { ApsStore } from "./store.js";

const TIMING_KEY = "aps.modelCoordinationTiming";
const FAULTS_KEY = "aps.modelCoordinationFaults";
const CLASH_DATA_CACHE_KEY = "aps.modelCoordinationClashData";
const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_VIEW_NAME = "All models";

export const CLASH_RESOURCE_TYPES = [
  "scope-version-clash.2.0.0",
  "scope-version-clash-instance.2.0.0",
  "scope-version-document.2.0.0",
] as const;
export type ClashResourceType = (typeof CLASH_RESOURCE_TYPES)[number];

export const MODEL_SET_REGIONS = ["US", "EMEA"] as const;

/**
 * Clash instance `lvid`/`rvid` are SVF (LMV) viewer ids, not the SVF2 ids that Model Derivative metadata reports.
 * The emulator derives them as metadata `objectid` + LMV_ID_OFFSET. This value MUST match `LMV_ID_OFFSET` in
 * model-properties-index.ts so the Model Properties index bridge (`lmvId` → `svf2Id` → `externalId`) round-trips.
 */
export const LMV_ID_OFFSET = 1000;

export interface ClashDocumentRow {
  id: number;
  urn: string;
  viewableName: string;
}

export interface ClashRow {
  id: number;
  clash: [number, number];
  dist: number;
  status: string;
}

export interface ClashInstanceRow {
  cid: number;
  ldid: number;
  loid: number;
  lvid: number;
  rdid: number;
  roid: number;
  rvid: number;
}

export interface VersionClashData {
  documents: ClashDocumentRow[];
  clashes: ClashRow[];
  instances: ClashInstanceRow[];
  /** Clash IDs reported New or Existing in this version. */
  live: Set<number>;
  /** Clash IDs present in this version's clash file with any status. */
  reported: Set<number>;
  files?: Record<ClashResourceType, Buffer>;
}

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

export function getModelCoordinationFaults(store: Store): ApsModelCoordinationFaultsConfig {
  return (
    store.getData<ApsModelCoordinationFaultsConfig>(FAULTS_KEY) ?? {
      ...DEFAULT_MODEL_COORDINATION_FAULTS,
      resources_extension: {},
    }
  );
}

export function setModelCoordinationFaults(store: Store, faults: Partial<ApsModelCoordinationFaultsConfig>): void {
  const next = { ...getModelCoordinationFaults(store), ...faults };
  if (!Number.isInteger(next.rate_limit_per_minute) || next.rate_limit_per_minute < 0) {
    throw new Error("APS Model Coordination rate_limit_per_minute must be a non-negative integer.");
  }
  if (typeof next.entitlement !== "boolean" && (typeof next.entitlement !== "object" || next.entitlement === null)) {
    throw new Error("APS Model Coordination entitlement must be a boolean or a map of project IDs to booleans.");
  }
  for (const [testId, extension] of Object.entries(next.resources_extension ?? {})) {
    if (extension !== "json.gz" && extension !== "sqlite") {
      throw new Error(`APS Model Coordination resources_extension for '${testId}' must be json.gz or sqlite.`);
    }
  }
  store.setData(FAULTS_KEY, next);
}

export function projectHasCoordinationEntitlement(store: Store, projectId: string): boolean {
  const entitlement = getModelCoordinationFaults(store).entitlement;
  if (typeof entitlement === "boolean") return entitlement;
  const bare = bareProjectId(projectId);
  for (const [key, value] of Object.entries(entitlement)) {
    if (bareProjectId(key) === bare) return value;
  }
  return true;
}

export function clashResourceExtension(store: Store, testId: string): "json.gz" | "sqlite" {
  return getModelCoordinationFaults(store).resources_extension[testId] ?? "json.gz";
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function clashTestIdForVersion(modelSetId: string, version: number): string {
  return stableDerivativeGuid(`${modelSetId}:clash-test:${version}`);
}

function clashGroupIdFor(modelSetId: string, ordinal: number): string {
  return stableDerivativeGuid(`${modelSetId}:clash-group:${ordinal}`);
}

function userIdForActor(aps: ApsStore, actor: string): string {
  return aps.users.findOneBy("email", actor)?.user_id ?? aps.users.findOneBy("user_id", actor)?.user_id ?? actor;
}

function modelSetDocument(
  aps: ApsStore,
  version: ApsDocumentVersion,
  documentStatus: ApsModelSetDocumentStatus,
): ApsModelSetDocumentVersion {
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
      distanceUnit: "autodesk.unit.unit:feet-2.0.0",
    },
    isTipVersion: tip?.version_id === version.version_id,
    documentStatus,
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

export function modelSetViewVersionPayload(view: ApsModelSetView, version: ApsModelSetVersion) {
  return {
    viewId: view.view_id,
    modelSetId: view.model_set_id,
    documentVersions: structuredClone(
      version.document_versions.filter((document) => view.document_versions.includes(document.versionUrn)),
    ),
    version: view.version,
  };
}

export function modelSetViewSummaryPayload(aps: ApsStore, view: ApsModelSetView) {
  return {
    name: view.name,
    description: view.description,
    isPrivate: false,
    definition: view.lineages.map((lineageUrn) => ({ lineageUrn, viewableName: "{3D}" })),
    modifiedBy: userIdForActor(aps, view.created_by),
    viewId: view.view_id,
    createdBy: userIdForActor(aps, view.created_by),
    createdTime: view.created_time,
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

export function modelSetVersionNumber(
  aps: ApsStore,
  modelSetId: string,
  version: number,
): ApsModelSetVersion | undefined {
  return aps.modelSetVersions.findBy("model_set_id", modelSetId).find((candidate) => candidate.version === version);
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

export function assignedClashGroupPayload(group: ApsClashGroup) {
  return {
    id: group.group_id,
    clashTestId: group.clash_test_id,
    issueId: group.issue_id,
    createdBy: group.created_by,
    createdOn: group.created_on,
    clashes: [...group.clashes],
  };
}

export function closedClashGroupPayload(group: ApsClashGroup) {
  return {
    id: group.group_id,
    clashTestId: group.clash_test_id,
    title: group.title,
    description: group.description,
    reason: group.reason,
    screenShots: [...group.screen_shots],
    createdBy: group.created_by,
    createdOn: group.created_on,
    clashes: [...group.clashes],
  };
}

export function clashGroupPayload(group: ApsClashGroup) {
  return group.disposition === "assigned" ? assignedClashGroupPayload(group) : closedClashGroupPayload(group);
}

export function clashGroupIntersectionPayload(group: ApsClashGroup, live: Set<number>) {
  return {
    id: group.group_id,
    originalClashTestId: group.clash_test_id,
    createdAtVersion: group.created_at_version,
    existing: group.clashes.filter((clash) => live.has(clash)),
    resolved: group.clashes.filter((clash) => !live.has(clash)),
  };
}

// ---------------------------------------------------------------------------
// Clash data generation
// ---------------------------------------------------------------------------

function clashDataCache(store: Store): Map<string, VersionClashData> {
  let cache = store.getData<Map<string, VersionClashData>>(CLASH_DATA_CACHE_KEY);
  if (!cache) {
    cache = new Map();
    store.setData(CLASH_DATA_CACHE_KEY, cache);
  }
  return cache;
}

function clearClashDataCache(store: Store, modelSetId: string): void {
  const cache = clashDataCache(store);
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${modelSetId}:`)) cache.delete(key);
  }
}

function clashDocuments(version: ApsModelSetVersion): ApsModelSetDocumentVersion[] {
  return version.document_versions.filter((document) => document.documentStatus === "Succeeded");
}

function buildVersionClashData(aps: ApsStore, version: ApsModelSetVersion, pool: ClashPoolVersion): VersionClashData {
  const documents = clashDocuments(version);
  const documentIndex = new Map(documents.map((document, index) => [document.stableDocumentId, index]));
  const leafIds = documents.map((document) => derivativeLeafObjectIds(aps, document.bubbleUrn));
  const clashes: ClashRow[] = [];
  const instances: ClashInstanceRow[] = [];
  const live = new Set<number>();
  const reported = new Set<number>();
  for (const { record, status } of pool.rows) {
    const ldid = documentIndex.get(record.leftLineage);
    const rdid = documentIndex.get(record.rightLineage);
    if (ldid === undefined || rdid === undefined) continue;
    clashes.push({ id: record.id, clash: [record.loid, record.roid], dist: record.dist, status });
    instances.push({
      cid: record.id,
      ldid,
      loid: record.loid,
      lvid: viewerObjectId(leafIds[ldid]!, record.loid, version.version) + LMV_ID_OFFSET,
      rdid,
      roid: record.roid,
      rvid: viewerObjectId(leafIds[rdid]!, record.roid, version.version) + LMV_ID_OFFSET,
    });
    reported.add(record.id);
    if (status !== "Resolved") live.add(record.id);
  }
  return {
    documents: documents.map((document, id) => ({ id, urn: document.versionUrn, viewableName: document.viewableName })),
    clashes,
    instances,
    live,
    reported,
  };
}

/** Clash result rows for one model set version, generated lazily from the scenario and memoized. */
export function versionClashData(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
  version: number,
): VersionClashData {
  const cache = clashDataCache(store);
  const key = `${modelSet.model_set_id}:${version}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pools = replayClashScenario(modelSet.clash_scenario);
  for (const pool of pools) {
    const poolKey = `${modelSet.model_set_id}:${pool.version}`;
    if (cache.has(poolKey)) continue;
    const row = modelSetVersionNumber(aps, modelSet.model_set_id, pool.version);
    if (!row) continue;
    cache.set(poolKey, buildVersionClashData(aps, row, pool));
  }
  return (
    cache.get(key) ?? {
      documents: [],
      clashes: [],
      instances: [],
      live: new Set<number>(),
      reported: new Set<number>(),
    }
  );
}

/** Encodes a result file exactly as the clash service does: gzip of a UTF-8 BOM followed by a wrapper object. */
export function encodeClashResource(type: ClashResourceType, rows: unknown[]): Buffer {
  const wrapperKey =
    type === "scope-version-clash.2.0.0"
      ? "clashes"
      : type === "scope-version-clash-instance.2.0.0"
        ? "instances"
        : "documents";
  return gzipSync(Buffer.concat([UTF8_BOM, Buffer.from(JSON.stringify({ [wrapperKey]: rows }), "utf8")]));
}

export function clashResourceFiles(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
  version: number,
): Record<ClashResourceType, Buffer> {
  const data = versionClashData(aps, store, modelSet, version);
  if (!data.files) {
    data.files = {
      "scope-version-clash.2.0.0": encodeClashResource("scope-version-clash.2.0.0", data.clashes),
      "scope-version-clash-instance.2.0.0": encodeClashResource("scope-version-clash-instance.2.0.0", data.instances),
      "scope-version-document.2.0.0": encodeClashResource("scope-version-document.2.0.0", data.documents),
    };
  }
  return data.files;
}

export function clashResourceBlobId(testId: string, type: string): string {
  return `${testId}.${type}`;
}

export function writeClashArtifacts(aps: ApsStore, store: Store, modelSet: ApsModelSet, test: ApsClashTest): void {
  const extension = clashResourceExtension(store, test.test_id);
  const files = extension === "json.gz" ? clashResourceFiles(aps, store, modelSet, test.model_set_version) : null;
  for (const type of CLASH_RESOURCE_TYPES) {
    putSignedBlob(aps, {
      blobId: clashResourceBlobId(test.test_id, type),
      filename: `${type}.${extension}`,
      contentType: extension === "json.gz" ? "application/gzip" : "application/octet-stream",
      content: files ? files[type] : Buffer.alloc(0),
    });
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface CreateClashGroupInput {
  kind: ApsClashGroupDisposition;
  version: number;
  clashes: number | number[];
  id?: string;
  issueId?: string;
  title?: string;
  description?: string;
  reason?: string;
  screenShots?: string[];
  createdBy?: string;
  createdOn?: string;
}

export function createClashGroup(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
  input: CreateClashGroupInput,
): ApsClashGroup {
  const version = modelSetVersionNumber(aps, modelSet.model_set_id, input.version);
  if (!version) throw new Error(`APS model set '${modelSet.model_set_id}' has no version ${input.version}.`);
  const test = aps.clashTests
    .findBy("model_set_id", modelSet.model_set_id)
    .find((candidate) => candidate.model_set_version === input.version);
  if (!test)
    throw new Error(`APS model set '${modelSet.model_set_id}' has no clash test for version ${input.version}.`);
  if (input.kind !== "assigned" && input.kind !== "closed") {
    throw new Error(`APS clash group kind '${String(input.kind)}' must be assigned or closed.`);
  }
  const reason = input.kind === "closed" ? (input.reason ?? "OTHER") : null;
  if (reason !== null && !(CLASH_CLOSE_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`APS clash group reason '${reason}' must be one of ${CLASH_CLOSE_REASONS.join(", ")}.`);
  }
  if (input.id && aps.clashGroups.findOneBy("group_id", input.id)) {
    throw new Error(`APS clash group '${input.id}' already exists.`);
  }

  const data = versionClashData(aps, store, modelSet, input.version);
  const existingGroups = aps.clashGroups.findBy("model_set_id", modelSet.model_set_id);
  let clashes: number[];
  if (Array.isArray(input.clashes)) {
    clashes = [...new Set(input.clashes)];
    const unknown = clashes.find((clash) => !Number.isInteger(clash) || !data.reported.has(clash));
    if (unknown !== undefined) {
      throw new Error(`APS clash ${String(unknown)} is not reported by the clash test for version ${input.version}.`);
    }
  } else {
    const count = input.clashes;
    if (!Number.isInteger(count) || count < 1) throw new Error("APS clash group clashes must be a positive integer.");
    const grouped = new Set(existingGroups.flatMap((group) => group.clashes));
    clashes = [...data.live].filter((clash) => !grouped.has(clash)).sort((left, right) => left - right);
    if (clashes.length < count) {
      throw new Error(
        `APS model set '${modelSet.model_set_id}' version ${input.version} has only ${clashes.length} ungrouped live clashes; ${count} requested.`,
      );
    }
    clashes = clashes.slice(0, count);
  }
  if (clashes.length === 0) throw new Error("APS clash groups require at least one clash.");

  const ordinal = existingGroups.length + 1;
  const createdOn = input.createdOn ?? new Date(Date.parse(version.create_time) + HOUR_MS).toISOString();
  return aps.clashGroups.insert({
    model_set_id: modelSet.model_set_id,
    disposition: input.kind,
    group_id: input.id ?? clashGroupIdFor(modelSet.model_set_id, ordinal),
    clash_test_id: test.test_id,
    created_at_version: input.version,
    issue_id: input.kind === "assigned" ? (input.issueId ?? null) : null,
    title: input.kind === "closed" ? (input.title ?? `Closed clash group ${ordinal}`) : "",
    description: input.kind === "closed" ? (input.description ?? "") : "",
    reason,
    screen_shots: input.kind === "closed" ? [...(input.screenShots ?? [])] : [],
    created_by: userIdForActor(aps, input.createdBy ?? modelSet.created_by),
    created_on: createdOn,
    clashes,
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

interface VersionPlan {
  documents: ApsModelSetDocumentVersion[];
  status: ApsModelSetVersionStatus;
  scenario: { added: number; resolved: number; succeeded: boolean; lineages: string[] };
}

function resolveDocumentVersion(aps: ApsStore, modelSet: Pick<ApsModelSet, "model_set_id" | "project_id">, id: string) {
  const document = aps.documentVersions.findOneBy("version_id", id);
  if (!document)
    throw new Error(`APS model set '${modelSet.model_set_id}' references unknown document version '${id}'.`);
  if (document.project_id !== modelSet.project_id) {
    throw new Error(`APS model set '${modelSet.model_set_id}' references a document version from another project.`);
  }
  if (!document.bubble_urn || !aps.manifests.findOneBy("urn", document.bubble_urn)) {
    throw new Error(`APS document version '${id}' references unknown manifest '${document.bubble_urn}'.`);
  }
  return document;
}

function planVersion(
  aps: ApsStore,
  modelSet: Pick<ApsModelSet, "model_set_id" | "project_id">,
  previousDocuments: ApsDocumentVersion[],
  step: ApsClashScenarioVersionSeed,
  large: boolean,
): VersionPlan {
  const documents = [...previousDocuments];
  for (const id of step.documents_removed ?? []) {
    const index = documents.findIndex((document) => document.version_id === id);
    if (index === -1)
      throw new Error(`APS model set '${modelSet.model_set_id}' cannot remove absent document version '${id}'.`);
    documents.splice(index, 1);
  }
  for (const id of step.documents_added ?? []) {
    const added = resolveDocumentVersion(aps, modelSet, id);
    const lineageIndex = documents.findIndex((document) => document.item_id === added.item_id);
    if (lineageIndex === -1) documents.push(added);
    else documents[lineageIndex] = added;
  }
  const statuses = step.document_status ?? {};
  for (const id of Object.keys(statuses)) {
    if (!documents.some((document) => document.version_id === id)) {
      throw new Error(`APS model set '${modelSet.model_set_id}' has no document version '${id}' to set a status on.`);
    }
  }
  const modelSetDocuments = documents.map((document) =>
    modelSetDocument(aps, document, statuses[document.version_id] ?? "Succeeded"),
  );
  const succeededCount = modelSetDocuments.filter((document) => document.documentStatus === "Succeeded").length;
  const status: ApsModelSetVersionStatus =
    step.status ??
    (succeededCount === modelSetDocuments.length ? "Successful" : succeededCount === 0 ? "Failed" : "Partial");
  if (!["Successful", "Partial", "Failed"].includes(status)) {
    throw new Error(`APS model set version status '${status}' must be Successful, Partial, or Failed.`);
  }
  const added = step.added ?? 0;
  const resolved = step.resolved ?? 0;
  if (!Number.isInteger(added) || added < 0 || !Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`APS model set '${modelSet.model_set_id}' scenario counts must be non-negative integers.`);
  }
  return {
    documents: modelSetDocuments,
    status,
    scenario: {
      added: large ? Math.max(added, LARGE_SCENARIO_CLASH_COUNT) : added,
      resolved,
      succeeded: status !== "Failed",
      lineages: modelSetDocuments
        .filter((document) => document.documentStatus === "Succeeded")
        .map((document) => document.stableDocumentId),
    },
  };
}

function dmVersionsFor(aps: ApsStore, documents: ApsModelSetDocumentVersion[]): ApsDocumentVersion[] {
  return documents.map((document) => aps.documentVersions.findOneBy("version_id", document.versionUrn)!);
}

function insertViewVersions(aps: ApsStore, modelSet: ApsModelSet, version: ApsModelSetVersion): void {
  const views = new Map<string, ApsModelSetView>();
  for (const view of aps.modelSetViews.findBy("model_set_id", modelSet.model_set_id)) {
    if (!views.has(view.view_id)) views.set(view.view_id, view);
  }
  for (const view of views.values()) {
    aps.modelSetViews.insert({
      model_set_id: modelSet.model_set_id,
      version: version.version,
      view_id: view.view_id,
      name: view.name,
      description: view.description,
      created_by: view.created_by,
      created_time: view.created_time,
      lineages: [...view.lineages],
      document_versions: version.document_versions
        .filter((document) => view.lineages.includes(document.stableDocumentId))
        .map((document) => document.versionUrn),
    });
  }
}

function seedViews(
  aps: ApsStore,
  modelSet: ApsModelSet,
  firstVersion: ApsModelSetVersion,
  seeds: ApsModelSetViewSeed[],
) {
  const viewSeeds: ApsModelSetViewSeed[] = seeds.length
    ? seeds
    : [{ name: DEFAULT_VIEW_NAME, document_version_ids: firstVersion.document_versions.map((doc) => doc.versionUrn) }];
  viewSeeds.forEach((seed, index) => {
    if (!seed.document_version_ids?.length) {
      throw new Error(`APS model set view '${seed.name}' requires at least one document version.`);
    }
    const lineages = seed.document_version_ids.map((id) => resolveDocumentVersion(aps, modelSet, id).item_id);
    const viewId = seed.id ?? stableDerivativeGuid(`${modelSet.model_set_id}:view:${index + 1}`);
    if (aps.modelSetViews.findBy("model_set_id", modelSet.model_set_id).some((view) => view.view_id === viewId)) {
      throw new Error(`APS model set view '${viewId}' is defined twice.`);
    }
    aps.modelSetViews.insert({
      model_set_id: modelSet.model_set_id,
      version: firstVersion.version,
      view_id: viewId,
      name: seed.name,
      description: seed.description ?? "",
      created_by: modelSet.created_by,
      created_time: modelSet.created_time,
      lineages: [...new Set(lineages)],
      document_versions: firstVersion.document_versions
        .filter((document) => lineages.includes(document.stableDocumentId))
        .map((document) => document.versionUrn),
    });
  });
}

export function seedModelCoordinationFromConfig(aps: ApsStore, store: Store, config: ApsSeedConfig): void {
  if (config.model_coordination_timing) setModelCoordinationTiming(store, config.model_coordination_timing);
  if (config.model_coordination_faults) setModelCoordinationFaults(store, config.model_coordination_faults);

  for (const seed of config.model_sets ?? []) {
    if (aps.modelSets.findOneBy("model_set_id", seed.id)) continue;
    const project = aps.projects.findOneBy("project_id", seed.project_id);
    if (!project) throw new Error(`APS model set '${seed.id}' references unknown project '${seed.project_id}'.`);
    const identity = { model_set_id: seed.id, project_id: project.project_id };
    const documents = (seed.document_version_ids ?? []).map((id) => resolveDocumentVersion(aps, identity, id));
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

    const scenarioSeed: ApsClashScenarioSeed = seed.clash_scenario ?? { seed: 1, versions: [{ added: 12 }] };
    if (!Array.isArray(scenarioSeed.versions) || scenarioSeed.versions.length === 0) {
      throw new Error(`APS model set '${seed.id}' clash_scenario requires at least one version.`);
    }
    const large = scenarioSeed.large ?? false;
    const plans: VersionPlan[] = [];
    let previous = documents;
    for (const step of scenarioSeed.versions) {
      const plan = planVersion(aps, identity, previous, step, large);
      plans.push(plan);
      previous = dmVersionsFor(aps, plan.documents);
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
      clash_scenario: {
        seed: scenarioSeed.seed ?? 1,
        large,
        versions: plans.map((plan) => plan.scenario),
      },
    });

    let firstVersion: ApsModelSetVersion | undefined;
    plans.forEach((plan, index) => {
      const versionNumber = index + 1;
      const createTime = new Date(Date.parse(createdTime) + index * DAY_MS).toISOString();
      const version = aps.modelSetVersions.insert({
        model_set_id: modelSet.model_set_id,
        version: versionNumber,
        create_time: createTime,
        status: plan.status,
        document_versions: plan.documents,
      });
      aps.clashTests.insert({
        project_id: modelSet.project_id,
        test_id:
          versionNumber === 1 && seed.test_id
            ? seed.test_id
            : clashTestIdForVersion(modelSet.model_set_id, versionNumber),
        model_set_id: modelSet.model_set_id,
        model_set_version: versionNumber,
        status: plan.status === "Failed" ? "Failed" : "Success",
        completed_on: createTime,
      });
      if (!firstVersion) {
        firstVersion = version;
        seedViews(aps, modelSet, version, seed.views ?? []);
      } else {
        insertViewVersions(aps, modelSet, version);
      }
    });
    if (latestModelSetVersion(aps, modelSet.model_set_id)) {
      aps.modelSets.update(modelSet.id, {
        modified_time: latestModelSetVersion(aps, modelSet.model_set_id)!.create_time,
      });
    }

    for (const group of scenarioSeed.groups ?? []) {
      seedClashGroup(aps, store, aps.modelSets.findOneBy("model_set_id", modelSet.model_set_id)!, group);
    }
  }
}

function seedClashGroup(aps: ApsStore, store: Store, modelSet: ApsModelSet, group: ApsClashScenarioGroupSeed): void {
  if (!Number.isInteger(group.at_version) || group.at_version < 1) {
    throw new Error(`APS model set '${modelSet.model_set_id}' clash group at_version must be a positive integer.`);
  }
  createClashGroup(aps, store, modelSet, {
    kind: group.kind,
    version: group.at_version,
    clashes: group.clashes,
    id: group.id,
    issueId: group.issue_id,
    title: group.title,
    description: group.description,
    reason: group.reason,
    screenShots: group.screen_shots,
    createdBy: group.created_by,
  });
}

export function addModelSetVersion(
  aps: ApsStore,
  store: Store,
  modelSet: ApsModelSet,
  overrides?: { processingMs?: number; step?: ApsClashScenarioVersionSeed },
): { version: ApsModelSetVersion; test: ApsClashTest } {
  const previous = latestModelSetVersion(aps, modelSet.model_set_id);
  if (!previous) throw new Error(`APS model set '${modelSet.model_set_id}' has no source version.`);
  const plan = planVersion(
    aps,
    modelSet,
    dmVersionsFor(aps, previous.document_versions),
    overrides?.step ?? {},
    modelSet.clash_scenario.large,
  );
  const createTime = new Date().toISOString();
  const version = aps.modelSetVersions.insert({
    model_set_id: modelSet.model_set_id,
    version: previous.version + 1,
    create_time: createTime,
    status: "Pending",
    document_versions: plan.documents,
  });
  insertViewVersions(aps, modelSet, version);
  const test = aps.clashTests.insert({
    project_id: modelSet.project_id,
    test_id: clashTestIdForVersion(modelSet.model_set_id, version.version),
    model_set_id: modelSet.model_set_id,
    model_set_version: version.version,
    status: "Pending",
    completed_on: null,
  });
  aps.modelSets.update(modelSet.id, {
    modified_time: createTime,
    clash_scenario: {
      ...modelSet.clash_scenario,
      versions: [...modelSet.clash_scenario.versions, plan.scenario],
    },
  });
  clearClashDataCache(store, modelSet.model_set_id);

  const processingMs = overrides?.processingMs ?? getModelCoordinationTiming(store).processing_ms;
  setTimeout(() => {
    aps.modelSetVersions.update(version.id, { status: "Processing" });
    aps.clashTests.update(test.id, { status: "Processing" });
    setTimeout(() => {
      aps.modelSetVersions.update(version.id, { status: plan.status });
      aps.clashTests.update(test.id, {
        status: plan.status === "Failed" ? "Failed" : "Success",
        completed_on: new Date().toISOString(),
      });
    }, processingMs);
  }, processingMs);

  return { version, test };
}
