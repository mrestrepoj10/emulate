---
name: aps-model-coordination
description: Emulated Autodesk BIM 360 / ACC Model Coordination (model set service v3 and clash service v3) for local development and testing. Use when the user needs model sets, model set versions, named views, clash tests, clash result files (scope-version-clash, clash-instance, document), assigned or closed clash groups, grouped clash ids, clash group intersections and batch data, deterministic clash scenarios, region headers, Model Coordination rate limits, entitlement errors, or sqlite resource fallbacks without hitting Autodesk. Triggers include "Model Coordination", "model set", "modelset service", "clash service", "clash test", "clash results", "scope-version-clash", "assigned clash group", "closed clash group", "clash scenario", "BIM 360 clash", or "ACC clash sync".
metadata:
  priority: 7
  docs:
    - "https://aps.autodesk.com/en/docs/bim360/v1/tutorials/mc-tutorial-clash/"
    - "https://aps.autodesk.com/en/docs/bim360/v1/tutorials/mc-tutorial-model-set/"
    - "https://aps.autodesk.com/en/docs/bim360/v1/reference/http/mc-clash-service-v3/"
    - "https://aps.autodesk.com/en/docs/bim360/v1/reference/http/mc-modelset-service-v3/"
    - "https://aps.autodesk.com/en/docs/bim360/v1/overview/rate-limits/model-coordination-rate-limits/"
  pathPatterns:
    - "**/model-coordination*/**"
    - "**/clash*/**"
    - "**/modelset*/**"
  promptSignals:
    phrases:
      - "model coordination"
      - "model set"
      - "clash test"
      - "clash group"
      - "scope-version-clash"
    minScore: 5
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# APS Model Coordination Emulator

Model set service v3 and clash service v3 emulation inside the APS emulator (`npx emulate --service aps`, default `http://localhost:4014`). Every route needs a 3-legged `data:read` token from the emulator's own OAuth flow; `containerId` is the ACC project id without the `b.` prefix (`emulate-project`).

## URL Table

| Real APS path (`https://developer.api.autodesk.com`) | Emulator | Notes |
| --- | --- | --- |
| `GET /bim360/modelset/v3/containers/:c/modelsets` | same | `name`, `folderUrn`, `includeDisabled`, `includeDeleted`, `pageLimit` ≤ 20, `continuationToken` |
| `GET .../modelsets/:m` | same | full model set with `tipVersion`, folders, checksum |
| `GET .../modelsets/:m/views` | same | named views (`name`, `definition[].lineageUrn`) |
| `GET .../modelsets/:m/versions` | same | `status` filter: Pending, Processing, Successful, Partial, Failed |
| `GET .../modelsets/:m/versions/latest` and `/:v` | same | `documentVersions[].documentStatus` Succeeded/Failed/Running/Skipped |
| `GET .../versions/:v/views` and `/views/:viewId` | same | view versions with the subset of `documentVersions` |
| `GET /bim360/clash/v3/containers/:c/modelsets/:m/tests` | same | `status` filter: Pending, Processing, Success, Failed |
| `GET .../modelsets/:m/versions/:v/tests` | same | one test per version |
| `GET .../modelsets/:m/clashes/assigned` | same | `clashTestId`, `issueId`, `createdBy`, `after`, `before`, `sort=Asc|Desc` (default Asc by `createdOn`), paging |
| `GET .../modelsets/:m/clashes/closed` | same | `clashTestId`, `reason`, `createdBy`, `after`, `before`, `sort`, paging |
| `GET .../modelsets/:m/clashes/grouped` | same | `{ clashes: [ids] }` |
| `GET .../tests/:t` | same | one test summary |
| `GET .../tests/:t/resources` | same | signed URLs with `validUntil`; `409` unless status is `Success` |
| `GET .../tests/:t/clashes/assigned` and `/closed` | same | `existing[]` / `resolved[]` per group against that test |
| `POST .../tests/:t/clashes/assigned` and `/closed` | same | JSON array of 1–20 group ids (`?issues=true` for issue ids) → groups with `clashData` |
| `POST /_aps/simulate/modelset-version-added` | emulator only | body: `modelSetId`, `processingMs`, scenario step fields |
| `POST /_aps/simulate/clash-group-assigned` and `/clash-group-closed` | emulator only | body: `modelSetId` or `testId` or `version`, `clashes`, `issueId`, `title`, `reason` |

Set `APS_EMULATOR_URL=http://localhost:4014` and route both `bim360/modelset/v3` and `bim360/clash/v3` there.

## Default Seed

Model set `13131313-1313-4131-8131-131313131313` in project `emulate-project` with documents `sample.rvt` and `structural.rvt`, three versions (v1 40 New; v2 10 New, 25 Existing, 15 Resolved; v3 3 New, 30 Existing, 5 Resolved), one successful test per version (v1 test id `16161616-1616-4161-8161-161616161616`), views `All models` and `Architecture only`, an assigned group of 8 clashes linked to issue `33333333-3333-4333-8333-333333333333`, and a closed group of 5 clashes with reason `VALID_INTERFACE`, both created at version 2.

## Result Files

- Three resources per successful test: `scope-version-clash.2.0.0`, `scope-version-clash-instance.2.0.0`, `scope-version-document.2.0.0`, extension `json.gz`.
- Each file is gzip of a UTF-8 BOM plus a wrapper object (`{"clashes":[…]}`, `{"instances":[…]}`, `{"documents":[…]}`). Strip the first character before `JSON.parse`, exactly like Autodesk's `aps-model-clash-powerbi` sample.
- Clash rows: `{ id, clash: [loid, roid], dist, status }`. Instance rows: `{ cid, ldid, loid, lvid, rdid, roid, rvid }`. Document rows: `{ id, urn, viewableName }` where `urn` is the model set version `versionUrn`.
- `id`, `loid`, `roid` are stable across versions. `lvid`/`rvid` are LMV viewer ids: Model Derivative metadata `objectid` + 1000 (`LMV_ID_OFFSET`, shared with the Model Properties index emulation's `lmvId`).
- A `Resolved` clash is reported once and then disappears. Documents that are not `Succeeded` are excluded from that version's files.

## Scenario Config

```yaml
aps:
  model_sets:
    - id: <uuid>
      project_id: b.emulate-project
      name: Coordination
      document_version_ids: [<translated DM version id>, <translated DM version id>]
      test_id: <uuid> # version 1 test id; later versions derive stable ids
      clash_scenario:
        seed: 42
        versions:
          - { added: 40 }
          - { added: 10, resolved: 15, documents_added: [<version id>], documents_removed: [<version id>] }
          - { added: 0, document_status: { <version id>: Failed }, status: Partial }
        groups:
          - { kind: assigned, at_version: 2, clashes: 8, issue_id: <issue uuid> }
          - { kind: closed, at_version: 2, clashes: [100001, 100002], reason: FIELD_FIX, title: Fix on site }
        large: false # true → ~200k clashes in version 1, generated lazily
      views:
        - { id: <uuid>, name: Architecture only, document_version_ids: [<version id>] }
  model_coordination_timing: { processing_ms: 25, signed_url_ttl_ms: 60000 }
  model_coordination_faults:
    rate_limit_per_minute: 0 # 429 + Retry-After per user token when exceeded
    entitlement: true # false or { b.<project>: false } → 403 "Model Coordination is not enabled for this project"
    resources_extension: {} # { <test id>: sqlite } → sqlite resources with empty bodies
```

Same `seed` and steps always produce byte-identical files. Steps default to `added: 0, resolved: 0`; version status derives from document statuses when omitted; a `Failed` version yields a `Failed` test and does not advance the clash pool. Group `clashes` as a count picks the lowest-id live clashes not already grouped.

## Rules

- Send `region` (or legacy `x-ads-region`) as `US` or `EMEA`; the emulator echoes it in `x-emulate-region` and rejects other values with a `BadInput` problem.
- Download resource files immediately after `GET .../resources`; URLs expire at `validUntil` (`signed_url_ttl_ms`) and return `403` afterwards. Re-request resources for a fresh lease.
- Handle `429` with `Retry-After` and `403` entitlement problems (`type: Forbidden`) when the faults are enabled.
- Only parse `json.gz` resources; skip a test whose resources report `sqlite`.
- Use the per-test intersection GETs for the latest test only; use the container-level searches for group metadata (`issueId`, `reason`, `createdOn`).
- Errors are RFC 7807 `application/problem+json` with `type` values `BadInput`, `NotFound`, `Forbidden`, `Conflict`, `UnsupportedMediaType`, `TooManyRequests`.
