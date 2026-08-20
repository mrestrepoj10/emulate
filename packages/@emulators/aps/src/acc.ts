import type { AppEnv, Collection, Context, Entity, Store } from "@emulators/core";
import { storedAccessToken } from "./auth.js";
import type { ApsAccProjectUser, ApsProject, ApsUser } from "./entities.js";
import type { ApsStore } from "./store.js";

export type AccProjectIdRule = "bare" | "bare-or-prefixed";

export interface OffsetPagination {
  limit: number;
  offset: number;
}

export type PaginationParseResult = { ok: true; value: OffsetPagination } | { ok: false; message: string };

export type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

export function bareProjectId(projectId: string): string {
  return projectId.startsWith("b.") ? projectId.slice(2) : projectId;
}

export function projectForAccId(
  aps: ApsStore,
  requestedProjectId: string,
  rule: AccProjectIdRule,
): { kind: "found"; project: ApsProject } | { kind: "invalid" } | { kind: "missing" } {
  if (rule === "bare" && requestedProjectId.startsWith("b.")) return { kind: "invalid" };

  const bareId = bareProjectId(requestedProjectId);
  const project = aps.projects.all().find((candidate) => bareProjectId(candidate.project_id) === bareId);
  return project ? { kind: "found", project } : { kind: "missing" };
}

export function findProjectResource<T extends Entity & { project_id: string }, K extends keyof T>(
  collection: Collection<T>,
  projectId: string,
  idField: K,
  id: T[K],
): T | undefined {
  return collection.findBy("project_id", projectId).find((item) => item[idField] === id);
}

function integerValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function parseOffsetPagination(
  limitValue: unknown,
  offsetValue: unknown,
  options: { defaultLimit: number; maxLimit: number },
): PaginationParseResult {
  const limit = limitValue === undefined ? options.defaultLimit : integerValue(limitValue);
  const offset = offsetValue === undefined ? 0 : integerValue(offsetValue);

  if (limit === null || limit < 1 || limit > options.maxLimit) {
    return { ok: false, message: `limit must be an integer between 1 and ${options.maxLimit}.` };
  }
  if (offset === null || offset < 0) {
    return { ok: false, message: "offset must be a non-negative integer." };
  }
  return { ok: true, value: { limit, offset } };
}

export function queryPagination(
  c: Context<AppEnv>,
  options: { defaultLimit: number; maxLimit: number },
): PaginationParseResult {
  return parseOffsetPagination(c.req.query("limit"), c.req.query("offset"), options);
}

export function pageItems<T>(items: T[], pagination: OffsetPagination): T[] {
  return items.slice(pagination.offset, pagination.offset + pagination.limit);
}

export function offsetEnvelope<T>(items: T[], pagination: OffsetPagination, totalResults: number) {
  return {
    pagination: { ...pagination, totalResults },
    results: items,
  };
}

function pageUrl(requestUrl: string, pagination: OffsetPagination, offset: number): string {
  const url = new URL(requestUrl);
  url.searchParams.set("limit", String(pagination.limit));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

export function sheetsEnvelope<T>(items: T[], pagination: OffsetPagination, totalResults: number, requestUrl: string) {
  const previousOffset = Math.max(0, pagination.offset - pagination.limit);
  const nextOffset = pagination.offset + pagination.limit;
  return {
    results: items,
    pagination: {
      ...pagination,
      previousUrl: pagination.offset > 0 ? pageUrl(requestUrl, pagination, previousOffset) : "",
      nextUrl: nextOffset < totalResults ? pageUrl(requestUrl, pagination, nextOffset) : "",
      totalResults,
    },
  };
}

export function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function readJsonObject(c: Context<AppEnv>): Promise<JsonObjectResult> {
  try {
    const value = await c.req.json<unknown>();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, message: "The request body must be a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, message: "The request body must contain valid JSON." };
  }
}

export type AccUserResolution = { kind: "user"; user: ApsUser } | { kind: "app" } | { kind: "unknown-user" };

/**
 * Resolves the acting user behind a request `apsAuth` already authenticated:
 * the token's user for 3-legged tokens, otherwise the x-user-id header (ACC's
 * 2-legged impersonation), otherwise the bare app.
 */
export function resolveAccUser(c: Context<AppEnv>, store: Store, aps: ApsStore): AccUserResolution {
  const requestedUserId = storedAccessToken(c, store)?.apsUserId ?? c.req.header("x-user-id");
  if (!requestedUserId) return { kind: "app" };
  const user = aps.users.findOneBy("user_id", requestedUserId);
  return user ? { kind: "user", user } : { kind: "unknown-user" };
}

export function accProjectUser(aps: ApsStore, projectId: string, userId: string): ApsAccProjectUser | null {
  return findProjectResource(aps.accProjectUsers, projectId, "user_id", userId) ?? null;
}

export type AccRequestErrorKind = "invalid-project-id" | "project-not-found" | "user-required" | "not-a-member";

export type AccErrorResponder = (c: Context<AppEnv>, kind: AccRequestErrorKind) => Response;

export interface AccMemberContext {
  project: ApsProject;
  user: ApsUser;
  member: ApsAccProjectUser;
}

/**
 * Shared request pipeline for ACC services that require project membership:
 * resolve the project by the service's ID rule, then the acting user, then
 * their membership. Failures render through the service's own error dialect.
 */
export function accMemberContext(
  c: Context<AppEnv>,
  store: Store,
  aps: ApsStore,
  options: { idRule: AccProjectIdRule; error: AccErrorResponder },
): AccMemberContext | Response {
  const projectResult = projectForAccId(aps, c.req.param("projectId"), options.idRule);
  if (projectResult.kind === "invalid") return options.error(c, "invalid-project-id");
  if (projectResult.kind === "missing") return options.error(c, "project-not-found");

  const resolution = resolveAccUser(c, store, aps);
  if (resolution.kind !== "user") return options.error(c, "user-required");
  const member = accProjectUser(aps, projectResult.project.project_id, resolution.user.user_id);
  if (!member) return options.error(c, "not-a-member");
  return { project: projectResult.project, user: resolution.user, member };
}
