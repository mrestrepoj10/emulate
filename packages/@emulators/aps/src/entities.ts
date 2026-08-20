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

export interface ApsIssueType extends Entity {
  project_id: string;
  issue_type_id: string;
  is_active: boolean;
  payload: Record<string, unknown>;
}

export interface ApsIssue extends Entity {
  project_id: string;
  issue_id: string;
  issue_type_id: string;
  issue_subtype_id: string;
  display_id: number;
  title: string;
  status: string;
  assigned_to: string | null;
  deleted: boolean;
  payload: Record<string, unknown>;
}

export interface ApsRfiType extends Entity {
  project_id: string;
  rfi_type_id: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface ApsRfiAttribute extends Entity {
  project_id: string;
  attribute_id: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface ApsRfi extends Entity {
  project_id: string;
  rfi_id: string;
  rfi_type_id: string;
  custom_identifier: string;
  title: string;
  status: string;
  assigned_to: string[];
  reference: string;
  priority: string;
  payload: Record<string, unknown>;
}

export interface ApsSheetCollection extends Entity {
  project_id: string;
  collection_id: string;
  payload: Record<string, unknown>;
}

export interface ApsSheetVersionSet extends Entity {
  project_id: string;
  version_set_id: string;
  collection_id: string | null;
  issuance_date: string;
  payload: Record<string, unknown>;
}

export interface ApsSheet extends Entity {
  project_id: string;
  sheet_id: string;
  version_set_id: string;
  collection_id: string | null;
  number: string;
  title: string;
  tags: string[];
  is_current: boolean;
  deleted: boolean;
  payload: Record<string, unknown>;
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
