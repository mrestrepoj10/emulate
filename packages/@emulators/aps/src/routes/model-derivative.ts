import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import {
  derivativeObjectTree,
  derivativeProperties,
  metadataViews,
  resolveDerivative,
  type DerivativeSource,
  type MetadataView,
} from "../derivative-resources.js";
import { documentFileType } from "../dm-tree.js";
import type { ApsTranslationOutputFormat } from "../entities.js";
import { isRecordObject, jsonObjectBody, optionalString } from "../helpers.js";
import { badInput, notFound } from "../problem.js";
import { getApsStore } from "../store.js";
import { enqueueTranslation } from "../translation.js";

const THUMBNAIL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export const VIEWABLE_INPUT_FORMATS = [
  "3dm",
  "3ds",
  "3dxml",
  "a",
  "asm",
  "axm",
  "brd",
  "catpart",
  "catproduct",
  "cgr",
  "collaboration",
  "dae",
  "ddx",
  "ddz",
  "dgk",
  "dgn",
  "dlv3",
  "dmt",
  "dwf",
  "dwfx",
  "dwg",
  "dwt",
  "dxf",
  "emodel",
  "exp",
  "f3d",
  "fbrd",
  "fbx",
  "fsch",
  "g",
  "gbxml",
  "glb",
  "gltf",
  "iam",
  "idw",
  "ifc",
  "ige",
  "iges",
  "igs",
  "ipt",
  "iwm",
  "jt",
  "max",
  "model",
  "mpf",
  "msr",
  "neu",
  "nwc",
  "nwd",
  "obj",
  "osb",
  "par",
  "pdf",
  "pmlprj",
  "pmlprjz",
  "prt",
  "psm",
  "psmodel",
  "rvm",
  "rvt",
  "sab",
  "sat",
  "sch",
  "session",
  "skp",
  "sldasm",
  "sldprt",
  "smb",
  "smt",
  "ste",
  "step",
  "stl",
  "stla",
  "stlb",
  "stp",
  "stpz",
  "usd",
  "usda",
  "usdc",
  "usdz",
  "vpb",
  "vue",
  "wire",
  "x_b",
  "x_t",
  "xas",
  "xpr",
  "zip",
  "asm\\.\\d+$",
  "neu\\.\\d+$",
  "prt\\.\\d+$",
];

const SUPPORTED_FORMATS = {
  formats: {
    annotations: ["rvt"],
    dwg: ["f2d", "f3d", "rvt", "slddrw"],
    f3d: [
      "123dx",
      "3dm",
      "3mf",
      "asm",
      "atfx",
      "bdf",
      "catpart",
      "catproduct",
      "cgr",
      "dwg",
      "dxf",
      "emn",
      "fbx",
      "g",
      "iam",
      "ige",
      "iges",
      "igs",
      "ipt",
      "jt",
      "neu",
      "obj",
      "par",
      "pcbdata",
      "pcbxml",
      "prt",
      "sab",
      "sat",
      "skp",
      "sldasm",
      "sldprt",
      "smb",
      "smt",
      "sta",
      "ste",
      "step",
      "stl",
      "stp",
      "wire",
      "x_b",
      "x_t",
      "xml",
      "asm\\.\\d+$",
      "neu\\.\\d+$",
      "prt\\.\\d+$",
    ],
    fbx: ["f3d"],
    ifc: ["rvt"],
    iges: ["f3d", "fbx", "iam", "ipt", "wire"],
    obj: [
      "asm",
      "f3d",
      "fbx",
      "iam",
      "ipt",
      "neu",
      "prt",
      "sldasm",
      "sldprt",
      "smb",
      "smt",
      "step",
      "stp",
      "stpz",
      "wire",
      "x_b",
      "x_t",
      "asm\\.\\d+$",
      "neu\\.\\d+$",
      "prt\\.\\d+$",
    ],
    step: ["f3d", "fbx", "iam", "ipt", "smb", "smt", "wire"],
    stl: ["f3d", "fbx", "iam", "ipt", "wire"],
    svf: VIEWABLE_INPUT_FORMATS,
    svf2: VIEWABLE_INPUT_FORMATS,
    thumbnail: [...VIEWABLE_INPUT_FORMATS, "axmf", "dwgx", "f2d", "flbr", "fprj", "rva"],
  },
};

const PLAIN_VIEWABLE_EXTENSIONS = new Set(VIEWABLE_INPUT_FORMATS.filter((format) => /^[a-z0-9_]+$/.test(format)));
const PATTERN_VIEWABLE_EXTENSIONS = VIEWABLE_INPUT_FORMATS.filter(
  (format) => !PLAIN_VIEWABLE_EXTENSIONS.has(format),
).map((pattern) => new RegExp(`^(?:${pattern})$`, "i"));

export function isViewableInputFormat(sourceName: string): boolean {
  const basename = sourceName.split(/[\\/]/).at(-1)!.toLowerCase();
  const segments = basename.split(".");
  const candidates = segments.length < 2 ? [] : [segments.at(-1)!, segments.slice(-2).join(".")];
  return candidates.some(
    (candidate) =>
      PLAIN_VIEWABLE_EXTENSIONS.has(candidate) ||
      PATTERN_VIEWABLE_EXTENSIONS.some((pattern) => pattern.test(candidate)),
  );
}

function translationViews(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const views = value.filter((view): view is string => typeof view === "string");
  return views.length === value.length ? views : null;
}

function translationFormats(value: unknown): ApsTranslationOutputFormat[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const formats: ApsTranslationOutputFormat[] = [];
  for (const candidate of value) {
    if (!isRecordObject(candidate)) return null;
    const type = optionalString(candidate.type);
    if (type !== "svf2" && type !== "svf" && type !== "thumbnail") return null;
    const views = translationViews(candidate.views);
    if (!views) return null;
    formats.push({ type, views });
  }
  return formats;
}

export function modelDerivativeRoutes({ app, store }: RouteContext): void {
  const aps = getApsStore(store);
  const readAuth = apsAuth(store, { scopes: ["data:read"] });
  const writeAuth = apsAuth(store, { scopes: ["data:create", "data:write"] });
  const deleteAuth = apsAuth(store, { scopes: ["data:write"] });

  app.get("/modelderivative/v2/designdata/formats", readAuth, (c) => c.json(SUPPORTED_FORMATS));

  app.post("/modelderivative/v2/designdata/job", writeAuth, async (c) => {
    const body = await jsonObjectBody(c);
    const input = body && isRecordObject(body.input) ? body.input : null;
    const output = body && isRecordObject(body.output) ? body.output : null;
    const urn = input ? optionalString(input.urn) : undefined;
    const formats = translationFormats(output?.formats);
    if (!urn) return badInput(c, "input.urn", "input.urn is required.");
    if (!formats) return badInput(c, "output.formats", "At least one svf2, svf, or thumbnail output is required.");
    let objectId: string;
    try {
      objectId = Buffer.from(urn, "base64url").toString("utf8");
    } catch {
      return badInput(c, "input.urn", "input.urn must be a base64url-encoded storage object ID.");
    }
    const storage = aps.storageObjects.findOneBy("object_id", objectId);
    if (!storage || !storage.uploaded_at) return notFound(c, "The source storage object");
    // A compressed archive translates its root design file, matching real
    // Model Derivative's compressedUrn + rootFilename contract.
    const compressed = input.compressedUrn === true;
    const rootFilename = optionalString(input.rootFilename);
    if (compressed && !rootFilename) {
      return badInput(c, "input.rootFilename", "rootFilename is required when compressedUrn is true.");
    }
    const sourceName = compressed && rootFilename ? rootFilename : storage.name;
    if (!isViewableInputFormat(sourceName)) {
      return badInput(c, "input.urn", `The .${documentFileType(sourceName)} source format is not viewable.`);
    }
    const force = c.req.header("x-ads-force")?.toLowerCase() === "true";
    const result = enqueueTranslation(aps, store, {
      urn,
      sourceName,
      outputFormats: formats,
      force,
    });
    return c.json(
      {
        result: result.created ? "created" : "success",
        urn,
        acceptedJobs: { output: formats.map((format) => ({ destination: { region: "us" }, formats: [format] })) },
      },
      result.created ? 201 : 200,
    );
  });

  app.get("/modelderivative/v2/designdata/:urn/manifest", readAuth, async (c) => {
    const derivative = await resolveDerivative(aps, store, c.req.param("urn"));
    return derivative.state === "missing" ? c.body(null, 404) : c.json(derivative.manifest);
  });

  app.delete("/modelderivative/v2/designdata/:urn/manifest", deleteAuth, (c) => {
    const urn = c.req.param("urn");
    const job = aps.translationJobs.findOneBy("urn", urn);
    const manifest = aps.manifests.findOneBy("urn", urn);
    if (job) aps.translationJobs.delete(job.id);
    if (manifest) aps.manifests.delete(manifest.id);
    return c.json({ result: "success" });
  });

  const inspectionRoute = (
    path: string,
    handler: (c: Context<AppEnv>, source: DerivativeSource) => Response | Promise<Response>,
  ) =>
    app.get(path, readAuth, async (c) => {
      const derivative = await resolveDerivative(aps, store, c.req.param("urn"));
      if (derivative.state === "pending") return c.body(null, 202, { "Retry-After": "1" });
      if (derivative.state !== "success") return notFound(c, "The requested derivative");
      return handler(c, derivative.source);
    });

  const viewForRequest = (c: Context<AppEnv>, source: DerivativeSource): MetadataView | undefined =>
    metadataViews(aps, source).find((candidate) => candidate.guid === c.req.param("guid"));

  inspectionRoute("/modelderivative/v2/designdata/:urn/thumbnail", () => {
    return new Response(THUMBNAIL_PNG, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(THUMBNAIL_PNG.length),
      },
    });
  });

  inspectionRoute("/modelderivative/v2/designdata/:urn/metadata", (c, source) =>
    c.json({
      data: {
        type: "metadata",
        metadata: metadataViews(aps, source),
      },
    }),
  );

  inspectionRoute("/modelderivative/v2/designdata/:urn/metadata/:guid", (c, source) => {
    const view = viewForRequest(c, source);
    if (!view) return notFound(c, "The requested model view");
    return c.json({
      data: {
        type: "objects",
        objects: derivativeObjectTree(source, view),
      },
    });
  });

  inspectionRoute("/modelderivative/v2/designdata/:urn/metadata/:guid/properties", (c, source) => {
    const view = viewForRequest(c, source);
    if (!view) return notFound(c, "The requested model view");
    const objectIdValue = c.req.query("objectid");
    if (objectIdValue !== undefined && (!/^\d+$/.test(objectIdValue) || Number(objectIdValue) < 1)) {
      return badInput(c, "objectid", "objectid must be a positive integer.");
    }
    const properties = derivativeProperties(source, view, derivativeObjectTree(source, view)).filter(
      (entry) => objectIdValue === undefined || entry.objectid === Number(objectIdValue),
    );
    return c.json({
      data: {
        type: "properties",
        collection: properties,
      },
    });
  });
}
