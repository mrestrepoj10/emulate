import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { apsPlugin, getApsStore, seedFromConfig, type ApsSeedConfig } from "../index.js";

export const base = "http://localhost:4000";

export function createTestApp(config?: ApsSeedConfig) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware(tokenMap));
  apsPlugin.register(app, store, webhooks, base, tokenMap);
  apsPlugin.seed?.(store, base);
  if (config) seedFromConfig(store, base, config);
  return { app, store, tokenMap };
}

export async function getAuthCode(
  app: Hono,
  store: Store,
  options: {
    userId?: string;
    redirectUri?: string;
    clientId?: string;
    scope?: string;
    state?: string;
    nonce?: string;
    responseMode?: string;
    codeChallenge?: string;
  } = {},
): Promise<{ code: string; state: string; response: Response }> {
  const userId = options.userId ?? getApsStore(store).users.all()[0]?.user_id ?? "";
  const redirectUri = options.redirectUri ?? "http://localhost:3000/callback";
  const clientId = options.clientId ?? "aps-test-client";
  const scope = options.scope ?? "data:read openid";
  const state = options.state ?? "state-1";
  const nonce = options.nonce ?? "nonce-1";
  const responseMode = options.responseMode ?? "query";

  const response = await app.request(`${base}/authentication/v2/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_id: userId,
      redirect_uri: redirectUri,
      scope,
      state,
      nonce,
      client_id: clientId,
      response_mode: responseMode,
      code_challenge: options.codeChallenge ?? "",
    }).toString(),
  });

  if (responseMode === "form_post") {
    const html = await response.text();
    return {
      code: html.match(/name="code" value="([^"]+)"/)?.[1] ?? "",
      state: html.match(/name="state" value="([^"]+)"/)?.[1] ?? "",
      response,
    };
  }

  const location = response.headers.get("location") ?? "";
  const locationUrl = new URL(location);
  return {
    code: locationUrl.searchParams.get("code") ?? "",
    state: locationUrl.searchParams.get("state") ?? "",
    response,
  };
}

export async function exchangeCode(
  app: Hono,
  code: string,
  options: {
    clientId?: string;
    clientSecret?: string;
    includeClientSecret?: boolean;
    redirectUri?: string;
    codeVerifier?: string;
    useBasicAuth?: boolean;
  } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: options.clientId ?? "aps-test-client",
    redirect_uri: options.redirectUri ?? "http://localhost:3000/callback",
  });
  if (options.includeClientSecret ?? true) {
    body.set("client_secret", options.clientSecret ?? "aps-test-secret");
  }
  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (options.useBasicAuth) {
    const credentials = Buffer.from(
      `${options.clientId ?? "aps-test-client"}:${options.clientSecret ?? "aps-test-secret"}`,
    ).toString("base64");
    headers.Authorization = `Basic ${credentials}`;
    body.delete("client_id");
    body.delete("client_secret");
  }

  return app.request(`${base}/authentication/v2/token`, {
    method: "POST",
    headers,
    body: body.toString(),
  });
}

export async function issueTwoLeggedToken(app: Hono, scope = "data:read"): Promise<string> {
  const response = await app.request(`${base}/authentication/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "aps-test-client",
      client_secret: "aps-test-secret",
      scope,
    }).toString(),
  });
  if (!response.ok) throw new Error(`Could not issue 2-legged test token: ${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

export async function issueThreeLeggedToken(app: Hono, store: Store, scope = "data:read"): Promise<string> {
  const { code } = await getAuthCode(app, store, { scope, state: "data-routes-test" });
  if (!code) throw new Error("Could not issue APS authorization code for test");
  const response = await exchangeCode(app, code);
  if (!response.ok) throw new Error(`Could not issue 3-legged test token: ${response.status}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
