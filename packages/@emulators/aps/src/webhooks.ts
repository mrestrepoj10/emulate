import { createHmac, randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import { DEFAULT_WEBHOOK_TIMING, type ApsWebhookTimingConfig } from "./config.js";
import type {
  ApsWebhookDelivery,
  ApsWebhookFilter,
  ApsWebhookHook,
  ApsWebhookSecret,
  ApsWebhookStatus,
} from "./entities.js";
import type { ApsStore } from "./store.js";
import { webhookFilterMatches } from "./webhook-filter.js";

const TIMING_STORE_KEY = "aps.webhooks.timing";
const MAX_DELIVERIES = 1000;

async function sendWebhookRequest(request: {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{ status_code: number | null; duration: number; success: boolean }> {
  const start = Date.now();
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return { status_code: response.status, duration: Date.now() - start, success: response.ok };
  } catch {
    return { status_code: null, duration: Date.now() - start, success: false };
  }
}

export interface WebhookIdentity {
  key: string;
  createdBy: string;
  creatorType: "Application" | "O2User";
}

export function userIdentity(userId: string): WebhookIdentity {
  return { key: `user:${userId}`, createdBy: userId, creatorType: "O2User" };
}

export function appIdentity(clientId: string): WebhookIdentity {
  return { key: `app:${clientId}`, createdBy: clientId, creatorType: "Application" };
}

export interface CreateWebhookRecordInput {
  system: string;
  event: string;
  callbackUrl: string;
  scope: Record<string, string>;
  tenant?: string;
  region: string;
  identity: WebhookIdentity;
  status?: "active" | "inactive";
  autoReactivateHook?: boolean;
  hookExpiry?: string | null;
  hookAttribute?: Record<string, unknown> | null;
  filter?: ApsWebhookFilter | null;
  token?: string | null;
  hubId?: string | null;
  projectId?: string | null;
}

export interface ApsWebhookEventInput {
  system: string;
  event: string;
  resourceUrn: string;
  payload: Record<string, unknown>;
  region: string;
  tenant?: string;
  scopeValue?: string;
  scope?: Record<string, string>;
  folderAncestors?: string[];
}

export interface ApsWebhookDeliveryReport {
  hookId: string;
  matched: boolean;
  delivered: boolean;
  statusCode: number | null;
  attempts: number;
  signaturePresent: boolean;
  reason?: string;
}

export interface ApsWebhookSimulationReport {
  system: string;
  event: string;
  resourceUrn: string;
  deliveries: ApsWebhookDeliveryReport[];
}

export function getWebhookTiming(store: Store): ApsWebhookTimingConfig {
  return { ...DEFAULT_WEBHOOK_TIMING, ...(store.getData<Partial<ApsWebhookTimingConfig>>(TIMING_STORE_KEY) ?? {}) };
}

export function setWebhookTiming(store: Store, timing: Partial<ApsWebhookTimingConfig>): void {
  store.setData(TIMING_STORE_KEY, { ...getWebhookTiming(store), ...timing });
}

export function canonicalWebhookScope(scope: Record<string, string>): string {
  return JSON.stringify(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right)));
}

export function createWebhookRecord(aps: ApsStore, input: CreateWebhookRecordInput): ApsWebhookHook {
  return aps.webhookHooks.insert({
    hook_id: randomUUID(),
    // APS derives a hook's tenant from its scope value when none is supplied.
    tenant: input.tenant ?? Object.values(input.scope)[0] ?? "",
    callback_url: input.callbackUrl,
    created_by: input.identity.createdBy,
    creator_type: input.identity.creatorType,
    identity_key: input.identity.key,
    event: input.event,
    system: input.system,
    status: input.status ?? "active",
    auto_reactivate_hook: input.autoReactivateHook ?? false,
    hook_expiry: input.hookExpiry ?? null,
    hook_attribute: structuredClone(input.hookAttribute ?? null),
    filter: structuredClone(input.filter ?? null),
    scope: structuredClone(input.scope),
    hub_id: input.hubId ?? null,
    project_id: input.projectId ?? null,
    token: input.token ?? null,
    region: input.region,
    failed_event_count: 0,
    inactive_at: input.status === "inactive" ? new Date().toISOString() : null,
    reactivation_count: 0,
  });
}

export function findDuplicateHook(aps: ApsStore, input: CreateWebhookRecordInput): ApsWebhookHook | undefined {
  const canonical = canonicalWebhookScope(input.scope);
  return aps.webhookHooks
    .all()
    .find(
      (hook) =>
        hook.identity_key === input.identity.key &&
        hook.region === input.region &&
        hook.system === input.system &&
        hook.event === input.event &&
        hook.callback_url === input.callbackUrl &&
        canonicalWebhookScope(hook.scope) === canonical,
    );
}

export function findWebhookSecret(aps: ApsStore, identityKey: string, region: string): ApsWebhookSecret | undefined {
  return aps.webhookSecrets.findBy("identity_key", identityKey).find((secret) => secret.region === region);
}

export function webhookDetails(hook: ApsWebhookHook): Record<string, unknown> {
  const details: Record<string, unknown> = {
    hookId: hook.hook_id,
    tenant: hook.tenant,
    callbackUrl: hook.callback_url,
    createdBy: hook.created_by,
    event: hook.event,
    createdDate: hook.created_at,
    lastUpdatedDate: hook.updated_at,
    system: hook.system,
    creatorType: hook.creator_type,
    status: hook.status,
    autoReactivateHook: hook.auto_reactivate_hook,
    scope: structuredClone(hook.scope),
    urn: `urn:adsk.webhooks:events.hook:${hook.hook_id}`,
    __self__: `/systems/${encodeURIComponent(hook.system)}/events/${encodeURIComponent(hook.event)}/hooks/${encodeURIComponent(hook.hook_id)}`,
  };
  if (hook.hook_expiry !== null) details.hookExpiry = hook.hook_expiry;
  if (hook.hook_attribute !== null) details.hookAttribute = structuredClone(hook.hook_attribute);
  if (hook.filter !== null) details.filter = structuredClone(hook.filter);
  if (hook.hub_id !== null) details.hubId = hook.hub_id;
  if (hook.project_id !== null) details.projectId = hook.project_id;
  return details;
}

export function webhookEventMatches(pattern: string, event: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`).test(event);
}

interface EventScopeCandidates {
  /** Candidate values per scope key; the "folder" entry includes the event's folder ancestors. */
  byName: Map<string, string[]>;
  /** Values that satisfy any scope key (the event's primary scope value). */
  anyKey: string[];
  /** Values that satisfy a hook's tenant check. */
  tenants: string[];
}

function eventScopeCandidates(input: ApsWebhookEventInput): EventScopeCandidates {
  const eventScope = input.scope ?? {};
  const ancestors = input.folderAncestors ?? [];
  const anyKey = input.scopeValue !== undefined ? [input.scopeValue] : [];
  const byName = new Map(Object.entries(eventScope).map(([name, value]) => [name, [value]]));
  byName.set("folder", [...(byName.get("folder") ?? []), ...ancestors]);
  const tenants = [
    ...(input.tenant !== undefined ? [input.tenant] : []),
    ...anyKey,
    ...Object.values(eventScope),
    ...ancestors,
  ];
  return { byName, anyKey, tenants };
}

function webhookScopeMatches(hook: ApsWebhookHook, candidates: EventScopeCandidates): boolean {
  const scopeMatches = Object.entries(hook.scope).every(
    ([name, value]) => (candidates.byName.get(name) ?? []).includes(value) || candidates.anyKey.includes(value),
  );
  if (!scopeMatches) return false;
  return !hook.tenant || candidates.tenants.includes(hook.tenant);
}

function skippedDelivery(hook: ApsWebhookHook, reason: string): ApsWebhookDeliveryReport {
  return {
    hookId: hook.hook_id,
    matched: false,
    delivered: false,
    statusCode: null,
    attempts: 0,
    signaturePresent: false,
    reason,
  };
}

function webhookStatusAllowsDelivery(store: Store, hook: ApsWebhookHook, now = Date.now()): boolean {
  if (hook.status === "active" || hook.status === "reactivated") return true;
  const inactiveAt = hook.inactive_at ? Date.parse(hook.inactive_at) : Number.NaN;
  const timing = getWebhookTiming(store);
  return (
    hook.auto_reactivate_hook &&
    Number.isFinite(inactiveAt) &&
    now - inactiveAt >= timing.reactivate_after_ms &&
    hook.reactivation_count < timing.max_reactivation_cycles
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addDelivery(aps: ApsStore, data: Omit<ApsWebhookDelivery, "id" | "created_at" | "updated_at">): void {
  aps.webhookDeliveries.insert(data);
  // Collection.all() preserves insertion order, so the front of the list is the oldest deliveries.
  for (const delivery of aps.webhookDeliveries.all().slice(0, -MAX_DELIVERIES)) {
    aps.webhookDeliveries.delete(delivery.id);
  }
}

async function attemptDelivery(
  aps: ApsStore,
  hook: ApsWebhookHook,
  input: ApsWebhookEventInput,
  token: string | null,
  timeoutMs: number,
  attempt: number,
): Promise<{ success: boolean; statusCode: number | null; signaturePresent: boolean }> {
  const envelope = {
    version: "1.0",
    resourceUrn: input.resourceUrn,
    hook: webhookDetails(hook),
    payload: input.payload,
  };
  const body = JSON.stringify(envelope);
  const deliveryId = randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-adsk-delivery-id": deliveryId,
  };
  if (token) {
    headers["x-adsk-signature"] = `sha1hash=${createHmac("sha1", token).update(body).digest("hex")}`;
  }
  const result = await sendWebhookRequest({ url: hook.callback_url, headers, body, timeoutMs });
  addDelivery(aps, {
    delivery_id: deliveryId,
    hook_id: hook.hook_id,
    system: input.system,
    event: input.event,
    attempt,
    envelope,
    status_code: result.status_code,
    duration: result.duration,
    success: result.success,
    signature_present: Boolean(token),
  });
  return { success: result.success, statusCode: result.status_code, signaturePresent: Boolean(token) };
}

function identityToken(aps: ApsStore, hook: ApsWebhookHook): string | null {
  return hook.token ?? findWebhookSecret(aps, hook.identity_key, hook.region)?.token ?? null;
}

async function deliverMatchingHook(
  aps: ApsStore,
  store: Store,
  hook: ApsWebhookHook,
  input: ApsWebhookEventInput,
): Promise<ApsWebhookDeliveryReport> {
  const timing = getWebhookTiming(store);
  let current = hook;
  let reactivationTrial = current.status === "reactivated";
  if (current.status === "inactive") {
    if (!webhookStatusAllowsDelivery(store, current)) return skippedDelivery(current, "inactive");
    current = aps.webhookHooks.update(current.id, {
      status: "reactivated",
      reactivation_count: current.reactivation_count + 1,
    })!;
    reactivationTrial = true;
  }

  const token = identityToken(aps, current);
  const maxAttempts = reactivationTrial ? 1 : timing.max_retries + 1;
  let lastStatus: number | null = null;
  let signaturePresent = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptDelivery(aps, current, input, token, timing.delivery_timeout_ms, attempt);
    lastStatus = result.statusCode;
    signaturePresent = result.signaturePresent;
    if (result.success) {
      aps.webhookHooks.update(current.id, {
        status: "active",
        failed_event_count: 0,
        inactive_at: null,
      });
      return {
        hookId: current.hook_id,
        matched: true,
        delivered: true,
        statusCode: lastStatus,
        attempts: attempt,
        signaturePresent,
      };
    }
    if (attempt < maxAttempts) {
      await delay(Math.min(timing.retry_base_ms * 2 ** (attempt - 1), timing.retry_max_ms));
    }
  }

  if (reactivationTrial) {
    const permanent = current.reactivation_count >= timing.max_reactivation_cycles;
    aps.webhookHooks.update(current.id, {
      status: "inactive",
      inactive_at: new Date().toISOString(),
      auto_reactivate_hook: permanent ? false : current.auto_reactivate_hook,
    });
  } else {
    const failedEventCount = current.failed_event_count + 1;
    const inactive = failedEventCount >= timing.failed_events_before_inactive;
    aps.webhookHooks.update(current.id, {
      failed_event_count: failedEventCount,
      status: inactive ? "inactive" : current.status,
      inactive_at: inactive ? new Date().toISOString() : current.inactive_at,
    });
  }
  return {
    hookId: current.hook_id,
    matched: true,
    delivered: false,
    statusCode: lastStatus,
    attempts: maxAttempts,
    signaturePresent,
    reason: "delivery_failed",
  };
}

export function deleteExpiredHooks(aps: ApsStore, now = Date.now()): void {
  for (const hook of aps.webhookHooks.all()) {
    if (hook.hook_expiry !== null && Date.parse(hook.hook_expiry) <= now) aps.webhookHooks.delete(hook.id);
  }
}

export async function simulateWebhookEvent(
  aps: ApsStore,
  store: Store,
  input: ApsWebhookEventInput,
): Promise<ApsWebhookSimulationReport> {
  deleteExpiredHooks(aps);
  const candidates = eventScopeCandidates(input);
  const hooks = aps.webhookHooks.all().filter((hook) => hook.region === input.region && hook.system === input.system);
  // Deliveries to distinct hooks are independent; run them concurrently and keep report order.
  const reports = await Promise.all(
    hooks.map((hook) => {
      if (!webhookEventMatches(hook.event, input.event)) return skippedDelivery(hook, "event");
      if (!webhookScopeMatches(hook, candidates)) return skippedDelivery(hook, "scope");
      if (!webhookStatusAllowsDelivery(store, hook)) return skippedDelivery(hook, "inactive");
      if (!webhookFilterMatches(hook.filter, input.payload)) return skippedDelivery(hook, "filter");
      return deliverMatchingHook(aps, store, hook, input);
    }),
  );
  return { system: input.system, event: input.event, resourceUrn: input.resourceUrn, deliveries: reports };
}

export function validWebhookStatus(value: unknown): value is ApsWebhookStatus {
  return value === "active" || value === "inactive" || value === "reactivated";
}
