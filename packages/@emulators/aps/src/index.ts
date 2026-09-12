import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { DEFAULT_DATA_SEED, type ApsSeedConfig } from "./config.js";
import { seedDocumentTreeFromConfig } from "./dm-tree.js";
import {
  getModelCoordinationFaults,
  getModelCoordinationTiming,
  seedModelCoordinationFromConfig,
  setModelCoordinationFaults,
  setModelCoordinationTiming,
} from "./model-coordination.js";
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
import { ingestionRoutes } from "./routes/ingestion.js";
import { clashRoutes } from "./routes/clash.js";
import { issueRoutes } from "./routes/issues.js";
import { modelDerivativeRoutes } from "./routes/model-derivative.js";
import { modelPropertiesIndexRoutes } from "./routes/model-properties-index.js";
import { modelSetRoutes } from "./routes/modelset.js";
import { oauthRoutes } from "./routes/oauth.js";
import { rfiRoutes } from "./routes/rfis.js";
import { sheetRoutes } from "./routes/sheets.js";
import { simulateRoutes } from "./routes/simulate.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { seedAccFromConfig } from "./seed-acc.js";
import { signedBlobRoutes } from "./signed-blobs.js";
import { getApsStore } from "./store.js";
import { setTranslationConfig, setUploadConfig } from "./ingestion-config.js";
import { getModelPropertiesIndexConfig, setModelPropertiesIndexConfig } from "./model-properties-index.js";
import {
  appIdentity,
  createWebhookRecord,
  findDuplicateHook,
  setWebhookTiming,
  userIdentity,
  type CreateWebhookRecordInput,
} from "./webhooks.js";

export { getApsStore, type ApsStore } from "./store.js";
export {
  CLASH_CLOSE_REASONS,
  DEFAULT_CLASH_SCENARIO,
  DEFAULT_DATA_SEED,
  DEFAULT_TRANSLATION_CONFIG,
  DEFAULT_UPLOAD_CONFIG,
  DEFAULT_MODEL_COORDINATION_FAULTS,
  DEFAULT_MODEL_COORDINATION_TIMING,
  DEFAULT_MODEL_PROPERTIES_INDEX_CONFIG,
  DEFAULT_WEBHOOK_TIMING,
  type ApsClashScenarioGroupSeed,
  type ApsClashScenarioSeed,
  type ApsClashScenarioVersionSeed,
  type ApsDocumentVersionSeed,
  type ApsDocumentFolderSeed,
  type ApsDocumentItemSeed,
  type ApsModelCoordinationFaultsConfig,
  type ApsModelCoordinationTimingConfig,
  type ApsModelPropertiesIndexConfig,
  type ApsModelSetViewSeed,
  type ApsSeedConfig,
  type ApsTranslationConfig,
  type ApsUploadConfig,
  type ApsWebhookTimingConfig,
} from "./config.js";
export * from "./entities.js";
export { getTranslationConfig, getUploadConfig, setTranslationConfig, setUploadConfig } from "./ingestion-config.js";
export {
  getModelCoordinationFaults,
  getModelCoordinationTiming,
  setModelCoordinationFaults,
  setModelCoordinationTiming,
};
export {
  CLASH_RESOURCE_TYPES,
  LMV_ID_OFFSET,
  createClashGroup,
  encodeClashResource,
  versionClashData,
} from "./model-coordination.js";
export { mulberry32, replayClashScenario } from "./clash-scenario.js";
export { resetModelCoordinationRateLimit } from "./model-coordination-http.js";
export { getModelPropertiesIndexConfig, setModelPropertiesIndexConfig };
export { getWebhookTiming, setWebhookTiming, simulateWebhookEvent, webhookDetails } from "./webhooks.js";

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

  if (config.webhook_timing) setWebhookTiming(store, config.webhook_timing);
  if (config.upload) setUploadConfig(store, config.upload);
  if (config.translation) setTranslationConfig(store, config.translation);

  seedDocumentTreeFromConfig(aps, config);

  seedModelCoordinationFromConfig(aps, store, config);

  if (config.model_properties_index) setModelPropertiesIndexConfig(store, config.model_properties_index);

  for (const hook of config.webhooks ?? []) {
    const user = hook.creator_user_email ? aps.users.findOneBy("email", hook.creator_user_email) : undefined;
    const clientId = hook.creator_client_id ?? DEFAULT_CONFIDENTIAL_CLIENT_ID;
    if (hook.creator_user_email && !user) {
      throw new Error(`APS webhook references unknown user '${hook.creator_user_email}'.`);
    }
    if (!user && !aps.clients.findOneBy("client_id", clientId)) {
      throw new Error(`APS webhook references unknown client '${clientId}'.`);
    }
    const input: CreateWebhookRecordInput = {
      system: hook.system,
      event: hook.event,
      callbackUrl: hook.callback_url,
      scope: hook.scope,
      tenant: hook.tenant,
      identity: user ? userIdentity(user.user_id) : appIdentity(clientId),
      region: (hook.region ?? "US").toUpperCase(),
      status: hook.status,
      autoReactivateHook: hook.auto_reactivate_hook,
      hookExpiry: hook.hook_expiry,
      hookAttribute: hook.hook_attribute,
      filter: hook.filter,
      token: hook.token,
      hubId: hook.hub_id,
      projectId: hook.project_id,
    };
    if (findDuplicateHook(aps, input)) continue;
    createWebhookRecord(aps, input);
  }
}

export const apsPlugin: ServicePlugin = {
  name: "aps",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    dataManagementRoutes(ctx);
    ingestionRoutes(ctx);
    modelDerivativeRoutes(ctx);
    modelPropertiesIndexRoutes(ctx);
    modelSetRoutes(ctx);
    clashRoutes(ctx);
    issueRoutes(ctx);
    rfiRoutes(ctx);
    sheetRoutes(ctx);
    webhookRoutes(ctx);
    signedBlobRoutes(ctx);
    simulateRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default apsPlugin;
