# @emulators/aps

Autodesk Platform Services (APS) emulation with authentication v2, Data Management, Model Derivative, and Autodesk Construction Cloud Issues, RFIs, and Sheets reads.

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

## URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                                    | Emulator URL                                   |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/...`      | `$APS_EMULATOR_URL/authentication/v2/...`      |
| `https://developer.api.autodesk.com/project/v1/...`             | `$APS_EMULATOR_URL/project/v1/...`             |
| `https://developer.api.autodesk.com/modelderivative/v2/...`     | `$APS_EMULATOR_URL/modelderivative/v2/...`     |
| `https://developer.api.autodesk.com/construction/issues/v1/...` | `$APS_EMULATOR_URL/construction/issues/v1/...` |
| `https://developer.api.autodesk.com/construction/rfis/v3/...`   | `$APS_EMULATOR_URL/construction/rfis/v3/...`   |
| `https://developer.api.autodesk.com/construction/sheets/v1/...` | `$APS_EMULATOR_URL/construction/sheets/v1/...` |
| `https://api.userprofile.autodesk.com/userinfo`                 | `$APS_EMULATOR_URL/userinfo`                   |

## Behavior

Access tokens are RS256 JWTs verifiable against the JWKS endpoint and expire after one hour (`expires_in` 3599). Data routes validate the signature, expiry, revocation state, and `data:read` scope. Generic static emulator tokens are not accepted. Hub, project, Issues, and RFI routes require a 3-legged token. Model Derivative and Sheets routes accept either token type. Sheets supports optional `x-user-id` impersonation for 2-legged tokens.

With no config, the emulator also seeds one hub, two projects, one ACC project membership, sample Issues, RFIs, Sheets, and a completed sample manifest.

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
```

Client `type` is inferred when omitted: confidential when a `client_secret` is present, public otherwise.
Every project `hub_id` must match a seeded hub.
ACC resources use the Data Management project ID in seed config. Remove `b.` when calling Issues or RFIs. Sheets accepts either form.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
