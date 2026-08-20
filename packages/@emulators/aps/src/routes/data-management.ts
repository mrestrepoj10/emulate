import { randomUUID } from "node:crypto";
import type { Context } from "@emulators/core";
import type { AppEnv, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import type { ApsHub, ApsProject } from "../entities.js";
import { getApsStore } from "../store.js";

function hubPath(hubId: string): string {
  return `/project/v1/hubs/${encodeURIComponent(hubId)}`;
}

function projectPath(hubId: string, projectId: string): string {
  return `${hubPath(hubId)}/projects/${encodeURIComponent(projectId)}`;
}

function hubData(baseUrl: string, hub: ApsHub) {
  const path = hubPath(hub.hub_id);
  return {
    type: "hubs",
    id: hub.hub_id,
    attributes: {
      name: hub.name,
      extension: {
        type: "hubs:autodesk.bim360:Account",
        version: "1.0",
        schema: {
          href: "https://developer.api.autodesk.com/schema/v1/versions/hubs%3Aautodesk.bim360%3AAccount-1.0",
        },
        data: {},
      },
      region: hub.region,
    },
    links: { self: { href: `${baseUrl}${path}` } },
    relationships: {
      projects: { links: { related: { href: `${baseUrl}${path}/projects` } } },
    },
  };
}

function projectData(baseUrl: string, project: ApsProject) {
  const path = projectPath(project.hub_id, project.project_id);
  const hub = hubPath(project.hub_id);
  const rootFolderId = `urn:adsk.wipprod:fs.folder:co.${Buffer.from(project.project_id).toString("base64url")}`;
  return {
    type: "projects",
    id: project.project_id,
    attributes: {
      name: project.name,
      scopes: ["global"],
      extension: {
        type: "projects:autodesk.bim360:Project",
        version: "1.0",
        schema: {
          href: "https://developer.api.autodesk.com/schema/v1/versions/projects%3Aautodesk.bim360%3AProject-1.0",
        },
        data: { projectType: "ACC" },
      },
    },
    links: { self: { href: `${baseUrl}${path}` } },
    relationships: {
      hub: {
        data: { type: "hubs", id: project.hub_id },
        links: { related: { href: `${baseUrl}${hub}` } },
      },
      rootFolder: {
        data: { type: "folders", id: rootFolderId },
        meta: {
          link: {
            href: `${baseUrl}/data/v1/projects/${encodeURIComponent(project.project_id)}/folders/${encodeURIComponent(rootFolderId)}`,
          },
        },
      },
      topFolders: { links: { related: { href: `${baseUrl}${path}/topFolders` } } },
    },
  };
}

function jsonApiDocument(c: Context<AppEnv>, baseUrl: string, path: string, data: unknown): Response {
  c.header("Content-Type", "application/vnd.api+json");
  return c.json({
    jsonapi: { version: "1.0" },
    links: { self: { href: `${baseUrl}${path}` } },
    data,
  });
}

function notFound(c: Context<AppEnv>, detail: string): Response {
  c.header("Content-Type", "application/vnd.api+json");
  return c.json(
    {
      jsonapi: { version: "1.0" },
      errors: [{ id: randomUUID(), status: "404", code: "NOT_FOUND", detail }],
    },
    404,
  );
}

export function dataManagementRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  app.use("/project/v1/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/project/v1/hubs", (c) => {
    const path = "/project/v1/hubs";
    return jsonApiDocument(
      c,
      baseUrl,
      path,
      aps.hubs.all().map((hub) => hubData(baseUrl, hub)),
    );
  });

  app.get("/project/v1/hubs/:hubId", (c) => {
    const hub = aps.hubs.findOneBy("hub_id", c.req.param("hubId"));
    if (!hub) return notFound(c, `The hub ${c.req.param("hubId")} was not found.`);
    const path = hubPath(hub.hub_id);
    return jsonApiDocument(c, baseUrl, path, hubData(baseUrl, hub));
  });

  app.get("/project/v1/hubs/:hubId/projects", (c) => {
    const hubId = c.req.param("hubId");
    if (!aps.hubs.findOneBy("hub_id", hubId)) return notFound(c, `The hub ${hubId} was not found.`);
    const path = `${hubPath(hubId)}/projects`;
    return jsonApiDocument(
      c,
      baseUrl,
      path,
      aps.projects.findBy("hub_id", hubId).map((project) => projectData(baseUrl, project)),
    );
  });

  app.get("/project/v1/hubs/:hubId/projects/:projectId", (c) => {
    const hubId = c.req.param("hubId");
    if (!aps.hubs.findOneBy("hub_id", hubId)) return notFound(c, `The hub ${hubId} was not found.`);
    const project = aps.projects.findOneBy("project_id", c.req.param("projectId"));
    if (!project || project.hub_id !== hubId) {
      return notFound(c, `The project ${c.req.param("projectId")} was not found in hub ${hubId}.`);
    }
    const path = projectPath(hubId, project.project_id);
    return jsonApiDocument(c, baseUrl, path, projectData(baseUrl, project));
  });
}
