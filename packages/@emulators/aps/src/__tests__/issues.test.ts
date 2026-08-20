import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const issuesBase = `${base}/construction/issues/v1/projects/emulate-project`;

describe("APS ACC Issues routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("returns the current user's seeded issue permissions", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${issuesBase}/users/me`, { headers: bearer(token) });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.isProjectAdmin).toBe(true);
    expect(body.permissionLevels).toEqual(["manage"]);
    expect(body.issues.new.permittedStatuses).toContain("closed");
    expect(body.issues.new.permittedActions).toContain("assign_all");
  });

  it("lists issue types with optional subtypes", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const withoutSubtypes = await app.request(`${issuesBase}/issue-types`, { headers: bearer(token) });
    const withoutBody = (await withoutSubtypes.json()) as Record<string, any>;
    expect(withoutBody.pagination).toEqual({ limit: 200, offset: 0, totalResults: 1 });
    expect(withoutBody.results[0]).not.toHaveProperty("subtypes");

    const withSubtypes = await app.request(`${issuesBase}/issue-types?include=subtypes&filter[isActive]=true`, {
      headers: bearer(token),
    });
    const withBody = (await withSubtypes.json()) as Record<string, any>;
    expect(withBody.results[0]).toMatchObject({ title: "Coordination", isActive: true });
    expect(withBody.results[0].subtypes[0]).toMatchObject({ title: "Clash", isActive: true });
  });

  it("filters, sorts, and paginates issues with the Issues envelope", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(
      `${issuesBase}/issues?filter[status]=open,closed&filter[search]=i&sortBy=-displayId&limit=1&offset=1`,
      { headers: { ...bearer(token), "x-ads-region": "EMEA" } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination).toEqual({ limit: 1, offset: 1, totalResults: 2 });
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      displayId: 1,
      status: "open",
    });
    expect(body.results[0].permittedStatuses).toContain("closed");
    expect(body.results[0].permittedActions).toContain("add_comment");
  });

  it("gets one issue and returns the Issues not-found shape", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${issuesBase}/issues/33333333-3333-4333-8333-333333333333`, {
      headers: bearer(token),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ title: "Door clearance conflict" });

    const missing = await app.request(`${issuesBase}/issues/00000000-0000-4000-8000-000000000000`, {
      headers: bearer(token),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ title: "Not Found", detail: "The requested issue was not found." });
  });

  it("requires user context and data:read", async () => {
    const twoLegged = await issueTwoLeggedToken(app);
    const withoutUser = await app.request(`${issuesBase}/issues`, { headers: bearer(twoLegged) });
    expect(withoutUser.status).toBe(403);
    expect((await withoutUser.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });

    const wrongScope = await issueThreeLeggedToken(app, store, "user-profile:read");
    const withoutScope = await app.request(`${issuesBase}/issues`, { headers: bearer(wrongScope) });
    expect(withoutScope.status).toBe(403);
    expect((await withoutScope.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });
  });

  it("rejects the Data Management project ID form and invalid pagination", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const prefixed = await app.request(`${base}/construction/issues/v1/projects/b.emulate-project/issues`, {
      headers: bearer(token),
    });
    expect(prefixed.status).toBe(400);
    expect(await prefixed.json()).toEqual({
      title: "Bad Request",
      detail: "Issues project IDs must not include the 'b.' prefix.",
    });

    const missing = await app.request(`${base}/construction/issues/v1/projects/missing-project/issues`, {
      headers: bearer(token),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      title: "Not Found",
      detail: "The requested project was not found.",
    });

    const pagination = await app.request(`${issuesBase}/issues?limit=0`, { headers: bearer(token) });
    expect(pagination.status).toBe(400);
    expect((await pagination.json()) as Record<string, unknown>).toMatchObject({ title: "Bad Request" });
  });

  it("loads additional issues from seed config", async () => {
    const setup = createTestApp({
      issues: [
        {
          id: "13131313-1313-4131-8131-131313131313",
          project_id: "b.emulate-project",
          title: "Seeded coordination issue",
          issue_type_id: "11111111-1111-4111-8111-111111111111",
          issue_subtype_id: "22222222-2222-4222-8222-222222222222",
          status: "pending",
        },
      ],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${issuesBase}/issues?filter[status]=pending`, {
      headers: bearer(token),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination.totalResults).toBe(1);
    expect(body.results[0]).toMatchObject({
      id: "13131313-1313-4131-8131-131313131313",
      title: "Seeded coordination issue",
    });
  });
});
