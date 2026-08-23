---
name: aps-data-management
description: Autodesk Platform Services (APS) Data Management and OSS guidance for hubs, projects, folders, items, versions, app-managed buckets, uploads, downloads, permissions, refs, commands, filtering, and pagination. Use when browsing ACC/BIM 360/Fusion project data, creating folders/items/versions, uploading or downloading files, managing OSS buckets/objects, using signed S3 URLs, checking permissions, publishing C4R models, or troubleshooting APS Data API workflows.
metadata:
  priority: 7
  docs:
    - "https://aps.autodesk.com/en/docs/data/v2"
    - "https://aps.autodesk.com/en/docs/data/v2/reference/http"
    - "https://aps.autodesk.com/en/docs/data/v2/reference/typescript-sdk-dm"
    - "https://aps.autodesk.com/en/docs/data/v2/reference/typescript-sdk-oss"
    - "https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/datamanagement/datamanagement.yaml"
    - "https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/oss/oss.yaml"
  pathPatterns:
    - "**/data-management/**"
    - "**/oss/**"
    - "**/services/aps.*"
  importPatterns:
    - "@aps_sdk/data-management"
    - "@aps_sdk/oss"
    - "@aps_sdk/autodesk-sdkmanager"
  promptSignals:
    phrases:
      - "data management"
      - "oss bucket"
      - "signed s3"
      - "checkpermission"
    minScore: 5
---

# APS Data Management
You are an expert in APS Data Management and OSS. Keep project data, app-owned storage, user context, JSON:API payloads, signed URLs, and Model Derivative handoff separate and explicit.

## Flow Picker

| Need | Use |
| --- | --- |
| Browse ACC, BIM 360, Fusion, or A360 data | Hubs, projects, top folders, folder contents, item tip, and versions |
| Upload to ACC/BIM 360 Docs | Create project storage, upload to the returned OSS object, then create an item or version |
| Store app-owned files | OSS buckets/objects with 2-legged auth, region, bucket policy, and signed S3 transfer |
| Download project files | Resolve item/version/storage, then use OSS signed S3 download or Data Management download jobs |
| Search or filter contents | Folder contents for one level; folder search for recursive 3-legged search |
| Manage relationships | Refs and relationship endpoints for derived, dependencies, auxiliary, xrefs, and includes |
| Check permissions or publish Revit cloud models | Execute Data Management commands such as CheckPermission, ListItems, ListRefs, and C4R publish |

## Rules

- Use `aps-auth` for tokens. User project data usually needs 3-legged auth; 2-legged access requires app provisioning and often `x-user-id` to act for one allowed user.
- Use app-owned OSS buckets only for application storage. For ACC/BIM 360 Docs uploads, do not create buckets; call `POST /data/v1/projects/{project_id}/storage`.
- Convert ACC/BIM 360 account and project UUIDs to Data Management IDs by prefixing `b.` when using hub or project routes.
- URL-encode URN path parameters such as folder, item, and version IDs. Keep IDs raw inside JSON payload fields when the endpoint says so.
- Send Data Management create/update bodies as JSON:API, usually `application/vnd.api+json`.
- Always paginate list calls with `page[number]` and `page[limit]`; the Data Management max page size is `200`.
- Use `filter[...]` parameters instead of fetching full folder trees when the API supports the desired filter.
- Treat OSS signed S3 URLs as short-lived. Persist `uploadKey` for retries and always complete the upload, even for a single signed URL.
- In the local APS emulator, use project storage plus `signeds3upload`; the deprecated direct OSS object PUT is intentionally unavailable. Signed part PUTs need no bearer token, uploaded bytes reset with emulator state, and the default object cap is 25 MB. Finalized objects support `signeds3download`, whose signed GET URL returns the exact stored bytes and content length.
- Local recursive folder search requires a 3-legged `data:read` token and returns descendant items with tip versions in `included`. Real APS commonly also requires `data:search`, so keep that scope in production integrations.
- Choose bucket policy deliberately: `transient` for 24 hours, `temporary` for 30 days, `persistent` until deletion.
- Preserve region consistency between OSS storage, Data Management storage, Model Derivative translation, and Viewer configuration.
- For Model Derivative handoff, convert the final OSS object ID to a URL-safe Base64 URN; do not pass raw object IDs.

## Detection Rules

- Code creates `/oss/v2/buckets` for ACC/BIM 360 Docs instead of project storage.
- ACC/BIM 360 account or project UUIDs are passed without the required `b.` prefix.
- Folder/item/version URNs appear unencoded in URL path segments.
- Upload code PUTs to signed S3 but never calls complete upload, or discards `uploadKey`.
- 2-legged ACC/BIM 360 calls omit app provisioning, `x-user-id`, or permission checks.
- Recursive browsing loops ignore pagination, filters, 429 backoff, or 423 locked resources.
- Public routes expose `bucket:*`, `data:create`, `data:write`, broad signed URLs, or raw APS tokens.
- BIM 360/ACC code depends on item `displayName` updates or version rename patches that are not supported there.
- Download job code ignores `202` startup, `303` completion redirects, or empty available-download responses.

## Implementation Workflow

1. Identify whether the file lives in user project data or app-owned OSS.
2. Choose token flow and minimum scopes: `data:read`, `data:create`, `data:write`, `data:search`, or `bucket:*` only as needed.
3. For project data, discover hub, project, top folder, folder contents, item, and version with pagination and filters.
4. For uploads, create storage, request signed S3 parts, PUT every raw part, complete with `uploadKey`, then create the item or new version. The local emulator emits `dm.version.added` automatically.
5. For downloads, resolve the version and storage object, request a signed S3 download, or create a format download job. Local signed GET targets need no bearer token and expire with their URL signature.
6. Use commands for permissions, bulk item/ref lookup, and C4R publish workflows.
7. Hand other APS skills only the narrow artifact they need: project IDs, folder/item/version IDs, object IDs, or Base64 derivative URNs.

## TypeScript SDK Pattern

```ts
import { SdkManagerBuilder } from '@aps_sdk/autodesk-sdkmanager'
import { DataManagementClient } from '@aps_sdk/data-management'
import { OssClient } from '@aps_sdk/oss'

const sdk = SdkManagerBuilder.create().build()
const data = new DataManagementClient(sdk)
const oss = new OssClient(sdk)

export const listTopFolders = async (hubId: string, projectId: string, accessToken: string) =>
  (await data.getProjectTopFolders(hubId, projectId, { accessToken })).data

export const uploadAppObject = (bucketKey: string, objectKey: string, filePath: string, accessToken: string) =>
  oss.upload(bucketKey, objectKey, filePath, accessToken)
```

More detail: use [REFERENCE.md](REFERENCE.md) for endpoint maps, upload/download payloads, OSS transfer rules, pagination/filtering, commands, refs, regions, errors, and cross-skill routing.
