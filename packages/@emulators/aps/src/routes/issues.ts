import type { AppEnv, ContentfulStatusCode, Context, RouteContext } from "@emulators/core";
import {
  accMemberContext,
  commaSeparated,
  findProjectResource,
  offsetEnvelope,
  pageItems,
  queryPagination,
  type AccRequestErrorKind,
} from "../acc.js";
import { apsAuth } from "../auth.js";
import type { ApsAccProjectUser, ApsIssue } from "../entities.js";
import { getApsStore } from "../store.js";

const ISSUE_STATUSES = [
  "draft",
  "open",
  "pending",
  "in_progress",
  "completed",
  "in_review",
  "not_approved",
  "in_dispute",
  "closed",
];

const ISSUE_ATTRIBUTES = [
  "title",
  "description",
  "issueSubtypeId",
  "status",
  "assignedTo",
  "assignedToType",
  "dueDate",
  "startDate",
  "locationId",
  "locationDetails",
  "published",
  "watchers",
  "customAttributes",
];

function issuesError(c: Context<AppEnv>, status: ContentfulStatusCode, title: string, detail: string): Response {
  return c.json({ title, detail }, status);
}

function issuesRequestError(c: Context<AppEnv>, kind: AccRequestErrorKind): Response {
  switch (kind) {
    case "invalid-project-id":
      return issuesError(c, 400, "Bad Request", "Issues project IDs must not include the 'b.' prefix.");
    case "project-not-found":
      return issuesError(c, 404, "Not Found", "The requested project was not found.");
    case "user-required":
      return issuesError(c, 403, "Forbidden", "User context is required.");
    case "not-a-member":
      return issuesError(c, 403, "Forbidden", "The user is not a member of this project.");
  }
}

function canManageIssues(member: ApsAccProjectUser): boolean {
  return member.role === "project_admin" || member.issue_permission === "manage";
}

function issuePermissions(member: ApsAccProjectUser, status: string) {
  if (!canManageIssues(member)) {
    return {
      permittedStatuses: [status],
      permittedAttributes: [],
      permittedActions: ["add_comment", "add_attachment"],
    };
  }
  return {
    permittedStatuses: status === "closed" ? ["closed", "open"] : ISSUE_STATUSES.filter((value) => value !== "draft"),
    permittedAttributes: ISSUE_ATTRIBUTES,
    permittedActions: ["assign_all", "clear_assignee", "delete", "add_comment", "add_attachment", "remove_attachment"],
  };
}

function issuePayload(issue: ApsIssue, member: ApsAccProjectUser): Record<string, unknown> {
  return {
    ...structuredClone(issue.payload),
    ...issuePermissions(member, issue.payload.status),
  };
}

function matchesAny(value: string | null, candidates: string[]): boolean {
  return candidates.length === 0 || (value !== null && candidates.includes(value));
}

function filterIssues(c: Context<AppEnv>, issues: ApsIssue[]): ApsIssue[] {
  const ids = commaSeparated(c.req.query("filter[id]"));
  const typeIds = commaSeparated(c.req.query("filter[issueTypeId]"));
  const subtypeIds = commaSeparated(c.req.query("filter[issueSubtypeId]"));
  const statuses = commaSeparated(c.req.query("filter[status]"));
  const assignees = commaSeparated(c.req.query("filter[assignedTo]"));
  const displayIds = commaSeparated(c.req.query("filter[displayId]"));
  const search = c.req.query("filter[search]")?.trim().toLocaleLowerCase();
  const deletedFilter = c.req.query("filter[deleted]");

  return issues.filter(({ payload }) => {
    if (!matchesAny(payload.id, ids)) return false;
    if (!matchesAny(payload.issueTypeId, typeIds)) return false;
    if (!matchesAny(payload.issueSubtypeId, subtypeIds)) return false;
    if (!matchesAny(payload.status, statuses)) return false;
    if (!matchesAny(payload.assignedTo, assignees)) return false;
    if (displayIds.length > 0 && !displayIds.includes(String(payload.displayId))) return false;
    if (deletedFilter === "true" && !payload.deleted) return false;
    if ((deletedFilter === undefined || deletedFilter === "false") && payload.deleted) return false;
    if (search && !payload.title.toLocaleLowerCase().includes(search) && !String(payload.displayId).includes(search)) {
      return false;
    }
    return true;
  });
}

function sortIssues(issues: ApsIssue[], sortBy: string | undefined): ApsIssue[] {
  const requestedSort = commaSeparated(sortBy)[0];
  if (!requestedSort) return issues;
  const descending = requestedSort.startsWith("-");
  const field = descending ? requestedSort.slice(1) : requestedSort;
  const valueFor = (issue: ApsIssue): string | number => {
    if (field === "displayId") return issue.payload.displayId;
    return String(issue.payload[field] ?? "");
  };
  return [...issues].sort((left, right) => {
    const a = valueFor(left);
    const b = valueFor(right);
    const result = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return descending ? -result : result;
  });
}

export function issueRoutes(route: RouteContext): void {
  const { app, store } = route;
  const aps = getApsStore(store);
  const requestContext = (c: Context<AppEnv>) =>
    accMemberContext(c, store, aps, { idRule: "bare", error: issuesRequestError });
  app.use("/construction/issues/v1/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/construction/issues/v1/projects/:projectId/users/me", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const manageable = canManageIssues(context.member);
    const permittedStatuses = manageable ? ISSUE_STATUSES : ["open", "closed"];
    const permittedAttributes = manageable ? ISSUE_ATTRIBUTES : [];
    const permittedActions = manageable ? ["add_comment", "add_attachment", "assign_all"] : ["add_comment"];
    return c.json({
      id: context.user.user_id,
      isProjectAdmin: context.member.role === "project_admin",
      canManageTemplates: manageable,
      issues: {
        new: {
          // Both casings are emitted deliberately until the shape is verified
          // against the live Issues API; clients have been seen reading either.
          permittedActions,
          permittedAttributes,
          permittedStatuses,
          permitted_actions: permittedActions,
          permitted_attributes: permittedAttributes,
          permitted_statuses: permittedStatuses,
        },
        filter: { permittedStatuses },
      },
      permissionLevels: [context.member.issue_permission],
    });
  });

  app.get("/construction/issues/v1/projects/:projectId/issue-types", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 200, maxLimit: 200 });
    if (!pagination.ok) return issuesError(c, 400, "Bad Request", pagination.message);

    const isActive = c.req.query("filter[isActive]");
    const includeSubtypes = commaSeparated(c.req.query("include")).includes("subtypes");
    const resources = aps.issueTypes
      .findBy("project_id", context.project.project_id)
      .filter((issueType) => isActive === undefined || issueType.payload.isActive === (isActive === "true"));
    const results = pageItems(resources, pagination.value).map((issueType) => {
      const { subtypes, ...summary } = structuredClone(issueType.payload);
      return includeSubtypes ? { ...summary, subtypes } : summary;
    });
    return c.json(offsetEnvelope(results, pagination.value, resources.length));
  });

  app.get("/construction/issues/v1/projects/:projectId/issues", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 100 });
    if (!pagination.ok) return issuesError(c, 400, "Bad Request", pagination.message);

    const filtered = sortIssues(
      filterIssues(c, aps.issues.findBy("project_id", context.project.project_id)),
      c.req.query("sortBy"),
    );
    const results = pageItems(filtered, pagination.value).map((issue) => issuePayload(issue, context.member));
    return c.json(offsetEnvelope(results, pagination.value, filtered.length));
  });

  app.get("/construction/issues/v1/projects/:projectId/issues/:issueId", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const issue = findProjectResource(aps.issues, context.project.project_id, "issue_id", c.req.param("issueId"));
    if (!issue) return issuesError(c, 404, "Not Found", "The requested issue was not found.");
    return c.json(issuePayload(issue, context.member));
  });
}
