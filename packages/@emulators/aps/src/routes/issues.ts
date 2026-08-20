import type { AppEnv, Context, RouteContext } from "@emulators/core";
import {
  accProjectUser,
  commaSeparated,
  issuesError,
  offsetEnvelope,
  pageItems,
  projectForAccId,
  queryPagination,
  userForApsRequest,
} from "../acc.js";
import { apsAuth } from "../auth.js";
import type { ApsAccProjectUser, ApsIssue, ApsProject, ApsUser } from "../entities.js";
import { getApsStore, type ApsStore } from "../store.js";

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

interface IssuesRequestContext {
  project: ApsProject;
  user: ApsUser;
  member: ApsAccProjectUser;
}

async function requestContext(
  c: Context<AppEnv>,
  route: RouteContext,
  aps: ApsStore,
): Promise<IssuesRequestContext | Response> {
  const projectResult = projectForAccId(aps, c.req.param("projectId"), "bare");
  if (projectResult.kind === "invalid") {
    return issuesError(c, 400, "Bad Request", "Issues project IDs must not include the 'b.' prefix.");
  }
  if (projectResult.kind === "missing") {
    return issuesError(c, 404, "Not Found", "The requested project was not found.");
  }

  const user = await userForApsRequest(c, route.store, aps, false);
  if (!user) return issuesError(c, 403, "Forbidden", "User context is required.");
  const member = accProjectUser(aps, projectResult.project.project_id, user.user_id);
  if (!member) return issuesError(c, 403, "Forbidden", "The user is not a member of this project.");
  return { project: projectResult.project, user, member };
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
    ...issuePermissions(member, issue.status),
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

  let filtered = issues.filter((issue) => {
    if (!matchesAny(issue.issue_id, ids)) return false;
    if (!matchesAny(issue.issue_type_id, typeIds)) return false;
    if (!matchesAny(issue.issue_subtype_id, subtypeIds)) return false;
    if (!matchesAny(issue.status, statuses)) return false;
    if (!matchesAny(issue.assigned_to, assignees)) return false;
    if (displayIds.length > 0 && !displayIds.includes(String(issue.display_id))) return false;
    if (deletedFilter === "true" && !issue.deleted) return false;
    if ((deletedFilter === undefined || deletedFilter === "false") && issue.deleted) return false;
    if (search && !issue.title.toLocaleLowerCase().includes(search) && !String(issue.display_id).includes(search)) {
      return false;
    }
    return true;
  });

  const requestedSort = commaSeparated(c.req.query("sortBy"))[0];
  if (!requestedSort) return filtered;
  const descending = requestedSort.startsWith("-");
  const field = descending ? requestedSort.slice(1) : requestedSort;
  const valueFor = (issue: ApsIssue): string | number => {
    if (field === "displayId") return issue.display_id;
    if (field === "title") return issue.title;
    if (field === "status") return issue.status;
    return String(issue.payload[field] ?? "");
  };
  filtered = [...filtered].sort((left, right) => {
    const a = valueFor(left);
    const b = valueFor(right);
    const result = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return descending ? -result : result;
  });
  return filtered;
}

export function issueRoutes(route: RouteContext): void {
  const { app, store } = route;
  const aps = getApsStore(store);
  app.use("/construction/issues/v1/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/construction/issues/v1/projects/:projectId/users/me", async (c) => {
    const context = await requestContext(c, route, aps);
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

  app.get("/construction/issues/v1/projects/:projectId/issue-types", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 200, maxLimit: 200 });
    if (!pagination.ok) return issuesError(c, 400, "Bad Request", pagination.message);

    const isActive = c.req.query("filter[isActive]");
    const includeSubtypes = commaSeparated(c.req.query("include")).includes("subtypes");
    const resources = aps.issueTypes
      .findBy("project_id", context.project.project_id)
      .filter((issueType) => isActive === undefined || issueType.is_active === (isActive === "true"));
    const results = pageItems(resources, pagination.value).map((issueType) => {
      const payload = structuredClone(issueType.payload);
      if (!includeSubtypes) delete payload.subtypes;
      return payload;
    });
    return c.json(offsetEnvelope(results, pagination.value, resources.length));
  });

  app.get("/construction/issues/v1/projects/:projectId/issues", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 100 });
    if (!pagination.ok) return issuesError(c, 400, "Bad Request", pagination.message);

    const filtered = filterIssues(c, aps.issues.findBy("project_id", context.project.project_id));
    const results = pageItems(filtered, pagination.value).map((issue) => issuePayload(issue, context.member));
    return c.json(offsetEnvelope(results, pagination.value, filtered.length));
  });

  app.get("/construction/issues/v1/projects/:projectId/issues/:issueId", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const issue = aps.issues
      .findBy("project_id", context.project.project_id)
      .find((candidate) => candidate.issue_id === c.req.param("issueId"));
    if (!issue) return issuesError(c, 404, "Not Found", "The requested issue was not found.");
    return c.json(issuePayload(issue, context.member));
  });
}
