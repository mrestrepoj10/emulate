import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import type { ApsModelSet, ApsModelSetVersion, ApsProject } from "../entities.js";
import { modelSetPayload, modelSetSummaryPayload, modelSetVersionPayload } from "../model-coordination.js";
import { booleanQuery, coordinationPage, coordinationProject, queryValues } from "../model-coordination-http.js";
import { badInput, notFound } from "../problem.js";
import { getApsStore, type ApsStore } from "../store.js";

const VERSION_STATUSES = ["Pending", "Processing", "Successful", "Partial", "Failed"];

function modelSetForProject(c: Context<AppEnv>, aps: ApsStore, project: ApsProject): ApsModelSet | Response {
  const modelSet = aps.modelSets.findOneBy("model_set_id", c.req.param("modelSetId"));
  if (!modelSet || modelSet.project_id !== project.project_id) return notFound(c, "The requested model set");
  return modelSet;
}

function versionForModelSet(
  c: Context<AppEnv>,
  aps: ApsStore,
  modelSet: ApsModelSet,
  requestedVersion: string,
): ApsModelSetVersion | Response {
  const version = Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) {
    return badInput(c, "version", `The value '${requestedVersion}' must be a positive integer.`);
  }
  const result = aps.modelSetVersions
    .findBy("model_set_id", modelSet.model_set_id)
    .find((candidate) => candidate.version === version);
  return result ?? notFound(c, "The requested model set version");
}

export function modelSetRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);
  app.use("/bim360/modelset/v3/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const includeDisabled = booleanQuery(c, "includeDisabled", false);
    if (includeDisabled instanceof Response) return includeDisabled;
    const includeDeleted = booleanQuery(c, "includeDeleted", false);
    if (includeDeleted instanceof Response) return includeDeleted;
    const name = c.req.query("name")?.trim().toLocaleLowerCase();
    const folderUrn = c.req.query("folderUrn")?.trim();

    const modelSets = aps.modelSets
      .findBy("project_id", project.project_id)
      .filter((modelSet) => includeDisabled || !modelSet.disabled)
      .filter((modelSet) => includeDeleted || !modelSet.deleted)
      .filter((modelSet) => !name || modelSet.name.toLocaleLowerCase().includes(name))
      .filter(
        (modelSet) => !folderUrn || modelSet.root_folder_urn === folderUrn || modelSet.folder_urns.includes(folderUrn),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    const page = coordinationPage(c, modelSets);
    if (page instanceof Response) return page;
    return c.json({ page: page.page, modelSets: page.items.map(modelSetSummaryPayload) });
  });

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    return c.json(modelSetPayload(aps, modelSet));
  });

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const statuses = queryValues(c, "status");
    const invalidStatus = statuses.find((status) => !VERSION_STATUSES.includes(status));
    if (invalidStatus) return badInput(c, "status", `The value '${invalidStatus}' is not valid.`);
    const versions = aps.modelSetVersions
      .findBy("model_set_id", modelSet.model_set_id)
      .filter((version) => statuses.length === 0 || statuses.includes(version.status))
      .sort((left, right) => right.version - left.version);
    const page = coordinationPage(c, versions);
    if (page instanceof Response) return page;
    return c.json({
      page: page.page,
      modelSetVersions: page.items.map((version) => ({
        version: version.version,
        createTime: version.create_time,
        status: version.status,
      })),
    });
  });

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions/latest", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const version = aps.modelSetVersions
      .findBy("model_set_id", modelSet.model_set_id)
      .sort((left, right) => right.version - left.version)[0];
    return version ? c.json(modelSetVersionPayload(version)) : notFound(c, "The requested model set version");
  });

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions/:version", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const version = versionForModelSet(c, aps, modelSet, c.req.param("version"));
    if (version instanceof Response) return version;
    return c.json(modelSetVersionPayload(version));
  });

  app.get("/bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions/:version/views", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const version = versionForModelSet(c, aps, modelSet, c.req.param("version"));
    if (version instanceof Response) return version;
    const views = aps.modelSetViews
      .findBy("model_set_id", modelSet.model_set_id)
      .filter((view) => view.version === version.version);
    const page = coordinationPage(c, views);
    if (page instanceof Response) return page;
    return c.json({
      page: page.page,
      modelSetViewVersions: page.items.map((view) => ({
        viewId: view.view_id,
        modelSetId: view.model_set_id,
        documentVersions: [...view.document_versions],
        version: view.version,
      })),
    });
  });
}
