import type { Entity } from "@emulators/core";

export type ApsClientType = "confidential" | "public";

export interface ApsClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  type: ApsClientType;
  redirect_uris: string[];
}

export interface ApsUser extends Entity {
  user_id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  picture: string | null;
}

export interface ApsHub extends Entity {
  hub_id: string;
  name: string;
  region: string;
}

export interface ApsProject extends Entity {
  project_id: string;
  hub_id: string;
  name: string;
}

export type ApsIssuePermission = "manage" | "full_visibility" | "read";

export interface ApsAccProjectUser extends Entity {
  project_id: string;
  user_id: string;
  role: "project_admin" | "member";
  issue_permission: ApsIssuePermission;
  rfi_roles: string[];
}

export interface ApsActorRef {
  id: string;
  type: string;
}

/**
 * ACC entities store the full API response document as a typed `payload`.
 * The payload is the single source of truth: the fields routes filter or sort
 * on are declared explicitly, the long tail of response-only fields rides
 * along through the index signature. Entities add only the store's lookup
 * keys next to the payload — never a second copy of payload data.
 */
export interface ApsIssueSubtypeDoc extends Record<string, unknown> {
  id: string;
}

export interface ApsIssueTypeDoc extends Record<string, unknown> {
  id: string;
  isActive: boolean;
  subtypes: ApsIssueSubtypeDoc[];
}

export interface ApsIssueType extends Entity {
  project_id: string;
  issue_type_id: string;
  payload: ApsIssueTypeDoc;
}

export interface ApsIssueDoc extends Record<string, unknown> {
  id: string;
  displayId: number;
  title: string;
  status: string;
  issueTypeId: string;
  issueSubtypeId: string;
  assignedTo: string | null;
  deleted: boolean;
}

export interface ApsIssue extends Entity {
  project_id: string;
  issue_id: string;
  payload: ApsIssueDoc;
}

export interface ApsRfiTypeDoc extends Record<string, unknown> {
  id: string;
  status: string;
  isDefault: boolean;
}

export interface ApsRfiType extends Entity {
  project_id: string;
  rfi_type_id: string;
  payload: ApsRfiTypeDoc;
}

export interface ApsRfiAttributeDoc extends Record<string, unknown> {
  id: string;
  status: string;
}

export interface ApsRfiAttribute extends Entity {
  project_id: string;
  attribute_id: string;
  payload: ApsRfiAttributeDoc;
}

export interface ApsRfiDoc extends Record<string, unknown> {
  id: string;
  customIdentifier: string;
  title: string;
  question: string;
  status: string;
  assignedTo: ApsActorRef[];
  rfiTypeId: string;
  reference: string;
  priority: string;
  responses: unknown[];
  draftResponses: unknown[];
}

export interface ApsRfi extends Entity {
  project_id: string;
  rfi_id: string;
  payload: ApsRfiDoc;
}

export interface ApsSheetCollectionDoc extends Record<string, unknown> {
  id: string;
  name: string;
}

export interface ApsSheetCollection extends Entity {
  project_id: string;
  collection_id: string;
  payload: ApsSheetCollectionDoc;
}

export interface ApsSheetCollectionRef {
  id: string;
  name: string;
}

export interface ApsSheetVersionSetDoc extends Record<string, unknown> {
  id: string;
  name: string;
  issuanceDate: string;
  collection: ApsSheetCollectionRef | null;
}

export interface ApsSheetVersionSet extends Entity {
  project_id: string;
  version_set_id: string;
  payload: ApsSheetVersionSetDoc;
}

export interface ApsSheetVersionSetRef {
  id: string;
  name: string;
  issuanceDate: string;
  deleted: boolean;
}

export interface ApsSheetDoc extends Record<string, unknown> {
  id: string;
  number: string;
  title: string;
  tags: string[];
  isCurrent: boolean;
  deleted: boolean;
  versionSet: ApsSheetVersionSetRef;
  collection: ApsSheetCollectionRef | null;
}

export interface ApsSheet extends Entity {
  project_id: string;
  sheet_id: string;
  payload: ApsSheetDoc;
}

export type ApsManifestDerivative = Record<string, unknown>;

export interface ApsManifest extends Entity {
  urn: string;
  type: string;
  hasThumbnail: string;
  status: string;
  progress: string;
  region: string;
  version: string;
  derivatives: ApsManifestDerivative[];
}
