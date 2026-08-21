import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import type { ApsClashTest, ApsProject } from "../entities.js";
import {
  CLASH_RESOURCE_TYPES,
  clashResourceBlobId,
  clashTestPayload,
  ensureClashArtifacts,
  getModelCoordinationTiming,
} from "../model-coordination.js";
import { coordinationPage, coordinationProject, queryValues } from "../model-coordination-http.js";
import { badInput, notFound, problem } from "../problem.js";
import { issueSignedBlobUrl } from "../signed-blobs.js";
import { getApsStore, type ApsStore } from "../store.js";

const TEST_STATUSES = ["Pending", "Processing", "Success", "Failed"];

function clashTestForProject(c: Context<AppEnv>, aps: ApsStore, project: ApsProject): ApsClashTest | Response {
  const test = aps.clashTests.findOneBy("test_id", c.req.param("testId"));
  if (!test || test.project_id !== project.project_id) return notFound(c, "The requested clash test");
  return test;
}

export function clashRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  app.use("/bim360/clash/v3/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  app.get("/bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/tests", (c) => {
    const project = coordinationProject(c, aps);
    if (project instanceof Response) return project;
    const modelSet = aps.modelSets.findOneBy("model_set_id", c.req.param("modelSetId"));
    if (!modelSet || modelSet.project_id !== project.project_id) return notFound(c, "The requested model set");
    const statuses = queryValues(c, "status");
    const invalidStatus = statuses.find((status) => !TEST_STATUSES.includes(status));
    if (invalidStatus) return badInput(c, "status", `The value '${invalidStatus}' is not valid.`);
    const tests = aps.clashTests
      .findBy("model_set_id", modelSet.model_set_id)
      .filter((test) => statuses.length === 0 || statuses.includes(test.status))
      .sort((left, right) => right.model_set_version - left.model_set_version);
    const page = coordinationPage(c, tests);
    if (page instanceof Response) return page;
    return c.json({ page: page.page, tests: page.items.map(clashTestPayload) });
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
        detail: "Clash resources are available only after the clash test succeeds.",
      });
    }
    const version = aps.modelSetVersions
      .findBy("model_set_id", test.model_set_id)
      .find((candidate) => candidate.version === test.model_set_version);
    if (!version) return notFound(c, "The clash test model set version");
    ensureClashArtifacts(aps, version, test);
    const ttl = getModelCoordinationTiming(store).signed_url_ttl_ms;
    const resources = CLASH_RESOURCE_TYPES.map((type) => {
      const signed = issueSignedBlobUrl(store, baseUrl, clashResourceBlobId(test.test_id, type), ttl);
      return { type, extension: "json.gz", url: signed.url, headers: {}, validUntil: signed.validUntil };
    });
    return c.json({ page: {}, resources });
  });

  for (const disposition of ["assigned", "closed"] as const) {
    app.get(`/bim360/clash/v3/containers/:containerId/tests/:testId/clashes/${disposition}`, (c) => {
      const project = coordinationProject(c, aps);
      if (project instanceof Response) return project;
      const test = clashTestForProject(c, aps, project);
      if (test instanceof Response) return test;
      const groups = aps.clashGroups
        .findBy("test_id", test.test_id)
        .filter((group) => group.disposition === disposition);
      const page = coordinationPage(c, groups);
      if (page instanceof Response) return page;
      return c.json({
        page: page.page,
        modelSetId: test.model_set_id,
        modelSetVersion: test.model_set_version,
        groups: page.items.map((group) => ({
          id: group.group_id,
          originalClashTestId: group.original_clash_test_id,
          createdAtVersion: group.created_at_version,
          existing: [...group.existing],
          resolved: [...group.resolved],
        })),
      });
    });
  }
}
