# @emulators/aps

Autodesk Platform Services (APS) emulation with authentication v2, Data Management, Model Derivative, Autodesk Construction Cloud Issues, RFIs, Sheets, and Model Coordination reads, plus active Webhooks delivery and local event simulation.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/aps
```

## Endpoints

- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /authentication/v2/keys` — JSON Web Key Set (JWKS)
- `GET /authentication/v2/authorize` — authorization endpoint (shows user picker)
- `POST /authentication/v2/token` — token exchange (authorization code, refresh token, client credentials)
- `POST /authentication/v2/revoke` — token revocation
- `POST /authentication/v2/introspect` — token introspection
- `GET /authentication/v2/logout` — end session / logout
- `GET /userinfo` — user profile
- `GET /project/v1/hubs` — list hubs with a 3-legged token
- `GET /project/v1/hubs/:hubId` — get a hub with a 3-legged token
- `GET /project/v1/hubs/:hubId/projects` — list projects with a 3-legged token
- `GET /project/v1/hubs/:hubId/projects/:projectId` — get a project with a 3-legged token
- `GET /project/v1/hubs/:hubId/projects/:projectId/topFolders` — list a project's top folders
- `GET /data/v1/projects/:projectId/folders/:folderId` — get a folder
- `GET /data/v1/projects/:projectId/folders/:folderId/contents` — list mixed child folders and items with included tips
- `GET /data/v1/projects/:projectId/items/:itemId` — get an item with its included tip
- `GET /data/v1/projects/:projectId/items/:itemId/versions` — list an item's versions
- `GET /data/v1/projects/:projectId/items/:itemId/tip` — get an item's tip version
- `GET /data/v1/projects/:projectId/versions/:versionId` — get a version by URL-encoded URN
- `GET /modelderivative/v2/designdata/formats` — list translation formats
- `GET /modelderivative/v2/designdata/:urn/manifest` — get a seeded manifest
- `GET /construction/issues/v1/projects/:projectId/users/me` — get current-user Issues permissions
- `GET /construction/issues/v1/projects/:projectId/issue-types` — list issue types
- `GET /construction/issues/v1/projects/:projectId/issues` — list and filter issues
- `GET /construction/issues/v1/projects/:projectId/issues/:issueId` — get an issue
- `GET /construction/rfis/v3/projects/:projectId/users/me` — get current-user RFI permissions
- `GET /construction/rfis/v3/projects/:projectId/workflow` — get the RFI workflow
- `GET /construction/rfis/v3/projects/:projectId/rfi-types` — list RFI types
- `GET /construction/rfis/v3/projects/:projectId/attributes` — list RFI custom attributes
- `GET /construction/rfis/v3/projects/:projectId/rfis/custom-identifier` — get the next RFI identifier
- `POST /construction/rfis/v3/projects/:projectId/search:rfis` — list and search RFIs
- `GET /construction/rfis/v3/projects/:projectId/rfis/:rfiId` — get an RFI
- `GET /construction/sheets/v1/projects/:projectId/sheets` — list and filter sheets
- `POST /construction/sheets/v1/projects/:projectId/sheets:batch-get` — batch get sheets
- `GET /construction/sheets/v1/projects/:projectId/version-sets` — list Sheet version sets
- `GET /construction/sheets/v1/projects/:projectId/collections` — list Sheet collections
- `GET /construction/sheets/v1/projects/:projectId/collections/:collectionId` — get a Sheet collection
- `GET /bim360/modelset/v3/containers/:containerId/modelsets` — list Model Coordination model sets
- `GET /bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions/latest` — get the latest model set version
- `GET /bim360/modelset/v3/containers/:containerId/modelsets/:modelSetId/versions/:version/views` — list model set views
- `GET /bim360/clash/v3/containers/:containerId/modelsets/:modelSetId/tests` — list clash tests
- `GET /bim360/clash/v3/containers/:containerId/tests/:testId/resources` — issue expiring gzip resource URLs
- `GET /bim360/clash/v3/containers/:containerId/tests/:testId/clashes/:disposition` — list assigned or closed clash groups
- `POST/GET /webhooks/v1/systems/:system/events/:event/hooks` — create or list event hooks
- `GET/PATCH/DELETE /webhooks/v1/systems/:system/events/:event/hooks/:hookId` — manage one hook
- `POST/GET /webhooks/v1/systems/:system/hooks` — create or list hooks for a system
- `GET /webhooks/v1/hooks` and `GET /webhooks/v1/app/hooks` — list visible hooks
- `POST /webhooks/v1/tokens` and `PUT/DELETE /webhooks/v1/tokens/@me` — manage signing secrets
- `POST /_aps/simulate/event` — emit an arbitrary local event
- `POST /_aps/simulate/dm-version-added` — emit from a seeded Data Management version
- `POST /_aps/simulate/extraction-finished` — emit from a seeded manifest
- `POST /_aps/simulate/issue-created` — emit from a seeded ACC issue
- `POST /_aps/simulate/modelset-version-added` — add a model set version and run its clash test

## URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                                    | Emulator URL                                   |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/...`      | `$APS_EMULATOR_URL/authentication/v2/...`      |
| `https://developer.api.autodesk.com/project/v1/...`             | `$APS_EMULATOR_URL/project/v1/...`             |
| `https://developer.api.autodesk.com/data/v1/...`                | `$APS_EMULATOR_URL/data/v1/...`                |
| `https://developer.api.autodesk.com/modelderivative/v2/...`     | `$APS_EMULATOR_URL/modelderivative/v2/...`     |
| `https://developer.api.autodesk.com/construction/issues/v1/...` | `$APS_EMULATOR_URL/construction/issues/v1/...` |
| `https://developer.api.autodesk.com/construction/rfis/v3/...`   | `$APS_EMULATOR_URL/construction/rfis/v3/...`   |
| `https://developer.api.autodesk.com/construction/sheets/v1/...` | `$APS_EMULATOR_URL/construction/sheets/v1/...` |
| `https://developer.api.autodesk.com/bim360/modelset/v3/...`     | `$APS_EMULATOR_URL/bim360/modelset/v3/...`     |
| `https://developer.api.autodesk.com/bim360/clash/v3/...`        | `$APS_EMULATOR_URL/bim360/clash/v3/...`        |
| `https://developer.api.autodesk.com/webhooks/v1/...`            | `$APS_EMULATOR_URL/webhooks/v1/...`            |
| `https://api.userprofile.autodesk.com/userinfo`                 | `$APS_EMULATOR_URL/userinfo`                   |

## Behavior

Access tokens are RS256 JWTs verifiable against the JWKS endpoint and expire after one hour (`expires_in` 3599). Protected routes validate the signature, expiry, revocation state, and required scopes. Generic static emulator tokens are not accepted. Data Management, Issues, RFI, and Model Coordination routes require a 3-legged token. Model Derivative, Sheets, and most Webhooks routes accept either token type. `GET /webhooks/v1/app/hooks` requires a 2-legged token. Sheets supports optional `x-user-id` impersonation for 2-legged tokens.

With no config, the emulator also seeds one hub, two projects, realistic folder trees with item histories, one ACC project membership, sample Issues, RFIs, Sheets, two coordinated Docs models with manifests, and one successful clash test.

## Seed Configuration

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
  document_folders:
    - id: urn:adsk.wipprod:fs.folder:co.emulate-documents
      project_id: b.emulate-project
      name: Project Files
    - id: urn:adsk.wipprod:fs.folder:co.emulate-plans
      project_id: b.emulate-project
      parent_folder_id: urn:adsk.wipprod:fs.folder:co.emulate-documents
      name: Plans
  document_items:
    - id: urn:adsk.wipprod:dm.lineage:emulate-sample-model
      project_id: b.emulate-project
      folder_id: urn:adsk.wipprod:fs.folder:co.emulate-plans
      display_name: sample.rvt
  document_versions:
    - version_id: urn:adsk.wipprod:fs.file:vf.emulate-sample-model?version=1
      item_id: urn:adsk.wipprod:dm.lineage:emulate-sample-model
      project_id: b.emulate-project
      version_number: 1
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

Client `type` is inferred when omitted: confidential when a `client_secret` is present, public otherwise.
Every project `hub_id` must match a seeded hub.
Folders reference parents, items reference folders, and versions reference items. Seeding validates those relationships and rejects folder cycles. Legacy version seeds with `folder_id` and `ancestor_folder_ids` remain supported. ACC resources use the Data Management project ID in seed config. Remove `b.` when calling Issues, RFIs, or Model Coordination. Sheets accepts either form.

## Data Management

Use a 3-legged `data:read` token and follow the resolving JSON:API relationships from the default project through a translated version:

```bash
ACCESS_TOKEN="<3-legged-access-token>"
AUTH="Authorization: Bearer $ACCESS_TOKEN"
TOP_URL="$APS_EMULATOR_URL/project/v1/hubs/b.emulate-hub/projects/b.emulate-project/topFolders"
ROOT_CONTENTS=$(curl -s "$TOP_URL" -H "$AUTH" | jq -r '.data[0].relationships.contents.links.related.href')
PLANS_CONTENTS=$(curl -s "$ROOT_CONTENTS" -H "$AUTH" | jq -r '.data[] | select(.attributes.displayName == "Plans") | .relationships.contents.links.related.href')
COORDINATION_CONTENTS=$(curl -s "$PLANS_CONTENTS" -H "$AUTH" | jq -r '.data[] | select(.attributes.displayName == "Coordination") | .relationships.contents.links.related.href')
ITEM_URL=$(curl -s "$COORDINATION_CONTENTS" -H "$AUTH" | jq -r '.data[] | select(.attributes.displayName == "sample.rvt") | .links.self.href')
TIP_URL=$(curl -s "$ITEM_URL" -H "$AUTH" | jq -r '.data.relationships.tip.links.related.href')
MANIFEST_URL=$(curl -s "$TIP_URL" -H "$AUTH" | jq -r '.data.relationships.derivatives.meta.link.href')
curl "$MANIFEST_URL" -H "$AUTH"
```

Folder contents returns mixed folders and items with tip versions in `included`. It supports type and extension filters plus zero-based pagination up to 200 resources per page. Version histories are newest first.

## Model Coordination

Use a 3-legged `data:read` token to fetch the latest model set version, find its clash test, and download a gzip result:

```bash
PROJECT_ID="emulate-project"
MODEL_SET_ID="13131313-1313-4131-8131-131313131313"
ACCESS_TOKEN="<3-legged-access-token>"

curl "$APS_EMULATOR_URL/bim360/modelset/v3/containers/$PROJECT_ID/modelsets/$MODEL_SET_ID/versions/latest" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

TEST_ID=$(curl -s "$APS_EMULATOR_URL/bim360/clash/v3/containers/$PROJECT_ID/modelsets/$MODEL_SET_ID/tests?status=Success" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.tests[0].id')
RESOURCE_URL=$(curl -s "$APS_EMULATOR_URL/bim360/clash/v3/containers/$PROJECT_ID/tests/$TEST_ID/resources" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.resources[2].url')
curl -s "$RESOURCE_URL" | gunzip -c
```

Resources are three deterministic JSON gzip artifacts with expiring signed URLs. Re-request resources for fresh URLs. `POST /_aps/simulate/modelset-version-added` adds a version and advances its one clash test from `Pending` through `Processing` to `Success`.

## Webhook Simulation

Obtain a 2-legged token with `data:read data:write`, then create a signing secret and hook:

```bash
curl -X POST "$APS_EMULATOR_URL/webhooks/v1/tokens" \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"token":"local-signing-secret"}'

curl -X POST "$APS_EMULATOR_URL/webhooks/v1/systems/data/events/dm.version.added/hooks" \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{"callbackUrl":"http://localhost:3000/api/webhooks/aps","scope":{"folder":"urn:adsk.wipprod:fs.folder:co.emulate-documents"}}'

curl -X POST "$APS_EMULATOR_URL/_aps/simulate/dm-version-added" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Callbacks use the APS `version`, `resourceUrn`, `hook`, and `payload` envelope and include `x-adsk-delivery-id`. When a token exists, `x-adsk-signature` contains `sha1hash=<hex HMAC-SHA1(raw body)>`. Retries, five-event deactivation, auto-reactivation, recursive folder scopes, wildcard events, and the documented JSONPath filter subset run on a configurable compressed clock.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
