import { Store, type Collection } from "@emulators/core";
import type { ApsClient, ApsHub, ApsManifest, ApsProject, ApsUser } from "./entities.js";

export interface ApsStore {
  clients: Collection<ApsClient>;
  users: Collection<ApsUser>;
  hubs: Collection<ApsHub>;
  projects: Collection<ApsProject>;
  manifests: Collection<ApsManifest>;
}

export function getApsStore(store: Store): ApsStore {
  return {
    clients: store.collection<ApsClient>("aps.clients", ["client_id"]),
    users: store.collection<ApsUser>("aps.users", ["user_id", "email"]),
    hubs: store.collection<ApsHub>("aps.hubs", ["hub_id"]),
    projects: store.collection<ApsProject>("aps.projects", ["project_id", "hub_id"]),
    manifests: store.collection<ApsManifest>("aps.manifests", ["urn"]),
  };
}
