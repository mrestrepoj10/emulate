import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import { folderSubtree, itemTip, rootFolderForProject } from "../dm-tree.js";
import type { ApsDocumentFolder, ApsDocumentItem, ApsDocumentVersion, ApsHub, ApsProject } from "../entities.js";
import { jsonApiDocument, jsonApiError, jsonApiNotFound, routeId } from "../jsonapi.js";
import type { ApsStore } from "../store.js";
import { getApsStore } from "../store.js";

const FOLDER_EXTENSION_TYPE = "folders:autodesk.bim360:Folder";
const VERSION_EXTENSION_TYPE = "versions:autodesk.bim360:File";

function hubPath(hubId: string): string {
  return `/project/v1/hubs/${encodeURIComponent(hubId)}`;
}

function projectPath(hubId: string, projectId: string): string {
  return `${hubPath(hubId)}/projects/${encodeURIComponent(projectId)}`;
}

function dataProjectPath(projectId: string): string {
  return `/data/v1/projects/${encodeURIComponent(projectId)}`;
}

function folderPath(projectId: string, folderId: string): string {
  return `${dataProjectPath(projectId)}/folders/${encodeURIComponent(folderId)}`;
}

function itemPath(projectId: string, itemId: string): string {
  return `${dataProjectPath(projectId)}/items/${encodeURIComponent(itemId)}`;
}

function versionPath(projectId: string, versionId: string): string {
  return `${dataProjectPath(projectId)}/versions/${encodeURIComponent(versionId)}`;
}

function requestHref(c: Context<AppEnv>, baseUrl: string): string {
  const requestUrl = new URL(c.req.url);
  return `${baseUrl}${requestUrl.pathname}${requestUrl.search}`;
}

function schemaHref(type: string): string {
  return `https://developer.api.autodesk.com/schema/v1/versions/${encodeURIComponent(type)}-1.0`;
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
        schema: { href: schemaHref("hubs:autodesk.bim360:Account") },
        data: {},
      },
      region: hub.region,
    },
    links: { self: { href: `${baseUrl}${path}` } },
    relationships: { projects: { links: { related: { href: `${baseUrl}${path}/projects` } } } },
  };
}

function projectData(baseUrl: string, aps: ApsStore, project: ApsProject) {
  const path = projectPath(project.hub_id, project.project_id);
  const hub = hubPath(project.hub_id);
  const rootFolder = rootFolderForProject(aps, project.project_id);
  return {
    type: "projects",
    id: project.project_id,
    attributes: {
      name: project.name,
      scopes: ["global"],
      extension: {
        type: "projects:autodesk.bim360:Project",
        version: "1.0",
        schema: { href: schemaHref("projects:autodesk.bim360:Project") },
        data: { projectType: "ACC" },
      },
    },
    links: { self: { href: `${baseUrl}${path}` } },
    relationships: {
      hub: {
        data: { type: "hubs", id: project.hub_id },
        links: { related: { href: `${baseUrl}${hub}` } },
      },
      ...(rootFolder
        ? {
            rootFolder: {
              data: { type: "folders", id: rootFolder.folder_id },
              meta: { link: { href: `${baseUrl}${folderPath(project.project_id, rootFolder.folder_id)}` } },
            },
          }
        : {}),
      topFolders: { links: { related: { href: `${baseUrl}${path}/topFolders` } } },
    },
  };
}

function folderData(baseUrl: string, aps: ApsStore, folder: ApsDocumentFolder) {
  const path = folderPath(folder.project_id, folder.folder_id);
  const objectCount =
    aps.documentFolders.findBy("parent_folder_id", folder.folder_id).length +
    aps.documentItems.findBy("folder_id", folder.folder_id).length;
  const parent = folder.parent_folder_id
    ? aps.documentFolders.findOneBy("folder_id", folder.parent_folder_id)
    : undefined;
  return {
    type: "folders",
    id: folder.folder_id,
    attributes: {
      name: folder.name,
      displayName: folder.name,
      objectCount,
      createTime: folder.create_time,
      createUserId: folder.created_by,
      createUserName: folder.created_by_name,
      lastModifiedTime: folder.last_modified_time,
      lastModifiedUserId: folder.last_modified_by,
      lastModifiedUserName: folder.last_modified_by_name,
      lastModifiedTimeRollup: folder.last_modified_time,
      hidden: folder.hidden,
      extension: {
        type: FOLDER_EXTENSION_TYPE,
        version: "1.0",
        schema: { href: schemaHref(FOLDER_EXTENSION_TYPE) },
        data: {
          allowedTypes: ["folders", "items:autodesk.bim360:File"],
          visibleTypes: ["folders", "items:autodesk.bim360:File"],
          namingStandardIds: [],
        },
      },
    },
    links: {
      self: { href: `${baseUrl}${path}` },
      webView: { href: `https://acc.autodesk.com/docs/files/projects/${encodeURIComponent(folder.project_id)}` },
    },
    relationships: {
      ...(parent
        ? {
            parent: {
              data: { type: "folders", id: parent.folder_id },
              links: { related: { href: `${baseUrl}${folderPath(folder.project_id, parent.folder_id)}` } },
            },
          }
        : {}),
      contents: { links: { related: { href: `${baseUrl}${path}/contents` } } },
    },
  };
}

export function documentItemData(baseUrl: string, aps: ApsStore, item: ApsDocumentItem) {
  const path = itemPath(item.project_id, item.item_id);
  const tip = itemTip(aps, item.item_id);
  return {
    type: "items",
    id: item.item_id,
    attributes: {
      displayName: item.display_name,
      createTime: item.create_time,
      createUserId: item.created_by,
      createUserName: item.created_by_name,
      lastModifiedTime: item.last_modified_time,
      lastModifiedUserId: item.last_modified_by,
      lastModifiedUserName: item.last_modified_by_name,
      hidden: item.hidden,
      reserved: item.reserved,
      ...(item.reserved_time ? { reservedTime: item.reserved_time } : {}),
      ...(item.reserved_by ? { reservedUserId: item.reserved_by } : {}),
      ...(item.reserved_by_name ? { reservedUserName: item.reserved_by_name } : {}),
      extension: {
        type: item.extension_type,
        version: "1.0",
        schema: { href: schemaHref(item.extension_type) },
        data: { sourceFileName: item.display_name },
      },
    },
    links: {
      self: { href: `${baseUrl}${path}` },
      webView: { href: `https://acc.autodesk.com/docs/files/projects/${encodeURIComponent(item.project_id)}` },
    },
    relationships: {
      parent: {
        data: { type: "folders", id: item.folder_id },
        links: { related: { href: `${baseUrl}${folderPath(item.project_id, item.folder_id)}` } },
      },
      ...(tip
        ? {
            tip: {
              data: { type: "versions", id: tip.version_id },
              links: { related: { href: `${baseUrl}${path}/tip` } },
            },
          }
        : {}),
      versions: { links: { related: { href: `${baseUrl}${path}/versions` } } },
    },
  };
}

export function documentVersionData(baseUrl: string, version: ApsDocumentVersion) {
  const path = versionPath(version.project_id, version.version_id);
  return {
    type: "versions",
    id: version.version_id,
    attributes: {
      name: version.display_name,
      displayName: version.display_name,
      createTime: version.create_time,
      createUserId: version.created_by,
      createUserName: version.created_by_name,
      lastModifiedTime: version.last_modified_time,
      lastModifiedUserId: version.last_modified_by,
      lastModifiedUserName: version.last_modified_by_name,
      versionNumber: version.version_number,
      mimeType: version.mime_type,
      fileType: version.file_type,
      storageSize: version.storage_size,
      extension: {
        type: VERSION_EXTENSION_TYPE,
        version: "1.0",
        schema: { href: schemaHref(VERSION_EXTENSION_TYPE) },
        data: {
          tempUrn: null,
          properties: {},
          storageUrn: version.storage_urn,
          storageType: "OSS",
          conformingStatus: "NONE",
        },
      },
    },
    links: {
      self: { href: `${baseUrl}${path}` },
      webView: { href: `https://acc.autodesk.com/docs/files/projects/${encodeURIComponent(version.project_id)}` },
    },
    relationships: {
      item: {
        data: { type: "items", id: version.item_id },
        links: { related: { href: `${baseUrl}${itemPath(version.project_id, version.item_id)}` } },
      },
      storage: { data: { type: "objects", id: version.storage_urn } },
      ...(version.bubble_urn
        ? {
            derivatives: {
              data: { type: "derivatives", id: version.bubble_urn },
              meta: {
                link: {
                  href: `${baseUrl}/modelderivative/v2/designdata/${encodeURIComponent(version.bubble_urn)}/manifest`,
                },
              },
            },
          }
        : {}),
    },
  };
}

function projectForDataRoute(aps: ApsStore, projectId: string): ApsProject | undefined {
  return aps.projects.findOneBy("project_id", routeId(projectId));
}

function folderForDataRoute(c: Context<AppEnv>, aps: ApsStore): ApsDocumentFolder | Response {
  const project = projectForDataRoute(aps, c.req.param("projectId"));
  const folderId = routeId(c.req.param("folderId"));
  const folder = aps.documentFolders.findOneBy("folder_id", folderId);
  if (!project || !folder || folder.project_id !== project.project_id) {
    return jsonApiNotFound(c, `The folder ${folderId} was not found in project ${c.req.param("projectId")}.`);
  }
  return folder;
}

function queryValues(c: Context<AppEnv>, name: string): string[] {
  return (c.req.queries(name) ?? []).flatMap((value) => value.split(",")).filter(Boolean);
}

function pagination(c: Context<AppEnv>): { number: number; limit: number } | string {
  const numberValue = c.req.query("page[number]") ?? "0";
  const limitValue = c.req.query("page[limit]") ?? "200";
  if (!/^\d+$/.test(numberValue)) return "page[number] must be a non-negative integer.";
  if (!/^\d+$/.test(limitValue)) return "page[limit] must be an integer from 1 through 200.";
  const number = Number(numberValue);
  const limit = Number(limitValue);
  if (limit < 1 || limit > 200) return "page[limit] must be an integer from 1 through 200.";
  return { number, limit };
}

function pageLinks(c: Context<AppEnv>, baseUrl: string, number: number, limit: number, total: number) {
  const href = (pageNumber: number) => {
    const url = new URL(requestHref(c, baseUrl));
    url.searchParams.set("page[number]", String(pageNumber));
    url.searchParams.set("page[limit]", String(limit));
    return { href: url.toString() };
  };
  const last = Math.max(0, Math.ceil(total / limit) - 1);
  return {
    self: { href: requestHref(c, baseUrl) },
    first: href(0),
    ...(number > 0 ? { prev: href(number - 1) } : {}),
    ...(number < last ? { next: href(number + 1) } : {}),
  };
}

function includedTipVersions(baseUrl: string, aps: ApsStore, items: ApsDocumentItem[]) {
  return items
    .map((item) => itemTip(aps, item.item_id))
    .filter((version): version is ApsDocumentVersion => Boolean(version))
    .map((version) => documentVersionData(baseUrl, version));
}

export function dataManagementRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  const auth = apsAuth(store, { scopes: ["data:read"], requireUser: true });
  app.use("/project/v1/*", auth);

  app.get("/project/v1/hubs", (c) =>
    jsonApiDocument(
      c,
      `${baseUrl}/project/v1/hubs`,
      aps.hubs.all().map((hub) => hubData(baseUrl, hub)),
    ),
  );

  app.get("/project/v1/hubs/:hubId", (c) => {
    const hub = aps.hubs.findOneBy("hub_id", routeId(c.req.param("hubId")));
    if (!hub) return jsonApiNotFound(c, `The hub ${c.req.param("hubId")} was not found.`);
    return jsonApiDocument(c, `${baseUrl}${hubPath(hub.hub_id)}`, hubData(baseUrl, hub));
  });

  app.get("/project/v1/hubs/:hubId/projects", (c) => {
    const hubId = routeId(c.req.param("hubId"));
    if (!aps.hubs.findOneBy("hub_id", hubId)) return jsonApiNotFound(c, `The hub ${hubId} was not found.`);
    const path = `${hubPath(hubId)}/projects`;
    return jsonApiDocument(
      c,
      `${baseUrl}${path}`,
      aps.projects.findBy("hub_id", hubId).map((project) => projectData(baseUrl, aps, project)),
    );
  });

  app.get("/project/v1/hubs/:hubId/projects/:projectId", (c) => {
    const hubId = routeId(c.req.param("hubId"));
    if (!aps.hubs.findOneBy("hub_id", hubId)) return jsonApiNotFound(c, `The hub ${hubId} was not found.`);
    const projectId = routeId(c.req.param("projectId"));
    const project = aps.projects.findOneBy("project_id", projectId);
    if (!project || project.hub_id !== hubId)
      return jsonApiNotFound(c, `The project ${projectId} was not found in hub ${hubId}.`);
    return jsonApiDocument(
      c,
      `${baseUrl}${projectPath(hubId, project.project_id)}`,
      projectData(baseUrl, aps, project),
    );
  });

  app.get("/project/v1/hubs/:hubId/projects/:projectId/topFolders", (c) => {
    const hubId = routeId(c.req.param("hubId"));
    const projectId = routeId(c.req.param("projectId"));
    const project = aps.projects.findOneBy("project_id", projectId);
    if (!project || project.hub_id !== hubId)
      return jsonApiNotFound(c, `The project ${projectId} was not found in hub ${hubId}.`);
    const folders = aps.documentFolders
      .findBy("project_id", project.project_id)
      .filter((folder) => folder.parent_folder_id === null && !folder.hidden);
    return jsonApiDocument(
      c,
      requestHref(c, baseUrl),
      folders.map((folder) => folderData(baseUrl, aps, folder)),
    );
  });

  app.get("/data/v1/projects/:projectId/folders/:folderId", auth, (c) => {
    const folder = folderForDataRoute(c, aps);
    if (folder instanceof Response) return folder;
    return jsonApiDocument(c, requestHref(c, baseUrl), folderData(baseUrl, aps, folder));
  });

  app.get("/data/v1/projects/:projectId/folders/:folderId/contents", auth, (c) => {
    const folder = folderForDataRoute(c, aps);
    if (folder instanceof Response) return folder;
    const parsedPage = pagination(c);
    if (typeof parsedPage === "string") return jsonApiError(c, 400, "BAD_INPUT", parsedPage);
    const types = queryValues(c, "filter[type]");
    if (types.some((type) => type !== "folders" && type !== "items")) {
      return jsonApiError(c, 400, "BAD_INPUT", "filter[type] accepts only folders and items.");
    }
    const extensions = queryValues(c, "filter[extension.type]");
    const includeHidden = c.req.query("includeHidden") === "true";
    const children = aps.documentFolders
      .findBy("parent_folder_id", folder.folder_id)
      .filter((child) => includeHidden || !child.hidden)
      .filter(() => types.length === 0 || types.includes("folders"))
      .filter(() => extensions.length === 0 || extensions.includes(FOLDER_EXTENSION_TYPE))
      .map((child) => ({ kind: "folder" as const, value: child }));
    const items = aps.documentItems
      .findBy("folder_id", folder.folder_id)
      .filter((item) => includeHidden || !item.hidden)
      .filter(() => types.length === 0 || types.includes("items"))
      .filter((item) => extensions.length === 0 || extensions.includes(item.extension_type))
      .map((item) => ({ kind: "item" as const, value: item }));
    const resources = [...children, ...items];
    const start = parsedPage.number * parsedPage.limit;
    const page = resources.slice(start, start + parsedPage.limit);
    const included = includedTipVersions(
      baseUrl,
      aps,
      page
        .filter((entry): entry is { kind: "item"; value: ApsDocumentItem } => entry.kind === "item")
        .map((entry) => entry.value),
    );
    return jsonApiDocument(
      c,
      requestHref(c, baseUrl),
      page.map((entry) =>
        entry.kind === "folder" ? folderData(baseUrl, aps, entry.value) : documentItemData(baseUrl, aps, entry.value),
      ),
      { included, links: pageLinks(c, baseUrl, parsedPage.number, parsedPage.limit, resources.length) },
    );
  });

  app.get("/data/v1/projects/:projectId/folders/:folderId/search", auth, (c) => {
    const folder = folderForDataRoute(c, aps);
    if (folder instanceof Response) return folder;
    const parsedPage = pagination(c);
    if (typeof parsedPage === "string") return jsonApiError(c, 400, "BAD_INPUT", parsedPage);
    const name = c.req.query("filter[attributes.displayName]")?.toLocaleLowerCase() ?? "";
    const fileTypes = queryValues(c, "filter[fileType]")
      .map((value) => value.trim().toLocaleLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    const folderIds = new Set(folderSubtree(aps, folder.project_id, folder.folder_id).map((entry) => entry.folder_id));
    const items = aps.documentItems
      .findBy("project_id", folder.project_id)
      .filter((item) => folderIds.has(item.folder_id) && !item.hidden)
      .filter((item) => !name || item.display_name.toLocaleLowerCase().includes(name))
      .filter((item) => {
        if (fileTypes.length === 0) return true;
        const tip = itemTip(aps, item.item_id);
        return Boolean(tip && fileTypes.includes(tip.file_type.toLocaleLowerCase()));
      });
    const start = parsedPage.number * parsedPage.limit;
    const page = items.slice(start, start + parsedPage.limit);
    return jsonApiDocument(
      c,
      requestHref(c, baseUrl),
      page.map((item) => documentItemData(baseUrl, aps, item)),
      {
        included: includedTipVersions(baseUrl, aps, page),
        links: pageLinks(c, baseUrl, parsedPage.number, parsedPage.limit, items.length),
      },
    );
  });

  app.get("/data/v1/projects/:projectId/items/:itemId", auth, (c) => {
    const project = projectForDataRoute(aps, c.req.param("projectId"));
    const itemId = routeId(c.req.param("itemId"));
    const item = aps.documentItems.findOneBy("item_id", itemId);
    if (!project || !item || item.project_id !== project.project_id) {
      return jsonApiNotFound(c, `The item ${itemId} was not found in project ${c.req.param("projectId")}.`);
    }
    const tip = itemTip(aps, item.item_id);
    return jsonApiDocument(c, requestHref(c, baseUrl), documentItemData(baseUrl, aps, item), {
      included: tip ? [documentVersionData(baseUrl, tip)] : [],
    });
  });

  app.get("/data/v1/projects/:projectId/items/:itemId/versions", auth, (c) => {
    const project = projectForDataRoute(aps, c.req.param("projectId"));
    const itemId = routeId(c.req.param("itemId"));
    const item = aps.documentItems.findOneBy("item_id", itemId);
    if (!project || !item || item.project_id !== project.project_id) {
      return jsonApiNotFound(c, `The item ${itemId} was not found in project ${c.req.param("projectId")}.`);
    }
    const parsedPage = pagination(c);
    if (typeof parsedPage === "string") return jsonApiError(c, 400, "BAD_INPUT", parsedPage);
    const extensions = queryValues(c, "filter[extension.type]");
    const versionNumbers = queryValues(c, "filter[versionNumber]");
    const versions = aps.documentVersions
      .findBy("item_id", item.item_id)
      .filter(() => extensions.length === 0 || extensions.includes(VERSION_EXTENSION_TYPE))
      .filter((version) => versionNumbers.length === 0 || versionNumbers.includes(String(version.version_number)))
      .sort((left, right) => right.version_number - left.version_number);
    const start = parsedPage.number * parsedPage.limit;
    return jsonApiDocument(
      c,
      requestHref(c, baseUrl),
      versions.slice(start, start + parsedPage.limit).map((version) => documentVersionData(baseUrl, version)),
      { links: pageLinks(c, baseUrl, parsedPage.number, parsedPage.limit, versions.length) },
    );
  });

  app.get("/data/v1/projects/:projectId/items/:itemId/tip", auth, (c) => {
    const project = projectForDataRoute(aps, c.req.param("projectId"));
    const itemId = routeId(c.req.param("itemId"));
    const item = aps.documentItems.findOneBy("item_id", itemId);
    const tip = item ? itemTip(aps, item.item_id) : undefined;
    if (!project || !item || item.project_id !== project.project_id || !tip) {
      return jsonApiNotFound(c, `The tip for item ${itemId} was not found in project ${c.req.param("projectId")}.`);
    }
    return jsonApiDocument(c, requestHref(c, baseUrl), documentVersionData(baseUrl, tip));
  });

  app.get("/data/v1/projects/:projectId/versions/:versionId", auth, (c) => {
    const project = projectForDataRoute(aps, c.req.param("projectId"));
    const versionId = routeId(c.req.param("versionId"));
    const version = aps.documentVersions.findOneBy("version_id", versionId);
    if (!project || !version || version.project_id !== project.project_id) {
      return jsonApiNotFound(c, `The version ${versionId} was not found in project ${c.req.param("projectId")}.`);
    }
    return jsonApiDocument(c, requestHref(c, baseUrl), documentVersionData(baseUrl, version));
  });
}
