import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import { CLASH_CLOSE_REASONS } from "../config.js";
import type { ApsClashGroup, ApsClashGroupDisposition, ApsClashTest, ApsModelSet, ApsProject } from "../entities.js";
import {
  CLASH_RESOURCE_TYPES,
  clashGroupIntersectionPayload,
  clashGroupPayload,
  clashResourceBlobId,
  clashResourceExtension,
  clashTestPayload,
  getModelCoordinationTiming,
  modelSetVersionNumber,
  versionClashData,
  writeClashArtifacts,
} from "../model-coordination.js";
import {
  booleanQuery,
  coordinationMiddleware,
  coordinationPage,
  coordinationProject,
  dateQuery,
  modelSetForProject,
  queryValues,
  sortQuery,
} from "../model-coordination-http.js";
import { badInput, notFound, problem } from "../problem.js";
import { issueSignedBlobUrl } from "../signed-blobs.js";
import { getApsStore, type ApsStore } from "../store.js";

const TEST_STATUSES = ["Pending", "Processing", "Success", "Failed"];
const BATCH_MAX_IDS = 20;

function clashTestForProject(c: Context<AppEnv>, aps: ApsStore, project: ApsProject): ApsClashTest | Response {
  const test = aps.clashTests.findOneBy("test_id", c.req.param("testId"));
  if (!test || test.project_id !== project.project_id) return notFound(c, "The requested clash test");
  return test;
}

function modelSetForTest(c: Context<AppEnv>, aps: ApsStore, test: ApsClashTest): ApsModelSet | Response {
  const modelSet = aps.modelSets.findOneBy("model_set_id", test.model_set_id);
  return modelSet ?? notFound(c, "The clash test model set");
}

function testsResponse(c: Context<AppEnv>, tests: ApsClashTest[]): Response {
  const statuses = queryValues(c, "status");
  const invalidStatus = statuses.find((status) => !TEST_STATUSES.includes(status));
  if (invalidStatus) return badInput(c, "status", `The value '${invalidStatus}' is not valid.`);
  const filtered = tests
    .filter((test) => statuses.length === 0 || statuses.includes(test.status))
    .sort((left, right) => right.model_set_version - left.model_set_version);
  const page = coordinationPage(c, filtered);
  if (page instanceof Response) return page;
  return c.json({ page: page.page, tests: page.items.map(clashTestPayload) });
}

function searchGroups(
  c: Context<AppEnv>,
  aps: ApsStore,
  modelSet: ApsModelSet,
  disposition: ApsClashGroupDisposition,
): Response {
  const clashTestId = c.req.query("clashTestId");
  const issueId = c.req.query("issueId");
  const reason = c.req.query("reason");
  const createdBy = c.req.query("createdBy");
  if (reason !== undefined && !(CLASH_CLOSE_REASONS as readonly string[]).includes(reason)) {
    return badInput(c, "reason", `The value '${reason}' must be one of ${CLASH_CLOSE_REASONS.join(", ")}.`);
  }
  const after = dateQuery(c, "after");
  if (after instanceof Response) return after;
  const before = dateQuery(c, "before");
  if (before instanceof Response) return before;
  const sort = sortQuery(c);
  if (sort instanceof Response) return sort;

  const groups = aps.clashGroups
    .findBy("model_set_id", modelSet.model_set_id)
    .filter((group) => group.disposition === disposition)
    .filter((group) => clashTestId === undefined || group.clash_test_id === clashTestId)
    .filter((group) => disposition !== "assigned" || issueId === undefined || group.issue_id === issueId)
    .filter((group) => disposition !== "closed" || reason === undefined || group.reason === reason)
    .filter((group) => createdBy === undefined || group.created_by === createdBy)
    .filter((group) => after === undefined || Date.parse(group.created_on) > after)
    .filter((group) => before === undefined || Date.parse(group.created_on) < before)
    .sort((left, right) => {
      const delta = Date.parse(left.created_on) - Date.parse(right.created_on) || left.id - right.id;
      return sort === "Asc" ? delta : -delta;
    });
  const page = coordinationPage(c, groups);
  if (page instanceof Response) return page;
  return c.json({ page: page.page, groups: page.items.map(clashGroupPayload) });
}

async function groupIdsBody(c: Context<AppEnv>): Promise<string[] | Response> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return problem(c, 415, {
      type: "UnsupportedMediaType",
      title: "The Content-Type header must be application/json",
      detail: `The content type '${contentType}' is not supported.`,
    });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badInput(c, "body", "The request body must be a JSON array of UUID strings.");
  }
  if (!Array.isArray(body) || body.length === 0 || body.some((item) => typeof item !== "string")) {
    return badInput(c, "body", `The request body must be an array of 1 through ${BATCH_MAX_IDS} UUID strings.`);
  }
  if (body.length > BATCH_MAX_IDS) {
    return badInput(c, "body", `The request body must contain at most ${BATCH_MAX_IDS} IDs.`);
  }
  return body as string[];
}

function groupClashData(
  aps: ApsStore,
  store: RouteContext["store"],
  modelSet: ApsModelSet,
  test: ApsClashTest,
  group: ApsClashGroup,
) {
  const data = versionClashData(aps, store, modelSet, test.model_set_version);
  const wanted = new Set(group.clashes);
  const clashes = data.clashes.filter((clash) => wanted.has(clash.id));
  const clashInstances = data.instances.filter((instance) => wanted.has(instance.cid));
  const documentIds = new Set(clashInstances.flatMap((instance) => [instance.ldid, instance.rdid]));
  return {
    documents: data.documents.filter((document) => documentIds.has(document.id)),
    clashes,
    clashInstances,
  };
}

export function clashRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  app.use("/bim360/clash/v3/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));
  app.use("/bim360/clash/v3/containers/:containerId/*", coordinationMiddleware(store, aps));

  app.get("/bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/tests", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    return testsResponse(c, aps.clashTests.findBy("model_set_id", modelSet.model_set_id));
  });

  app.get("/bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/versions/:version/tests", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const requested = c.req.param("version");
    const versionNumber = Number(requested);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return badInput(c, "version", `The value '${requested}' must be a positive integer.`);
    }
    if (!modelSetVersionNumber(aps, modelSet.model_set_id, versionNumber)) {
      return notFound(c, "The requested model set version");
    }
    return testsResponse(
      c,
      aps.clashTests
        .findBy("model_set_id", modelSet.model_set_id)
        .filter((test) => test.model_set_version === versionNumber),
    );
  });

  for (const disposition of ["assigned", "closed"] as const) {
    app.get(`/bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/clashes/${disposition}`, (c) => {
      const project = coordinationProject(c, aps);
      if (project instanceof Response) return project;
      const modelSet = modelSetForProject(c, aps, project);
      if (modelSet instanceof Response) return modelSet;
      return searchGroups(c, aps, modelSet, disposition);
    });
  }

  app.get("/bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/clashes/grouped", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = modelSetForProject(c, aps, project);
    if (modelSet instanceof Response) return modelSet;
    const clashes = [
      ...new Set(aps.clashGroups.findBy("model_set_id", modelSet.model_set_id).flatMap((group) => group.clashes)),
    ].sort((left, right) => left - right);
    return c.json({ clashes });
  });

  app.get("/bim360/clash/v3/containers/:containerId/tests/:testId", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const test = clashTestForProject(c, aps, project);
    if (test instanceof Response) return test;
    return c.json(clashTestPayload(test));
  });

  app.get("/bim360/clash/v3/containers/:containerId/tests/:testId/resources", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const test = clashTestForProject(c, aps, project);
    if (test instanceof Response) return test;
    if (test.status !== "Success") {
      return problem(c, 409, {
        type: "Conflict",
        title: "The clash test is not complete",
        detail: `Clash resources are available only after the clash test succeeds; the test status is ${test.status}.`,
      });
    }
    const modelSet = modelSetForTest(c, aps, test);
    if (modelSet instanceof Response) return modelSet;
    if (!modelSetVersionNumber(aps, test.model_set_id, test.model_set_version)) {
      return notFound(c, "The clash test model set version");
    }
    writeClashArtifacts(aps, store, modelSet, test);
    const ttl = getModelCoordinationTiming(store).signed_url_ttl_ms;
    const extension = clashResourceExtension(store, test.test_id);
    const resources = CLASH_RESOURCE_TYPES.map((type) => {
      const signed = issueSignedBlobUrl(store, baseUrl, clashResourceBlobId(test.test_id, type), ttl);
      return { type, extension, url: signed.url, headers: {}, validUntil: signed.validUntil };
    });
    return c.json({ page: {}, resources });
  });

  for (const disposition of ["assigned", "closed"] as const) {
    app.get(`/bim360/clash/v3/containers/:containerId/tests/:testId/clashes/${disposition}`, (c) => {
      const project = coordinationProject(c, aps);
      if (project instanceof Response) return project;
      const test = clashTestForProject(c, aps, project);
      if (test instanceof Response) return test;
      const modelSet = modelSetForTest(c, aps, test);
      if (modelSet instanceof Response) return modelSet;
      const groups = aps.clashGroups
        .findBy("model_set_id", test.model_set_id)
        .filter((group) => group.disposition === disposition)
        .sort((left, right) => left.id - right.id);
      const page = coordinationPage(c, groups);
      if (page instanceof Response) return page;
      const live = versionClashData(aps, store, modelSet, test.model_set_version).live;
      return c.json({
        page: page.page,
        modelSetId: test.model_set_id,
        modelSetVersion: test.model_set_version,
        groups: page.items.map((group) => clashGroupIntersectionPayload(group, live)),
      });
    });

    app.post(`/bim360/clash/v3/containers/:containerId/tests/:testId/clashes/${disposition}`, async (c) => {
      const project = coordinationProject(c, aps);
      if (project instanceof Response) return project;
      const test = clashTestForProject(c, aps, project);
      if (test instanceof Response) return test;
      const modelSet = modelSetForTest(c, aps, test);
      if (modelSet instanceof Response) return modelSet;
      const byIssue = disposition === "assigned" ? booleanQuery(c, "issues", false) : false;
      if (byIssue instanceof Response) return byIssue;
      const ids = await groupIdsBody(c);
      if (ids instanceof Response) return ids;
      const requested = new Set(ids);
      const groups = aps.clashGroups
        .findBy("model_set_id", test.model_set_id)
        .filter((group) => group.disposition === disposition)
        .filter((group) =>
          byIssue ? group.issue_id !== null && requested.has(group.issue_id) : requested.has(group.group_id),
        )
        .sort((left, right) => left.id - right.id);
      // The batch response carries the group's clash rows inside clashData rather than a bare clashes[] list.
      return c.json(
        groups.map((group) => {
          const { clashes: _clashes, ...summary } = clashGroupPayload(group);
          return { ...summary, clashData: groupClashData(aps, store, modelSet, test, group) };
        }),
      );
    });
  }
}
