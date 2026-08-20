# @emulators/aps

Autodesk Platform Services (APS) emulation with authentication v2, Data Management hub and project reads, and Model Derivative format and manifest reads.

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

## URL Mapping

Real APS paths map 1:1 onto the emulator:

| Real APS URL                                               | Emulator URL                              |
| ---------------------------------------------------------- | ----------------------------------------- |
| `https://developer.api.autodesk.com/authentication/v2/...` | `$APS_EMULATOR_URL/authentication/v2/...` |
| `https://developer.api.autodesk.com/project/v1/...`        | `$APS_EMULATOR_URL/project/v1/...`        |
| `https://developer.api.autodesk.com/modelderivative/v2/...` | `$APS_EMULATOR_URL/modelderivative/v2/...` |
| `https://api.userprofile.autodesk.com/userinfo`            | `$APS_EMULATOR_URL/userinfo`              |

## Behavior

Access tokens are RS256 JWTs verifiable against the JWKS endpoint and expire after one hour (`expires_in` 3599). Data routes validate the signature, expiry, revocation state, and `data:read` scope. Generic static emulator tokens are not accepted. Hub and project routes require a 3-legged token. Model Derivative formats and manifests accept either token type.

With no config, the emulator also seeds one hub, two projects, and a completed sample manifest.

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

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
