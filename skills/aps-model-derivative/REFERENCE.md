# APS Model Derivative Reference

## Official Docs

- Model Derivative overview: https://aps.autodesk.com/developer/overview/model-derivative-api
- OAuth scopes and tokens: https://aps.autodesk.com/en/docs/oauth/v2/developers_guide/scopes
- Model Derivative v2 docs: https://aps.autodesk.com/en/docs/model-derivative/v2
- Developer guide: https://aps.autodesk.com/en/docs/model-derivative/v2/developers_guide
- HTTP reference: https://aps.autodesk.com/en/docs/model-derivative/v2/reference/http
- TypeScript SDK reference: https://aps.autodesk.com/en/docs/model-derivative/v2/reference/typescript-sdk
- OpenAPI spec: https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/modelderivative/modelderivative.yaml
- Simple Viewer data/derivatives tutorial: https://get-started.aps.autodesk.com/tutorials/simple-viewer/data/
- New Node.js SDK migration: https://aps.autodesk.com/blog/migrating-new-aps-nodejs-sdk-0

## Endpoint Map

Use `https://developer.api.autodesk.com` as the API host.

| Operation | Method and path | Notes |
| --- | --- | --- |
| List supported formats | `GET /modelderivative/v2/designdata/formats` | Use before uncommon conversions. |
| Create translation job | `POST /modelderivative/v2/designdata/job` | Creates or reuses derivatives; `201` can mean the derivative already exists. |
| Specify references | `POST /modelderivative/v2/designdata/{urn}/references` | Use before jobs with referenced files/xrefs; combine with `checkReferences`. |
| Fetch manifest | `GET /modelderivative/v2/designdata/{urn}/manifest` | Main status and derivative registry. |
| Delete manifest | `DELETE /modelderivative/v2/designdata/{urn}/manifest` | Deletes generated derivatives, not the source file. |
| List model views | `GET /modelderivative/v2/designdata/{urn}/metadata` | Returns view GUIDs for 2D/3D views. |
| Fetch object tree | `GET /modelderivative/v2/designdata/{urn}/metadata/{modelGuid}` | Supports object subtree and limited depth. |
| Fetch all properties | `GET /modelderivative/v2/designdata/{urn}/metadata/{modelGuid}/properties` | Can be large; prefer specific query when possible. |
| Fetch specific properties | `POST /modelderivative/v2/designdata/{urn}/metadata/{modelGuid}/properties:query` | Query, fields, and pagination. |
| Fetch thumbnail | `GET /modelderivative/v2/designdata/{urn}/thumbnail` | Width/height values are `100`, `200`, or `400`. |
| Fetch derivative URL | `GET /modelderivative/v2/designdata/{urn}/manifest/{derivativeUrn}/signedcookies` | Signed cookies allow secure derivative downloads. |
| Check derivative details | `HEAD /modelderivative/v2/designdata/{urn}/manifest/{derivativeUrn}` | Use `Content-Length` and `Range` for large downloads. |

## Job Payloads

Minimal Viewer translation:

```json
{
  "input": {
    "urn": "<url-safe-base64-source-urn>"
  },
  "output": {
    "formats": [
      {
        "type": "svf2",
        "views": ["2d", "3d"]
      }
    ]
  }
}
```

Zip source with a root file:

```json
{
  "input": {
    "urn": "<url-safe-base64-source-urn>",
    "compressedUrn": true,
    "rootFilename": "model.rvt"
  },
  "output": {
    "formats": [{ "type": "svf2", "views": ["2d", "3d"] }]
  }
}
```

Referenced-file workflows have two valid patterns:

- Package the design and references in a zip, then set `compressedUrn: true` and `rootFilename`.
- Call `POST /references` to record referenced file locations, then start the job with `checkReferences: true`.

Use `x-ads-force: true` only when intentionally replacing all previous derivatives for the source design.

## Output Formats

- `svf2`: preferred output for modern Viewer workflows.
- `svf`: legacy Viewer compatibility and workflows that depend on SVF object IDs or downloadable SVF artifacts.
- `thumbnail`: preview image output; thumbnails can also be fetched separately.
- `obj`, `stl`, `step`, `iges`, `dwg`, `ifc`: export workflows. Always verify the source/target pair with supported formats first.

Advanced options are source-format specific. Examples from the current spec include IFC conversion method, Revit extractor version/material mode, DWG/RVT 2D view handling, OBJ units, STL binary/ascii and file structure, STEP application protocol, and IGES body/surface options.

## Regions

Model Derivative uses a `region` header for where manifests and derivatives are stored. Common values in the current spec include `US`, `EMEA`, `AUS`, `CAN`, `DEU`, `IND`, `JPN`, and `GBR`.

Use the same region for:

- Translation job creation.
- Manifest polling.
- Metadata/property calls.
- Thumbnail calls.
- Derivative signed-cookie/download calls.
- Viewer environment/API configuration where applicable.

## Manifest Workflow

After creating a job:

1. `GET /manifest` until the manifest exists and the overall status is terminal.
2. Inspect each derivative, not just the top-level status.
3. Surface `messages` from derivatives/children to callers; they often contain the useful failure reason.
4. Treat `success`, `failed`, and `timedout` as terminal job statuses.
5. Prefer webhooks for long-running production translations; use polling with backoff only when webhooks are not available.

The manifest is a registry for all derivatives of a source design. New translations update the same manifest instead of creating a separate manifest.

## Rate Limits and Retries

- Do not poll manifests, properties, or thumbnails in a tight loop.
- Back off on `202` and `429`; honor retry/rate-limit headers when present.
- Use webhooks for production translation-complete notifications instead of long-running polling loops.
- Cache successful status/results where appropriate; do not restart jobs just to check state.
- Avoid concurrent duplicate jobs for the same source URN and output format unless `x-ads-force` is intentional.

## Metadata and Properties

Metadata workflow:

1. Ensure the source has been translated to `svf` or `svf2`.
2. Call `GET /metadata` to list model views.
3. Pick a view GUID.
4. Call object tree, all properties, or specific properties.

Rules:

- `objectid` is assigned at translation time and can change after retranslation.
- Use `externalId` for durable links to model objects when available.
- Use `properties:query` with `fields`, `query`, and `pagination` for large models.
- `forceget=true` can retrieve resources over the normal 20 MB limit, but exceptionally large resources can still be refused. Do not make it the default.
- Use `x-ads-derivative-format: fallback` only for BIM 360/ACC legacy SVF/SVF2 object ID compatibility, and use it consistently across job, object tree, and property calls for the same derivative.

Example specific properties request:

```json
{
  "query": { "$in": ["objectid", 4269, 438] },
  "fields": ["objectid", "name", "externalId", "properties.Cons*"],
  "pagination": { "offset": 0, "limit": 20 },
  "payload": "text"
}
```

## Derivative Downloads

Use the manifest to discover derivative URNs. For downloadable derivatives:

- `HEAD /manifest/{derivativeUrn}` checks size and readiness.
- `GET /manifest/{derivativeUrn}/signedcookies` returns a download URL and signed cookies.
- Use range requests for large derivatives.
- Do not build download URLs by guessing manifest child paths.

Important limitation: the current official spec states that 3D SVF2 derivatives cannot be downloaded directly. For Viewer workflows, keep the derivative hosted by APS and load it through Viewer with a narrow token.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Job returns `201` | Derivative already exists; fetch manifest instead of assuming no work happened. |
| Manifest `404` | Job not started, wrong URN, wrong region, or source was never translated. |
| Manifest stuck/incomplete | Poll with backoff, inspect child statuses/messages, consider webhook delivery. |
| Translation fails for zip/assembly | Missing root filename, missing `compressedUrn`, unresolved references, wrong source layout. |
| Metadata/properties `202` | Property extraction is still processing; retry with backoff. |
| Properties response too large | Use `properties:query`, pagination, narrower fields, or object-specific reads. |
| Viewer cannot load | Job incomplete/failed, wrong URN, wrong region, missing `viewables:read`, or Viewer env/API mismatch. |
| Object links break after retranslation | Code used `objectid`; use `externalId` or a format-specific persistent identifier. |
| Download fails | Derivative is not downloadable, derivative URN not URL-encoded, cookies expired, or region mismatch. |

## Cross-Skill Routing

- Use `aps-auth` for 2-legged/3-legged tokens, Viewer-safe public tokens, and scope selection.
- Use `aps-data-management` for OSS buckets, object upload, ACC/Fusion hubs, projects, folders, items, and versions.
- Use `aps-viewer` for Viewer initialization, token callbacks, loading URNs, and SVF2 Viewer settings.
- Use `aps-webhooks` for production translation-complete notifications.
