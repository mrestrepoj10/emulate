# APS Data Management Reference

## Official Docs

- Data Management overview: https://aps.autodesk.com/developer/overview/data-management-api
- Data Management v2 docs: https://aps.autodesk.com/en/docs/data/v2
- HTTP reference: https://aps.autodesk.com/en/docs/data/v2/reference/http
- TypeScript Data Management SDK: https://aps.autodesk.com/en/docs/data/v2/reference/typescript-sdk-dm
- TypeScript OSS SDK: https://aps.autodesk.com/en/docs/data/v2/reference/typescript-sdk-oss
- OpenAPI Data Management: https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/datamanagement/datamanagement.yaml
- OpenAPI OSS: https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/oss/oss.yaml

## Service Split

Data Management has two closely related surfaces:

- Project/Data Service: hubs, projects, top folders, folders, items, versions, refs, commands, and project storage placeholders.
- OSS: app-owned buckets, raw objects, bucket policies, signed OSS URLs, signed S3 uploads/downloads, and object metadata.

Use project/data routes for ACC, BIM 360 Docs, Fusion Team, A360, or user-visible project data. Use OSS buckets for application-owned storage and temporary files.

## Endpoint Map

| Area | Endpoint | Purpose |
| --- | --- | --- |
| Hubs | `GET /project/v1/hubs` | List hubs visible to the app/user |
| Hubs | `GET /project/v1/hubs/{hub_id}` | Get hub details |
| Projects | `GET /project/v1/hubs/{hub_id}/projects` | List projects in a hub |
| Projects | `GET /project/v1/hubs/{hub_id}/projects/{project_id}` | Get project details |
| Projects | `GET /project/v1/hubs/{hub_id}/projects/{project_id}/topFolders` | List accessible root folders |
| Folders | `GET /data/v1/projects/{project_id}/folders/{folder_id}` | Get folder |
| Folders | `PATCH /data/v1/projects/{project_id}/folders/{folder_id}` | Rename, move, hide, or restore folder |
| Folders | `GET /data/v1/projects/{project_id}/folders/{folder_id}/contents` | List immediate folder contents |
| Folders | `GET /data/v1/projects/{project_id}/folders/{folder_id}/search` | Search recursively; requires 3-legged `data:search` |
| Items | `GET /data/v1/projects/{project_id}/items/{item_id}` | Get item and included tip version |
| Items | `GET /data/v1/projects/{project_id}/items/{item_id}/tip` | Get latest version |
| Items | `GET /data/v1/projects/{project_id}/items/{item_id}/versions` | List versions |
| Versions | `GET /data/v1/projects/{project_id}/versions/{version_id}` | Get version |
| Upload | `POST /data/v1/projects/{project_id}/storage` | Create storage placeholder |
| Upload | `POST /data/v1/projects/{project_id}/items` | Create first item version |
| Upload | `POST /data/v1/projects/{project_id}/versions` | Create new version |
| Download | `GET /data/v1/projects/{project_id}/versions/{version_id}/downloadFormats` | List convertible download formats |
| Download | `POST /data/v1/projects/{project_id}/downloads` | Start a download-format job |
| Download | `GET /data/v1/projects/{project_id}/jobs/{job_id}` | Poll job; `303` points to finished download |
| Commands | `POST /data/v1/projects/{project_id}/commands` | Execute CheckPermission, ListItems, ListRefs, C4R publish |
| OSS Buckets | `GET/POST /oss/v2/buckets` | List or create app-owned buckets |
| OSS Objects | `GET /oss/v2/buckets/{bucketKey}/objects` | List bucket objects |
| OSS Objects | `GET /oss/v2/buckets/{bucketKey}/objects/{objectKey}/signeds3upload` | Generate upload URLs |
| OSS Objects | `POST /oss/v2/buckets/{bucketKey}/objects/{objectKey}/signeds3upload` | Complete upload |
| OSS Objects | `GET /oss/v2/buckets/{bucketKey}/objects/{objectKey}/signeds3download` | Generate download URL |
| OSS Batch | `POST /oss/v2/buckets/{bucketKey}/objects/batchsigneds3upload` | Batch upload URLs |
| OSS Batch | `POST /oss/v2/buckets/{bucketKey}/objects/batchcompleteupload` | Complete batch uploads |
| OSS Batch | `POST /oss/v2/buckets/{bucketKey}/objects/batchsigneds3download` | Batch download URLs |

## Auth and Scopes

Use `aps-auth` to implement tokens.

- Project reads: `data:read`
- Project writes: `data:create` for new folders/items/versions/storage, `data:write` for updates
- Recursive folder search: 3-legged `data:read data:search`
- OSS buckets: `bucket:create`, `bucket:read`, `bucket:delete`, and sometimes `bucket:update`
- OSS object upload: `data:create data:write`
- OSS object download: `data:read`

For ACC/BIM 360 Docs with 2-legged auth, verify the app is provisioned and use `x-user-id` when the call must act for one allowed user. A 3-legged token derives the user from the token.

## ID and Encoding Rules

- ACC/BIM 360 account and project UUIDs need the `b.` prefix in Data Management hub/project IDs.
- Folder IDs, item IDs, and version IDs are often URNs. URL-encode them in path segments.
- Some payload fields require raw IDs. For example, a create-download payload source version ID is raw, not URL-encoded.
- The storage response returns an OSS object ID such as `urn:adsk.objects:os.object:bucket/key`. Save it.
- For Model Derivative, convert the OSS object ID to URL-safe Base64 before calling derivative endpoints.

## Upload to ACC/BIM 360 Docs

1. Browse to the target folder using hubs, projects, top folders, and folder contents.
2. Create a storage placeholder:

```json
{
  "jsonapi": { "version": "1.0" },
  "data": {
    "type": "objects",
    "attributes": { "name": "drawing.dwg" },
    "relationships": {
      "target": {
        "data": { "type": "folders", "id": "urn:adsk.wipprod:dm.folder:..." }
      }
    }
  }
}
```

3. Upload the binary to the returned OSS object. The SDK `oss.upload(...)` helper wraps signed S3 URL generation, transfer, and completion.
4. Create the first item with `POST /items`, or create a later version with `POST /versions`.
5. On `409` from item creation, inspect the existing item and create a version instead.

For BIM 360/ACC extension types, prefer `folders:autodesk.bim360:Folder`, `items:autodesk.bim360:File`, and `versions:autodesk.bim360:File`. For other services, use the documented core extension types.

### Create First Item Shape

```json
{
  "jsonapi": { "version": "1.0" },
  "data": {
    "type": "items",
    "attributes": {
      "displayName": "drawing.dwg",
      "extension": { "type": "items:autodesk.core:File", "version": "1.0" }
    },
    "relationships": {
      "tip": { "data": { "type": "versions", "id": "1" } },
      "parent": { "data": { "type": "folders", "id": "urn:adsk.wipprod:dm.folder:..." } }
    }
  },
  "included": [
    {
      "type": "versions",
      "id": "1",
      "attributes": {
        "name": "drawing.dwg",
        "extension": { "type": "versions:autodesk.core:File", "version": "1.0" }
      },
      "relationships": {
        "storage": {
          "data": {
            "type": "objects",
            "id": "urn:adsk.objects:os.object:bucket/object.dwg"
          }
        }
      }
    }
  ]
}
```

## App-Owned OSS Uploads

Use OSS buckets when the app owns the storage.

- Bucket keys are globally unique, lowercase, 3-128 chars, and immutable.
- Policies: `transient` keeps objects 24 hours, `temporary` keeps them 30 days, `persistent` keeps them until deletion.
- Region values include `US`, `EMEA`, `AUS`, `APAC`, `CAN`, `DEU`, `IND`, `JPN`, and `GBR`; beta regions should not be used for production.
- Signed S3 URLs default to 2 minutes and can be requested for 1-60 minutes. Start transfer before expiry.
- If requesting signed S3 upload URLs, call complete upload afterward even for one part.
- Keep `uploadKey` for retries or chunk continuation.
- For batch complete, at most 25 objects can be completed in one request.

Minimal complete-upload body:

```json
{
  "uploadKey": "returned-upload-key"
}
```

Include `eTags`, `size`, and metadata headers when the workflow needs validation or saved content metadata.

## Downloads

For project files, normally resolve the item tip or target version, then obtain the storage object and create a signed S3 download URL from OSS. Use range requests for large files when needed.

For alternative download formats:

1. `GET /versions/{version_id}/downloadFormats`
2. `POST /downloads` with the raw version ID and format.
3. Poll `GET /jobs/{job_id}` with backoff.
4. A finished job returns HTTP `303` with a `Location` header pointing to the download details.

Do not rely on `GET /versions/{version_id}/downloads` alone; the spec notes it is not fully implemented and can return an empty data object.

## Filtering, Search, and Pagination

- Use `page[number]` and `page[limit]`; page numbers are 0-based and `page[limit]` maxes at `200`.
- `GET /folders/{folder_id}/contents` lists one level and includes tip versions for returned items.
- `GET /folders/{folder_id}/search` searches descendants and requires 3-legged `data:read data:search`.
- Supported filter families include `filter[id]`, `filter[name]`, `filter[type]`, `filter[extension.type]`, `filter[versionNumber]`, `filter[lastModifiedTimeRollup]`, `filter[refType]`, and `filter[direction]`.
- Use `includeHidden`, `excludeDeleted`, and `filter[hidden]` intentionally for BIM 360 Docs delete/restore flows.

## Commands

`POST /data/v1/projects/{project_id}/commands` accepts command payloads:

- `commands:autodesk.core:CheckPermission`
- `commands:autodesk.core:ListItems`
- `commands:autodesk.core:ListRefs`
- `commands:autodesk.bim360:C4RModelPublish`
- `commands:autodesk.bim360:C4RPublishWithoutLinks`
- `commands:autodesk.bim360:C4RModelGetPublishJob`

Use CheckPermission before write, upload, delete, or admin actions where user access is uncertain.

## Relationships and Xrefs

Folders, items, and versions support related resources and custom relationship endpoints. Version payloads can include `refs` for xrefs. Ref types include `derived`, `dependencies`, `auxiliary`, `xrefs`, and `includes`; directions include `from` and `to`. For core xrefs, nested behavior is represented by `attachment` or `overlay`.

## Error Handling

- `401`: expired or invalid token.
- `403`: missing scopes, app not provisioned, user lacks access, or wrong auth context.
- `404`: ID not found, wrong hub/project prefix, region mismatch, or missing object/bucket.
- `409`: name/key conflict, item already exists, bucket deletion conflict, or in-progress process.
- `423`: locked project resource.
- `429`: rate limited; back off with jitter and honor retry headers when present.
- `303`: download job completed; follow the `Location` header.

## Cross-Skill Routing

- Use `aps-auth` for OAuth flows, scope minimization, token refresh, and public/private token separation.
- Use `aps-model-derivative` after upload when translating an OSS object ID into Viewer SVF/SVF2, metadata, properties, thumbnails, or derivatives.
- Use a future `aps-viewer` skill for browser Viewer token routes and model loading.
- Use a future `aps-webhooks` skill for Data Management or Model Derivative event subscriptions.
