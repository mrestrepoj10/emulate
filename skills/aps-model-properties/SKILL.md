---
name: aps-model-properties
description: Autodesk Construction Cloud Model Properties (index) API guidance for building property indexes and diff indexes from Docs file versions, polling index and query jobs, downloading gzip NDJSON manifests, fields, properties, and query results, and mapping svf2Id, lmvId, and externalId. Use when querying BIM properties across ACC model versions, bridging clash or Viewer object ids, tracking property changes between versions, or troubleshooting index jobs against ACC or the local APS emulator.
metadata:
  priority: 7
  docs:
    - "https://aps.autodesk.com/en/docs/acc/v1/overview/model-properties-field-guide/"
    - "https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties-query-ref/"
    - "https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties-querying/"
    - "https://aps.autodesk.com/en/docs/acc/v1/tutorials/model-properties-diff/"
    - "https://aps.autodesk.com/en/docs/acc/v1/reference/http/index-v2-post-index-jobs-batch-status-POST/"
  pathPatterns:
    - "**/model-properties*/**"
    - "**/model-properties-*"
    - "**/construction/index/**"
    - "**/version-comparison*/**"
  promptSignals:
    phrases:
      - "model properties"
      - "property index"
      - "indexes:batch-status"
      - "diffs:batch-status"
      - "svf2Id"
      - "lmvId"
      - "externalId"
      - "queryResultsUrl"
    minScore: 5
---

# ACC Model Properties (index) API

You are an expert in the ACC Model Properties service. Build index and diff workflows that request the right file versions, poll with `retryAt`, download gzip NDJSON resources, and keep SVF (`lmvId`), SVF2 (`svf2Id`), and persistent (`externalId`) object ids straight.

## Flow Picker

| Need | Use |
| --- | --- |
| Index one or more file versions | `POST /construction/index/v2/projects/{projectId}/indexes:batch-status` with `versions: [{ versionUrn }]`, then poll `selfUrl` until `state` is `FINISHED` |
| Query at creation time | Add `query` and optional `columns` to a batch-status item; the response carries `queryId` and `queryResultsUrl` |
| Query an existing index | `POST .../indexes/{indexId}/queries` with `{ query, columns }`, poll `.../queries/{queryId}`, download `queryResultsUrl` |
| Discover field keys | Download `fieldsUrl`; one `{ key, category, type, name, uom }` per line |
| Bridge clash or Viewer ids | Read `lmvId` (SVF, used by Model Coordination clash instances) and `svf2Id` (SVF2 Viewer dbId) from the same row; persist `externalId` |
| Track changes between versions | `POST .../diffs:batch-status` with `diffs: [{ prevVersionUrn, curVersionUrn }]`; rows carry `type` `OBJECT_ADDED`, `OBJECT_REMOVED`, or `OBJECT_CHANGED` plus `prev` |

## Rules

- Use a three-legged token with `data:read`; the caller needs at least View+Download on the folder. Pass the project GUID without the `b.` prefix.
- Batch status is lazy and idempotent: unchanged `versions`, `query`, and `columns` return the same `indexId` and `queryId`. Do not treat repeated calls as duplicate jobs.
- Poll with backoff using the `retryAt` hint. `manifestUrl`, `fieldsUrl`, `propertiesUrl`, and `queryResultsUrl` are `null` until the job is `FINISHED`; a query job reports them `null` while the query itself is still running even when the index is done.
- Resources are gzip line-delimited JSON. Decode by magic bytes, not only by headers, and parse line by line; the manifest is one JSON document.
- Never confuse `lmvId` with `svf2Id`. Model Coordination clash instances reference SVF ids; the Viewer with SVF2 uses `svf2Id`. Use `externalId` for storage and cross-version matching. The `(svf2Id, lineageId)` pair identifies an object within one lineage.
- Field keys (`p<8 hex>`) are stable per attribute definition; resolve semantics from the fields resource rather than hardcoding keys. The synthetic Revit classification fields live under `__category__` as `_RC`, `_RFN`, and `_RFT`; the display name is `__name__/name`.
- Query strings must be single quoted (`"'Walls'"`); unquoted strings are property paths such as `s.props.p20d8441e`. Use `{ "$gt": [{ "$count": "s.views" }, 0] }` to keep only viewable objects.
- Diff indexing depends on stable element ids (RVT, DWG, NWC from Revit or AutoCAD, and supported IFC exporters). Removed rows have `null` top-level props and a full `prev`; changed rows carry only the differing keys in `prev.props`.
- In the local APS emulator, jobs are timer-free: each status observation is one poll and a job reports `PROCESSING` for `model_properties_index.processing_polls` observations (default one) before `FINISHED` or `FAILED`. Rows come from the emulator's Model Derivative fixtures, so `svf2Id` equals the metadata `objectid`, `externalId` matches the metadata `externalId`, and `lmvId` is `svf2Id + 1000`. Only the documented query operator subset is accepted; anything else is `400 BadInput`. Resource URLs point at the emulator origin over plain HTTP.

## Detection Rules

- Mapping clash `lvid`/`rvid` or Viewer dbIds directly to the other id space without going through an index row.
- Polling `selfUrl` in a tight loop or ignoring `retryAt`, `FAILED`, and the `errors` array.
- Reading `propertiesUrl` or `queryResultsUrl` before `state` is `FINISHED`.
- Treating fields, properties, or results as a single JSON document instead of gzip NDJSON.
- Hardcoding `p...` field keys instead of resolving them from `fieldsUrl`.
- Rejecting resource URLs whose host is not `developer.api.autodesk.com`; the emulator and any signed redirect target differ.
- Building diffs client-side from two full property downloads when the diff endpoint already computes them.

## Implementation Workflow

1. Resolve the Docs version URNs (`urn:adsk.wipprod:fs.file:vf...?version=N`) and the bare project GUID.
2. `POST indexes:batch-status`; store each `indexId` keyed by version URN.
3. Poll `GET indexes/{indexId}` until `FINISHED`; surface `FAILED` with its `errors`.
4. Download `fieldsUrl`, pick field keys by `category` and `name`, and build the `query` and `columns`.
5. `POST indexes/{indexId}/queries`, poll `queries/{queryId}`, then stream `queryResultsUrl`.
6. For version comparisons, `POST diffs:batch-status` with the previous and current URNs and normalize `type`, `externalId`, `props`, and `prev`.

## Request Pattern

```ts
const root = `${APS_BASE}/construction/index/v2/projects/${projectId}`;
const status = await fetch(`${root}/indexes:batch-status`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ versions: [{ versionUrn }] }),
}).then((response) => response.json());
const [index] = status.indexes ?? status;
// poll index.selfUrl until state === "FINISHED", then read fieldsUrl / propertiesUrl
```

## More Detail

Use the field guide for manifest, fields, properties, and diff row schemas, and the query language reference for the full operator list. The emulator README section "Model Properties (index) API" documents the local URL mapping and seed knobs.
