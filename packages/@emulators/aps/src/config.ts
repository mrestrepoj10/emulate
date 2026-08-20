import type { ApsClientType, ApsManifestDerivative } from "./entities.js";
import { DEFAULT_HUB_ID, DEFAULT_MANIFEST_URN, DEFAULT_PROJECT_ID } from "./helpers.js";

export interface ApsSeedConfig {
  clients?: Array<{
    client_id: string;
    client_secret?: string;
    name?: string;
    type?: ApsClientType;
    redirect_uris: string[];
  }>;
  users?: Array<{
    user_id?: string;
    email: string;
    name?: string;
    picture?: string;
  }>;
  hubs?: Array<{
    id: string;
    name: string;
    region?: string;
  }>;
  projects?: Array<{
    id: string;
    hub_id: string;
    name: string;
  }>;
  manifests?: Record<
    string,
    {
      type?: string;
      hasThumbnail?: string;
      status?: string;
      progress?: string;
      region?: string;
      version?: string;
      derivatives?: ApsManifestDerivative[];
    }
  >;
}

const DEFAULT_DERIVATIVE_BASE = `urn:adsk.viewing:fs.file:${DEFAULT_MANIFEST_URN}/output`;

export const DEFAULT_DATA_SEED = {
  hubs: [{ id: DEFAULT_HUB_ID, name: "Emulate Construction Hub", region: "US" }],
  projects: [
    { id: DEFAULT_PROJECT_ID, hub_id: DEFAULT_HUB_ID, name: "Sample Building" },
    { id: "b.emulate-infrastructure", hub_id: DEFAULT_HUB_ID, name: "Sample Infrastructure" },
  ],
  manifests: {
    [DEFAULT_MANIFEST_URN]: {
      type: "manifest",
      hasThumbnail: "true",
      status: "success",
      progress: "complete",
      region: "US",
      version: "1.0",
      derivatives: [
        {
          name: "sample.rvt",
          hasThumbnail: "true",
          status: "success",
          progress: "complete",
          outputType: "svf2",
          children: [
            {
              guid: "6fac95cb-af5d-3e4f-b943-8a7f55847ff1",
              type: "resource",
              role: "Autodesk.CloudPlatform.PropertyDatabase",
              urn: `${DEFAULT_DERIVATIVE_BASE}/Resource/model.sdb`,
              mime: "application/autodesk-db",
              status: "success",
            },
            {
              guid: "d8e734a8-6e9e-4f4d-9a4f-000000000001",
              type: "geometry",
              role: "3d",
              name: "{3D}",
              viewableID: "emulate-3d-view",
              status: "success",
              hasThumbnail: "true",
              progress: "complete",
              children: [
                {
                  guid: "emulate-3d-view",
                  type: "view",
                  role: "3d",
                  name: "{3D}",
                  status: "success",
                  progress: "complete",
                },
              ],
            },
          ],
        },
        {
          status: "success",
          progress: "complete",
          outputType: "thumbnail",
          children: [
            {
              guid: "d8e734a8-6e9e-4f4d-9a4f-000000000002",
              type: "resource",
              role: "thumbnail",
              urn: `${DEFAULT_DERIVATIVE_BASE}/preview4.png`,
              resolution: [400, 400],
              mime: "image/png",
              status: "success",
            },
          ],
        },
      ],
    },
  },
} satisfies ApsSeedConfig;
