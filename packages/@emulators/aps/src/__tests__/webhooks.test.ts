import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getApsStore } from "../store.js";
import { APS_WEBHOOK_EVENTS } from "../webhook-events.js";
import { createWebhookRecord, setWebhookTiming, webhookEventMatches } from "../webhooks.js";
import { base, bearer, createTestApp, issueThreeLeggedToken, issueTwoLeggedToken } from "./test-helpers.js";

interface ReceivedCallback {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function callbackServer(status: { value: number; sequence?: number[] }) {
  const received: ReceivedCallback[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      response.statusCode = status.sequence?.shift() ?? status.value;
      response.end();
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Callback server did not bind to a port");
  return { url: `http://127.0.0.1:${address.port}/callback`, received };
}

async function createHook(
  app: ReturnType<typeof createTestApp>["app"],
  token: string,
  callbackUrl: string,
  options: {
    system?: string;
    event?: string;
    scope?: Record<string, string>;
    token?: string;
    filter?: string | string[];
    autoReactivateHook?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return app.request(
    `${base}/webhooks/v1/systems/${options.system ?? "data"}/events/${options.event ?? "dm.version.added"}/hooks`,
    {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify({
        callbackUrl,
        scope: options.scope ?? { folder: "urn:folder:root" },
        ...(options.token ? { token: options.token } : {}),
        ...(options.filter ? { filter: options.filter } : {}),
        ...(options.autoReactivateHook !== undefined ? { autoReactivateHook: options.autoReactivateHook } : {}),
      }),
    },
  );
}

describe("APS Webhooks API", () => {
  it("implements event hook CRUD and its status-code quirks", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const empty = await app.request(`${base}/webhooks/v1/systems/data/events/dm.version.added/hooks`, {
      headers: bearer(token),
    });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const created = await createHook(app, token, "http://127.0.0.1:9/callback");
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");
    const location = created.headers.get("location");
    expect(location).toMatch(/^\/webhooks\/v1\/systems\/data\/events\/dm.version.added\/hooks\//);

    const duplicate = await createHook(app, token, "http://127.0.0.1:9/callback");
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as Record<string, unknown>).toEqual({ id: expect.any(String) });

    const detail = await app.request(`${base}${location}`, { headers: bearer(token) });
    expect(detail.status).toBe(200);
    const hook = (await detail.json()) as Record<string, unknown>;
    expect(hook).toMatchObject({
      system: "data",
      event: "dm.version.added",
      creatorType: "Application",
      status: "active",
      scope: { folder: "urn:folder:root" },
    });

    const patched = await app.request(`${base}${location}`, {
      method: "PATCH",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "inactive", hookAttribute: { test: true }, filter: "$[?(@.ext=='rvt')]" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.text()).toBe("");

    const updated = (await (await app.request(`${base}${location}`, { headers: bearer(token) })).json()) as Record<
      string,
      unknown
    >;
    expect(updated).toMatchObject({ status: "inactive", hookAttribute: { test: true }, filter: "$[?(@.ext=='rvt')]" });

    const deleted = await app.request(`${base}${location}`, { method: "DELETE", headers: bearer(token) });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await app.request(`${base}${location}`, { headers: bearer(token) })).status).toBe(404);
  });

  it("partitions visibility by OAuth identity and region precedence", async () => {
    const { app, store } = createTestApp();
    const appToken = await issueTwoLeggedToken(app, "data:read data:write");
    const userToken = await issueThreeLeggedToken(app, store, "data:read data:write");
    const created = await createHook(app, appToken, "http://127.0.0.1:9/callback", {
      headers: { region: "EMEA", "x-ads-region": "US" },
    });
    expect(created.status).toBe(201);

    expect(
      (
        await app.request(`${base}/webhooks/v1/hooks?region=JPN`, {
          headers: { ...bearer(appToken), region: "EMEA", "x-ads-region": "US" },
        })
      ).status,
    ).toBe(200);
    expect((await app.request(`${base}/webhooks/v1/hooks?region=EMEA`, { headers: bearer(userToken) })).status).toBe(
      204,
    );
    expect(
      (await app.request(`${base}/webhooks/v1/app/hooks?region=EMEA`, { headers: bearer(userToken) })).status,
    ).toBe(403);
    expect((await app.request(`${base}/webhooks/v1/app/hooks?region=EMEA`, { headers: bearer(appToken) })).status).toBe(
      200,
    );
  });

  it("creates catalog hooks for a system and accepts unknown systems", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const known = await app.request(`${base}/webhooks/v1/systems/derivative/hooks`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://127.0.0.1:9/derivative", scope: { workflow: "wf-1" } }),
    });
    expect(known.status).toBe(201);
    expect(((await known.json()) as { hooks: unknown[] }).hooks).toHaveLength(2);
    const knownList = await app.request(`${base}/webhooks/v1/systems/derivative/hooks?status=active`, {
      headers: bearer(token),
    });
    expect(knownList.status).toBe(200);
    expect(((await knownList.json()) as { data: unknown[] }).data).toHaveLength(2);

    const unknown = await app.request(`${base}/webhooks/v1/systems/custom.system/hooks`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://127.0.0.1:9/custom", scope: { project: "project-1" } }),
    });
    expect(unknown.status).toBe(201);
    expect(((await unknown.json()) as { hooks: Array<{ event: string }> }).hooks[0]?.event).toBe("*");
    expect(APS_WEBHOOK_EVENTS["autodesk.construction.cost"]).toContain("segmentValue.created-1.0");
    expect(APS_WEBHOOK_EVENTS["autodesk.construction.reviews"]).toEqual(["review.created-1.0", "review.closed-1.0"]);
  });

  it("paginates 200 hooks with an opaque relative next path and enforces the scope quota", async () => {
    const { app, store } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const aps = getApsStore(store);
    const identity = { key: "app:aps-test-client", createdBy: "aps-test-client", creatorType: "Application" as const };
    for (let index = 0; index < 201; index += 1) {
      createWebhookRecord(aps, {
        system: "data",
        event: `event.${index}`,
        callbackUrl: `http://127.0.0.1:9/${index}`,
        scope: { folder: `urn:folder:${index}` },
        region: "US",
        identity,
      });
    }
    const first = await app.request(`${base}/webhooks/v1/hooks`, { headers: bearer(token) });
    const firstBody = (await first.json()) as { data: unknown[]; links: { next: string } };
    expect(firstBody.data).toHaveLength(200);
    expect(firstBody.links.next).toMatch(/^\/hooks\?pageState=/);
    const second = await app.request(`${base}/webhooks/v1${firstBody.links.next}`, { headers: bearer(token) });
    expect(((await second.json()) as { data: unknown[] }).data).toHaveLength(1);

    for (let index = 0; index < 1000; index += 1) {
      createWebhookRecord(aps, {
        system: "quota",
        event: `event.${index}`,
        callbackUrl: `http://127.0.0.1:9/quota/${index}`,
        scope: { folder: "urn:folder:quota" },
        region: "EMEA",
        identity,
      });
    }
    const quota = await createHook(app, token, "http://127.0.0.1:9/quota/new", {
      system: "quota",
      event: "event.new",
      scope: { folder: "urn:folder:quota" },
      headers: { region: "EMEA" },
    });
    expect(quota.status).toBe(400);
  });

  it("creates, updates, and deletes identity-level signing tokens", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const create = await app.request(`${base}/webhooks/v1/tokens`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: "first-secret" }),
    });
    expect(create.status).toBe(200);
    expect((await create.json()) as Record<string, unknown>).toMatchObject({
      status: 200,
      detail: [expect.any(String)],
    });
    expect(
      (
        await app.request(`${base}/webhooks/v1/tokens`, {
          method: "POST",
          headers: { ...bearer(token), "Content-Type": "application/json" },
          body: JSON.stringify({ token: "duplicate" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`${base}/webhooks/v1/tokens/@me`, {
          method: "PUT",
          headers: { ...bearer(token), "Content-Type": "application/json" },
          body: JSON.stringify({ token: "second-secret" }),
        })
      ).status,
    ).toBe(204);
    expect(
      (await app.request(`${base}/webhooks/v1/tokens/@me`, { method: "DELETE", headers: bearer(token) })).status,
    ).toBe(204);
    expect(
      (await app.request(`${base}/webhooks/v1/tokens/@me`, { method: "DELETE", headers: bearer(token) })).status,
    ).toBe(404);
  });

  it("rejects invalid auth and payload fields and deletes expired hooks", async () => {
    const { app } = createTestApp();
    const readToken = await issueTwoLeggedToken(app, "data:read");
    expect((await createHook(app, readToken, "http://127.0.0.1:9/callback")).status).toBe(403);
    const unauthenticated = await app.request(`${base}/webhooks/v1/hooks`);
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json()) as Record<string, unknown>).toEqual({ id: expect.any(String) });

    const token = await issueTwoLeggedToken(app, "data:read data:write");
    expect(
      (
        await createHook(app, token, "http://127.0.0.1:9/filter", {
          filter: "$..unsupported",
        })
      ).status,
    ).toBe(400);
    const oversized = await app.request(`${base}/webhooks/v1/systems/data/events/dm.version.added/hooks`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        callbackUrl: "http://127.0.0.1:9/attribute",
        scope: { folder: "urn:folder:root" },
        hookAttribute: { value: "x".repeat(1024) },
      }),
    });
    expect(oversized.status).toBe(400);

    const expired = await app.request(`${base}/webhooks/v1/systems/data/events/dm.version.added/hooks`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        callbackUrl: "http://127.0.0.1:9/expired",
        scope: { folder: "urn:folder:root" },
        hookExpiry: "2000-01-01T00:00:00.000Z",
      }),
    });
    expect(expired.status).toBe(201);
    expect(
      (
        await app.request(`${base}/webhooks/v1/systems/data/events/dm.version.added/hooks`, {
          headers: bearer(token),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(`${base}/webhooks/v1/hooks`, {
          headers: { ...bearer(token), region: "unknown" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("APS webhook delivery", () => {
  it("signs the exact raw callback body and honors a per-hook token override", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callback = await callbackServer({ value: 204 });
    await app.request(`${base}/webhooks/v1/tokens`, {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ token: "identity-secret" }),
    });
    expect((await createHook(app, token, callback.url, { token: "hook-secret" })).status).toBe(201);

    const simulated = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "data",
        event: "dm.version.added",
        scopeValue: "urn:folder:root",
        resourceUrn: "urn:version:1",
        payload: { ext: "rvt" },
      }),
    });
    expect(simulated.status).toBe(200);
    expect((await simulated.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ delivered: true, statusCode: 204, attempts: 1, signaturePresent: true }],
    });
    expect(callback.received).toHaveLength(1);
    const received = callback.received[0]!;
    const expected = `sha1hash=${createHmac("sha1", "hook-secret").update(received.body).digest("hex")}`;
    expect(received.headers["x-adsk-signature"]).toBe(expected);
    expect(received.headers["x-adsk-delivery-id"]).toEqual(expect.any(String));
    expect(JSON.parse(received.body)).toMatchObject({
      version: "1.0",
      resourceUrn: "urn:version:1",
      hook: { event: "dm.version.added" },
      payload: { ext: "rvt" },
    });
  });

  it("matches wildcard events, recursive folders, and the documented filter subset", async () => {
    expect([
      webhookEventMatches("*", "dm.version.added"),
      webhookEventMatches("*.added", "dm.version.added"),
      webhookEventMatches("dm.*.modified", "dm.version.modified"),
      webhookEventMatches("dm.*.modified", "dm.version.added"),
    ]).toEqual([true, true, true, false]);

    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callback = await callbackServer({ value: 200 });
    expect(
      (
        await createHook(app, token, callback.url, {
          scope: { folder: "urn:adsk.wipprod:fs.folder:co.emulate-documents" },
          filter: ["$[?(@.ext in ['rvt','dwg'])]", "$[?(@.sizeInBytes>=0 && @.project=='emulate-project')]"],
        })
      ).status,
    ).toBe(201);
    const delivered = await app.request(`${base}/_aps/simulate/dm-version-added`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await delivered.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ matched: true, delivered: true }],
    });
    expect(JSON.parse(callback.received[0]!.body).payload).toMatchObject({
      source: "urn:adsk.wipprod:fs.file:vf.emulate-sample-model?version=1",
      version: "1",
      project: "emulate-project",
      parentFolderUrn: "urn:adsk.wipprod:fs.folder:co.emulate-plans",
      ancestors: [
        { urn: "urn:adsk.wipprod:fs.folder:co.emulate-documents" },
        { urn: "urn:adsk.wipprod:fs.folder:co.emulate-plans" },
      ],
    });

    const dropped = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "data",
        event: "dm.version.added",
        scopeValue: "urn:adsk.wipprod:fs.folder:co.emulate-plans",
        folderAncestors: ["urn:adsk.wipprod:fs.folder:co.emulate-documents"],
        payload: { ext: "txt", sizeInBytes: 0, project: "emulate-project" },
      }),
    });
    expect((await dropped.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ matched: false, delivered: false, reason: "filter" }],
    });
  });

  it("matches tenant values from explicit scopes and checks status before filters", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callback = await callbackServer({ value: 204 });
    const created = await createHook(app, token, callback.url, {
      system: "derivative",
      event: "extraction.finished",
      scope: { workflow: "workflow-from-scope" },
      filter: "$[?(@.status=='success')]",
    });
    const location = created.headers.get("location")!;

    const delivered = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "derivative",
        event: "extraction.finished",
        scope: { workflow: "workflow-from-scope" },
        payload: { status: "success" },
      }),
    });
    expect((await delivered.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ matched: true, delivered: true }],
    });

    expect(
      (
        await app.request(`${base}${location}`, {
          method: "PATCH",
          headers: { ...bearer(token), "Content-Type": "application/json" },
          body: JSON.stringify({ status: "inactive" }),
        })
      ).status,
    ).toBe(200);
    const skipped = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "derivative",
        event: "extraction.finished",
        scope: { workflow: "workflow-from-scope" },
        payload: { status: "failed" },
      }),
    });
    expect((await skipped.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ matched: false, delivered: false, reason: "inactive" }],
    });
    expect(callback.received).toHaveLength(1);
  });

  it("omits signatures without a token and retries one event until it succeeds", async () => {
    const { app, store } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callback = await callbackServer({ value: 204, sequence: [503, 503, 204] });
    setWebhookTiming(store, {
      max_retries: 2,
      retry_base_ms: 0,
      retry_max_ms: 0,
      delivery_timeout_ms: 1000,
    });
    expect((await createHook(app, token, callback.url)).status).toBe(201);
    const response = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "data",
        event: "dm.version.added",
        scopeValue: "urn:folder:root",
        payload: {},
      }),
    });
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ delivered: true, attempts: 3, signaturePresent: false }],
    });
    expect(callback.received).toHaveLength(3);
    expect(callback.received[0]!.headers["x-adsk-signature"]).toBeUndefined();
  });

  it("retries failed events, deactivates after five, and auto-reactivates to recovery", async () => {
    const { app, store } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callbackStatus = { value: 503 };
    const callback = await callbackServer(callbackStatus);
    setWebhookTiming(store, {
      max_retries: 0,
      retry_base_ms: 0,
      retry_max_ms: 0,
      failed_events_before_inactive: 5,
      reactivate_after_ms: 0,
      max_reactivation_cycles: 5,
      delivery_timeout_ms: 1000,
    });
    expect((await createHook(app, token, callback.url, { autoReactivateHook: true })).status).toBe(201);

    for (let index = 0; index < 5; index += 1) {
      const response = await app.request(`${base}/_aps/simulate/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: "data",
          event: "dm.version.added",
          scopeValue: "urn:folder:root",
          payload: { event: index },
        }),
      });
      expect(response.status).toBe(200);
    }
    const stored = getApsStore(store).webhookHooks.all()[0]!;
    expect(stored.status).toBe("inactive");
    expect(stored.failed_event_count).toBe(5);

    callbackStatus.value = 204;
    const recovery = await app.request(`${base}/_aps/simulate/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: "data",
        event: "dm.version.added",
        scopeValue: "urn:folder:root",
        payload: { recovered: true },
      }),
    });
    expect((await recovery.json()) as Record<string, unknown>).toMatchObject({
      deliveries: [{ delivered: true, attempts: 1 }],
    });
    const recovered = getApsStore(store).webhookHooks.all()[0]!;
    expect(recovered.status).toBe("active");
    expect(recovered.failed_event_count).toBe(0);
    expect(recovered.reactivation_count).toBe(1);
  });

  it("builds derivative and Issues payloads from seeded state", async () => {
    const { app } = createTestApp();
    const token = await issueTwoLeggedToken(app, "data:read data:write");
    const callback = await callbackServer({ value: 200 });
    expect(
      (
        await createHook(app, token, callback.url, {
          system: "derivative",
          event: "extraction.finished",
          scope: { workflow: "emulate-translation" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await createHook(app, token, callback.url, {
          system: "autodesk.construction.issues",
          event: "issue.created-1.0",
          scope: { project: "emulate-project" },
        })
      ).status,
    ).toBe(201);

    await app.request(`${base}/_aps/simulate/extraction-finished`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await app.request(`${base}/_aps/simulate/issue-created`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(callback.received).toHaveLength(2);
    expect(JSON.parse(callback.received[0]!.body).payload).toMatchObject({
      TimeStamp: expect.any(Number),
      URN: expect.any(String),
      EventType: "EXTRACTION_FINISHED",
      Payload: { status: "success", scope: "emulate-translation", registerKey: [] },
    });
    expect(JSON.parse(callback.received[1]!.body).payload).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      projectId: "emulate-project",
    });
    expect(JSON.parse(callback.received[1]!.body).resourceUrn).toBe(
      "urn:adsk.issues:issues.issue:33333333-3333-4333-8333-333333333333",
    );
  });
});
