import type { AppEnv, ContentfulStatusCode, Context, RouteContext } from "@emulators/core";
import {
  accProjectUser,
  commaSeparated,
  findProjectResource,
  pageItems,
  projectForAccId,
  queryPagination,
  readJsonObject,
  resolveAccUser,
  sheetsEnvelope,
} from "../acc.js";
import { apsAuth } from "../auth.js";
import type { ApsProject, ApsSheet } from "../entities.js";
import { getApsStore } from "../store.js";

interface SheetsRequestContext {
  project: ApsProject;
}

function sheetsError(c: Context<AppEnv>, status: ContentfulStatusCode, errorCode: string, message: string): Response {
  return c.json({ errorCode, message }, status);
}

function filterSheets(c: Context<AppEnv>, sheets: ApsSheet[]): ApsSheet[] {
  const versionSetIds = commaSeparated(c.req.query("filter[versionSetId]"));
  const tags = commaSeparated(c.req.query("filter[tags]"));
  const searchTerms = commaSeparated(c.req.query("searchText")).map((value) => value.toLocaleLowerCase());
  const collectionId = c.req.query("collectionId");
  const currentOnly = c.req.query("currentOnly") === "true";
  const isDeleted = c.req.query("isDeleted");

  return sheets.filter(({ payload }) => {
    if (versionSetIds.length > 0 && !versionSetIds.includes(payload.versionSet.id)) return false;
    if (tags.length > 0 && !tags.some((tag) => payload.tags.includes(tag))) return false;
    if (currentOnly && !payload.isCurrent) return false;
    if (isDeleted === "true" && !payload.deleted) return false;
    if ((isDeleted === undefined || isDeleted === "false") && payload.deleted) return false;
    if (collectionId && collectionId !== "*" && payload.collection?.id !== collectionId) return false;
    if (
      searchTerms.length > 0 &&
      !searchTerms.some(
        (term) => payload.title.toLocaleLowerCase().includes(term) || payload.number.toLocaleLowerCase().includes(term),
      )
    ) {
      return false;
    }
    return true;
  });
}

export function sheetRoutes(route: RouteContext): void {
  const { app, store } = route;
  const aps = getApsStore(store);
  app.use("/construction/sheets/v1/*", apsAuth(store, { scopes: ["data:read"] }));

  // Sheets accepts 2-legged tokens: the user is optional, but when one is
  // identified (token user or x-user-id impersonation) it must be a seeded
  // project member.
  function requestContext(c: Context<AppEnv>): SheetsRequestContext | Response {
    const projectResult = projectForAccId(aps, c.req.param("projectId"), "bare-or-prefixed");
    if (projectResult.kind !== "found") {
      return sheetsError(c, 404, "ERR_RESOURCE_NOT_EXIST", "The requested project was not found.");
    }

    const resolution = resolveAccUser(c, store, aps);
    if (resolution.kind === "unknown-user") {
      return sheetsError(c, 403, "ERR_NOT_ALLOWED", "The x-user-id does not identify a seeded user.");
    }
    if (resolution.kind === "user" && !accProjectUser(aps, projectResult.project.project_id, resolution.user.user_id)) {
      return sheetsError(c, 403, "ERR_NOT_ALLOWED", "The user is not a member of this project.");
    }
    return { project: projectResult.project };
  }

  app.get("/construction/sheets/v1/projects/:projectId/sheets", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const filtered = filterSheets(c, aps.sheets.findBy("project_id", context.project.project_id));
    const results = pageItems(filtered, pagination.value).map((sheet) => structuredClone(sheet.payload));
    return c.json(sheetsEnvelope(results, pagination.value, filtered.length, c.req.url));
  });

  app.post("/construction/sheets/v1/projects/:projectId/sheets:batch-get", async (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const body = await readJsonObject(c);
    if (!body.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", body.message);
    const ids = body.value.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return sheetsError(c, 400, "ERR_BAD_INPUT", "ids must be an array of sheet IDs.");
    }

    const projectSheets = aps.sheets.findBy("project_id", context.project.project_id);
    const results = ids.flatMap((id) => {
      const sheet = projectSheets.find((candidate) => candidate.sheet_id === id);
      return sheet ? [structuredClone(sheet.payload)] : [];
    });
    return c.json({ results });
  });

  app.get("/construction/sheets/v1/projects/:projectId/version-sets", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const collectionId = c.req.query("collectionId");
    const resources = aps.sheetVersionSets
      .findBy("project_id", context.project.project_id)
      .filter(
        (versionSet) => !collectionId || collectionId === "*" || versionSet.payload.collection?.id === collectionId,
      );
    const results = pageItems(resources, pagination.value).map((versionSet) => structuredClone(versionSet.payload));
    return c.json(sheetsEnvelope(results, pagination.value, resources.length, c.req.url));
  });

  app.get("/construction/sheets/v1/projects/:projectId/collections", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const resources = aps.sheetCollections.findBy("project_id", context.project.project_id);
    const results = pageItems(resources, pagination.value).map((collection) => structuredClone(collection.payload));
    return c.json(sheetsEnvelope(results, pagination.value, resources.length, c.req.url));
  });

  app.get("/construction/sheets/v1/projects/:projectId/collections/:collectionId", (c) => {
    const context = requestContext(c);
    if (context instanceof Response) return context;
    const collection = findProjectResource(
      aps.sheetCollections,
      context.project.project_id,
      "collection_id",
      c.req.param("collectionId"),
    );
    if (!collection) {
      return sheetsError(c, 404, "ERR_RESOURCE_NOT_EXIST", "The collection does not exist.");
    }
    return c.json(structuredClone(collection.payload));
  });
}
