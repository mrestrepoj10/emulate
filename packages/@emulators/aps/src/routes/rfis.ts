import type { AppEnv, ContentfulStatusCode, Context, RouteContext } from "@emulators/core";
import {
  accMemberContext,
  findProjectResource,
  offsetEnvelope,
  pageItems,
  parseOffsetPagination,
  queryPagination,
  readJsonObject,
  type AccRequestErrorKind,
} from "../acc.js";
import { apsAuth } from "../auth.js";
import type { ApsAccProjectUser, ApsRfi } from "../entities.js";
import { getApsStore } from "../store.js";

function rfiError(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function rfiRequestError(c: Context<AppEnv>, kind: AccRequestErrorKind): Response {
  switch (kind) {
    case "invalid-project-id":
      return rfiError(c, 400, "BAD_INPUT", "RFI project IDs must not include the 'b.' prefix.");
    case "project-not-found":
      return rfiError(c, 404, "NOT_FOUND", "The requested project was not found.");
    case "user-required":
      return rfiError(c, 403, "FORBIDDEN", "User context is required.");
    case "not-a-member":
      return rfiError(c, 403, "FORBIDDEN", "The user is not a member of this project.");
  }
}

function canManageRfis(member: ApsAccProjectUser): boolean {
  return member.role === "project_admin" || member.rfi_roles.some((role) => role !== "reviewer");
}

function transition(status: string, userId: string) {
  return {
    status,
    maxAssignees: 10,
    requiredAttributes: [],
    permittedAttributes: [
      {
        name: "assignedTo",
        values: [{ value: userId, type: "user" }],
      },
    ],
  };
}

function workflowStatuses(statuses: string[], userId: string) {
  const transitions = statuses.map((value) => transition(value, userId));
  return { wfUS: transitions, wfEU: transitions };
}

function permittedActions(member: ApsAccProjectUser, userId: string, status: string): Record<string, unknown> {
  const manageable = canManageRfis(member);
  const statuses = manageable ? ["draft", "submitted", "open", "answered", "closed"] : [status];
  return {
    share: manageable,
    nudge: manageable,
    updateRfi: {
      permittedStatuses: workflowStatuses(statuses, userId),
      permittedAttributes: manageable
        ? [
            { name: "title" },
            { name: "question" },
            { name: "assignedTo", values: [{ value: userId, type: "user" }] },
            { name: "dueDate" },
          ]
        : [],
      useCustomAttributes: manageable,
    },
    createComment: true,
    createResponse: manageable,
    createResponseOnBehalf: manageable,
    remainingReviewers: [{ id: userId, type: "user" }],
    createDocumentReference: manageable,
    removeDocumentReference: manageable,
  };
}

function rfiPayload(
  rfi: ApsRfi,
  member: ApsAccProjectUser,
  userId: string,
  includeDetail: boolean,
): Record<string, unknown> {
  const { responses, draftResponses, ...summary } = structuredClone(rfi.payload);
  const common = { ...summary, permittedActions: permittedActions(member, userId, rfi.payload.status) };
  return includeDetail ? { ...common, responses, draftResponses, maxAssignees: 10 } : common;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function actorIds(value: unknown): string[] {
  if (!Array.isArray(value)) return stringArray(value);
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
      return [(item as Record<string, string>).id];
    }
    return [];
  });
}

function filterRfis(rfis: ApsRfi[], body: Record<string, unknown>): ApsRfi[] {
  const filter =
    body.filter && typeof body.filter === "object" && !Array.isArray(body.filter)
      ? (body.filter as Record<string, unknown>)
      : {};
  const search = typeof body.search === "string" ? body.search.trim().toLocaleLowerCase() : "";
  const ids = stringArray(filter.id);
  const statuses = stringArray(filter.status);
  const assignees = actorIds(filter.assignedTo);
  const rfiTypeIds = stringArray(filter.rfiTypeId);
  const references = stringArray(filter.reference);
  const priorities = stringArray(filter.priority);

  let results = rfis.filter(({ payload }) => {
    if (ids.length > 0 && !ids.includes(payload.id)) return false;
    if (statuses.length > 0 && !statuses.includes(payload.status)) return false;
    if (rfiTypeIds.length > 0 && !rfiTypeIds.includes(payload.rfiTypeId)) return false;
    if (references.length > 0 && !references.includes(payload.reference)) return false;
    if (priorities.length > 0 && !priorities.includes(payload.priority)) return false;
    if (assignees.length > 0 && !payload.assignedTo.some((actor) => assignees.includes(actor.id))) return false;
    if (search) {
      if (
        !payload.title.toLocaleLowerCase().includes(search) &&
        !payload.customIdentifier.toLocaleLowerCase().includes(search) &&
        !payload.question.toLocaleLowerCase().includes(search)
      ) {
        return false;
      }
    }
    return true;
  });

  const sorts = Array.isArray(body.sort) ? body.sort : [];
  const firstSort = sorts[0];
  if (firstSort && typeof firstSort === "object") {
    const sort = firstSort as Record<string, unknown>;
    const field = typeof sort.field === "string" ? sort.field : "";
    const descending = sort.order === "DESC";
    results = [...results].sort((left, right) => {
      const a = String(left.payload[field] ?? "");
      const b = String(right.payload[field] ?? "");
      const comparison = a.localeCompare(b);
      return descending ? -comparison : comparison;
    });
  }
  return results;
}

function nextCustomIdentifier(rfis: ApsRfi[]): { current: string | null; next: string } {
  if (rfis.length === 0) return { current: null, next: "1" };
  const sorted = [...rfis].sort((left, right) =>
    left.payload.customIdentifier.localeCompare(right.payload.customIdentifier, undefined, { numeric: true }),
  );
  const current = sorted.at(-1)?.payload.customIdentifier ?? "0";
  const match = current.match(/^(.*?)(\d+)$/);
  if (!match) return { current, next: `${current}-1` };
  const prefix = match[1];
  const numeric = match[2];
  return { current, next: `${prefix}${String(Number(numeric) + 1).padStart(numeric.length, "0")}` };
}

export function rfiRoutes(route: RouteContext): void {
  const { app, store } = route;
  const aps = getApsStore(store);
  const requestContext = (c: Context<AppEnv>) =>
    accMemberContext(c, store, aps, { idRule: "bare", error: rfiRequestError });
  app.use("/construction/rfis/v3/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/construction/rfis/v3/projects/:projectId/users/me", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const defaultType = aps.rfiTypes
      .findBy("project_id", context.project.project_id)
      .find((candidate) => candidate.payload.isDefault);
    const createStatuses = canManageRfis(context.member) ? ["draft", "open"] : [];
    return c.json({
      user: {
        id: context.user.user_id,
        name: context.user.name,
        role: context.member.role,
      },
      permittedActions: {
        createRfi: {
          permittedStatuses: workflowStatuses(createStatuses, context.user.user_id),
        },
      },
      workflow: { roles: context.member.rfi_roles, type: "US" },
      defaultRfiType: defaultType?.rfi_type_id ?? null,
      externalUsers: [],
      maintenanceEndDate: null,
    });
  });

  app.get("/construction/rfis/v3/projects/:projectId/workflow", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    return c.json({
      workflowType: "US",
      description: "RFI creation, review, and response workflow.",
      projectRolesMapping: context.member.rfi_roles.map((name) => ({
        name,
        permittedAssignees: [{ id: context.user.user_id, type: "user" }],
      })),
    });
  });

  app.get("/construction/rfis/v3/projects/:projectId/rfi-types", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return rfiError(c, 400, "BAD_INPUT", pagination.message);
    const status = c.req.query("filter[status]");
    const resources = aps.rfiTypes
      .findBy("project_id", context.project.project_id)
      .filter((candidate) => !status || candidate.payload.status === status);
    const results = pageItems(resources, pagination.value).map((candidate) => structuredClone(candidate.payload));
    return c.json(offsetEnvelope(results, pagination.value, resources.length));
  });

  app.get("/construction/rfis/v3/projects/:projectId/attributes", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return rfiError(c, 400, "BAD_INPUT", pagination.message);
    const status = c.req.query("filter[status]");
    const resources = aps.rfiAttributes
      .findBy("project_id", context.project.project_id)
      .filter((candidate) => !status || candidate.payload.status === status);
    const results = pageItems(resources, pagination.value).map((candidate) => structuredClone(candidate.payload));
    return c.json(offsetEnvelope(results, pagination.value, resources.length));
  });

  app.get("/construction/rfis/v3/projects/:projectId/rfis/custom-identifier", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    return c.json(nextCustomIdentifier(aps.rfis.findBy("project_id", context.project.project_id)));
  });

  app.post("/construction/rfis/v3/projects/:projectId/search:rfis", async (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const body = await readJsonObject(c);
    if (!body.ok) return rfiError(c, 400, "BAD_INPUT", body.message);
    const pagination = parseOffsetPagination(
      body.value.limit ?? c.req.query("limit"),
      body.value.offset ?? c.req.query("offset"),
      {
        defaultLimit: 100,
        maxLimit: 200,
      },
    );
    if (!pagination.ok) return rfiError(c, 400, "BAD_INPUT", pagination.message);

    const filtered = filterRfis(aps.rfis.findBy("project_id", context.project.project_id), body.value);
    const results = pageItems(filtered, pagination.value).map((rfi) =>
      rfiPayload(rfi, context.member, context.user.user_id, false),
    );
    return c.json(offsetEnvelope(results, pagination.value, filtered.length));
  });

  app.get("/construction/rfis/v3/projects/:projectId/rfis/:rfiId", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const rfi = findProjectResource(aps.rfis, context.project.project_id, "rfi_id", c.req.param("rfiId"));
    if (!rfi) return rfiError(c, 404, "NOT_FOUND", "The requested RFI was not found.");
    return c.json(rfiPayload(rfi, context.member, context.user.user_id, true));
  });
}
