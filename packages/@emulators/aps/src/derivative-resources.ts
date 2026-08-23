import { createHash } from "node:crypto";
import type { Store } from "@emulators/core";
import type { ApsDocumentVersion, ApsManifestDerivative } from "./entities.js";
import { manifestForJob, refreshTranslationJob } from "./translation.js";
import type { ApsStore } from "./store.js";

export interface DerivativeManifest {
  type: string;
  hasThumbnail: string;
  status: string;
  progress: string;
  region: string;
  urn: string;
  version: string;
  derivatives: ApsManifestDerivative[];
}

export interface DerivativeSource {
  urn: string;
  name: string;
  version?: ApsDocumentVersion;
}

export type ResolvedDerivative =
  | { state: "missing" }
  | { state: "pending" | "failed" | "success"; manifest: DerivativeManifest; source: DerivativeSource };

export interface MetadataView {
  name: string;
  role: "2d" | "3d";
  guid: string;
}

export interface DerivativeObject {
  objectid: number;
  name: string;
  category: string;
  objects?: DerivativeObject[];
}

export function stableDerivativeGuid(value: string): string {
  const digest = createHash("sha1").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function sourceForUrn(aps: ApsStore, urn: string, jobName?: string): DerivativeSource {
  const version = aps.documentVersions.findBy("bubble_urn", urn)[0];
  if (version) return { urn, name: version.display_name, version };
  let objectId = "";
  try {
    objectId = Buffer.from(urn, "base64url").toString("utf8");
  } catch {
    objectId = "";
  }
  const storage = objectId ? aps.storageObjects.findOneBy("object_id", objectId) : undefined;
  return { urn, name: jobName ?? storage?.name ?? "model" };
}

export async function resolveDerivative(aps: ApsStore, store: Store, urn: string): Promise<ResolvedDerivative> {
  const job = aps.translationJobs.findOneBy("urn", urn);
  let manifest: DerivativeManifest | undefined;
  if (job) {
    manifest = manifestForJob(await refreshTranslationJob(aps, store, job));
  } else {
    const seeded = aps.manifests.findOneBy("urn", urn);
    if (seeded) {
      manifest = {
        type: seeded.type,
        hasThumbnail: seeded.hasThumbnail,
        status: seeded.status,
        progress: seeded.progress,
        region: seeded.region,
        urn: seeded.urn,
        version: seeded.version,
        derivatives: seeded.derivatives,
      };
    }
  }
  if (!manifest) return { state: "missing" };
  const source = sourceForUrn(aps, urn, job?.source_name);
  if (manifest.status === "pending" || manifest.status === "inprogress") {
    return { state: "pending", manifest, source };
  }
  return { state: manifest.status === "success" ? "success" : "failed", manifest, source };
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function metadataViews(aps: ApsStore, source: DerivativeSource): MetadataView[] {
  const version = source.version;
  const threeDimensional: MetadataView = {
    name: version?.display_name ?? source.name,
    role: "3d",
    guid: version?.viewable_guid ?? stableDerivativeGuid(`${source.urn}:3d`),
  };
  if (!version) return [threeDimensional];
  const sheet = aps.sheets.findBy("project_id", version.project_id).find((candidate) => {
    const viewable = candidate.payload.viewable;
    const viewableUrn =
      typeof viewable === "object" && viewable !== null
        ? stringProperty((viewable as Record<string, unknown>).urn)
        : undefined;
    return (
      stringProperty(candidate.payload.uploadFileName) === version.display_name ||
      viewableUrn === version.bubble_urn ||
      viewableUrn === version.storage_urn
    );
  });
  if (!sheet) return [threeDimensional];
  const viewable = sheet.payload.viewable;
  const configuredGuid =
    typeof viewable === "object" && viewable !== null
      ? stringProperty((viewable as Record<string, unknown>).guid)
      : undefined;
  return [
    threeDimensional,
    {
      name: `${sheet.number} - ${sheet.title}`,
      role: "2d",
      guid: configuredGuid ?? stableDerivativeGuid(`${source.urn}:2d:${sheet.sheet_id}`),
    },
  ];
}

function baseObjectId(urn: string, guid: string): number {
  return Number.parseInt(createHash("sha1").update(`${urn}:${guid}`).digest("hex").slice(0, 7), 16) + 1;
}

export function derivativeObjectTree(source: DerivativeSource, view: MetadataView): DerivativeObject[] {
  const first = baseObjectId(source.urn, view.guid);
  return [
    {
      objectid: first,
      name: source.name,
      category: "Model",
      objects: [
        {
          objectid: first + 1,
          name: view.role === "2d" ? "Sheets" : "Model Elements",
          category: "Category",
          objects: [
            {
              objectid: first + 2,
              name: `${source.name} Family`,
              category: "Family",
              objects: [
                { objectid: first + 3, name: `${source.name} Instance 1`, category: "Instance" },
                { objectid: first + 4, name: `${source.name} Instance 2`, category: "Instance" },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function flattenDerivativeObjects(objects: DerivativeObject[]): DerivativeObject[] {
  return objects.flatMap((object) => [object, ...flattenDerivativeObjects(object.objects ?? [])]);
}

export function derivativeProperties(source: DerivativeSource, view: MetadataView, objects: DerivativeObject[]) {
  return flattenDerivativeObjects(objects).map((object) => ({
    objectid: object.objectid,
    name: object.name,
    externalId: stableDerivativeGuid(`${source.urn}:${view.guid}:${object.objectid}`),
    properties: {
      "Identity Data": { Name: object.name, Category: object.category },
      Emulate: { "Source URN": source.urn, "View GUID": view.guid },
    },
  }));
}
