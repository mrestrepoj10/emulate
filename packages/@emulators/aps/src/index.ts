import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { DEFAULT_DATA_SEED, type ApsSeedConfig } from "./config.js";
import {
  createDefaultConfidentialClient,
  createDefaultPublicClient,
  createDefaultUser,
  DEFAULT_CONFIDENTIAL_CLIENT_ID,
  DEFAULT_PUBLIC_CLIENT_ID,
  DEFAULT_USER_EMAIL,
  generateUserId,
  normalizeClientType,
  splitName,
} from "./helpers.js";
import { dataManagementRoutes } from "./routes/data-management.js";
import { issueRoutes } from "./routes/issues.js";
import { modelDerivativeRoutes } from "./routes/model-derivative.js";
import { oauthRoutes } from "./routes/oauth.js";
import { rfiRoutes } from "./routes/rfis.js";
import { sheetRoutes } from "./routes/sheets.js";
import { seedAccFromConfig } from "./seed-acc.js";
import { getApsStore } from "./store.js";

export { getApsStore, type ApsStore } from "./store.js";
export { DEFAULT_DATA_SEED, type ApsSeedConfig } from "./config.js";
export * from "./entities.js";

function seedDefaults(store: Store, baseUrl: string): void {
  const aps = getApsStore(store);

  if (!aps.clients.findOneBy("client_id", DEFAULT_CONFIDENTIAL_CLIENT_ID)) {
    aps.clients.insert(createDefaultConfidentialClient());
  }
  if (!aps.clients.findOneBy("client_id", DEFAULT_PUBLIC_CLIENT_ID)) {
    aps.clients.insert(createDefaultPublicClient());
  }
  if (!aps.users.findOneBy("email", DEFAULT_USER_EMAIL)) {
    aps.users.insert(createDefaultUser());
  }
  seedFromConfig(store, baseUrl, DEFAULT_DATA_SEED);
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ApsSeedConfig): void {
  const aps = getApsStore(store);

  if (config.clients) {
    for (const client of config.clients) {
      const existing = aps.clients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      const type = normalizeClientType(client.type, client.client_secret ? "confidential" : "public");
      aps.clients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret ?? "",
        name: client.name ?? client.client_id,
        type,
        redirect_uris: client.redirect_uris,
      });
    }
  }

  if (config.users) {
    for (const user of config.users) {
      const byEmail = aps.users.findOneBy("email", user.email);
      if (byEmail) continue;
      const name = user.name ?? "Test User";
      const { first_name, last_name } = splitName(name, user.email);
      aps.users.insert({
        user_id: user.user_id ?? generateUserId(),
        email: user.email,
        name,
        first_name,
        last_name,
        picture: user.picture ?? null,
      });
    }
  }

  if (config.hubs) {
    for (const hub of config.hubs) {
      if (aps.hubs.findOneBy("hub_id", hub.id)) continue;
      aps.hubs.insert({
        hub_id: hub.id,
        name: hub.name,
        region: hub.region ?? "US",
      });
    }
  }

  if (config.projects) {
    for (const project of config.projects) {
      if (aps.projects.findOneBy("project_id", project.id)) continue;
      if (!aps.hubs.findOneBy("hub_id", project.hub_id)) {
        throw new Error(`APS project '${project.id}' references unknown hub '${project.hub_id}'.`);
      }
      aps.projects.insert({
        project_id: project.id,
        hub_id: project.hub_id,
        name: project.name,
      });
    }
  }

  seedAccFromConfig(aps, config);

  if (config.manifests) {
    for (const [urn, manifest] of Object.entries(config.manifests)) {
      if (aps.manifests.findOneBy("urn", urn)) continue;
      aps.manifests.insert({
        urn,
        type: manifest.type ?? "manifest",
        hasThumbnail: manifest.hasThumbnail ?? "false",
        status: manifest.status ?? "success",
        progress: manifest.progress ?? "complete",
        region: manifest.region ?? "US",
        version: manifest.version ?? "1.0",
        derivatives: structuredClone(manifest.derivatives ?? []),
      });
    }
  }
}

export const apsPlugin: ServicePlugin = {
  name: "aps",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    dataManagementRoutes(ctx);
    modelDerivativeRoutes(ctx);
    issueRoutes(ctx);
    rfiRoutes(ctx);
    sheetRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default apsPlugin;
