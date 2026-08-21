---
name: aps
description: Emulated Autodesk Platform Services (APS) OAuth 2.0, Data Management, Model Derivative, Autodesk Construction Cloud workflow reads including Model Coordination, and active Webhooks for local development and testing. Use when the user needs Autodesk sign-in, APS token exchange, local hubs and projects, seeded manifests, Issues, RFIs, Sheets, model sets, clash tests, expiring clash resources, webhook subscriptions, signed callback delivery, retry lifecycle testing, or Autodesk userinfo without hitting real Autodesk APIs. Triggers include "APS OAuth", "Autodesk Platform Services", "Autodesk Forge", "APS hubs", "APS projects", "Model Derivative manifest", "ACC Issues", "ACC RFIs", "ACC Sheets", "Model Coordination", "clash test", "APS webhooks", "dm.version.added", "extraction.finished", "APS 3-legged flow", "APS 2-legged token", "APS refresh token", or "Autodesk userinfo".
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Autodesk Platform Services (APS) Emulator

APS authentication v2 emulation plus Data Management, Model Derivative, ACC Issues, RFIs, Sheets, and Model Coordination reads, with active Webhooks delivery and local event simulators. Protected routes validate the emulator's own RS256 token signature, expiry, revocation state, and required scopes. Generic static emulator tokens are not accepted by these routes.

## Start

```bash
# APS only
npx emulate --service aps

# Default port when all services run
# http://localhost:4014
```

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const aps = await createEmulator({ service: "aps", port: 4014 });
// aps.url === 'http://localhost:4014'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
APS_EMULATOR_URL=http://localhost:4014
```

### URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                                                     | Emulator URL                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/authorize`                 | `$APS_EMULATOR_URL/authentication/v2/authorize`                 |
| `https://developer.api.autodesk.com/authentication/v2/token`                     | `$APS_EMULATOR_URL/authentication/v2/token`                     |
| `https://developer.api.autodesk.com/authentication/v2/revoke`                    | `$APS_EMULATOR_URL/authentication/v2/revoke`                    |
| `https://developer.api.autodesk.com/authentication/v2/introspect`                | `$APS_EMULATOR_URL/authentication/v2/introspect`                |
| `https://developer.api.autodesk.com/authentication/v2/keys`                      | `$APS_EMULATOR_URL/authentication/v2/keys`                      |
| `https://developer.api.autodesk.com/authentication/v2/logout`                    | `$APS_EMULATOR_URL/authentication/v2/logout`                    |
| `https://developer.api.autodesk.com/project/v1/hubs`                             | `$APS_EMULATOR_URL/project/v1/hubs`                             |
| `https://developer.api.autodesk.com/project/v1/hubs/:hubId/projects`             | `$APS_EMULATOR_URL/project/v1/hubs/:hubId/projects`             |
| `https://developer.api.autodesk.com/modelderivative/v2/designdata/formats`       | `$APS_EMULATOR_URL/modelderivative/v2/designdata/formats`       |
| `https://developer.api.autodesk.com/modelderivative/v2/designdata/:urn/manifest` | `$APS_EMULATOR_URL/modelderivative/v2/designdata/:urn/manifest` |
| `https://developer.api.autodesk.com/construction/issues/v1/...`                  | `$APS_EMULATOR_URL/construction/issues/v1/...`                  |
| `https://developer.api.autodesk.com/construction/rfis/v3/...`                    | `$APS_EMULATOR_URL/construction/rfis/v3/...`                    |
| `https://developer.api.autodesk.com/construction/sheets/v1/...`                  | `$APS_EMULATOR_URL/construction/sheets/v1/...`                  |
| `https://developer.api.autodesk.com/bim360/modelset/v3/...`                     | `$APS_EMULATOR_URL/bim360/modelset/v3/...`                     |
| `https://developer.api.autodesk.com/bim360/clash/v3/...`                        | `$APS_EMULATOR_URL/bim360/clash/v3/...`                        |
| `https://developer.api.autodesk.com/webhooks/v1/...`                             | `$APS_EMULATOR_URL/webhooks/v1/...`                             |
| `https://developer.api.autodesk.com/.well-known/openid-configuration`            | `$APS_EMULATOR_URL/.well-known/openid-configuration`            |
| `https://api.userprofile.autodesk.com/userinfo`                                  | `$APS_EMULATOR_URL/userinfo`                                    |

## Seed Config

```yaml
aps:
  users:
    - email: testuser@autodesk.local
      name: Test User
  clients:
    - client_id: aps-test-client
      client_secret: aps-test-secret
      name: My APS App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/aps
        - http://localhost:3000/api/auth/oauth2/callback/aps
    - client_id: aps-test-app
      type: public
      redirect_uris:
        - http://localhost:3000/callback
  hubs:
    - id: b.emulate-hub
      name: Emulate Construction Hub
      region: US
  projects:
    - id: b.emulate-project
      hub_id: b.emulate-hub
      name: Sample Building
  acc_project_users:
    - project_id: b.emulate-project
      user_email: testuser@autodesk.local
      role: project_admin
      issue_permission: manage
      rfi_roles: [project_admin, projectGC, projectSC]
  issue_types:
    - id: 11111111-1111-4111-8111-111111111111
      project_id: b.emulate-project
      title: Coordination
      subtypes:
        - id: 22222222-2222-4222-8222-222222222222
          title: Clash
  issues:
    - id: 33333333-3333-4333-8333-333333333333
      project_id: b.emulate-project
      title: Door clearance conflict
      issue_type_id: 11111111-1111-4111-8111-111111111111
      issue_subtype_id: 22222222-2222-4222-8222-222222222222
      status: open
  rfi_types:
    - id: 55555555-5555-4555-8555-555555555555
      project_id: b.emulate-project
      name: Design clarification
      is_default: true
  rfis:
    - id: 77777777-7777-4777-8777-777777777777
      project_id: b.emulate-project
      rfi_type_id: 55555555-5555-4555-8555-555555555555
      custom_identifier: RFI-001
      title: Confirm structural opening
      status: open
  sheet_collections:
    - id: 99999999-9999-4999-8999-999999999999
      project_id: b.emulate-project
      name: Issued for Construction
  sheet_version_sets:
    - id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
      project_id: b.emulate-project
      name: August 2026 Issue
      issuance_date: 2026-08-19
      collection_id: 99999999-9999-4999-8999-999999999999
  sheets:
    - id: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
      project_id: b.emulate-project
      number: A-101
      title: Level 1 Floor Plan
      version_set_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
      collection_id: 99999999-9999-4999-8999-999999999999
      tags: [architectural, floor-plan]
  manifests:
    dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZW11bGF0ZS1idWNrZXQvc2FtcGxlLnJ2dA:
      status: success
      progress: complete
      region: US
      derivatives:
        - outputType: svf2
          status: success
          progress: complete
  webhook_timing:
    max_retries: 8
    retry_base_ms: 25
    retry_max_ms: 1000
    failed_events_before_inactive: 5
    reactivate_after_ms: 1000
    max_reactivation_cycles: 5
    delivery_timeout_ms: 6000
  document_versions:
    - version_id: urn:adsk.wipprod:fs.file:vf.emulate-sample-model?version=1
      item_id: urn:adsk.wipprod:dm.lineage:emulate-sample-model
      folder_id: urn:adsk.wipprod:fs.folder:co.emulate-plans
      ancestor_folder_ids: [urn:adsk.wipprod:fs.folder:co.emulate-documents]
      project_id: b.emulate-project
      display_name: sample.rvt
  model_coordination_timing:
    processing_ms: 25
    signed_url_ttl_ms: 60000
  model_sets:
    - id: 13131313-1313-4131-8131-131313131313
      project_id: b.emulate-project
      name: Sample Building Coordination
      document_version_ids:
        - urn:adsk.wipprod:fs.file:vf.emulate-sample-model?version=1
        - urn:adsk.wipprod:fs.file:vf.emulate-structural-model?version=1
  webhooks:
    - system: data
      event: dm.version.added
      callback_url: http://localhost:3000/api/webhooks/aps
      scope:
        folder: urn:adsk.wipprod:fs.folder:co.emulate-documents
      creator_client_id: aps-test-client
      auto_reactivate_hook: true
```

Client `type` is inferred when omitted: confidential when a `client_secret` is present, public otherwise. Every project `hub_id` must match a seeded hub. ACC resources use the Data Management project ID in seed config. With no config, the emulator also seeds one hub, two projects, one ACC project membership, sample workflow resources, two coordinated Docs models with manifests, and one successful clash test.

## 3-Legged Authorization Code Flow

```bash
APS_URL="http://localhost:4014"
CLIENT_ID="aps-test-client"
CLIENT_SECRET="aps-test-secret"
REDIRECT_URI="http://localhost:3000/api/auth/callback/aps"

# 1. Open in browser (user picks a seeded Autodesk account)
#    $APS_URL/authentication/v2/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&response_type=code&scope=data:read&state=abc

# 2. After user selection, emulator redirects to:
#    $REDIRECT_URI?code=<code>&state=abc

# 3. Exchange code for tokens
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI"
```

Client credentials can also be sent as an HTTP Basic `Authorization` header instead of body parameters. Do not send `client_id` in the body when an `Authorization` header is present; the emulator rejects that, matching real APS. Returns:

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3599,
  "refresh_token": "..."
}
```

When the requested scope includes `openid`, the response also contains an `id_token`. Authorization codes are single use and expire after 5 minutes.

### PKCE

The authorize endpoint accepts `code_challenge` with `code_challenge_method=S256` (`S256` only). PKCE is required for public clients, which omit `client_secret`:

```bash
# Verifier/challenge pair
CODE_VERIFIER="test-code-verifier-string"
CODE_CHALLENGE=$(printf %s "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 1. Authorize with code_challenge=$CODE_CHALLENGE&code_challenge_method=S256

# 2. Exchange with the verifier (public client, no secret)
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=<code>&client_id=aps-test-app&redirect_uri=http://localhost:3000/callback&code_verifier=$CODE_VERIFIER"
```

## 2-Legged Client Credentials Flow

Confidential clients only. `scope` is required:

```bash
curl -X POST $APS_URL/authentication/v2/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=data:read data:write"
```

Returns an `access_token` without a `refresh_token` or `id_token`.

## Data Management Reads

Hub and project routes require a 3-legged access token carrying `data:read` and a `userid` claim. Use the authorization code flow above, then walk the seeded data:

```bash
curl "$APS_URL/project/v1/hubs" \
  -H "Authorization: Bearer <3-legged-access-token>"

curl "$APS_URL/project/v1/hubs/b.emulate-hub/projects" \
  -H "Authorization: Bearer <3-legged-access-token>"
```

The four available reads are `GET /project/v1/hubs`, `GET /project/v1/hubs/:hubId`, `GET /project/v1/hubs/:hubId/projects`, and `GET /project/v1/hubs/:hubId/projects/:projectId`. Responses use JSON:API envelopes with `jsonapi`, `links`, `data`, `attributes`, and `relationships`.

## Model Derivative Reads

Formats and manifests accept either a 2-legged or 3-legged token carrying `data:read`. After obtaining the 2-legged token above:

```bash
SAMPLE_URN="dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6ZW11bGF0ZS1idWNrZXQvc2FtcGxlLnJ2dA"

curl "$APS_URL/modelderivative/v2/designdata/formats" \
  -H "Authorization: Bearer <2-legged-access-token>"

curl "$APS_URL/modelderivative/v2/designdata/$SAMPLE_URN/manifest" \
  -H "Authorization: Bearer <2-legged-access-token>"
```

The optional `region` parameter is accepted and ignored. Unknown URNs return `404`, matching the real empty-body response.

## ACC Workflow Reads

Issues and RFIs require a 3-legged access token carrying `data:read`. Their project path parameter is the Data Management project ID with the `b.` prefix removed. Use the authorization code flow above, then inspect the default project:

```bash
PROJECT_ID="emulate-project"

curl "$APS_URL/construction/issues/v1/projects/$PROJECT_ID/issues?limit=100" \
  -H "Authorization: Bearer <3-legged-access-token>"

curl -X POST "$APS_URL/construction/rfis/v3/projects/$PROJECT_ID/search:rfis" \
  -H "Authorization: Bearer <3-legged-access-token>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Issues provides current-user permissions, issue types, issue lists, and issue details. RFIs provides current-user permissions, workflow, types, custom attributes, the next custom identifier, POST-based search, and RFI details. List responses use module-correct offset pagination, and permission fields are computed from `acc_project_users`.

Sheets accepts either token type carrying `data:read` and accepts the project ID with or without `b.`. A 2-legged request can include `x-user-id` to impersonate a seeded project user:

```bash
curl "$APS_URL/construction/sheets/v1/projects/b.emulate-project/sheets" \
  -H "Authorization: Bearer <2-legged-access-token>"

curl "$APS_URL/construction/sheets/v1/projects/emulate-project/version-sets" \
  -H "Authorization: Bearer <2-legged-access-token>"
```

Sheets provides sheet lists and batch reads, version-set lists, collection lists, and collection details. Its paginated lists include `previousUrl` and `nextUrl`.

## Model Coordination Walkthrough

Model Coordination requires a 3-legged `data:read` token and the bare project GUID. The default model set references two seeded Data Management versions and two Model Derivative manifests. Walk the same sequence as a real coordination client:

```bash
APS_URL="http://localhost:4014"
ACCESS_TOKEN="<3-legged-access-token>"
PROJECT_ID="emulate-project"
MODEL_SET_ID="13131313-1313-4131-8131-131313131313"

# List model sets and inspect the latest document versions
curl "$APS_URL/bim360/modelset/v3/containers/$PROJECT_ID/modelsets" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
curl "$APS_URL/bim360/modelset/v3/containers/$PROJECT_ID/modelsets/$MODEL_SET_ID/versions/latest" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Select the successful clash test
TEST_ID=$(curl -s "$APS_URL/bim360/clash/v3/containers/$PROJECT_ID/modelsets/$MODEL_SET_ID/tests?status=Success" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.tests[0].id')

# Request signed resources, then download and decompress the document map
RESOURCE_URL=$(curl -s "$APS_URL/bim360/clash/v3/containers/$PROJECT_ID/tests/$TEST_ID/resources" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.resources[] | select(.type == "scope-version-document.2.0.0") | .url')
curl -s "$RESOURCE_URL" | gunzip -c
```

The document-map URNs match `documentVersions[].versionUrn` from the latest model set version. Signed URLs are deliberately short-lived; request resources again after expiry. Lists use opaque `continuationToken` values and accept at most 20 items per page.

To exercise the asynchronous lifecycle, append a version and poll its returned clash-test id until it reaches `Success`:

```bash
curl -X POST "$APS_URL/_aps/simulate/modelset-version-added" \
  -H "Content-Type: application/json" \
  -d '{"modelSetId":"13131313-1313-4131-8131-131313131313"}'
```

## Webhooks

Use a 2-legged or 3-legged token with `data:read data:write` for hook writes and signing-secret management. Reads need `data:read`. Hooks created with a 2-legged token belong to the app; hooks created with a 3-legged token belong to that user. Region is part of the partition and follows `region` header, `x-ads-region` header, then query parameter precedence.

```bash
APS_URL="http://localhost:4014"
ACCESS_TOKEN="<2-legged-or-3-legged-access-token>"

# 1. Set the app or user signing secret
curl -X POST "$APS_URL/webhooks/v1/tokens" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token":"local-signing-secret"}'

# 2. Subscribe recursively to a seeded folder
curl -X POST "$APS_URL/webhooks/v1/systems/data/events/dm.version.added/hooks" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{"callbackUrl":"http://localhost:3000/api/webhooks/aps","scope":{"folder":"urn:adsk.wipprod:fs.folder:co.emulate-documents"},"filter":"$[?(@.ext in ['rvt','dwg'])]"}
JSON

# 3. Deliver a callback from the seeded descendant version
curl -X POST "$APS_URL/_aps/simulate/dm-version-added" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The event-specific create returns `201` with an empty body and a `Location` header. Empty lists return `204`. System-wide creation fans out over the documented catalog and returns `{ "hooks": [...] }`. Lists page at 200 items through opaque `pageState` cursors. Unknown system and event strings are accepted for forward-compatible tests.

Callbacks contain `{ version, resourceUrn, hook, payload }` and an `x-adsk-delivery-id` header. If a token exists, verify `x-adsk-signature` against the exact raw body:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = `sha1hash=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
const valid = timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expected));
```

A per-hook `token` overrides the identity secret. The generic `POST /_aps/simulate/event` route returns per-hook statuses, attempts, signature presence, and drop reasons. Convenience routes cover `dm.version.added`, `extraction.finished`, and `issue.created-1.0` from seeded state.

Event matching supports exact names, `*`, `dm.*.modified`, and `*.added`; recursive folder ancestry; exact workflow/project/company scope; expiry deletion; and the documented JSONPath subset. Filters support comparisons, `in [...]`, `&&`, `||`, and arrays combined with AND.

Failed callbacks retry exponentially. Five exhausted events deactivate a hook. Auto-reactivation performs one trial after the configured delay, restores the hook on success, and stops permanently after five failed cycles. `webhook_timing` compresses the real APS clock so tests finish in seconds.

## Refresh Token Flow

```bash
curl -X POST $APS_URL/authentication/v2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<refresh_token>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"
```

Refresh tokens live for 15 days and are single use. Every refresh returns a new `refresh_token`; always store the latest one. Replaying an already-used refresh token invalidates the whole grant family (all access and refresh tokens descended from the original authorization), matching real APS behavior. An optional `scope` parameter may downscope the grant but never widen it.

## Other Endpoints

### User Info

```bash
curl $APS_URL/userinfo \
  -H "Authorization: Bearer <access_token>"
```

Requires a 3-legged token; 2-legged tokens carry no user context and return a 401 `AUTH-006` error.

### Introspection

```bash
curl -X POST $APS_URL/authentication/v2/introspect \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=<access_or_refresh_token>"
```

### Revocation

```bash
curl -X POST $APS_URL/authentication/v2/revoke \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=<access_or_refresh_token>"
```

### OIDC Discovery and Logout

```bash
curl $APS_URL/.well-known/openid-configuration
curl "$APS_URL/authentication/v2/logout?post_logout_redirect_uri=http://localhost:3000/"
```

The logout redirect is only followed when the target host matches a registered client redirect URI.

## Verifying Access Tokens

Access tokens are RS256 JWTs signed with the emulator's key pair and expire after one hour (`expires_in` 3599). Verify them against the JWKS endpoint:

```bash
curl $APS_URL/authentication/v2/keys
```

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(`${process.env.APS_EMULATOR_URL}/authentication/v2/keys`));
const { payload } = await jwtVerify(accessToken, jwks, {
  issuer: "https://developer.api.autodesk.com",
  audience: "https://autodesk.com",
});
// payload.scope, payload.client_id, payload.userid (3-legged only)
```

## Current Limits

Data Management folder, item, version, and OSS HTTP routes; write operations; translation jobs; other Model Derivative resources; ACC Forms, Submittals, Assets, Relationships, and Model Properties; Model Coordination writes, index-service routes, sqlite clash resources, screenshots, and exports; ACC write endpoints; webhook callback verification; rate limits; and the real token propagation delay are not included yet.
