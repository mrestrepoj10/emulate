import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { bareProjectId } from "../acc.js";
import { DEFAULT_MANIFEST_URN, DEFAULT_PROJECT_ID, isRecordObject, jsonObjectBody, optionalString } from "../helpers.js";
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
      ? aps.webhookDmVersions.findOneBy("version_id", requestedVersionId)
      : aps.webhookDmVersions.all()[0];
    if (!version) return simulatorError(c, "The seeded Data Management version was not found.", 404);
    const now = new Date().toISOString();
    const projectId = bareProjectId(version.project_id);
    const payload = {
      ext: version.display_name.split(".").pop() ?? "",
      modifiedTime: now,
      creator: "testuser@autodesk.local",
      lineageUrn: version.item_id,
      sizeInBytes: 0,
      hidden: false,
      indexable: true,
      project: projectId,
      source: version.version_id,
      version: "1",
      user_info: { id: "testuser@autodesk.local" },
      name: version.display_name,
      createdTime: now,
      modifiedBy: "testuser@autodesk.local",
      state: "CONTENT_AVAILABLE",
      parentFolderUrn: version.folder_id,
      ancestors: [...version.ancestor_folder_ids, version.folder_id].map((urn, index) => ({
        urn,
        name: index === version.ancestor_folder_ids.length ? "Plans" : `Ancestor ${index + 1}`,
      })),
      tenant: projectId,
    };
    const report = await simulateWebhookEvent(aps, store, {
      system: "data",
      event: "dm.version.added",
      resourceUrn: version.version_id,
      region: version.region,
      scope: { folder: version.folder_id, project: version.project_id },
      folderAncestors: version.ancestor_folder_ids,
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
