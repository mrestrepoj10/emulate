import type { RouteContext } from "@emulators/core";
import { apsAuth } from "../auth.js";
import { documentFileType } from "../dm-tree.js";
import type { ApsTranslationOutputFormat } from "../entities.js";
import { isRecordObject, jsonObjectBody, optionalString } from "../helpers.js";
import { badInput, notFound } from "../problem.js";
import { getApsStore } from "../store.js";
import { enqueueTranslation, manifestForJob, refreshTranslationJob } from "../translation.js";

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
    if (!isViewableInputFormat(storage.name)) {
      return badInput(c, "input.urn", `The .${documentFileType(storage.name)} source format is not viewable.`);
    }
    const force = c.req.header("x-ads-force")?.toLowerCase() === "true";
    const result = enqueueTranslation(aps, store, {
      urn,
      sourceName: storage.name,
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
    const job = aps.translationJobs.findOneBy("urn", c.req.param("urn"));
    if (job) {
      const refreshed = await refreshTranslationJob(aps, store, job);
      return c.json(manifestForJob(refreshed));
    }
    const manifest = aps.manifests.findOneBy("urn", c.req.param("urn"));
    if (!manifest) return c.body(null, 404);
    return c.json({
      type: manifest.type,
      hasThumbnail: manifest.hasThumbnail,
      status: manifest.status,
      progress: manifest.progress,
      region: manifest.region,
      urn: manifest.urn,
      version: manifest.version,
      derivatives: manifest.derivatives,
    });
  });
}
