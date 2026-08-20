import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

describe("APS Data Management routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("lists seeded hubs in an APS JSON:API envelope", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${base}/project/v1/hubs`, { headers: bearer(token) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.api+json");
    const body = (await response.json()) as Record<string, any>;
    expect(body.jsonapi).toEqual({ version: "1.0" });
    expect(body.links.self.href).toBe(`${base}/project/v1/hubs`);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      type: "hubs",
      id: "b.emulate-hub",
      attributes: {
        name: "Emulate Construction Hub",
        region: "US",
        extension: { type: "hubs:autodesk.bim360:Account", version: "1.0" },
      },
    });
    expect(body.data[0].relationships.projects.links.related.href).toBe(
      `${base}/project/v1/hubs/b.emulate-hub/projects`,
    );
  });

  it("gets a hub, its projects, and one project", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);

    const hubResponse = await app.request(`${base}/project/v1/hubs/b.emulate-hub`, { headers });
    expect(hubResponse.status).toBe(200);
    const hub = (await hubResponse.json()) as Record<string, any>;
    expect(hub.data.id).toBe("b.emulate-hub");

    const listResponse = await app.request(`${base}/project/v1/hubs/b.emulate-hub/projects`, { headers });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as Record<string, any>;
    expect(list.data).toHaveLength(2);
    expect(list.data[0]).toMatchObject({
      type: "projects",
      id: "b.emulate-project",
      attributes: {
        name: "Sample Building",
        scopes: ["global"],
        extension: { data: { projectType: "ACC" } },
      },
      relationships: { hub: { data: { type: "hubs", id: "b.emulate-hub" } } },
    });

    const projectResponse = await app.request(`${base}/project/v1/hubs/b.emulate-hub/projects/b.emulate-project`, {
      headers,
    });
    expect(projectResponse.status).toBe(200);
    const project = (await projectResponse.json()) as Record<string, any>;
    expect(project.data.id).toBe("b.emulate-project");
    expect(project.data.relationships.rootFolder.data.type).toBe("folders");
  });

  it("rejects 2-legged access with the APS insufficient-privilege error", async () => {
    const token = await issueTwoLeggedToken(app);
    const response = await app.request(`${base}/project/v1/hubs`, { headers: bearer(token) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      developerMessage: "Token does not have the privilege for this request.",
      moreInfo: "https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/error_handling/",
      errorCode: "AUTH-010",
    });
  });

  it("rejects a revoked 3-legged access token", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const credentials = Buffer.from("aps-test-client:aps-test-secret").toString("base64");
    const revoke = await app.request(`${base}/authentication/v2/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(revoke.status).toBe(200);

    const response = await app.request(`${base}/project/v1/hubs`, { headers: bearer(token) });
    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-006" });
  });

  it("rejects a 3-legged token without data:read", async () => {
    const token = await issueThreeLeggedToken(app, store, "user-profile:read");
    const response = await app.request(`${base}/project/v1/hubs`, { headers: bearer(token) });
    expect(response.status).toBe(403);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });
  });

  it("returns JSON:API 404 errors for unknown hubs and projects", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);

    const hubResponse = await app.request(`${base}/project/v1/hubs/b.missing`, { headers });
    expect(hubResponse.status).toBe(404);
    const hubBody = (await hubResponse.json()) as Record<string, any>;
    expect(hubBody.jsonapi).toEqual({ version: "1.0" });
    expect(hubBody.errors[0]).toMatchObject({ status: "404", code: "NOT_FOUND" });

    const projectResponse = await app.request(`${base}/project/v1/hubs/b.emulate-hub/projects/b.missing`, { headers });
    expect(projectResponse.status).toBe(404);
    const projectBody = (await projectResponse.json()) as Record<string, any>;
    expect(projectBody.errors[0].detail).toContain("b.missing");
  });

  it("serves custom seeded hubs and projects", async () => {
    const setup = createTestApp({
      hubs: [{ id: "b.custom-hub", name: "Custom Hub", region: "EMEA" }],
      projects: [{ id: "b.custom-project", hub_id: "b.custom-hub", name: "Custom Project" }],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${base}/project/v1/hubs/b.custom-hub/projects`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "b.custom-project",
      attributes: { name: "Custom Project" },
    });
  });

  it("rejects projects that reference an unknown hub", () => {
    expect(() =>
      createTestApp({
        projects: [{ id: "b.orphan", hub_id: "b.missing", name: "Orphan Project" }],
      }),
    ).toThrow("APS project 'b.orphan' references unknown hub 'b.missing'.");
  });
});
