import type { AppEnv, ContentfulStatusCode, Context } from "@emulators/core";

export interface ApsProblemError {
  field?: string;
  title: string;
  detail: string;
  type: string;
}

export function problem(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  input: {
    type: string;
    title: string;
    detail: string;
    errors?: ApsProblemError[];
  },
): Response {
  return c.json(
    {
      type: input.type,
      title: input.title,
      detail: input.detail,
      errors: input.errors ?? [],
    },
    status,
    { "Content-Type": "application/problem+json" },
  );
}

export function badInput(c: Context<AppEnv>, field: string, detail: string): Response {
  return problem(c, 400, {
    type: "BadInput",
    title: "One or more input values in the request were bad",
    detail: `The following parameters are invalid: ${field}`,
    errors: [{ field, title: "Invalid parameter", detail, type: "BadInput" }],
  });
}

export function notFound(c: Context<AppEnv>, resource: string): Response {
  return problem(c, 404, {
    type: "NotFound",
    title: "The requested resource was not found",
    detail: `${resource} was not found.`,
  });
}

export function forbidden(c: Context<AppEnv>, detail: string): Response {
  return problem(c, 403, {
    type: "Forbidden",
    title: "The request is forbidden",
    detail,
  });
}
