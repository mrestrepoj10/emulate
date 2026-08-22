import type { Store } from "@emulators/core";
import { bareProjectId } from "./acc.js";
import { documentItemForVersion, folderAncestors } from "./dm-tree.js";
import type { ApsDocumentVersion } from "./entities.js";
import type { ApsStore } from "./store.js";
import { simulateWebhookEvent, type ApsWebhookEventInput } from "./webhooks.js";

export function documentVersionAddedEvent(aps: ApsStore, version: ApsDocumentVersion): ApsWebhookEventInput | null {
  const item = documentItemForVersion(aps, version);
  if (!item) return null;
  const folder = aps.documentFolders.findOneBy("folder_id", item.folder_id);
  if (!folder) return null;
  const ancestors = folderAncestors(aps, version.project_id, folder.folder_id);
  const projectId = bareProjectId(version.project_id);
  return {
    system: "data",
    event: "dm.version.added",
    resourceUrn: version.version_id,
    region: version.region,
    scope: { folder: folder.folder_id, project: version.project_id },
    folderAncestors: ancestors.map((ancestor) => ancestor.folder_id),
    payload: {
      ext: version.file_type,
      modifiedTime: version.last_modified_time,
      creator: version.created_by,
      lineageUrn: version.item_id,
      sizeInBytes: version.storage_size,
      hidden: item.hidden,
      indexable: true,
      project: projectId,
      source: version.version_id,
      version: String(version.version_number),
      user_info: { id: version.created_by },
      name: version.display_name,
      createdTime: version.create_time,
      modifiedBy: version.last_modified_by,
      state: "CONTENT_AVAILABLE",
      parentFolderUrn: folder.folder_id,
      ancestors: [...ancestors, folder].map((ancestor) => ({ urn: ancestor.folder_id, name: ancestor.name })),
      tenant: projectId,
    },
  };
}

export async function emitDocumentVersionAdded(aps: ApsStore, store: Store, version: ApsDocumentVersion) {
  const event = documentVersionAddedEvent(aps, version);
  return event ? simulateWebhookEvent(aps, store, event) : null;
}
