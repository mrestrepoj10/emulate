import type { AppEnv, Context, RouteContext } from "@emulators/core";
import {
  accProjectUser,
  commaSeparated,
  pageItems,
  projectForAccId,
  queryPagination,
  readJsonObject,
  sheetsEnvelope,
  sheetsError,
  userForApsRequest,
} from "../acc.js";
import { accessTokenForRequest, apsAuth } from "../auth.js";
import type { ApsProject, ApsSheet } from "../entities.js";
import { getApsStore, type ApsStore } from "../store.js";

interface SheetsRequestContext {
  project: ApsProject;
}

async function requestContext(
  c: Context<AppEnv>,
  route: RouteContext,
  aps: ApsStore,
): Promise<SheetsRequestContext | Response> {
  const projectResult = projectForAccId(aps, c.req.param("projectId"), "bare-or-prefixed");
  if (projectResult.kind !== "found") {
    return sheetsError(c, 404, "ERR_RESOURCE_NOT_EXIST", "The requested project was not found.");
  }

  const token = await accessTokenForRequest(c, route.store);
  const user = await userForApsRequest(c, route.store, aps, true);
  if (!token) return sheetsError(c, 401, "ERR_AUTHENTICATED_ERROR", "Authentication header is not correct.");
  if (!token.apsUserId && c.req.header("x-user-id") && !user) {
    return sheetsError(c, 403, "ERR_NOT_ALLOWED", "The x-user-id does not identify a seeded user.");
  }
  if (user && !accProjectUser(aps, projectResult.project.project_id, user.user_id)) {
    return sheetsError(c, 403, "ERR_NOT_ALLOWED", "The user is not a member of this project.");
  }
  return { project: projectResult.project };
}

function filterSheets(c: Context<AppEnv>, sheets: ApsSheet[]): ApsSheet[] {
  const versionSetIds = commaSeparated(c.req.query("filter[versionSetId]"));
  const tags = commaSeparated(c.req.query("filter[tags]"));
  const searchTerms = commaSeparated(c.req.query("searchText")).map((value) => value.toLocaleLowerCase());
  const collectionId = c.req.query("collectionId");
  const currentOnly = c.req.query("currentOnly") === "true";
  const isDeleted = c.req.query("isDeleted");

  return sheets.filter((sheet) => {
    if (versionSetIds.length > 0 && !versionSetIds.includes(sheet.version_set_id)) return false;
    if (tags.length > 0 && !tags.some((tag) => sheet.tags.includes(tag))) return false;
    if (currentOnly && !sheet.is_current) return false;
    if (isDeleted === "true" && !sheet.deleted) return false;
    if ((isDeleted === undefined || isDeleted === "false") && sheet.deleted) return false;
    if (collectionId && collectionId !== "*" && sheet.collection_id !== collectionId) return false;
    if (
      searchTerms.length > 0 &&
      !searchTerms.some(
        (term) => sheet.title.toLocaleLowerCase().includes(term) || sheet.number.toLocaleLowerCase().includes(term),
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

  app.get("/construction/sheets/v1/projects/:projectId/sheets", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const filtered = filterSheets(c, aps.sheets.findBy("project_id", context.project.project_id));
    const results = pageItems(filtered, pagination.value).map((sheet) => structuredClone(sheet.payload));
    return c.json(sheetsEnvelope(results, pagination.value, filtered.length, c.req.url));
  });

  app.post("/construction/sheets/v1/projects/:projectId/sheets:batch-get", async (c) => {
    const context = await requestContext(c, route, aps);
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

  app.get("/construction/sheets/v1/projects/:projectId/version-sets", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const collectionId = c.req.query("collectionId");
    const resources = aps.sheetVersionSets
      .findBy("project_id", context.project.project_id)
      .filter((versionSet) => !collectionId || collectionId === "*" || versionSet.collection_id === collectionId);
    const results = pageItems(resources, pagination.value).map((versionSet) => structuredClone(versionSet.payload));
    return c.json(sheetsEnvelope(results, pagination.value, resources.length, c.req.url));
  });

  app.get("/construction/sheets/v1/projects/:projectId/collections", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const pagination = queryPagination(c, { defaultLimit: 100, maxLimit: 200 });
    if (!pagination.ok) return sheetsError(c, 400, "ERR_BAD_INPUT", pagination.message);
    const resources = aps.sheetCollections.findBy("project_id", context.project.project_id);
    const results = pageItems(resources, pagination.value).map((collection) => structuredClone(collection.payload));
    return c.json(sheetsEnvelope(results, pagination.value, resources.length, c.req.url));
  });

  app.get("/construction/sheets/v1/projects/:projectId/collections/:collectionId", async (c) => {
    const context = await requestContext(c, route, aps);
    if (context instanceof Response) return context;
    const collection = aps.sheetCollections
      .findBy("project_id", context.project.project_id)
      .find((candidate) => candidate.collection_id === c.req.param("collectionId"));
    if (!collection) {
      return sheetsError(c, 404, "ERR_RESOURCE_NOT_EXIST", "The collection does not exist.");
    }
    return c.json(structuredClone(collection.payload));
  });
}
