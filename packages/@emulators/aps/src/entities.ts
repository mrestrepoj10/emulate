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
