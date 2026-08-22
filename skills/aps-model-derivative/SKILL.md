---
name: aps-model-derivative
description: Autodesk Platform Services (APS) Model Derivative guidance for translation jobs, SVF/SVF2 viewables, manifests, metadata, properties, thumbnails, derivative downloads, regions, and references. Use when preparing CAD/BIM files for Viewer, translating files with Model Derivative, extracting object trees/properties/geometry, checking manifests, generating thumbnails, or troubleshooting APS derivative jobs.
metadata:
  priority: 7
  docs:
    - "https://aps.autodesk.com/en/docs/model-derivative/v2"
    - "https://aps.autodesk.com/en/docs/model-derivative/v2/developers_guide"
    - "https://aps.autodesk.com/en/docs/model-derivative/v2/reference/http"
    - "https://aps.autodesk.com/en/docs/model-derivative/v2/reference/typescript-sdk"
    - "https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/modelderivative/modelderivative.yaml"
  pathPatterns:
    - "**/model-derivative/**"
    - "**/derivative*/**"
    - "**/models/**"
    - "**/services/aps.*"
    - "**/services/autodesk.*"
  importPatterns:
    - "@aps_sdk/model-derivative"
  promptSignals:
    phrases:
      - "model derivative"
      - "svf2"
      - "translation job"
      - "manifest"
      - "object tree"
      - "model properties"
      - "thumbnail"
      - "derivative urn"
    minScore: 5
---

# APS Model Derivative

You are an expert in APS Model Derivative. Build translation and extraction workflows that use the right source URN, scopes, region, output format, and manifest/metadata flow.

## Flow Picker

| Need | Use |
| --- | --- |
| Load a model in Viewer | Upload or locate source, URL-safe Base64 the object ID, start an `svf2` job, wait for manifest completion |
| Inspect model structure | `GET /metadata`, choose a view GUID, then fetch object tree or properties |
| Query a subset of properties | `POST /metadata/{modelGuid}/properties:query` with fields and pagination |
| Generate previews | Translate or fetch thumbnails with size `100`, `200`, or `400` |
| Export other formats | Check supported formats, then request OBJ, STL, STEP, IGES, DWG, IFC, or thumbnail output as appropriate |
| Handle assemblies or xrefs | Use `compressedUrn` plus `rootFilename`, or specify references and set `checkReferences` |

## Rules

- Use `aps-auth` for tokens. Backend translation jobs need `data:read`, `data:write`, and often `data:create`; Viewer clients usually need only `viewables:read`.
- Use `aps-data-management` or OSS helpers for upload/source file work; Model Derivative starts after the source design is addressable.
- Encode the source design as a URL-safe Base64 URN. Do not pass raw OSS object IDs to Model Derivative endpoints.
- Prefer `svf2` for modern Viewer workflows; use `svf` only for compatibility needs.
- Set the `region` header consistently for jobs, manifests, metadata, thumbnails, and downloads. Do not mix regions for the same derivative.
- Treat job-level `x-ads-force: true` as destructive: it removes the existing manifest and generated derivatives before recreating them.
- In the local APS emulator, jobs accept `svf2`, `svf`, and `thumbnail`; manifests advance lazily without timers, `x-ads-force: true` resets the job, and terminal observation emits `extraction.finished` once. The emulator returns a plausible manifest tree but never serves geometry.
- Prefer webhooks for long translations. If polling manifests, use backoff, surface child messages, and stop on failed or timed out statuses.
- Use `externalId` for persistent object references. `objectid` values are non-persistent and can change after retranslation.

## Detection Rules

- Raw object IDs used where URL-safe Base64 URNs are required.
- Zip or assembly jobs missing `rootFilename`, `compressedUrn`, `checkReferences`, or prior `references` setup.
- Tight manifest polling loops, ignored `202` responses, or missing handling for `404` manifest-not-found.
- Large property extraction using fetch-all/`forceget` instead of specific properties with pagination.
- Client Viewer token or route using broad backend scopes instead of `viewables:read`.
- Code assuming 3D SVF2 derivatives can be downloaded directly.
- Region mismatch between source storage, translation job, manifest, metadata, and Viewer configuration.

## Implementation Workflow

1. Verify the target output with `GET /modelderivative/v2/designdata/formats`; do not hardcode rare conversions.
2. Obtain or upload the source file, then convert its object ID to a URL-safe Base64 URN.
3. Start `POST /modelderivative/v2/designdata/job` with explicit output formats and region.
4. For multipart sources, set `compressedUrn/rootFilename` or call `POST /references` and use `checkReferences`.
5. Monitor `GET /manifest` or a webhook until overall and derivative statuses finish; capture warnings and errors.
6. Fetch model views, then object tree, all properties, or specific properties depending on the use case.
7. Hand Viewer only the URN and a narrow public token; keep translation and metadata tokens server-side.

## TypeScript SDK Pattern

```ts
import { SdkManagerBuilder } from '@aps_sdk/autodesk-sdkmanager'
import { ModelDerivativeClient, OutputType, View } from '@aps_sdk/model-derivative'

const sdk = SdkManagerBuilder.create().build()
const derivatives = new ModelDerivativeClient(sdk)

export async function translateForViewer(urn: string, accessToken: string, rootFilename?: string) {
  return derivatives.startJob({
    input: { urn, compressedUrn: Boolean(rootFilename), rootFilename },
    output: { formats: [{ type: OutputType.Svf2, views: [View._2d, View._3d] }] },
  }, { accessToken })
}
```

## More Detail

Use [REFERENCE.md](REFERENCE.md) for endpoint maps, job payloads, metadata/property workflows, regions, derivatives, thumbnails, rate limits, and troubleshooting.
