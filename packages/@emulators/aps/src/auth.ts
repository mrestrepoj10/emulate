import { generateKeyPair, jwtVerify } from "jose";
import type { Context } from "@emulators/core";
import type { AppEnv, MiddlewareHandler, Store } from "@emulators/core";

export const APS_TOKEN_KID = "emulate-aps-1";
export const APS_TOKEN_ISSUER = "https://developer.api.autodesk.com";
export const APS_TOKEN_AUDIENCE = "https://autodesk.com";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export interface StoredAccessToken {
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  apsUserId: string | null;
  familyId: string | null;
}

export function getApsKeyPair(store: Store): Promise<KeyPair> {
  let pair = store.getData<Promise<KeyPair>>("aps.oauth.keyPair");
  if (!pair) {
    pair = generateKeyPair("RS256");
    store.setData("aps.oauth.keyPair", pair);
  }
  return pair;
}

export function getAccessTokens(store: Store): Map<string, StoredAccessToken> {
  let map = store.getData<Map<string, StoredAccessToken>>("aps.oauth.accessTokens");
  if (!map) {
    map = new Map();
    store.setData("aps.oauth.accessTokens", map);
  }
  return map;
}

function invalidToken(c: Context<AppEnv>): Response {
  return c.json(
    {
      developerMessage: "Access token provided is invalid or expired.",
      moreInfo: "https://forge.autodesk.com/en/docs/oauth/v2/developers_guide/error_handling/",
      errorCode: "AUTH-006",
    },
    401,
  );
}

function insufficientPrivilege(c: Context<AppEnv>): Response {
  return c.json(
    {
      developerMessage: "Token does not have the privilege for this request.",
      moreInfo: "https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/error_handling/",
      errorCode: "AUTH-010",
    },
    403,
  );
}

function bearerToken(c: Context<AppEnv>): string | null {
  const match = (c.req.header("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export async function findActiveAccessToken(store: Store, token: string): Promise<StoredAccessToken | null> {
  const record = getAccessTokens(store).get(token);
  if (!record || record.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  try {
    const { publicKey } = await getApsKeyPair(store);
    await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: APS_TOKEN_ISSUER,
      audience: APS_TOKEN_AUDIENCE,
    });
    return record;
  } catch {
    return null;
  }
}

export async function accessTokenForRequest(c: Context<AppEnv>, store: Store): Promise<StoredAccessToken | null> {
  const token = bearerToken(c);
  return token ? findActiveAccessToken(store, token) : null;
}

/**
 * The token record for a request already authenticated by `apsAuth`. Reads the
 * token the middleware stashed on the context, so handlers never re-verify.
 */
export function storedAccessToken(c: Context<AppEnv>, store: Store): StoredAccessToken | null {
  const token = c.get("authToken");
  return token ? (getAccessTokens(store).get(token) ?? null) : null;
}

export function apsAuth(store: Store, options: { scopes: string[]; requireUser?: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c);
    const record = token ? await findActiveAccessToken(store, token) : null;
    if (!token || !record) return invalidToken(c);

    const grantedScopes = record.scope.split(/\s+/).filter(Boolean);
    if (options.scopes.some((scope) => !grantedScopes.includes(scope))) {
      return insufficientPrivilege(c);
    }
    if (options.requireUser && !record.apsUserId) {
      return insufficientPrivilege(c);
    }

    c.set("authToken", token);
    c.set("authScopes", grantedScopes);
    await next();
  };
}
