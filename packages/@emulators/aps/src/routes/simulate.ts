import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { bareProjectId } from "../acc.js";
import { documentItemForVersion, folderAncestors } from "../dm-tree.js";
import {
  DEFAULT_MANIFEST_URN,
  DEFAULT_PROJECT_ID,
  isRecordObject,
  jsonObjectBody,
  optionalString,
} from "../helpers.js";
import { addModelSetVersion, clashTestPayload, modelSetVersionPayload } from "../model-coordination.js";
import { getApsStore } from "../store.js";
import { parseWebhookRegion } from "../webhook-events.js";
import { simulateWebhookEvent } from "../webhooks.js";

function simulatorError(c: Context<AppEnv>, message: string, status: 400 | 404 = 400): Response {
  return c.json({ error: message }, status);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecordObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

export function simulateRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);

  app.post("/_aps/simulate/modelset-version-added", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const requestedModelSetId = optionalString(body.modelSetId);
    const modelSet = requestedModelSetId
      ? aps.modelSets.findOneBy("model_set_id", requestedModelSetId)
      : aps.modelSets.all()[0];
    if (!modelSet) return simulatorError(c, "The seeded model set was not found.", 404);
    const processingMs = body.processingMs;
    if (
      processingMs !== undefined &&
      (typeof processingMs !== "number" || !Number.isFinite(processingMs) || processingMs < 0)
    ) {
      return simulatorError(c, "processingMs must be a non-negative number.");
    }
    const result = addModelSetVersion(aps, store, modelSet, { processingMs });
    return c.json({
      modelSetVersion: modelSetVersionPayload(result.version),
      clashTest: clashTestPayload(result.test),
    });
  });

  app.post("/_aps/simulate/event", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const system = optionalString(body.system);
    const event = optionalString(body.event);
    const region = parseWebhookRegion(optionalString(body.region) ?? "US");
    if (!system || !event || !region) return simulatorError(c, "system, event, and a valid region are required.");
    if (body.payload !== undefined && !isRecordObject(body.payload))
      return simulatorError(c, "payload must be an object.");
    const scope = body.scope === undefined ? undefined : stringRecord(body.scope);
    if (body.scope !== undefined && !scope) return simulatorError(c, "scope values must be strings.");
    if (
      body.folderAncestors !== undefined &&
      (!Array.isArray(body.folderAncestors) || body.folderAncestors.some((item) => typeof item !== "string"))
    ) {
      return simulatorError(c, "folderAncestors must contain strings.");
    }
    const resourceUrn =
      optionalString(body.resourceUrn) ??
      `urn:adsk.webhooks:resource:${encodeURIComponent(system)}:${encodeURIComponent(event)}`;
    const report = await simulateWebhookEvent(aps, store, {
      system,
      event,
      resourceUrn,
      region,
      payload: (body.payload as Record<string, unknown> | undefined) ?? {},
      tenant: optionalString(body.tenant),
      scopeValue: optionalString(body.scopeValue),
      scope,
      folderAncestors: body.folderAncestors as string[] | undefined,
    });
    return c.json(report);
  });

  app.post("/_aps/simulate/dm-version-added", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const requestedVersionId = optionalString(body.versionId);
    const version = requestedVersionId
      ? aps.documentVersions.findOneBy("version_id", requestedVersionId)
      : aps.documentVersions.all()[0];
    if (!version) return simulatorError(c, "The seeded Data Management version was not found.", 404);
    const item = documentItemForVersion(aps, version);
    if (!item) return simulatorError(c, "The seeded Data Management item was not found.", 404);
    const folder = aps.documentFolders.findOneBy("folder_id", item.folder_id);
    if (!folder) return simulatorError(c, "The seeded Data Management folder was not found.", 404);
    const ancestors = folderAncestors(aps, version.project_id, folder.folder_id);
    const projectId = bareProjectId(version.project_id);
    const payload = {
      ext: version.file_type,
      modifiedTime: version.last_modified_time,
      creator: version.created_by,
      lineageUrn: version.item_id,
      sizeInBytes: version.storage_size,
      hidden: item.hidden,
      indexable: true,
      project: projectId,
      source: version.version_id,
      version: String(version.version_number),
      user_info: { id: version.created_by },
      name: version.display_name,
      createdTime: version.create_time,
      modifiedBy: version.last_modified_by,
      state: "CONTENT_AVAILABLE",
      parentFolderUrn: folder.folder_id,
      ancestors: [...ancestors, folder].map((ancestor) => ({ urn: ancestor.folder_id, name: ancestor.name })),
      tenant: projectId,
    };
    const report = await simulateWebhookEvent(aps, store, {
      system: "data",
      event: "dm.version.added",
      resourceUrn: version.version_id,
      region: version.region,
      scope: { folder: folder.folder_id, project: version.project_id },
      folderAncestors: ancestors.map((ancestor) => ancestor.folder_id),
      payload,
    });
    return c.json(report);
  });

  app.post("/_aps/simulate/extraction-finished", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const urn = optionalString(body.urn) ?? DEFAULT_MANIFEST_URN;
    const manifest = aps.manifests.findOneBy("urn", urn);
    if (!manifest) return simulatorError(c, "The seeded manifest was not found.", 404);
    const workflow = optionalString(body.workflow) ?? "emulate-translation";
    const payload = {
      TimeStamp: Date.now(),
      URN: manifest.urn,
      EventType: "EXTRACTION_FINISHED",
      Payload: {
        status: manifest.status,
        scope: workflow,
        registerKey: [],
      },
    };
    const report = await simulateWebhookEvent(aps, store, {
      system: "derivative",
      event: "extraction.finished",
      resourceUrn: manifest.urn,
      region: manifest.region,
      scope: { workflow },
      payload,
    });
    return c.json(report);
  });

  app.post("/_aps/simulate/issue-created", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const requestedProjectId = optionalString(body.projectId) ?? bareProjectId(DEFAULT_PROJECT_ID);
    const project = aps.projects.all().find((candidate) => bareProjectId(candidate.project_id) === requestedProjectId);
    if (!project) return simulatorError(c, "The seeded project was not found.", 404);
    const requestedIssueId = optionalString(body.issueId);
    const issue = requestedIssueId
      ? aps.issues.findBy("project_id", project.project_id).find((candidate) => candidate.issue_id === requestedIssueId)
      : aps.issues.findBy("project_id", project.project_id)[0];
    if (!issue) return simulatorError(c, "The seeded issue was not found.", 404);
    const projectId = bareProjectId(project.project_id);
    const payload = {
      ...structuredClone(issue.payload),
      projectId,
    };
    const report = await simulateWebhookEvent(aps, store, {
      system: "autodesk.construction.issues",
      event: "issue.created-1.0",
      resourceUrn: `urn:adsk.issues:issues.issue:${issue.issue_id}`,
      region: "US",
      scope: { project: projectId },
      payload,
    });
    return c.json(report);
  });
}
