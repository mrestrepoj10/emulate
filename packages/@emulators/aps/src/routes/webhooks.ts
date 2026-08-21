import { randomUUID } from "node:crypto";
import type { AppEnv, ContentfulStatusCode, Context, RouteContext } from "@emulators/core";
import { accessTokenForRequest } from "../auth.js";
import type { ApsWebhookFilter, ApsWebhookHook } from "../entities.js";
import { getApsStore } from "../store.js";
import {
  APS_WEBHOOK_EVENTS,
  APS_WEBHOOK_REGIONS,
  canonicalWebhookScope,
  createWebhookRecord,
  deleteExpiredHooks,
  type CreateWebhookRecordInput,
  type WebhookIdentity,
  validWebhookStatus,
  validateWebhookFilter,
  webhookDetails,
} from "../webhooks.js";

const PAGE_SIZE = 200;
const SCOPE_QUOTA = 1000;

type HookPayload = Omit<CreateWebhookRecordInput, "system" | "event" | "region" | "identity">;

function webhookError(c: Context<AppEnv>, status: ContentfulStatusCode): Response {
  return c.json({ id: randomUUID() }, status);
}

async function authorize(
  c: Context<AppEnv>,
  store: RouteContext["store"],
  scopes: string[],
  appOnly = false,
): Promise<WebhookIdentity | Response> {
  const token = await accessTokenForRequest(c, store);
  if (!token) return webhookError(c, 401);
  const granted = token.scope.split(/\s+/).filter(Boolean);
  if (scopes.some((scope) => !granted.includes(scope))) return webhookError(c, 403);
  if (appOnly && token.apsUserId) return webhookError(c, 403);
  return token.apsUserId
    ? { key: `user:${token.apsUserId}`, createdBy: token.apsUserId, creatorType: "O2User" }
    : { key: `app:${token.clientId}`, createdBy: token.clientId, creatorType: "Application" };
}

function requestRegion(c: Context<AppEnv>): string | null {
  const value = c.req.header("region") ?? c.req.header("x-ads-region") ?? c.req.query("region") ?? "US";
  const normalized = value.toUpperCase();
  return APS_WEBHOOK_REGIONS.includes(normalized as (typeof APS_WEBHOOK_REGIONS)[number]) ? normalized : null;
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json<unknown>();
    return recordObject(body) ? body : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown, nullable = false): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseScope(value: unknown): Record<string, string> | null {
  if (!recordObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([, item]) => typeof item !== "string" || !item.trim())) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function validHookAttribute(value: unknown): value is Record<string, unknown> {
  return recordObject(value) && Buffer.byteLength(JSON.stringify(value), "utf8") < 1024;
}

function parseFilter(value: unknown): ApsWebhookFilter | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return validateWebhookFilter(value) ? value : undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const filters = value as string[];
    return validateWebhookFilter(filters) ? filters : undefined;
  }
  return undefined;
}

function parseExpiry(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseHookPayload(body: Record<string, unknown>): HookPayload | null {
  const callbackUrl = stringField(body.callbackUrl);
  const scope = parseScope(body.scope);
  if (!callbackUrl || !scope) return null;
  if (body.autoReactivateHook !== undefined && typeof body.autoReactivateHook !== "boolean") return null;
  if (body.hookAttribute !== undefined && !validHookAttribute(body.hookAttribute)) return null;
  const filter = parseFilter(body.filter);
  if (body.filter !== undefined && filter === undefined) return null;
  const hookExpiry = parseExpiry(body.hookExpiry);
  if (body.hookExpiry !== undefined && hookExpiry === undefined) return null;
  const token = stringField(body.token);
  if (body.token !== undefined && token === undefined) return null;
  const tenant = stringField(body.tenant);
  const hubId = stringField(body.hubId);
  const projectId = stringField(body.projectId);
  if (body.tenant !== undefined && tenant === undefined) return null;
  if (body.hubId !== undefined && hubId === undefined) return null;
  if (body.projectId !== undefined && projectId === undefined) return null;
  return {
    callbackUrl,
    scope,
    tenant: tenant ?? undefined,
    autoReactivateHook: body.autoReactivateHook as boolean | undefined,
    hookExpiry,
    hookAttribute: (body.hookAttribute as Record<string, unknown> | undefined) ?? null,
    filter: filter ?? null,
    token: token ?? null,
    hubId: hubId ?? null,
    projectId: projectId ?? null,
  };
}

function identityHooks(hooks: ApsWebhookHook[], identity: WebhookIdentity, region: string): ApsWebhookHook[] {
  return hooks.filter((hook) => hook.identity_key === identity.key && hook.region === region);
}

function duplicateHook(
  hooks: ApsWebhookHook[],
  identity: WebhookIdentity,
  region: string,
  system: string,
  event: string,
  payload: HookPayload,
): boolean {
  const scope = canonicalWebhookScope(payload.scope);
  return identityHooks(hooks, identity, region).some(
    (hook) =>
      hook.system === system &&
      hook.event === event &&
      hook.callback_url === payload.callbackUrl &&
      canonicalWebhookScope(hook.scope) === scope,
  );
}

function overQuota(
  hooks: ApsWebhookHook[],
  identity: WebhookIdentity,
  region: string,
  scope: Record<string, string>,
  additional: number,
): boolean {
  const canonical = canonicalWebhookScope(scope);
  const count = identityHooks(hooks, identity, region).filter(
    (hook) => canonicalWebhookScope(hook.scope) === canonical,
  ).length;
  return count + additional > SCOPE_QUOTA;
}

function encodePageState(offset: number): string {
  return Buffer.from(`aps-webhooks:${offset}`, "utf8").toString("base64");
}

function decodePageState(value: string | undefined): number | null {
  if (!value) return 0;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const match = decoded.match(/^aps-webhooks:(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function listResponse(c: Context<AppEnv>, hooks: ApsWebhookHook[]): Response {
  const offset = decodePageState(c.req.query("pageState"));
  if (offset === null) return webhookError(c, 400);
  if (!hooks.length || offset >= hooks.length) return c.body(null, 204);
  const data = hooks.slice(offset, offset + PAGE_SIZE).map(webhookDetails);
  const links: Record<string, string> = {};
  if (offset + PAGE_SIZE < hooks.length) {
    const url = new URL(c.req.url);
    url.searchParams.set("pageState", encodePageState(offset + PAGE_SIZE));
    const relativePath = url.pathname.replace(/^\/webhooks\/v1/, "") || "/";
    links.next = `${relativePath}?${url.searchParams.toString()}`;
  }
  return c.json({ links, data });
}

function filterStatus(c: Context<AppEnv>, hooks: ApsWebhookHook[]): ApsWebhookHook[] | null {
  const status = c.req.query("status");
  if (status !== undefined && !validWebhookStatus(status)) return null;
  return status ? hooks.filter((hook) => hook.status === status) : hooks;
}

function visibleHook(
  hooks: ApsWebhookHook[],
  identity: WebhookIdentity,
  region: string,
  system: string,
  event: string,
  hookId: string,
): ApsWebhookHook | undefined {
  return identityHooks(hooks, identity, region).find(
    (hook) => hook.hook_id === hookId && hook.system === system && hook.event === event,
  );
}

export function webhookRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);

  app.post("/webhooks/v1/systems/:system/events/:event/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const body = await readObject(c);
    const payload = body ? parseHookPayload(body) : null;
    if (!region || !payload) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const system = c.req.param("system");
    const event = c.req.param("event");
    if (duplicateHook(aps.webhookHooks.all(), identity, region, system, event, payload)) {
      return webhookError(c, 409);
    }
    if (overQuota(aps.webhookHooks.all(), identity, region, payload.scope, 1)) return webhookError(c, 400);
    const hook = createWebhookRecord(aps, { ...payload, identity, region, system, event });
    c.header(
      "Location",
      `/webhooks/v1/systems/${encodeURIComponent(system)}/events/${encodeURIComponent(event)}/hooks/${encodeURIComponent(hook.hook_id)}`,
    );
    return c.body(null, 201);
  });

  app.get("/webhooks/v1/systems/:system/events/:event/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    let hooks = identityHooks(aps.webhookHooks.all(), identity, region).filter(
      (hook) => hook.system === c.req.param("system") && hook.event === c.req.param("event"),
    );
    const scopeName = c.req.query("scopeName");
    const scopeValue = c.req.query("scopeValue");
    if (scopeName) hooks = hooks.filter((hook) => scopeName in hook.scope);
    if (scopeName && scopeValue) hooks = hooks.filter((hook) => hook.scope[scopeName] === scopeValue);
    const filtered = filterStatus(c, hooks);
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.get("/webhooks/v1/systems/:system/events/:event/hooks/:hookId", async (c) => {
    const identity = await authorize(c, store, ["data:read"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const hook = visibleHook(
      aps.webhookHooks.all(),
      identity,
      region,
      c.req.param("system"),
      c.req.param("event"),
      c.req.param("hookId"),
    );
    return hook ? c.json(webhookDetails(hook)) : webhookError(c, 404);
  });

  app.patch("/webhooks/v1/systems/:system/events/:event/hooks/:hookId", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const body = await readObject(c);
    if (!region || !body) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const hook = visibleHook(
      aps.webhookHooks.all(),
      identity,
      region,
      c.req.param("system"),
      c.req.param("event"),
      c.req.param("hookId"),
    );
    if (!hook) return webhookError(c, 404);
    const update: Partial<ApsWebhookHook> = {};
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "inactive") return webhookError(c, 400);
      update.status = body.status;
      update.failed_event_count = body.status === "active" ? 0 : hook.failed_event_count;
      update.inactive_at = body.status === "inactive" ? new Date().toISOString() : null;
    }
    if (body.autoReactivateHook !== undefined) {
      if (typeof body.autoReactivateHook !== "boolean") return webhookError(c, 400);
      update.auto_reactivate_hook = body.autoReactivateHook;
    }
    if (body.filter !== undefined) {
      const filter = parseFilter(body.filter);
      if (filter === undefined) return webhookError(c, 400);
      update.filter = filter;
    }
    if (body.hookAttribute !== undefined) {
      if (body.hookAttribute !== null && !validHookAttribute(body.hookAttribute)) return webhookError(c, 400);
      update.hook_attribute = body.hookAttribute as Record<string, unknown> | null;
    }
    if (body.token !== undefined) {
      const token = stringField(body.token);
      if (!token) return webhookError(c, 400);
      update.token = token;
    }
    if (body.hookExpiry !== undefined) {
      const hookExpiry = parseExpiry(body.hookExpiry);
      if (hookExpiry === undefined) return webhookError(c, 400);
      update.hook_expiry = hookExpiry;
    }
    aps.webhookHooks.update(hook.id, update);
    return c.body(null, 200);
  });

  app.delete("/webhooks/v1/systems/:system/events/:event/hooks/:hookId", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const hook = visibleHook(
      aps.webhookHooks.all(),
      identity,
      region,
      c.req.param("system"),
      c.req.param("event"),
      c.req.param("hookId"),
    );
    if (!hook) return webhookError(c, 404);
    aps.webhookHooks.delete(hook.id);
    return c.body(null, 204);
  });

  app.post("/webhooks/v1/systems/:system/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const body = await readObject(c);
    const payload = body ? parseHookPayload(body) : null;
    if (!region || !payload) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const system = c.req.param("system");
    const events = APS_WEBHOOK_EVENTS[system] ?? ["*"];
    if (overQuota(aps.webhookHooks.all(), identity, region, payload.scope, events.length)) {
      return webhookError(c, 400);
    }
    if (events.some((event) => duplicateHook(aps.webhookHooks.all(), identity, region, system, event, payload))) {
      return webhookError(c, 409);
    }
    const hooks = events.map((event) => createWebhookRecord(aps, { ...payload, identity, region, system, event }));
    return c.json({ hooks: hooks.map(webhookDetails) }, 201);
  });

  app.get("/webhooks/v1/systems/:system/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const hooks = identityHooks(aps.webhookHooks.all(), identity, region).filter(
      (hook) => hook.system === c.req.param("system"),
    );
    const filtered = filterStatus(c, hooks);
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.get("/webhooks/v1/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const filtered = filterStatus(c, identityHooks(aps.webhookHooks.all(), identity, region));
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.get("/webhooks/v1/app/hooks", async (c) => {
    const identity = await authorize(c, store, ["data:read"], true);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const sort = c.req.query("sort") ?? "desc";
    if (!region || (sort !== "asc" && sort !== "desc")) return webhookError(c, 400);
    deleteExpiredHooks(aps);
    const hooks = identityHooks(aps.webhookHooks.all(), identity, region).sort((left, right) => {
      const comparison = Date.parse(left.updated_at) - Date.parse(right.updated_at);
      return sort === "asc" ? comparison : -comparison;
    });
    const filtered = filterStatus(c, hooks);
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.post("/webhooks/v1/tokens", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const body = await readObject(c);
    const token = body ? stringField(body.token) : undefined;
    if (!region || !token) return webhookError(c, 400);
    const existing = aps.webhookSecrets.findBy("identity_key", identity.key).find((secret) => secret.region === region);
    if (existing) return webhookError(c, 400);
    aps.webhookSecrets.insert({ identity_key: identity.key, region, token });
    return c.json({ status: 200, detail: [`Token created successfully for client: ${identity.createdBy}`] });
  });

  app.put("/webhooks/v1/tokens/@me", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    const body = await readObject(c);
    const token = body ? stringField(body.token) : undefined;
    if (!region || !token) return webhookError(c, 400);
    const existing = aps.webhookSecrets.findBy("identity_key", identity.key).find((secret) => secret.region === region);
    if (!existing) return webhookError(c, 404);
    aps.webhookSecrets.update(existing.id, { token });
    return c.body(null, 204);
  });

  app.delete("/webhooks/v1/tokens/@me", async (c) => {
    const identity = await authorize(c, store, ["data:read", "data:write"]);
    if (identity instanceof Response) return identity;
    const region = requestRegion(c);
    if (!region) return webhookError(c, 400);
    const existing = aps.webhookSecrets.findBy("identity_key", identity.key).find((secret) => secret.region === region);
    if (!existing) return webhookError(c, 404);
    aps.webhookSecrets.delete(existing.id);
    return c.body(null, 204);
  });
}
