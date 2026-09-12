import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { bareProjectId } from "../acc.js";
import { documentVersionAddedEvent } from "../dm-events.js";
import {
  DEFAULT_MANIFEST_URN,
  DEFAULT_PROJECT_ID,
  isRecordObject,
  jsonObjectBody,
  optionalString,
} from "../helpers.js";
import type { ApsClashScenarioVersionSeed, ApsModelSetDocumentStatus } from "../config.js";
import {
  addModelSetVersion,
  clashGroupPayload,
  clashTestPayload,
  createClashGroup,
  modelSetVersionPayload,
} from "../model-coordination.js";
import { getApsStore } from "../store.js";
import { forceTranslationTerminal, manifestForJob } from "../translation.js";
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

function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** Parses an optional clash scenario step from a simulator request body. */
function scenarioStepBody(body: Record<string, unknown>): ApsClashScenarioVersionSeed | string {
  const added = optionalCount(body.added);
  const resolved = optionalCount(body.resolved);
  if (added === null || resolved === null) return "added and resolved must be non-negative integers.";
  const documentsAdded = optionalStringArray(body.documents_added ?? body.documentsAdded);
  const documentsRemoved = optionalStringArray(body.documents_removed ?? body.documentsRemoved);
  if (documentsAdded === null || documentsRemoved === null) {
    return "documents_added and documents_removed must be arrays of Data Management version IDs.";
  }
  const status = optionalString(body.status);
  if (status !== undefined && !["Successful", "Partial", "Failed"].includes(status)) {
    return "status must be Successful, Partial, or Failed.";
  }
  const rawStatuses = body.document_status ?? body.documentStatus;
  const documentStatus = rawStatuses === undefined ? undefined : stringRecord(rawStatuses);
  if (rawStatuses !== undefined && !documentStatus) return "document_status must map version IDs to statuses.";
  return {
    added,
    resolved,
    documents_added: documentsAdded,
    documents_removed: documentsRemoved,
    status: status as ApsClashScenarioVersionSeed["status"],
    document_status: documentStatus as Record<string, ApsModelSetDocumentStatus> | undefined,
  };
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
    const step = scenarioStepBody(body);
    if (typeof step === "string") return simulatorError(c, step);
    let result: ReturnType<typeof addModelSetVersion>;
    try {
      result = addModelSetVersion(aps, store, modelSet, { processingMs, step });
    } catch (error) {
      return simulatorError(c, error instanceof Error ? error.message : String(error));
    }
    return c.json({
      modelSetVersion: modelSetVersionPayload(result.version),
      clashTest: clashTestPayload(result.test),
    });
  });

  for (const kind of ["assigned", "closed"] as const) {
    app.post(`/_aps/simulate/clash-group-${kind}`, async (c) => {
      const body = await jsonObjectBody(c);
      if (!body) return simulatorError(c, "The request body must be a JSON object.");
      const requestedModelSetId = optionalString(body.modelSetId);
      const testId = optionalString(body.testId);
      const test = testId ? aps.clashTests.findOneBy("test_id", testId) : undefined;
      if (testId && !test) return simulatorError(c, "The clash test was not found.", 404);
      const modelSet = test
        ? aps.modelSets.findOneBy("model_set_id", test.model_set_id)
        : requestedModelSetId
          ? aps.modelSets.findOneBy("model_set_id", requestedModelSetId)
          : aps.modelSets.all()[0];
      if (!modelSet) return simulatorError(c, "The seeded model set was not found.", 404);
      if (test && requestedModelSetId && test.model_set_id !== requestedModelSetId) {
        return simulatorError(c, "testId belongs to a different model set than modelSetId.");
      }
      let version: number | undefined = test?.model_set_version;
      if (version === undefined) {
        if (body.version === undefined) {
          version = aps.clashTests
            .findBy("model_set_id", modelSet.model_set_id)
            .reduce((max, candidate) => Math.max(max, candidate.model_set_version), 0);
        } else if (typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 1) {
          version = body.version;
        } else {
          return simulatorError(c, "version must be a positive integer.");
        }
      }
      const clashes = body.clashes ?? 1;
      if (
        !(typeof clashes === "number" && Number.isInteger(clashes) && clashes >= 1) &&
        !(Array.isArray(clashes) && clashes.length > 0 && clashes.every((item) => Number.isInteger(item)))
      ) {
        return simulatorError(c, "clashes must be a positive integer count or a non-empty array of clash IDs.");
      }
      const screenShots = optionalStringArray(body.screenShots);
      if (screenShots === null) return simulatorError(c, "screenShots must be an array of strings.");
      try {
        const group = createClashGroup(aps, store, modelSet, {
          kind,
          version,
          clashes: clashes as number | number[],
          id: optionalString(body.id),
          issueId: optionalString(body.issueId),
          title: optionalString(body.title),
          description: optionalString(body.description),
          reason: optionalString(body.reason),
          screenShots,
          createdBy: optionalString(body.createdBy),
        });
        return c.json(clashGroupPayload(group));
      } catch (error) {
        return simulatorError(c, error instanceof Error ? error.message : String(error));
      }
    });
  }

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
    const event = documentVersionAddedEvent(aps, version);
    if (!event) return simulatorError(c, "The seeded Data Management item or folder was not found.", 404);
    const report = await simulateWebhookEvent(aps, store, event);
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

  app.post("/_aps/simulate/translation-complete", async (c) => {
    const body = await jsonObjectBody(c);
    if (!body) return simulatorError(c, "The request body must be a JSON object.");
    const urn = optionalString(body.urn);
    const status = optionalString(body.status) ?? "success";
    if (!urn) return simulatorError(c, "urn is required.");
    if (status !== "success" && status !== "failed") {
      return simulatorError(c, "status must be success or failed.");
    }
    const job = aps.translationJobs.findOneBy("urn", urn);
    if (!job) return simulatorError(c, "The translation job was not found.", 404);
    const completed = await forceTranslationTerminal(aps, store, job, status);
    return c.json(manifestForJob(completed));
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
