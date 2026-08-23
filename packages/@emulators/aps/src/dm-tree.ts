import type { InsertInput } from "@emulators/core";
import type { ApsDocumentFolderSeed, ApsSeedConfig } from "./config.js";
import type { ApsDocumentFolder, ApsDocumentItem, ApsDocumentVersion } from "./entities.js";
import { DEFAULT_MANIFEST_URN, DEFAULT_USER_EMAIL } from "./helpers.js";
import type { ApsStore } from "./store.js";

const DEFAULT_TIMESTAMP = "2026-08-19T12:00:00.000Z";

function actorName(aps: ApsStore, actor: string, configuredName?: string): string {
  if (configuredName) return configuredName;
  return aps.users.findOneBy("email", actor)?.name ?? aps.users.findOneBy("user_id", actor)?.name ?? "Test User";
}

function projectFolderId(projectId: string): string {
  return `urn:adsk.wipprod:fs.folder:co.${Buffer.from(projectId).toString("base64url")}`;
}

export function documentFileType(displayName: string): string {
  const separator = displayName.lastIndexOf(".");
  return separator < 0 ? "" : displayName.slice(separator + 1).toLowerCase();
}

export function documentMimeType(extension: string): string {
  switch (extension) {
    case "dwg":
      return "application/acad";
    case "pdf":
      return "application/pdf";
    case "rvt":
      return "application/vnd.autodesk.revit";
    default:
      return "application/octet-stream";
  }
}

export function createDocumentItem(aps: ApsStore, data: InsertInput<ApsDocumentItem>): ApsDocumentItem {
  const folder = aps.documentFolders.findOneBy("folder_id", data.folder_id);
  if (!folder || folder.project_id !== data.project_id) {
    throw new Error(`APS document item '${data.item_id}' references unknown folder '${data.folder_id}'.`);
  }
  if (aps.documentItems.findOneBy("item_id", data.item_id)) {
    throw new Error(`APS document item '${data.item_id}' already exists.`);
  }
  return aps.documentItems.insert(data);
}

export function createDocumentVersion(aps: ApsStore, data: InsertInput<ApsDocumentVersion>): ApsDocumentVersion {
  const item = aps.documentItems.findOneBy("item_id", data.item_id);
  if (!item || item.project_id !== data.project_id) {
    throw new Error(`APS document version '${data.version_id}' references unknown item '${data.item_id}'.`);
  }
  if (!Number.isInteger(data.version_number) || data.version_number < 1) {
    throw new Error(`APS document version '${data.version_id}' must have a positive integer version number.`);
  }
  if (aps.documentVersions.findOneBy("version_id", data.version_id)) {
    throw new Error(`APS document version '${data.version_id}' already exists.`);
  }
  if (
    aps.documentVersions
      .findBy("item_id", data.item_id)
      .some((version) => version.version_number === data.version_number)
  ) {
    throw new Error(`APS document item '${data.item_id}' has more than one version numbered ${data.version_number}.`);
  }
  return aps.documentVersions.insert(data);
}

function versionNumber(versionId: string, configured?: number): number {
  if (configured !== undefined) return configured;
  const match = /[?&]version=(\d+)(?:&|$)/.exec(versionId);
  return match ? Number(match[1]) : 1;
}

function insertFolder(aps: ApsStore, seed: ApsDocumentFolderSeed): ApsDocumentFolder {
  const actor = seed.created_by ?? DEFAULT_USER_EMAIL;
  const actorDisplayName = actorName(aps, actor, seed.created_by_name);
  const created = seed.create_time ?? DEFAULT_TIMESTAMP;
  const modifier = seed.last_modified_by ?? actor;
  return aps.documentFolders.insert({
    folder_id: seed.id,
    project_id: seed.project_id,
    parent_folder_id: seed.parent_folder_id ?? null,
    name: seed.name,
    hidden: seed.hidden ?? false,
    created_by: actor,
    created_by_name: actorDisplayName,
    create_time: created,
    last_modified_by: modifier,
    last_modified_by_name: actorName(aps, modifier, seed.last_modified_by_name),
    last_modified_time: seed.last_modified_time ?? created,
  });
}

function validateFolders(aps: ApsStore): void {
  for (const folder of aps.documentFolders.all()) {
    if (!aps.projects.findOneBy("project_id", folder.project_id)) {
      throw new Error(`APS document folder '${folder.folder_id}' references unknown project '${folder.project_id}'.`);
    }
    if (folder.parent_folder_id) {
      const parent = aps.documentFolders.findOneBy("folder_id", folder.parent_folder_id);
      if (!parent) {
        throw new Error(
          `APS document folder '${folder.folder_id}' references unknown parent '${folder.parent_folder_id}'.`,
        );
      }
      if (parent.project_id !== folder.project_id) {
        throw new Error(`APS document folder '${folder.folder_id}' references a parent from another project.`);
      }
    }
    folderAncestors(aps, folder.project_id, folder.folder_id);
  }
}

function materializeLegacyFolders(
  aps: ApsStore,
  projectId: string,
  folderId: string,
  ancestorFolderIds: string[],
): void {
  const configuredFolder = aps.documentFolders.findOneBy("folder_id", folderId);
  if (ancestorFolderIds.length === 0 && configuredFolder?.project_id === projectId) return;
  const lineage = [...ancestorFolderIds, folderId];
  let parentFolderId: string | undefined;
  lineage.forEach((id, index) => {
    const existing = aps.documentFolders.findOneBy("folder_id", id);
    if (existing) {
      if (existing.project_id !== projectId) throw new Error(`APS document folder '${id}' belongs to another project.`);
      if ((existing.parent_folder_id ?? undefined) !== parentFolderId) {
        throw new Error(`APS legacy document lineage for folder '${id}' conflicts with the configured tree.`);
      }
    } else {
      insertFolder(aps, {
        id,
        project_id: projectId,
        parent_folder_id: parentFolderId,
        name: index === lineage.length - 1 ? "Plans" : `Ancestor ${index + 1}`,
      });
    }
    parentFolderId = id;
  });
}

export function rootFolderForProject(aps: ApsStore, projectId: string): ApsDocumentFolder | undefined {
  return aps.documentFolders.findBy("project_id", projectId).find((folder) => folder.parent_folder_id === null);
}

export function folderAncestors(aps: ApsStore, projectId: string, folderId: string): ApsDocumentFolder[] {
  const folder = aps.documentFolders.findOneBy("folder_id", folderId);
  if (!folder || folder.project_id !== projectId) return [];
  const ancestors: ApsDocumentFolder[] = [];
  const visited = new Set([folder.folder_id]);
  let parentId = folder.parent_folder_id;
  while (parentId) {
    if (visited.has(parentId)) throw new Error(`APS document folder tree contains a cycle at '${parentId}'.`);
    visited.add(parentId);
    const parent = aps.documentFolders.findOneBy("folder_id", parentId);
    if (!parent || parent.project_id !== projectId) return [];
    ancestors.unshift(parent);
    parentId = parent.parent_folder_id;
  }
  return ancestors;
}

export function folderSubtree(aps: ApsStore, projectId: string, folderId: string): ApsDocumentFolder[] {
  const root = aps.documentFolders.findOneBy("folder_id", folderId);
  if (!root || root.project_id !== projectId) return [];
  const folders: ApsDocumentFolder[] = [];
  const pending = [root];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const folder = pending[index]!;
    if (visited.has(folder.folder_id)) {
      throw new Error(`APS document folder tree contains a cycle at '${folder.folder_id}'.`);
    }
    visited.add(folder.folder_id);
    folders.push(folder);
    pending.push(
      ...aps.documentFolders
        .findBy("parent_folder_id", folder.folder_id)
        .filter((candidate) => candidate.project_id === projectId),
    );
  }
  return folders;
}

export function documentItemForVersion(aps: ApsStore, version: ApsDocumentVersion): ApsDocumentItem | undefined {
  const item = aps.documentItems.findOneBy("item_id", version.item_id);
  return item?.project_id === version.project_id ? item : undefined;
}

export function itemTip(aps: ApsStore, itemId: string): ApsDocumentVersion | undefined {
  return aps.documentVersions
    .findBy("item_id", itemId)
    .sort((left, right) => right.version_number - left.version_number)[0];
}

export function seedDocumentTreeFromConfig(aps: ApsStore, config: ApsSeedConfig): void {
  for (const seed of config.document_folders ?? []) {
    if (aps.documentFolders.findOneBy("folder_id", seed.id)) continue;
    insertFolder(aps, seed);
  }

  for (const project of aps.projects.all()) {
    if (aps.documentFolders.findBy("project_id", project.project_id).length > 0) continue;
    insertFolder(aps, {
      id: projectFolderId(project.project_id),
      project_id: project.project_id,
      name: "Project Files",
    });
  }
  validateFolders(aps);

  for (const seed of config.document_items ?? []) {
    if (aps.documentItems.findOneBy("item_id", seed.id)) continue;
    const actor = seed.created_by ?? DEFAULT_USER_EMAIL;
    const created = seed.create_time ?? DEFAULT_TIMESTAMP;
    const modifier = seed.last_modified_by ?? actor;
    createDocumentItem(aps, {
      item_id: seed.id,
      project_id: seed.project_id,
      folder_id: seed.folder_id,
      display_name: seed.display_name,
      hidden: seed.hidden ?? false,
      reserved: seed.reserved ?? false,
      reserved_time: seed.reserved_time ?? null,
      reserved_by: seed.reserved_by ?? null,
      reserved_by_name: seed.reserved_by_name ?? null,
      created_by: actor,
      created_by_name: actorName(aps, actor, seed.created_by_name),
      create_time: created,
      last_modified_by: modifier,
      last_modified_by_name: actorName(aps, modifier, seed.last_modified_by_name),
      last_modified_time: seed.last_modified_time ?? created,
      extension_type: seed.extension_type ?? "items:autodesk.bim360:File",
    });
  }

  const versions = [...(config.document_versions ?? []), ...(config.webhook_dm_versions ?? [])];
  for (const seed of versions) {
    if (aps.documentItems.findOneBy("item_id", seed.item_id)) continue;
    if (!seed.folder_id) {
      throw new Error(`APS document version '${seed.version_id}' references unknown item '${seed.item_id}'.`);
    }
    materializeLegacyFolders(aps, seed.project_id, seed.folder_id, seed.ancestor_folder_ids ?? []);
    const displayName = seed.display_name ?? "model.rvt";
    const actor = seed.created_by ?? DEFAULT_USER_EMAIL;
    const created = seed.create_time ?? DEFAULT_TIMESTAMP;
    const modifier = seed.last_modified_by ?? actor;
    createDocumentItem(aps, {
      item_id: seed.item_id,
      project_id: seed.project_id,
      folder_id: seed.folder_id,
      display_name: displayName,
      hidden: false,
      reserved: false,
      reserved_time: null,
      reserved_by: null,
      reserved_by_name: null,
      created_by: actor,
      created_by_name: actorName(aps, actor, seed.created_by_name),
      create_time: created,
      last_modified_by: modifier,
      last_modified_by_name: actorName(aps, modifier, seed.last_modified_by_name),
      last_modified_time: seed.last_modified_time ?? created,
      extension_type: "items:autodesk.bim360:File",
    });
  }
  validateFolders(aps);

  for (const seed of versions) {
    if (aps.documentVersions.findOneBy("version_id", seed.version_id)) continue;
    const item = aps.documentItems.findOneBy("item_id", seed.item_id);
    if (!item || item.project_id !== seed.project_id) {
      throw new Error(`APS document version '${seed.version_id}' references unknown item '${seed.item_id}'.`);
    }
    if (seed.folder_id && item.folder_id !== seed.folder_id) {
      throw new Error(`APS document version '${seed.version_id}' conflicts with its item's folder.`);
    }
    const displayName = seed.display_name ?? item.display_name;
    const extension = seed.file_type ?? documentFileType(displayName);
    const number = versionNumber(seed.version_id, seed.version_number);
    const bubbleUrn = seed.bubble_urn === undefined ? DEFAULT_MANIFEST_URN : seed.bubble_urn;
    if (bubbleUrn && !aps.manifests.findOneBy("urn", bubbleUrn)) {
      throw new Error(`APS document version '${seed.version_id}' references unknown manifest '${bubbleUrn}'.`);
    }
    const actor = seed.created_by ?? DEFAULT_USER_EMAIL;
    const created = seed.create_time ?? item.create_time;
    const modifier = seed.last_modified_by ?? actor;
    createDocumentVersion(aps, {
      version_id: seed.version_id,
      item_id: seed.item_id,
      project_id: seed.project_id,
      version_number: number,
      display_name: displayName,
      file_type: extension,
      mime_type: seed.mime_type ?? documentMimeType(extension),
      storage_size: seed.storage_size ?? 0,
      storage_urn:
        seed.storage_urn ?? `urn:adsk.objects:os.object:emulate-bucket/${encodeURIComponent(seed.version_id)}`,
      region: (seed.region ?? "US").toUpperCase(),
      bubble_urn: bubbleUrn,
      viewable_id: seed.viewable_id ?? "emulate-3d-view",
      viewable_guid: seed.viewable_guid ?? "d8e734a8-6e9e-4f4d-9a4f-000000000001",
      created_by: actor,
      created_by_name: actorName(aps, actor, seed.created_by_name),
      create_time: created,
      last_modified_by: modifier,
      last_modified_by_name: actorName(aps, modifier, seed.last_modified_by_name),
      last_modified_time: seed.last_modified_time ?? created,
    });
  }
}
