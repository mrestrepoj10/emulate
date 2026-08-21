import { randomUUID } from "node:crypto";
import type { AppEnv, ContentfulStatusCode, Context, RouteContext, Store } from "@emulators/core";
import { accessTokenForRequest, tokenGrantsScopes } from "../auth.js";
import type { ApsWebhookFilter, ApsWebhookHook } from "../entities.js";
import { isRecordObject, jsonObjectBody } from "../helpers.js";
import { getApsStore, type ApsStore } from "../store.js";
import { APS_WEBHOOK_EVENTS, parseWebhookRegion } from "../webhook-events.js";
import { validateWebhookFilter } from "../webhook-filter.js";
import {
  appIdentity,
  canonicalWebhookScope,
  createWebhookRecord,
  deleteExpiredHooks,
  findDuplicateHook,
  findWebhookSecret,
  type CreateWebhookRecordInput,
  type WebhookIdentity,
  userIdentity,
  validWebhookStatus,
  webhookDetails,
} from "../webhooks.js";

const PAGE_SIZE = 200;
const SCOPE_QUOTA = 1000;
const READ_SCOPES = ["data:read"];
const WRITE_SCOPES = ["data:read", "data:write"];

function webhookError(c: Context<AppEnv>, status: ContentfulStatusCode): Response {
  return c.json({ id: randomUUID() }, status);
}

interface WebhookRequestContext {
  identity: WebhookIdentity;
  region: string;
}

async function webhookContext(
  c: Context<AppEnv>,
  store: Store,
  aps: ApsStore,
  scopes: string[],
  appOnly = false,
): Promise<WebhookRequestContext | Response> {
  const token = await accessTokenForRequest(c, store);
  if (!token) return webhookError(c, 401);
  if (!tokenGrantsScopes(token, scopes)) return webhookError(c, 403);
  if (appOnly && token.apsUserId) return webhookError(c, 403);
  const region = parseWebhookRegion(
    c.req.header("region") ?? c.req.header("x-ads-region") ?? c.req.query("region") ?? "US",
  );
  if (!region) return webhookError(c, 400);
  deleteExpiredHooks(aps);
  const identity = token.apsUserId ? userIdentity(token.apsUserId) : appIdentity(token.clientId);
  return { identity, region };
}

// Field parsers distinguish a missing field (undefined) from a malformed one (INVALID),
// so callers never have to re-consult the raw body to tell the two apart.
const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

function optional<T>(parse: (value: unknown) => T | Invalid): (value: unknown) => T | undefined | Invalid {
  return (value) => (value === undefined ? undefined : parse(value));
}

function nullable<T>(parse: (value: unknown) => T | Invalid): (value: unknown) => T | null | Invalid {
  return (value) => (value === null ? null : parse(value));
}

function asString(value: unknown): string | Invalid {
  return typeof value === "string" && value.trim() ? value : INVALID;
}

function asBoolean(value: unknown): boolean | Invalid {
  return typeof value === "boolean" ? value : INVALID;
}

function asHookAttribute(value: unknown): Record<string, unknown> | Invalid {
  return isRecordObject(value) && Buffer.byteLength(JSON.stringify(value), "utf8") < 1024 ? value : INVALID;
}

function asFilter(value: unknown): ApsWebhookFilter | Invalid {
  const filter =
    typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))
      ? (value as ApsWebhookFilter)
      : undefined;
  return filter !== undefined && validateWebhookFilter(filter) ? filter : INVALID;
}

function asExpiry(value: unknown): string | Invalid {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : INVALID;
}

const optString = optional(asString);
const optBoolean = optional(asBoolean);
const optAttribute = optional(asHookAttribute);
const optNullableAttribute = optional(nullable(asHookAttribute));
const optFilter = optional(nullable(asFilter));
const optExpiry = optional(nullable(asExpiry));

function parseHookScope(value: unknown): Record<string, string> | null {
  if (!isRecordObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([, item]) => typeof item !== "string" || !item.trim())) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

type HookPayload = Omit<CreateWebhookRecordInput, "system" | "event" | "region" | "identity">;

function parseHookPayload(body: Record<string, unknown>): HookPayload | null {
  const callbackUrl = optString(body.callbackUrl);
  const scope = parseHookScope(body.scope);
  const tenant = optString(body.tenant);
  const autoReactivateHook = optBoolean(body.autoReactivateHook);
  const hookAttribute = optAttribute(body.hookAttribute);
  const filter = optFilter(body.filter);
  const hookExpiry = optExpiry(body.hookExpiry);
  const token = optString(body.token);
  const hubId = optString(body.hubId);
  const projectId = optString(body.projectId);
  if (
    callbackUrl === undefined ||
    callbackUrl === INVALID ||
    !scope ||
    tenant === INVALID ||
    autoReactivateHook === INVALID ||
    hookAttribute === INVALID ||
    filter === INVALID ||
    hookExpiry === INVALID ||
    token === INVALID ||
    hubId === INVALID ||
    projectId === INVALID
  ) {
    return null;
  }
  return {
    callbackUrl,
    scope,
    tenant,
    autoReactivateHook,
    hookExpiry,
    hookAttribute: hookAttribute ?? null,
    filter: filter ?? null,
    token: token ?? null,
    hubId: hubId ?? null,
    projectId: projectId ?? null,
  };
}

function parseHookUpdate(body: Record<string, unknown>, hook: ApsWebhookHook): Partial<ApsWebhookHook> | null {
  const status =
    body.status === undefined || body.status === "active" || body.status === "inactive" ? body.status : INVALID;
  const autoReactivateHook = optBoolean(body.autoReactivateHook);
  const filter = optFilter(body.filter);
  const hookAttribute = optNullableAttribute(body.hookAttribute);
  const token = optString(body.token);
  const hookExpiry = optExpiry(body.hookExpiry);
  if (
    status === INVALID ||
    autoReactivateHook === INVALID ||
    filter === INVALID ||
    hookAttribute === INVALID ||
    token === INVALID ||
    hookExpiry === INVALID
  ) {
    return null;
  }
  const update: Partial<ApsWebhookHook> = {};
  if (status !== undefined) {
    update.status = status;
    update.failed_event_count = status === "active" ? 0 : hook.failed_event_count;
    update.inactive_at = status === "inactive" ? new Date().toISOString() : null;
  }
  if (autoReactivateHook !== undefined) update.auto_reactivate_hook = autoReactivateHook;
  if (filter !== undefined) update.filter = filter;
  if (hookAttribute !== undefined) update.hook_attribute = hookAttribute;
  if (token !== undefined) update.token = token;
  if (hookExpiry !== undefined) update.hook_expiry = hookExpiry;
  return update;
}

function identityHooks(aps: ApsStore, { identity, region }: WebhookRequestContext): ApsWebhookHook[] {
  return aps.webhookHooks.all().filter((hook) => hook.identity_key === identity.key && hook.region === region);
}

function overQuota(
  aps: ApsStore,
  context: WebhookRequestContext,
  scope: Record<string, string>,
  additional: number,
): boolean {
  const canonical = canonicalWebhookScope(scope);
  const count = identityHooks(aps, context).filter((hook) => canonicalWebhookScope(hook.scope) === canonical).length;
  return count + additional > SCOPE_QUOTA;
}

function visibleHook(aps: ApsStore, context: WebhookRequestContext, c: Context<AppEnv>): ApsWebhookHook | undefined {
  const hook = aps.webhookHooks.findOneBy("hook_id", c.req.param("hookId"));
  return hook &&
    hook.identity_key === context.identity.key &&
    hook.region === context.region &&
    hook.system === c.req.param("system") &&
    hook.event === c.req.param("event")
    ? hook
    : undefined;
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

export function webhookRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);

  app.post("/webhooks/v1/systems/:system/events/:event/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const body = await jsonObjectBody(c);
    const payload = body ? parseHookPayload(body) : null;
    if (!payload) return webhookError(c, 400);
    const system = c.req.param("system");
    const event = c.req.param("event");
    const input = { ...payload, identity: context.identity, region: context.region, system, event };
    if (findDuplicateHook(aps, input)) return webhookError(c, 409);
    if (overQuota(aps, context, payload.scope, 1)) return webhookError(c, 400);
    const hook = createWebhookRecord(aps, input);
    c.header(
      "Location",
      `/webhooks/v1/systems/${encodeURIComponent(system)}/events/${encodeURIComponent(event)}/hooks/${encodeURIComponent(hook.hook_id)}`,
    );
    return c.body(null, 201);
  });

  app.get("/webhooks/v1/systems/:system/events/:event/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, READ_SCOPES);
    if (context instanceof Response) return context;
    let hooks = identityHooks(aps, context).filter(
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
    const context = await webhookContext(c, store, aps, READ_SCOPES);
    if (context instanceof Response) return context;
    const hook = visibleHook(aps, context, c);
    return hook ? c.json(webhookDetails(hook)) : webhookError(c, 404);
  });

  app.patch("/webhooks/v1/systems/:system/events/:event/hooks/:hookId", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const body = await jsonObjectBody(c);
    if (!body) return webhookError(c, 400);
    const hook = visibleHook(aps, context, c);
    if (!hook) return webhookError(c, 404);
    const update = parseHookUpdate(body, hook);
    if (!update) return webhookError(c, 400);
    aps.webhookHooks.update(hook.id, update);
    return c.body(null, 200);
  });

  app.delete("/webhooks/v1/systems/:system/events/:event/hooks/:hookId", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const hook = visibleHook(aps, context, c);
    if (!hook) return webhookError(c, 404);
    aps.webhookHooks.delete(hook.id);
    return c.body(null, 204);
  });

  app.post("/webhooks/v1/systems/:system/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const body = await jsonObjectBody(c);
    const payload = body ? parseHookPayload(body) : null;
    if (!payload) return webhookError(c, 400);
    const system = c.req.param("system");
    const events = APS_WEBHOOK_EVENTS[system] ?? ["*"];
    const inputs = events.map((event) => ({
      ...payload,
      identity: context.identity,
      region: context.region,
      system,
      event,
    }));
    if (inputs.some((input) => findDuplicateHook(aps, input))) return webhookError(c, 409);
    if (overQuota(aps, context, payload.scope, events.length)) return webhookError(c, 400);
    const hooks = inputs.map((input) => createWebhookRecord(aps, input));
    return c.json({ hooks: hooks.map(webhookDetails) }, 201);
  });

  app.get("/webhooks/v1/systems/:system/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, READ_SCOPES);
    if (context instanceof Response) return context;
    const hooks = identityHooks(aps, context).filter((hook) => hook.system === c.req.param("system"));
    const filtered = filterStatus(c, hooks);
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.get("/webhooks/v1/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, READ_SCOPES);
    if (context instanceof Response) return context;
    const filtered = filterStatus(c, identityHooks(aps, context));
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.get("/webhooks/v1/app/hooks", async (c) => {
    const context = await webhookContext(c, store, aps, READ_SCOPES, true);
    if (context instanceof Response) return context;
    const sort = c.req.query("sort") ?? "desc";
    if (sort !== "asc" && sort !== "desc") return webhookError(c, 400);
    const hooks = identityHooks(aps, context).sort((left, right) => {
      const comparison = Date.parse(left.updated_at) - Date.parse(right.updated_at);
      return sort === "asc" ? comparison : -comparison;
    });
    const filtered = filterStatus(c, hooks);
    return filtered ? listResponse(c, filtered) : webhookError(c, 400);
  });

  app.post("/webhooks/v1/tokens", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const body = await jsonObjectBody(c);
    const token = body ? optString(body.token) : undefined;
    if (token === undefined || token === INVALID) return webhookError(c, 400);
    if (findWebhookSecret(aps, context.identity.key, context.region)) return webhookError(c, 400);
    aps.webhookSecrets.insert({ identity_key: context.identity.key, region: context.region, token });
    return c.json({ status: 200, detail: [`Token created successfully for client: ${context.identity.createdBy}`] });
  });

  app.put("/webhooks/v1/tokens/@me", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const body = await jsonObjectBody(c);
    const token = body ? optString(body.token) : undefined;
    if (token === undefined || token === INVALID) return webhookError(c, 400);
    const existing = findWebhookSecret(aps, context.identity.key, context.region);
    if (!existing) return webhookError(c, 404);
    aps.webhookSecrets.update(existing.id, { token });
    return c.body(null, 204);
  });

  app.delete("/webhooks/v1/tokens/@me", async (c) => {
    const context = await webhookContext(c, store, aps, WRITE_SCOPES);
    if (context instanceof Response) return context;
    const existing = findWebhookSecret(aps, context.identity.key, context.region);
    if (!existing) return webhookError(c, 404);
    aps.webhookSecrets.delete(existing.id);
    return c.body(null, 204);
  });
}
