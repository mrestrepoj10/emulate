import { Store, type Collection } from "@emulators/core";
import type {
  ApsAccProjectUser,
  ApsClient,
  ApsHub,
  ApsIssue,
  ApsIssueType,
  ApsManifest,
  ApsProject,
  ApsRfi,
  ApsRfiAttribute,
  ApsRfiType,
  ApsSheet,
  ApsSheetCollection,
  ApsSheetVersionSet,
  ApsUser,
  ApsWebhookDelivery,
  ApsWebhookDmVersion,
  ApsWebhookHook,
  ApsWebhookSecret,
} from "./entities.js";

export interface ApsStore {
  clients: Collection<ApsClient>;
  users: Collection<ApsUser>;
  hubs: Collection<ApsHub>;
  projects: Collection<ApsProject>;
  manifests: Collection<ApsManifest>;
  accProjectUsers: Collection<ApsAccProjectUser>;
  issueTypes: Collection<ApsIssueType>;
  issues: Collection<ApsIssue>;
  rfiTypes: Collection<ApsRfiType>;
  rfiAttributes: Collection<ApsRfiAttribute>;
  rfis: Collection<ApsRfi>;
  sheetCollections: Collection<ApsSheetCollection>;
  sheetVersionSets: Collection<ApsSheetVersionSet>;
  sheets: Collection<ApsSheet>;
  webhookHooks: Collection<ApsWebhookHook>;
  webhookSecrets: Collection<ApsWebhookSecret>;
  webhookDeliveries: Collection<ApsWebhookDelivery>;
  webhookDmVersions: Collection<ApsWebhookDmVersion>;
}

export function getApsStore(store: Store): ApsStore {
  return {
    clients: store.collection<ApsClient>("aps.clients", ["client_id"]),
    users: store.collection<ApsUser>("aps.users", ["user_id", "email"]),
    hubs: store.collection<ApsHub>("aps.hubs", ["hub_id"]),
    projects: store.collection<ApsProject>("aps.projects", ["project_id", "hub_id"]),
    manifests: store.collection<ApsManifest>("aps.manifests", ["urn"]),
    accProjectUsers: store.collection<ApsAccProjectUser>("aps.accProjectUsers", ["project_id", "user_id"]),
    issueTypes: store.collection<ApsIssueType>("aps.issueTypes", ["project_id", "issue_type_id"]),
    issues: store.collection<ApsIssue>("aps.issues", ["project_id", "issue_id"]),
    rfiTypes: store.collection<ApsRfiType>("aps.rfiTypes", ["project_id", "rfi_type_id"]),
    rfiAttributes: store.collection<ApsRfiAttribute>("aps.rfiAttributes", ["project_id", "attribute_id"]),
    rfis: store.collection<ApsRfi>("aps.rfis", ["project_id", "rfi_id"]),
    sheetCollections: store.collection<ApsSheetCollection>("aps.sheetCollections", ["project_id", "collection_id"]),
    sheetVersionSets: store.collection<ApsSheetVersionSet>("aps.sheetVersionSets", ["project_id", "version_set_id"]),
    sheets: store.collection<ApsSheet>("aps.sheets", ["project_id", "sheet_id"]),
    webhookHooks: store.collection<ApsWebhookHook>("aps.webhookHooks", ["hook_id"]),
    webhookSecrets: store.collection<ApsWebhookSecret>("aps.webhookSecrets", ["identity_key"]),
    webhookDeliveries: store.collection<ApsWebhookDelivery>("aps.webhookDeliveries"),
    webhookDmVersions: store.collection<ApsWebhookDmVersion>("aps.webhookDmVersions", ["version_id"]),
  };
}
