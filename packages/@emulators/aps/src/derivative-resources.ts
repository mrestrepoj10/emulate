import { createHash } from "node:crypto";
import type { Store } from "@emulators/core";
import type { ApsDocumentVersion } from "./entities.js";
import { stableDerivativeGuid } from "./helpers.js";
import { manifestForJob, refreshTranslationJob, type DerivativeManifest } from "./translation.js";
import type { ApsStore } from "./store.js";

export type { DerivativeManifest } from "./translation.js";

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

function sourceForUrn(aps: ApsStore, urn: string, jobName?: string): DerivativeSource {
  const version = aps.documentVersions.findBy("bubble_urn", urn)[0];
  if (version) return { urn, name: version.display_name, version };
  const objectId = Buffer.from(urn, "base64url").toString("utf8");
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
      const { id: _id, created_at: _created, updated_at: _updated, ...fields } = seeded;
      manifest = fields;
    }
  }
  if (!manifest) return { state: "missing" };
  const source = sourceForUrn(aps, urn, job?.source_name);
  if (manifest.status === "pending" || manifest.status === "inprogress") {
    return { state: "pending", manifest, source };
  }
  return { state: manifest.status === "success" ? "success" : "failed", manifest, source };
}

export function metadataViews(aps: ApsStore, source: DerivativeSource): MetadataView[] {
  const version = source.version;
  const threeDimensional: MetadataView = {
    name: version?.display_name ?? source.name,
    role: "3d",
    guid: version?.viewable_guid ?? stableDerivativeGuid(`${source.urn}:3d`),
  };
  if (!version) return [threeDimensional];
  const sheet = aps.sheets
    .findBy("project_id", version.project_id)
    .find(
      (candidate) =>
        candidate.upload_file_name === version.display_name ||
        (candidate.viewable_urn !== "" &&
          (candidate.viewable_urn === version.bubble_urn || candidate.viewable_urn === version.storage_urn)),
    );
  if (!sheet) return [threeDimensional];
  return [
    threeDimensional,
    {
      name: `${sheet.number} - ${sheet.title}`,
      role: "2d",
      guid: sheet.viewable_guid || stableDerivativeGuid(`${source.urn}:2d:${sheet.sheet_id}`),
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
