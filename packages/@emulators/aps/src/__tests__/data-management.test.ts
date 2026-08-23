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

  it("walks the seeded folder tree and returns mixed folder and item contents with tip versions", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const topResponse = await app.request(
      `${base}/project/v1/hubs/b.emulate-hub/projects/b.emulate-project/topFolders`,
      { headers },
    );
    expect(topResponse.status).toBe(200);
    const top = (await topResponse.json()) as Record<string, any>;
    expect(top.data).toHaveLength(1);
    expect(top.data[0]).toMatchObject({
      type: "folders",
      attributes: {
        displayName: "Project Files",
        extension: { type: "folders:autodesk.bim360:Folder", version: "1.0" },
      },
    });

    const rootContentsResponse = await app.request(top.data[0].relationships.contents.links.related.href, { headers });
    const rootContents = (await rootContentsResponse.json()) as Record<string, any>;
    const plans = rootContents.data.find((entry: Record<string, any>) => entry.attributes.displayName === "Plans");
    expect(plans).toBeDefined();

    const plansResponse = await app.request(plans.relationships.contents.links.related.href, { headers });
    expect(plansResponse.status).toBe(200);
    const plansContents = (await plansResponse.json()) as Record<string, any>;
    expect(plansContents.data.map((entry: Record<string, unknown>) => entry.type)).toEqual(["folders", "items"]);
    expect(plansContents.data[1]).toMatchObject({
      attributes: {
        displayName: "coordination-report.pdf",
        extension: { type: "items:autodesk.bim360:File" },
      },
      relationships: { tip: { data: { type: "versions" } } },
    });
    expect(plansContents.included).toHaveLength(1);
    expect(plansContents.included[0]).toMatchObject({
      type: "versions",
      attributes: { versionNumber: 3, fileType: "pdf", mimeType: "application/pdf" },
    });
  });

  it("filters and paginates folder contents using APS JSON:API query parameters", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const plansId = encodeURIComponent("urn:adsk.wipprod:fs.folder:co.emulate-plans");
    const path = `${base}/data/v1/projects/b.emulate-project/folders/${plansId}/contents`;

    const itemsResponse = await app.request(
      `${path}?filter%5Btype%5D=items&filter%5Bextension.type%5D=items%3Aautodesk.bim360%3AFile`,
      { headers },
    );
    const items = (await itemsResponse.json()) as Record<string, any>;
    expect(items.data).toHaveLength(1);
    expect(items.data[0].type).toBe("items");

    const firstResponse = await app.request(`${path}?page%5Bnumber%5D=0&page%5Blimit%5D=1`, { headers });
    const first = (await firstResponse.json()) as Record<string, any>;
    expect(first.data).toHaveLength(1);
    expect(first.links.next.href).toContain("page%5Bnumber%5D=1");
    const secondResponse = await app.request(first.links.next.href, { headers });
    const second = (await secondResponse.json()) as Record<string, any>;
    expect(second.data).toHaveLength(1);
    expect(second.links.prev.href).toContain("page%5Bnumber%5D=0");

    const invalid = await app.request(`${path}?page%5Blimit%5D=201`, { headers });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ errors: [{ status: "400", code: "BAD_INPUT" }] });
  });

  it("gets an item, its descending version history, its tip, and an encoded version URN", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const itemId = "urn:adsk.wipprod:dm.lineage:emulate-coordination-report";
    const itemPath = `${base}/data/v1/projects/b.emulate-project/items/${encodeURIComponent(itemId)}`;

    const itemResponse = await app.request(itemPath, { headers });
    const item = (await itemResponse.json()) as Record<string, any>;
    expect(item.data.id).toBe(itemId);
    expect(item.included[0].attributes.versionNumber).toBe(3);

    const versionsResponse = await app.request(item.data.relationships.versions.links.related.href, { headers });
    const versions = (await versionsResponse.json()) as Record<string, any>;
    expect(versions.data.map((entry: Record<string, any>) => entry.attributes.versionNumber)).toEqual([3, 2, 1]);

    const tipResponse = await app.request(item.data.relationships.tip.links.related.href, { headers });
    expect(((await tipResponse.json()) as Record<string, any>).data.attributes.versionNumber).toBe(3);

    const versionId = "urn:adsk.wipprod:fs.file:vf.emulate-coordination-report?version=2";
    const versionResponse = await app.request(
      `${base}/data/v1/projects/b.emulate-project/versions/${encodeURIComponent(versionId)}`,
      { headers },
    );
    expect(versionResponse.status).toBe(200);
    expect(((await versionResponse.json()) as Record<string, any>).data.id).toBe(versionId);
  });

  it("follows a translated item tip through to its Model Derivative manifest", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const itemId = encodeURIComponent("urn:adsk.wipprod:dm.lineage:emulate-sample-model");
    const itemResponse = await app.request(`${base}/data/v1/projects/b.emulate-project/items/${itemId}`, { headers });
    const item = (await itemResponse.json()) as Record<string, any>;
    const tipResponse = await app.request(item.data.relationships.tip.links.related.href, { headers });
    const tip = (await tipResponse.json()) as Record<string, any>;
    expect(tip.data.relationships.derivatives.data.type).toBe("derivatives");

    const manifestResponse = await app.request(tip.data.relationships.derivatives.meta.link.href, { headers });
    expect(manifestResponse.status).toBe(200);
    expect(await manifestResponse.json()).toMatchObject({ type: "manifest", status: "success" });
  });

  it("requires 3-legged data:read access on Data API routes", async () => {
    const token = await issueTwoLeggedToken(app, "data:read");
    const response = await app.request(
      `${base}/data/v1/projects/b.emulate-project/folders/${encodeURIComponent("urn:adsk.wipprod:fs.folder:co.emulate-documents")}`,
      { headers: bearer(token) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ errorCode: "AUTH-010" });
  });

  it("returns JSON:API 404s for unknown folders, items, and versions", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    for (const path of ["folders/urn%3Amissing", "items/urn%3Amissing", "versions/urn%3Amissing"]) {
      const response = await app.request(`${base}/data/v1/projects/b.emulate-project/${path}`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ errors: [{ status: "404", code: "NOT_FOUND" }] });
    }
  });

  it("keeps every advertised emulator href resolvable", async () => {
    const token = await issueThreeLeggedToken(app, store);
    const headers = bearer(token);
    const pending = [`${base}/project/v1/hubs`];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const href = pending.shift()!;
      if (visited.has(href)) continue;
      visited.add(href);
      const response = await app.request(href, { headers });
      expect(response.status, href).toBe(200);
      const body = (await response.json()) as unknown;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (key === "href" && typeof entry === "string" && entry.startsWith(base)) pending.push(entry);
          else visit(entry);
        }
      };
      visit(body);
    }

    expect(visited.size).toBeGreaterThan(20);
  });

  it("validates custom tree parents, item folders, and cycles", () => {
    expect(() =>
      createTestApp({
        document_folders: [
          {
            id: "urn:folder:orphan",
            project_id: "b.emulate-project",
            parent_folder_id: "urn:folder:missing",
            name: "Orphan",
          },
        ],
      }),
    ).toThrow("references unknown parent 'urn:folder:missing'");

    expect(() =>
      createTestApp({
        document_items: [
          {
            id: "urn:item:orphan",
            project_id: "b.emulate-project",
            folder_id: "urn:folder:missing",
            display_name: "orphan.rvt",
          },
        ],
      }),
    ).toThrow("references unknown folder 'urn:folder:missing'");

    expect(() =>
      createTestApp({
        document_folders: [
          { id: "urn:folder:a", project_id: "b.emulate-project", parent_folder_id: "urn:folder:b", name: "A" },
          { id: "urn:folder:b", project_id: "b.emulate-project", parent_folder_id: "urn:folder:a", name: "B" },
        ],
      }),
    ).toThrow("contains a cycle");
  });

  it("serves custom structural trees and materializes legacy version ancestry", async () => {
    const setup = createTestApp({
      document_folders: [
        {
          id: "urn:folder:custom",
          project_id: "b.emulate-project",
          parent_folder_id: "urn:adsk.wipprod:fs.folder:co.emulate-documents",
          name: "Custom",
        },
      ],
      document_items: [
        {
          id: "urn:item:custom",
          project_id: "b.emulate-project",
          folder_id: "urn:folder:custom",
          display_name: "custom.dwg",
        },
      ],
      document_versions: [
        {
          version_id: "urn:version:custom?version=1",
          item_id: "urn:item:custom",
          project_id: "b.emulate-project",
          bubble_urn: null,
        },
      ],
      webhook_dm_versions: [
        {
          version_id: "urn:version:legacy?version=1",
          item_id: "urn:item:legacy",
          project_id: "b.emulate-project",
          folder_id: "urn:folder:legacy-child",
          ancestor_folder_ids: ["urn:folder:legacy-root"],
          display_name: "legacy.rvt",
          bubble_urn: null,
        },
      ],
    });
    const token = await issueThreeLeggedToken(setup.app, setup.store);
    const headers = bearer(token);

    const customResponse = await setup.app.request(
      `${base}/data/v1/projects/b.emulate-project/folders/${encodeURIComponent("urn:folder:custom")}/contents`,
      { headers },
    );
    expect(await customResponse.json()).toMatchObject({
      data: [{ id: "urn:item:custom" }],
      included: [{ id: "urn:version:custom?version=1" }],
    });

    const legacyResponse = await setup.app.request(
      `${base}/data/v1/projects/b.emulate-project/folders/${encodeURIComponent("urn:folder:legacy-root")}/contents`,
      { headers },
    );
    expect(await legacyResponse.json()).toMatchObject({ data: [{ id: "urn:folder:legacy-child" }] });
  });
});
