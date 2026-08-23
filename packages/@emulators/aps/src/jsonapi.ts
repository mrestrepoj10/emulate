import { randomUUID } from "node:crypto";
import type { AppEnv, Context } from "@emulators/core";
import { isRecordObject, optionalString } from "./helpers.js";

export const JSON_API_TYPE = "application/vnd.api+json";

export function routeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecordObject(value) ? value : null;
}

export function resourceAttributes(resource: Record<string, unknown>): Record<string, unknown> {
  return asRecord(resource.attributes) ?? {};
}

export function relationshipId(resource: Record<string, unknown>, name: string): string | undefined {
  const relationships = asRecord(resource.relationships);
  const relationship = relationships ? asRecord(relationships[name]) : null;
  const data = relationship ? asRecord(relationship.data) : null;
  return data ? optionalString(data.id) : undefined;
}

export function jsonApiDocument(
  c: Context<AppEnv>,
  selfHref: string,
  data: unknown,
  options?: { included?: unknown[]; links?: Record<string, unknown> },
): Response {
  c.header("Content-Type", JSON_API_TYPE);
  return c.json({
    jsonapi: { version: "1.0" },
    links: options?.links ?? { self: { href: selfHref } },
    data,
    ...(options?.included ? { included: options.included } : {}),
  });
}

export function jsonApiCreated(c: Context<AppEnv>, selfHref: string, data: unknown, included?: unknown[]): Response {
  c.header("Content-Type", JSON_API_TYPE);
  return c.json(
    {
      jsonapi: { version: "1.0" },
      links: { self: { href: selfHref } },
      data,
      ...(included ? { included } : {}),
    },
    201,
  );
}

export function jsonApiError(c: Context<AppEnv>, status: 400 | 404 | 409, code: string, detail: string): Response {
  c.header("Content-Type", JSON_API_TYPE);
  return c.json(
    { jsonapi: { version: "1.0" }, errors: [{ id: randomUUID(), status: String(status), code, detail }] },
    status,
  );
}

export function jsonApiNotFound(c: Context<AppEnv>, detail: string): Response {
  return jsonApiError(c, 404, "NOT_FOUND", detail);
}
