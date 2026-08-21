import { createHmac, randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import { DEFAULT_WEBHOOK_TIMING, type ApsWebhookTimingConfig } from "./config.js";
import type { ApsWebhookDelivery, ApsWebhookFilter, ApsWebhookHook, ApsWebhookStatus } from "./entities.js";
import type { ApsStore } from "./store.js";

export const APS_WEBHOOK_REGIONS = ["US", "EMEA", "AUS", "CAN", "DEU", "IND", "JPN", "GBR"] as const;

export const APS_WEBHOOK_EVENTS: Record<string, string[]> = {
  data: [
    "dm.version.added",
    "dm.version.modified",
    "dm.version.deleted",
    "dm.version.moved",
    "dm.version.moved.out",
    "dm.version.copied",
    "dm.version.copied.out",
    "dm.lineage.reserved",
    "dm.lineage.unreserved",
    "dm.lineage.updated",
    "dm.folder.added",
    "dm.folder.modified",
    "dm.folder.deleted",
    "dm.folder.purged",
    "dm.folder.moved",
    "dm.folder.moved.out",
    "dm.folder.copied",
    "dm.folder.copied.out",
    "dm.operation.started",
    "dm.operation.completed",
  ],
  derivative: ["extraction.finished", "extraction.updated"],
  "adsk.c4r": ["model.sync", "model.publish"],
  "adsk.flc.production": [
    "item.clone",
    "item.create",
    "item.lock",
    "item.release",
    "item.unlock",
    "item.update",
    "workflow.transition",
  ],
  "autodesk.construction.cost": [
    "budget.created-1.0",
    "budget.updated-1.0",
    "budget.deleted-1.0",
    "budgetPayment.created-1.0",
    "budgetPayment.updated-1.0",
    "budgetPayment.deleted-1.0",
    "contract.created-1.0",
    "contract.updated-1.0",
    "contract.deleted-1.0",
    "cor.created-1.0",
    "cor.updated-1.0",
    "cor.deleted-1.0",
    "costPayment.created-1.0",
    "costPayment.updated-1.0",
    "costPayment.deleted-1.0",
    "expense.created-1.0",
    "expense.updated-1.0",
    "expense.deleted-1.0",
    "expenseItem.created-1.0",
    "expenseItem.updated-1.0",
    "expenseItem.deleted-1.0",
    "mainContract.created-1.0",
    "mainContract.updated-1.0",
    "mainContract.deleted-1.0",
    "mainContractItem.created-1.0",
    "mainContractItem.updated-1.0",
    "mainContractItem.deleted-1.0",
    "oco.created-1.0",
    "oco.updated-1.0",
    "oco.deleted-1.0",
    "pco.created-1.0",
    "pco.updated-1.0",
    "pco.deleted-1.0",
    "project.initialized-1.0",
    "rfq.created-1.0",
    "rfq.updated-1.0",
    "rfq.deleted-1.0",
    "scheduleOfValue.created-1.0",
    "scheduleOfValue.updated-1.0",
    "scheduleOfValue.deleted-1.0",
    "sco.created-1.0",
    "sco.updated-1.0",
    "sco.deleted-1.0",
    "segmentValue.created-1.0",
    "segmentValue.updated-1.0",
    "segmentValue.deleted-1.0",
  ],
  "autodesk.construction.bc": [
    "bid.created",
    "opportunity.comment.created",
    "opportunity.comment.deleted",
    "opportunity.comment.updated",
    "opportunity.created",
    "opportunity.status.updated",
  ],
  "autodesk.construction.issues": [
    "issue.created-1.0",
    "issue.updated-1.0",
    "issue.deleted-1.0",
    "issue.restored-1.0",
    "issue.unlinked-1.0",
  ],
  "autodesk.construction.reviews": ["review.created-1.0", "review.closed-1.0"],
  "adsk.tandem": ["dt.alert", "dt.mutation", "dt.applyTemplate", "dt.removeTemplate"],
};

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

type Scalar = string | number | boolean | null;

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

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (bracketDepth === 0 && value.slice(index, index + delimiter.length) === delimiter) {
      parts.push(value.slice(start, index).trim());
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parseScalar(value: string): Scalar | undefined {
  const trimmed = value.trim();
  if (/^'(?:[^'\\]|\\.)*'$/.test(trimmed) || /^"(?:[^"\\]|\\.)*"$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(['"\\])/g, "$1");
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return undefined;
}

function parseArray(value: string): Scalar[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const result: Scalar[] = [];
  for (const part of splitTopLevel(body, ",")) {
    const scalar = parseScalar(part);
    if (scalar === undefined) return null;
    result.push(scalar);
  }
  return result;
}

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function evaluateClause(payload: Record<string, unknown>, clause: string): boolean | null {
  const match = clause.match(/^@\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(==|!=|>=|<=|>|<|in)\s*(.+)$/);
  if (!match) return null;
  const [, path, operator, rawExpected] = match;
  const actual = valueAtPath(payload, path!);
  if (operator === "in") {
    const expected = parseArray(rawExpected!);
    return expected ? expected.some((candidate) => candidate === actual) : null;
  }
  const expected = parseScalar(rawExpected!);
  if (expected === undefined) return null;
  if (operator === "==") return actual === expected;
  if (operator === "!=") return actual !== expected;
  if (
    (typeof actual !== "number" || typeof expected !== "number") &&
    (typeof actual !== "string" || typeof expected !== "string")
  ) {
    return false;
  }
  if (operator === ">") return actual > expected;
  if (operator === ">=") return actual >= expected;
  if (operator === "<") return actual < expected;
  return actual <= expected;
}

function evaluateFilterString(filter: string, payload: Record<string, unknown>): boolean | null {
  const trimmed = filter.trim();
  if (!trimmed.startsWith("$[?(") || !trimmed.endsWith(")]")) return null;
  const expression = trimmed.slice(4, -2).trim();
  if (!expression) return null;
  const orGroups = splitTopLevel(expression, "||");
  let valid = true;
  let result = false;
  for (const group of orGroups) {
    const clauses = splitTopLevel(group, "&&");
    let groupMatches = true;
    for (const clause of clauses) {
      const clauseResult = evaluateClause(payload, clause);
      if (clauseResult === null) valid = false;
      if (clauseResult !== true) groupMatches = false;
    }
    if (groupMatches) result = true;
  }
  return valid ? result : null;
}

export function validateWebhookFilter(filter: ApsWebhookFilter): boolean {
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.length > 0 && filters.every((candidate) => evaluateFilterString(candidate, {}) !== null);
}

export function webhookFilterMatches(filter: ApsWebhookFilter | null, payload: Record<string, unknown>): boolean {
  if (filter === null) return true;
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.every((candidate) => evaluateFilterString(candidate, payload) === true);
}

export function webhookEventMatches(pattern: string, event: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`).test(event);
}

function webhookScopeMatches(hook: ApsWebhookHook, input: ApsWebhookEventInput): boolean {
  const entries = Object.entries(hook.scope);
  const eventScope = input.scope ?? {};
  const folderValues = [eventScope.folder, input.scopeValue, ...(input.folderAncestors ?? [])].filter(
    (value): value is string => typeof value === "string",
  );
  const scopeMatches = entries.every(([name, value]) => {
    if (name === "folder") return folderValues.includes(value);
    return eventScope[name] === value || input.scopeValue === value;
  });
  if (!scopeMatches) return false;
  if (!hook.tenant) return true;
  return [input.tenant, input.scopeValue, ...Object.values(eventScope), ...folderValues].includes(hook.tenant);
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
  const overflow = aps.webhookDeliveries
    .all()
    .sort((left, right) => left.id - right.id)
    .slice(0, -MAX_DELIVERIES);
  for (const delivery of overflow) aps.webhookDeliveries.delete(delivery.id);
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
  return (
    hook.token ??
    aps.webhookSecrets.findBy("identity_key", hook.identity_key).find((secret) => secret.region === hook.region)
      ?.token ??
    null
  );
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
  const reports: ApsWebhookDeliveryReport[] = [];
  const candidates = aps.webhookHooks
    .all()
    .filter((hook) => hook.region === input.region && hook.system === input.system)
    .sort((left, right) => left.id - right.id);
  for (const hook of candidates) {
    if (!webhookEventMatches(hook.event, input.event)) {
      reports.push(skippedDelivery(hook, "event"));
      continue;
    }
    if (!webhookScopeMatches(hook, input)) {
      reports.push(skippedDelivery(hook, "scope"));
      continue;
    }
    if (!webhookStatusAllowsDelivery(store, hook)) {
      reports.push(skippedDelivery(hook, "inactive"));
      continue;
    }
    if (!webhookFilterMatches(hook.filter, input.payload)) {
      reports.push(skippedDelivery(hook, "filter"));
      continue;
    }
    reports.push(await deliverMatchingHook(aps, store, hook, input));
  }
  return { system: input.system, event: input.event, resourceUrn: input.resourceUrn, deliveries: reports };
}

export function validWebhookStatus(value: unknown): value is ApsWebhookStatus {
  return value === "active" || value === "inactive" || value === "reactivated";
}
