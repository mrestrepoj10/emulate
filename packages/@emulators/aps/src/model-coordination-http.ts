import type { AppEnv, Context } from "@emulators/core";
import { projectForAccId } from "./acc.js";
import type { ApsProject } from "./entities.js";
import { badInput, notFound } from "./problem.js";
import type { ApsStore } from "./store.js";

export function coordinationProject(c: Context<AppEnv>, aps: ApsStore): ApsProject | Response {
  const containerId = c.req.param("containerId");
  const result = projectForAccId(aps, containerId, "bare");
  if (result.kind === "invalid") {
    return badInput(c, "containerId", `The value '${containerId}' must not include the 'b.' prefix.`);
  }
  if (result.kind === "missing") return notFound(c, "The requested container");
  return result.project;
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
  return new URL(c.req.url).searchParams
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}
