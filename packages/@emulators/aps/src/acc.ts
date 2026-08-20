import type { AppEnv, ContentfulStatusCode, Context, Store } from "@emulators/core";
import { accessTokenForRequest } from "./auth.js";
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

export async function userForApsRequest(
  c: Context<AppEnv>,
  store: Store,
  aps: ApsStore,
  allowUserHeader: boolean,
): Promise<ApsUser | null> {
  const token = await accessTokenForRequest(c, store);
  if (!token) return null;
  if (token.apsUserId) return aps.users.findOneBy("user_id", token.apsUserId) ?? null;
  if (!allowUserHeader) return null;

  const requestedUserId = c.req.header("x-user-id");
  return requestedUserId ? (aps.users.findOneBy("user_id", requestedUserId) ?? null) : null;
}

export function accProjectUser(aps: ApsStore, projectId: string, userId: string): ApsAccProjectUser | null {
  return (
    aps.accProjectUsers.findBy("project_id", projectId).find((membership) => membership.user_id === userId) ?? null
  );
}

export function issuesError(c: Context<AppEnv>, status: ContentfulStatusCode, title: string, detail: string): Response {
  return c.json({ title, detail }, status);
}

export function rfiError(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

export function sheetsError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  errorCode: string,
  message: string,
): Response {
  return c.json({ errorCode, message }, status);
}
