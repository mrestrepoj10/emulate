import type { ApsClientType, ApsIssuePermission, ApsManifestDerivative } from "./entities.js";
import {
  DEFAULT_HUB_ID,
  DEFAULT_MANIFEST_URN,
  DEFAULT_PROJECT_ID,
  DEFAULT_SECOND_DOCUMENT_ITEM_ID,
  DEFAULT_SECOND_DOCUMENT_VERSION_ID,
  DEFAULT_SECOND_MANIFEST_URN,
  DEFAULT_WEBHOOK_CHILD_FOLDER_ID,
  DEFAULT_WEBHOOK_FOLDER_ID,
  DEFAULT_WEBHOOK_ITEM_ID,
  DEFAULT_WEBHOOK_VERSION_ID,
} from "./helpers.js";

export interface ApsAccActorSeed {
  id: string;
  type?: "user" | "role" | "company";
}

export interface ApsDocumentVersionSeed {
  version_id: string;
  item_id: string;
  folder_id: string;
  ancestor_folder_ids?: string[];
  project_id: string;
  display_name?: string;
  storage_urn?: string;
  region?: string;
  bubble_urn?: string;
  viewable_id?: string;
  viewable_guid?: string;
}

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
  acc_project_users?: Array<{
    project_id: string;
    user_email: string;
    role?: "project_admin" | "member";
    issue_permission?: ApsIssuePermission;
    rfi_roles?: string[];
  }>;
  issue_types?: Array<{
    id: string;
    project_id: string;
    title: string;
    is_active?: boolean;
    order_index?: number;
    subtypes?: Array<{
      id: string;
      title: string;
      code?: string;
      is_active?: boolean;
      order_index?: number;
    }>;
  }>;
  issues?: Array<{
    id: string;
    project_id: string;
    title: string;
    description?: string;
    display_id?: number;
    issue_type_id: string;
    issue_subtype_id: string;
    status?: string;
    assigned_to?: string;
    assigned_to_type?: "user" | "role" | "company" | null;
    due_date?: string;
    start_date?: string;
    location_id?: string;
    location_details?: string;
    root_cause_id?: string;
    published?: boolean;
    deleted?: boolean;
    created_by?: string;
    created_at?: string;
    updated_by?: string;
    updated_at?: string;
  }>;
  rfi_types?: Array<{
    id: string;
    project_id: string;
    name: string;
    status?: string;
    is_default?: boolean;
    workflow_type?: string;
    due_date_offset?: number;
    manager?: ApsAccActorSeed[];
    reviewers?: ApsAccActorSeed[];
    watchers?: ApsAccActorSeed[];
  }>;
  rfi_attributes?: Array<{
    id: string;
    project_id: string;
    name: string;
    type?: string;
    description?: string;
    status?: string;
    multiple_choice?: boolean;
    possible_values?: Array<{ id: string; name: string }>;
  }>;
  rfis?: Array<{
    id: string;
    project_id: string;
    rfi_type_id: string;
    custom_identifier: string;
    title: string;
    question?: string;
    status?: string;
    previous_status?: string;
    workflow_type?: string;
    assigned_to?: ApsAccActorSeed[];
    manager_id?: string;
    due_date?: string;
    location_description?: string;
    locations?: string[];
    official_response?: string;
    official_response_status?: string;
    priority?: string;
    discipline?: string[];
    category?: string[];
    reference?: string;
    created_by?: string;
    created_at?: string;
    updated_by?: string;
    updated_at?: string;
  }>;
  sheet_collections?: Array<{
    id: string;
    project_id: string;
    name: string;
    created_by?: string;
    created_by_name?: string;
    created_at?: string;
    updated_by?: string;
    updated_by_name?: string;
    updated_at?: string;
  }>;
  sheet_version_sets?: Array<{
    id: string;
    project_id: string;
    name: string;
    issuance_date: string;
    collection_id?: string;
    created_by?: string;
    created_by_name?: string;
    created_at?: string;
    updated_by?: string;
    updated_by_name?: string;
    updated_at?: string;
  }>;
  sheets?: Array<{
    id: string;
    project_id: string;
    number: string;
    title: string;
    version_set_id: string;
    collection_id?: string;
    tags?: string[];
    upload_file_name?: string;
    upload_id?: string;
    paper_size?: [number, number];
    is_current?: boolean;
    deleted?: boolean;
    viewable_urn?: string;
    viewable_guid?: string;
    created_by?: string;
    created_by_name?: string;
    created_at?: string;
    updated_by?: string;
    updated_by_name?: string;
    updated_at?: string;
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
  webhook_timing?: Partial<ApsWebhookTimingConfig>;
  model_coordination_timing?: Partial<ApsModelCoordinationTimingConfig>;
  document_versions?: ApsDocumentVersionSeed[];
  /** @deprecated Use document_versions. */
  webhook_dm_versions?: ApsDocumentVersionSeed[];
  model_sets?: Array<{
    id: string;
    project_id: string;
    name: string;
    description?: string;
    root_folder_urn?: string;
    folder_urns?: string[];
    document_version_ids?: string[];
    created_by?: string;
    created_time?: string;
    disabled?: boolean;
    deleted?: boolean;
    test_id?: string;
  }>;
  webhooks?: Array<{
    system: string;
    event: string;
    callback_url: string;
    scope: Record<string, string>;
    tenant?: string;
    creator_client_id?: string;
    creator_user_email?: string;
    region?: string;
    status?: "active" | "inactive";
    auto_reactivate_hook?: boolean;
    hook_expiry?: string | null;
    hook_attribute?: Record<string, unknown>;
    filter?: string | string[];
    token?: string;
    hub_id?: string;
    project_id?: string;
  }>;
}

export interface ApsWebhookTimingConfig {
  max_retries: number;
  retry_base_ms: number;
  retry_max_ms: number;
  failed_events_before_inactive: number;
  reactivate_after_ms: number;
  max_reactivation_cycles: number;
  delivery_timeout_ms: number;
}

export interface ApsModelCoordinationTimingConfig {
  processing_ms: number;
  signed_url_ttl_ms: number;
}

export const DEFAULT_MODEL_COORDINATION_TIMING: ApsModelCoordinationTimingConfig = {
  processing_ms: 25,
  signed_url_ttl_ms: 60_000,
};

export const DEFAULT_WEBHOOK_TIMING: ApsWebhookTimingConfig = {
  max_retries: 8,
  retry_base_ms: 25,
  retry_max_ms: 1000,
  failed_events_before_inactive: 5,
  reactivate_after_ms: 1000,
  max_reactivation_cycles: 5,
  delivery_timeout_ms: 6000,
};

const DEFAULT_DERIVATIVE_BASE = `urn:adsk.viewing:fs.file:${DEFAULT_MANIFEST_URN}/output`;
const DEFAULT_SECOND_DERIVATIVE_BASE = `urn:adsk.viewing:fs.file:${DEFAULT_SECOND_MANIFEST_URN}/output`;
const DEFAULT_ACC_TIMESTAMP = "2026-08-19T12:00:00.000Z";
const DEFAULT_ISSUE_TYPE_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ISSUE_SUBTYPE_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_RFI_TYPE_ID = "55555555-5555-4555-8555-555555555555";
const DEFAULT_SHEET_COLLECTION_ID = "99999999-9999-4999-8999-999999999999";
const DEFAULT_VERSION_SET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const DEFAULT_DATA_SEED = {
  hubs: [{ id: DEFAULT_HUB_ID, name: "Emulate Construction Hub", region: "US" }],
  projects: [
    { id: DEFAULT_PROJECT_ID, hub_id: DEFAULT_HUB_ID, name: "Sample Building" },
    { id: "b.emulate-infrastructure", hub_id: DEFAULT_HUB_ID, name: "Sample Infrastructure" },
  ],
  acc_project_users: [
    {
      project_id: DEFAULT_PROJECT_ID,
      user_email: "testuser@autodesk.local",
      role: "project_admin",
      issue_permission: "manage",
      rfi_roles: ["project_admin", "projectGC", "projectSC"],
    },
  ],
  issue_types: [
    {
      id: DEFAULT_ISSUE_TYPE_ID,
      project_id: DEFAULT_PROJECT_ID,
      title: "Coordination",
      is_active: true,
      order_index: 1,
      subtypes: [
        {
          id: DEFAULT_ISSUE_SUBTYPE_ID,
          title: "Clash",
          code: "CLASH",
          is_active: true,
          order_index: 1,
        },
      ],
    },
  ],
  issues: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      project_id: DEFAULT_PROJECT_ID,
      title: "Door clearance conflict",
      description: "The door conflicts with the adjacent wall finish.",
      display_id: 1,
      issue_type_id: DEFAULT_ISSUE_TYPE_ID,
      issue_subtype_id: DEFAULT_ISSUE_SUBTYPE_ID,
      status: "open",
      assigned_to: "testuser@autodesk.local",
      assigned_to_type: "user",
      due_date: "2026-08-26",
      location_details: "Level 1 corridor",
      published: true,
      created_by: "testuser@autodesk.local",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      project_id: DEFAULT_PROJECT_ID,
      title: "Verify ceiling access panel",
      description: "Confirm the access panel location before closeout.",
      display_id: 2,
      issue_type_id: DEFAULT_ISSUE_TYPE_ID,
      issue_subtype_id: DEFAULT_ISSUE_SUBTYPE_ID,
      status: "closed",
      assigned_to: "testuser@autodesk.local",
      assigned_to_type: "user",
      due_date: "2026-08-20",
      location_details: "Level 2 mechanical room",
      published: true,
      created_by: "testuser@autodesk.local",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
  ],
  rfi_types: [
    {
      id: DEFAULT_RFI_TYPE_ID,
      project_id: DEFAULT_PROJECT_ID,
      name: "Design clarification",
      status: "active",
      is_default: true,
      workflow_type: "US",
      due_date_offset: 7,
      manager: [{ id: "testuser@autodesk.local" }],
      reviewers: [{ id: "testuser@autodesk.local" }],
      watchers: [{ id: "testuser@autodesk.local" }],
    },
  ],
  rfi_attributes: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      project_id: DEFAULT_PROJECT_ID,
      name: "Specification section",
      type: "text",
      description: "Related specification section",
      status: "active",
    },
  ],
  rfis: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      project_id: DEFAULT_PROJECT_ID,
      rfi_type_id: DEFAULT_RFI_TYPE_ID,
      custom_identifier: "RFI-001",
      title: "Confirm structural opening",
      question: "What dimensions should be used for the structural opening?",
      status: "open",
      previous_status: "submitted",
      workflow_type: "US",
      assigned_to: [{ id: "testuser@autodesk.local" }],
      manager_id: "testuser@autodesk.local",
      due_date: "2026-08-27T12:00:00.000Z",
      location_description: "Level 1 electrical room",
      priority: "High",
      discipline: ["Structural"],
      category: ["Constructability"],
      reference: "S-101",
      created_by: "testuser@autodesk.local",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      project_id: DEFAULT_PROJECT_ID,
      rfi_type_id: DEFAULT_RFI_TYPE_ID,
      custom_identifier: "RFI-002",
      title: "Clarify finish transition",
      question: "Which finish transition detail applies at the lobby?",
      status: "draft",
      workflow_type: "US",
      assigned_to: [{ id: "testuser@autodesk.local" }],
      priority: "Normal",
      discipline: ["Architectural"],
      category: ["Design"],
      reference: "A-201",
      created_by: "testuser@autodesk.local",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
  ],
  sheet_collections: [
    {
      id: DEFAULT_SHEET_COLLECTION_ID,
      project_id: DEFAULT_PROJECT_ID,
      name: "Issued for Construction",
      created_by: "testuser@autodesk.local",
      created_by_name: "Test User",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_by_name: "Test User",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
  ],
  sheet_version_sets: [
    {
      id: DEFAULT_VERSION_SET_ID,
      project_id: DEFAULT_PROJECT_ID,
      name: "August 2026 Issue",
      issuance_date: "2026-08-19",
      collection_id: DEFAULT_SHEET_COLLECTION_ID,
      created_by: "testuser@autodesk.local",
      created_by_name: "Test User",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_by_name: "Test User",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
  ],
  sheets: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      project_id: DEFAULT_PROJECT_ID,
      number: "A-101",
      title: "Level 1 Floor Plan",
      version_set_id: DEFAULT_VERSION_SET_ID,
      collection_id: DEFAULT_SHEET_COLLECTION_ID,
      tags: ["architectural", "floor-plan"],
      upload_file_name: "architectural-set.pdf",
      upload_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      paper_size: [1200, 800],
      is_current: true,
      viewable_urn: "urn:adsk.bimdocs:seed:emulate-architectural-set",
      viewable_guid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      created_by: "testuser@autodesk.local",
      created_by_name: "Test User",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_by_name: "Test User",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      project_id: DEFAULT_PROJECT_ID,
      number: "S-101",
      title: "Foundation Plan",
      version_set_id: DEFAULT_VERSION_SET_ID,
      collection_id: DEFAULT_SHEET_COLLECTION_ID,
      tags: ["structural", "foundation"],
      upload_file_name: "structural-set.pdf",
      upload_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      paper_size: [1200, 800],
      is_current: true,
      viewable_urn: "urn:adsk.bimdocs:seed:emulate-structural-set",
      viewable_guid: "12121212-1212-4121-8121-121212121212",
      created_by: "testuser@autodesk.local",
      created_by_name: "Test User",
      created_at: DEFAULT_ACC_TIMESTAMP,
      updated_by: "testuser@autodesk.local",
      updated_by_name: "Test User",
      updated_at: DEFAULT_ACC_TIMESTAMP,
    },
  ],
  document_versions: [
    {
      version_id: DEFAULT_WEBHOOK_VERSION_ID,
      item_id: DEFAULT_WEBHOOK_ITEM_ID,
      folder_id: DEFAULT_WEBHOOK_CHILD_FOLDER_ID,
      ancestor_folder_ids: [DEFAULT_WEBHOOK_FOLDER_ID],
      project_id: DEFAULT_PROJECT_ID,
      display_name: "sample.rvt",
      storage_urn: "urn:adsk.objects:os.object:emulate-bucket/sample.rvt",
      region: "US",
    },
    {
      version_id: DEFAULT_SECOND_DOCUMENT_VERSION_ID,
      item_id: DEFAULT_SECOND_DOCUMENT_ITEM_ID,
      folder_id: DEFAULT_WEBHOOK_CHILD_FOLDER_ID,
      ancestor_folder_ids: [DEFAULT_WEBHOOK_FOLDER_ID],
      project_id: DEFAULT_PROJECT_ID,
      display_name: "structural.rvt",
      storage_urn: "urn:adsk.objects:os.object:emulate-bucket/structural.rvt",
      region: "US",
      bubble_urn: DEFAULT_SECOND_MANIFEST_URN,
      viewable_id: "emulate-structural-3d-view",
      viewable_guid: "14141414-1414-4141-8141-141414141414",
    },
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
    [DEFAULT_SECOND_MANIFEST_URN]: {
      type: "manifest",
      hasThumbnail: "true",
      status: "success",
      progress: "complete",
      region: "US",
      version: "1.0",
      derivatives: [
        {
          name: "structural.rvt",
          hasThumbnail: "true",
          status: "success",
          progress: "complete",
          outputType: "svf2",
          children: [
            {
              guid: "15151515-1515-4151-8151-151515151515",
              type: "resource",
              role: "Autodesk.CloudPlatform.PropertyDatabase",
              urn: `${DEFAULT_SECOND_DERIVATIVE_BASE}/Resource/model.sdb`,
              mime: "application/autodesk-db",
              status: "success",
            },
            {
              guid: "14141414-1414-4141-8141-141414141414",
              type: "geometry",
              role: "3d",
              name: "{3D}",
              viewableID: "emulate-structural-3d-view",
              status: "success",
              hasThumbnail: "true",
              progress: "complete",
              children: [
                {
                  guid: "emulate-structural-3d-view",
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
      ],
    },
  },
  model_sets: [
    {
      id: "13131313-1313-4131-8131-131313131313",
      project_id: DEFAULT_PROJECT_ID,
      name: "Sample Building Coordination",
      description: "Architectural and structural coordination model set",
      root_folder_urn: DEFAULT_WEBHOOK_FOLDER_ID,
      folder_urns: [DEFAULT_WEBHOOK_CHILD_FOLDER_ID],
      document_version_ids: [DEFAULT_WEBHOOK_VERSION_ID, DEFAULT_SECOND_DOCUMENT_VERSION_ID],
      created_by: "testuser@autodesk.local",
      created_time: DEFAULT_ACC_TIMESTAMP,
      test_id: "16161616-1616-4161-8161-161616161616",
    },
  ],
} satisfies ApsSeedConfig;
