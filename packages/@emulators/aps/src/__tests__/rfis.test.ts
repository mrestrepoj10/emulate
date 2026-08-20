import type { Hono } from "@emulators/core";
import type { Store } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import { bearer, base, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

const rfisBase = `${base}/construction/rfis/v3/projects/emulate-project`;

describe("APS ACC RFI routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const setup = createTestApp();
    app = setup.app;
    store = setup.store;
  });

  it("returns the RFI user and workflow permission documents", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);

    const profileResponse = await app.request(`${rfisBase}/users/me`, { headers });
    expect(profileResponse.status).toBe(200);
    const profile = (await profileResponse.json()) as Record<string, any>;
    expect(profile.user).toMatchObject({ name: "Test User", role: "project_admin" });
    expect(profile.workflow).toMatchObject({ type: "US" });
    expect(profile.workflow.roles).toContain("projectGC");
    expect(profile.permittedActions.createRfi.permittedStatuses.wfUS).toHaveLength(2);

    const workflowResponse = await app.request(`${rfisBase}/workflow`, { headers });
    const workflow = (await workflowResponse.json()) as Record<string, any>;
    expect(workflow.workflowType).toBe("US");
    expect(workflow.projectRolesMapping.map((mapping: Record<string, unknown>) => mapping.name)).toContain("projectSC");
  });

  it("lists RFI types and custom attributes with offset pagination", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);

    const typesResponse = await app.request(`${rfisBase}/rfi-types?filter[status]=active&limit=1`, { headers });
    const types = (await typesResponse.json()) as Record<string, any>;
    expect(types.pagination).toEqual({ limit: 1, offset: 0, totalResults: 1 });
    expect(types.results[0]).toMatchObject({ name: "Design clarification", status: "active", isDefault: true });

    const attributesResponse = await app.request(`${rfisBase}/attributes?limit=1`, { headers });
    const attributes = (await attributesResponse.json()) as Record<string, any>;
    expect(attributes.pagination.totalResults).toBe(1);
    expect(attributes.results[0]).toMatchObject({ name: "Specification section", type: "text" });
  });

  it("uses POST search:rfis as the paginated list endpoint", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${rfisBase}/search:rfis`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json", "x-ads-region": "US" },
      body: JSON.stringify({
        limit: 1,
        offset: 0,
        search: "structural",
        filter: { status: ["open"], priority: "High" },
        sort: [{ field: "createdAt", order: "DESC" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination).toEqual({ limit: 1, offset: 0, totalResults: 1 });
    expect(body.results[0]).toMatchObject({
      id: "77777777-7777-4777-8777-777777777777",
      customIdentifier: "RFI-001",
      status: "open",
      priority: "High",
    });
    expect(body.results[0]).not.toHaveProperty("responses");
    expect(body.results[0].permittedActions.createComment).toBe(true);
  });

  it("gets RFI details with computed permitted actions", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${rfisBase}/rfis/77777777-7777-4777-8777-777777777777`, {
      headers: bearer(token),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.responses).toEqual([]);
    expect(body.draftResponses).toEqual([]);
    expect(body.maxAssignees).toBe(10);
    expect(body.permittedActions.updateRfi.permittedStatuses.wfUS).toHaveLength(5);

    const missing = await app.request(`${rfisBase}/rfis/00000000-0000-4000-8000-000000000000`, {
      headers: bearer(token),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "The requested RFI was not found." },
    });
  });

  it("returns the current and next RFI custom identifiers", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const response = await app.request(`${rfisBase}/rfis/custom-identifier`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ current: "RFI-002", next: "RFI-003" });
  });

  it("orders custom identifiers numerically, not lexicographically", async () => {
    const rfiSeed = {
      project_id: "b.emulate-project",
      rfi_type_id: "55555555-5555-4555-8555-555555555555",
      title: "Numeric ordering",
    };
    const setup = createTestApp({
      rfis: [
        { ...rfiSeed, id: "19191919-1919-4191-8191-191919191919", custom_identifier: "RFI-9" },
        { ...rfiSeed, id: "20202020-2020-4202-8202-202020202020", custom_identifier: "RFI-10" },
      ],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${rfisBase}/rfis/custom-identifier`, { headers: bearer(token) });
    expect(await response.json()).toEqual({ current: "RFI-10", next: "RFI-11" });
  });

  it("rejects malformed searches and the Data Management project ID form", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const malformed = await app.request(`${rfisBase}/search:rfis`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: "BAD_INPUT", message: "The request body must contain valid JSON." },
    });

    const prefixed = await app.request(`${base}/construction/rfis/v3/projects/b.emulate-project/rfi-types`, {
      headers: bearer(token),
    });
    expect(prefixed.status).toBe(400);
    expect((await prefixed.json()) as Record<string, any>).toMatchObject({ error: { code: "BAD_INPUT" } });

    const missing = await app.request(`${base}/construction/rfis/v3/projects/missing-project/rfi-types`, {
      headers: bearer(token),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "The requested project was not found." },
    });
  });

  it("requires a user-context data:read token", async () => {
    const twoLegged = await issueTwoLeggedToken(app);
    const withoutUser = await app.request(`${rfisBase}/rfi-types`, { headers: bearer(twoLegged) });
    expect(withoutUser.status).toBe(403);
    expect((await withoutUser.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });

    const wrongScope = await issueThreeLeggedToken(app, store, "user-profile:read");
    const withoutScope = await app.request(`${rfisBase}/rfi-types`, { headers: bearer(wrongScope) });
    expect(withoutScope.status).toBe(403);
    expect((await withoutScope.json()) as Record<string, unknown>).toMatchObject({ errorCode: "AUTH-010" });
  });

  it("loads additional RFIs from seed config", async () => {
    const setup = createTestApp({
      rfis: [
        {
          id: "14141414-1414-4141-8141-141414141414",
          project_id: "b.emulate-project",
          rfi_type_id: "55555555-5555-4555-8555-555555555555",
          custom_identifier: "RFI-003",
          title: "Seeded RFI",
          status: "answered",
          priority: "Low",
        },
      ],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const response = await setup.app.request(`${rfisBase}/search:rfis`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { status: "answered" } }),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.pagination.totalResults).toBe(1);
    expect(body.results[0]).toMatchObject({ customIdentifier: "RFI-003", title: "Seeded RFI" });
  });
});
