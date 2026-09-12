import type { AppEnv, Context, MiddlewareHandler, Store } from "@emulators/core";
import { commaSeparated, projectForAccId } from "./acc.js";
import { accessTokenForRequest } from "./auth.js";
import type { ApsModelSet, ApsProject } from "./entities.js";
import {
  MODEL_SET_REGIONS,
  getModelCoordinationFaults,
  projectHasCoordinationEntitlement,
} from "./model-coordination.js";
import { badInput, notFound, problem } from "./problem.js";
import type { ApsStore } from "./store.js";

const RATE_LIMIT_KEY = "aps.modelCoordinationRateLimit";
const RATE_WINDOW_MS = 60_000;

export function coordinationProject(c: Context<AppEnv>, aps: ApsStore): ApsProject | Response {
  const containerId = c.req.param("containerId");
  const result = projectForAccId(aps, containerId, "bare");
  if (result.kind === "invalid") {
    return badInput(c, "containerId", `The value '${containerId}' must not include the 'b.' prefix.`);
  }
  if (result.kind === "missing") return notFound(c, "The requested container");
  return result.project;
}

export function modelSetForProject(c: Context<AppEnv>, aps: ApsStore, project: ApsProject): ApsModelSet | Response {
  const modelSet = aps.modelSets.findOneBy("model_set_id", c.req.param("modelSetId"));
  if (!modelSet || modelSet.project_id !== project.project_id) return notFound(c, "The requested model set");
  return modelSet;
}

function continuationToken(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}

function continuationOffset(token: string | undefined): number | null {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) return null;
    const offset = Number(decoded);
    return Number.isSafeInteger(offset) ? offset : null;
  } catch {
    return null;
  }
}

export function coordinationPage<T>(
  c: Context<AppEnv>,
  items: T[],
): { items: T[]; page: { continuationToken?: string } } | Response {
  const limitValue = c.req.query("pageLimit");
  const limit = limitValue === undefined ? 20 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return badInput(c, "pageLimit", `The value '${limitValue ?? ""}' must be an integer from 1 through 20.`);
  }
  const token = c.req.query("continuationToken");
  const offset = continuationOffset(token);
  if (offset === null) return badInput(c, "continuationToken", `The value '${token}' is not valid.`);
  const nextOffset = offset + limit;
  return {
    items: items.slice(offset, nextOffset),
    page: nextOffset < items.length ? { continuationToken: continuationToken(nextOffset) } : {},
  };
}

export function booleanQuery(c: Context<AppEnv>, name: string, fallback: boolean): boolean | Response {
  const value = c.req.query(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return badInput(c, name, `The value '${value}' must be true or false.`);
}

export function queryValues(c: Context<AppEnv>, name: string): string[] {
  return (c.req.queries(name) ?? []).flatMap(commaSeparated);
}

/** Parses an ISO 8601 query value into epoch milliseconds; `undefined` when absent, a 400 when malformed. */
export function dateQuery(c: Context<AppEnv>, name: string): number | undefined | Response {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return badInput(c, name, `The value '${value}' must be an ISO 8601 date-time.`);
  return parsed;
}

export function sortQuery(c: Context<AppEnv>): "Asc" | "Desc" | Response {
  const value = c.req.query("sort");
  if (value === undefined || value === "Asc" || value === "Desc") return value ?? "Asc";
  return badInput(c, "sort", `The value '${value}' must be Asc or Desc.`);
}

function rateLimitWindows(store: Store): Map<string, number[]> {
  let windows = store.getData<Map<string, number[]>>(RATE_LIMIT_KEY);
  if (!windows) {
    windows = new Map();
    store.setData(RATE_LIMIT_KEY, windows);
  }
  return windows;
}

export function resetModelCoordinationRateLimit(store: Store): void {
  rateLimitWindows(store).clear();
}

/**
 * Shared Model Coordination request handling: region header validation and echo, project entitlement, and the
 * per-user sliding-window rate limit. Mount after `apsAuth` on `/containers/:containerId/*`.
 */
export function coordinationMiddleware(store: Store, aps: ApsStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const region = c.req.header("region") ?? c.req.header("x-ads-region");
    if (region !== undefined) {
      const normalized = region.trim().toUpperCase();
      if (!(MODEL_SET_REGIONS as readonly string[]).includes(normalized)) {
        return badInput(c, "region", `The value '${region}' must be one of ${MODEL_SET_REGIONS.join(", ")}.`);
      }
      c.header("x-emulate-region", normalized);
    }

    const faults = getModelCoordinationFaults(store);
    if (faults.rate_limit_per_minute > 0) {
      const token = await accessTokenForRequest(c, store);
      const key = token?.apsUserId ?? token?.clientId ?? "anonymous";
      const now = Date.now();
      const windows = rateLimitWindows(store);
      const recent = (windows.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
      if (recent.length >= faults.rate_limit_per_minute) {
        const retryAfterMs = recent[0]! + RATE_WINDOW_MS - now;
        c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        windows.set(key, recent);
        return problem(c, 429, {
          type: "TooManyRequests",
          title: "Rate limit exceeded",
          detail: `The Model Coordination rate limit of ${faults.rate_limit_per_minute} requests per minute per user was exceeded. Retry after the Retry-After interval.`,
        });
      }
      recent.push(now);
      windows.set(key, recent);
    }

    const containerId = c.req.param("containerId");
    if (containerId) {
      const result = projectForAccId(aps, containerId, "bare");
      if (result.kind === "found" && !projectHasCoordinationEntitlement(store, result.project.project_id)) {
        return problem(c, 403, {
          type: "Forbidden",
          title: "Model Coordination is not enabled for this project",
          detail: `Container '${containerId}' does not have a BIM Collaborate entitlement for Model Coordination.`,
        });
      }
    }

    await next();
  };
}
