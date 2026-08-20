import { bareProjectId, findProjectResource, projectForAccId } from "./acc.js";
import type { ApsAccActorSeed, ApsSeedConfig } from "./config.js";
import type { ApsActorRef } from "./entities.js";
import type { ApsStore } from "./store.js";

function seedProjectId(aps: ApsStore, projectId: string): string {
  const result = projectForAccId(aps, projectId, "bare-or-prefixed");
  if (result.kind !== "found") {
    throw new Error(`APS ACC resource references unknown project '${projectId}'.`);
  }
  return result.project.project_id;
}

// User references resolve softly: unknown values pass through verbatim so
// seeds can name external actors that are not seeded APS users. Unknown
// projects, types, and collections throw instead — those are structural links.
function userId(aps: ApsStore, value: string | undefined): string {
  if (!value) return aps.users.all()[0]?.user_id ?? "";
  return aps.users.findOneBy("email", value)?.user_id ?? aps.users.findOneBy("user_id", value)?.user_id ?? value;
}

function actors(aps: ApsStore, values: ApsAccActorSeed[] | undefined): ApsActorRef[] {
  return (values ?? []).map((actor) => ({ id: userId(aps, actor.id), type: actor.type ?? "user" }));
}

interface AuditSeed {
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

interface NamedAuditSeed extends AuditSeed {
  created_by_name?: string;
  updated_by_name?: string;
}

function auditFields(aps: ApsStore, seed: AuditSeed, now: string) {
  const createdAt = seed.created_at ?? now;
  return {
    createdBy: userId(aps, seed.created_by),
    createdAt,
    updatedBy: userId(aps, seed.updated_by ?? seed.created_by),
    updatedAt: seed.updated_at ?? createdAt,
  };
}

function namedAuditFields(aps: ApsStore, seed: NamedAuditSeed, now: string) {
  return {
    ...auditFields(aps, seed, now),
    createdByName: seed.created_by_name ?? "",
    updatedByName: seed.updated_by_name ?? seed.created_by_name ?? "",
  };
}

export function seedAccFromConfig(aps: ApsStore, config: ApsSeedConfig): void {
  const now = new Date().toISOString();

  for (const member of config.acc_project_users ?? []) {
    const projectId = seedProjectId(aps, member.project_id);
    const user = aps.users.findOneBy("email", member.user_email);
    if (!user) {
      throw new Error(`APS ACC project user references unknown user '${member.user_email}'.`);
    }
    if (findProjectResource(aps.accProjectUsers, projectId, "user_id", user.user_id)) continue;
    aps.accProjectUsers.insert({
      project_id: projectId,
      user_id: user.user_id,
      role: member.role ?? "member",
      issue_permission: member.issue_permission ?? "read",
      rfi_roles: structuredClone(member.rfi_roles ?? []),
    });
  }

  for (const issueType of config.issue_types ?? []) {
    const projectId = seedProjectId(aps, issueType.project_id);
    if (findProjectResource(aps.issueTypes, projectId, "issue_type_id", issueType.id)) continue;
    const createdBy = aps.accProjectUsers.findBy("project_id", projectId)[0]?.user_id ?? "";
    const isActive = issueType.is_active ?? true;
    const subtypes = (issueType.subtypes ?? []).map((subtype) => ({
      id: subtype.id,
      issueTypeId: issueType.id,
      title: subtype.title,
      code: subtype.code ?? "",
      isActive: subtype.is_active ?? true,
      orderIndex: subtype.order_index ?? 1,
      isReadOnly: false,
      permittedActions: ["edit"],
      permittedAttributes: ["title"],
      createdBy,
      createdAt: now,
      updatedBy: createdBy,
      updatedAt: now,
      deletedBy: null,
      deletedAt: null,
    }));
    aps.issueTypes.insert({
      project_id: projectId,
      issue_type_id: issueType.id,
      payload: {
        id: issueType.id,
        containerId: bareProjectId(projectId),
        title: issueType.title,
        isActive,
        orderIndex: issueType.order_index ?? 1,
        permittedActions: ["edit"],
        permittedAttributes: ["title"],
        subtypes,
        statusSet: "default",
        createdBy,
        createdAt: now,
        updatedBy: createdBy,
        updatedAt: now,
        deletedBy: null,
        deletedAt: null,
      },
    });
  }

  for (const issue of config.issues ?? []) {
    const projectId = seedProjectId(aps, issue.project_id);
    if (findProjectResource(aps.issues, projectId, "issue_id", issue.id)) continue;
    const issueType = findProjectResource(aps.issueTypes, projectId, "issue_type_id", issue.issue_type_id);
    if (!issueType || !issueType.payload.subtypes.some((subtype) => subtype.id === issue.issue_subtype_id)) {
      throw new Error(`APS issue '${issue.id}' references an unknown issue type or subtype.`);
    }

    const assignedTo = issue.assigned_to ? userId(aps, issue.assigned_to) : null;
    const audit = auditFields(aps, issue, now);
    const status = issue.status ?? "open";
    const displayId = issue.display_id ?? aps.issues.findBy("project_id", projectId).length + 1;
    aps.issues.insert({
      project_id: projectId,
      issue_id: issue.id,
      payload: {
        id: issue.id,
        containerId: bareProjectId(projectId),
        deleted: issue.deleted ?? false,
        deletedAt: null,
        deletedBy: null,
        displayId,
        title: issue.title,
        description: issue.description ?? "",
        snapshotUrn: "",
        issueTypeId: issue.issue_type_id,
        issueSubtypeId: issue.issue_subtype_id,
        status,
        assignedTo,
        assignedToType: assignedTo ? (issue.assigned_to_type ?? "user") : null,
        dueDate: issue.due_date ?? null,
        startDate: issue.start_date ?? null,
        locationId: issue.location_id ?? null,
        locationDetails: issue.location_details ?? "",
        linkedDocuments: [],
        links: [],
        ownerId: null,
        rootCauseId: issue.root_cause_id ?? null,
        officialResponse: null,
        issueTemplateId: null,
        published: issue.published ?? true,
        commentCount: 0,
        attachmentCount: 0,
        openedBy: audit.createdBy,
        openedAt: audit.createdAt,
        closedBy: status === "closed" ? audit.updatedBy : null,
        closedAt: status === "closed" ? audit.updatedAt : null,
        ...audit,
        watchers: [],
        customAttributes: [],
        gpsCoordinates: null,
        snapshotHasMarkups: false,
      },
    });
  }

  for (const rfiType of config.rfi_types ?? []) {
    const projectId = seedProjectId(aps, rfiType.project_id);
    if (findProjectResource(aps.rfiTypes, projectId, "rfi_type_id", rfiType.id)) continue;
    aps.rfiTypes.insert({
      project_id: projectId,
      rfi_type_id: rfiType.id,
      payload: {
        id: rfiType.id,
        name: rfiType.name,
        wfType: rfiType.workflow_type ?? "US",
        status: rfiType.status ?? "active",
        isDefault: rfiType.is_default ?? false,
        projectReviewer: actors(aps, rfiType.reviewers),
        projectCoordinator: actors(aps, rfiType.manager),
        manager: actors(aps, rfiType.manager),
        watchers: actors(aps, rfiType.watchers),
        dueDateOffset: rfiType.due_date_offset ?? 7,
        locationDescription: "",
        costImpact: "Unknown",
        scheduleImpact: "Unknown",
        priority: "Normal",
        discipline: [],
        category: [],
        reference: "",
        bridgeTargetProjectIds: [],
      },
    });
  }

  for (const attribute of config.rfi_attributes ?? []) {
    const projectId = seedProjectId(aps, attribute.project_id);
    if (findProjectResource(aps.rfiAttributes, projectId, "attribute_id", attribute.id)) continue;
    aps.rfiAttributes.insert({
      project_id: projectId,
      attribute_id: attribute.id,
      payload: {
        id: attribute.id,
        name: attribute.name,
        type: attribute.type ?? "text",
        description: attribute.description ?? "",
        status: attribute.status ?? "active",
        multipleChoice: attribute.multiple_choice ?? false,
        possibleValues: structuredClone(attribute.possible_values ?? []),
      },
    });
  }

  for (const rfi of config.rfis ?? []) {
    const projectId = seedProjectId(aps, rfi.project_id);
    if (findProjectResource(aps.rfis, projectId, "rfi_id", rfi.id)) continue;
    if (!findProjectResource(aps.rfiTypes, projectId, "rfi_type_id", rfi.rfi_type_id)) {
      throw new Error(`APS RFI '${rfi.id}' references unknown RFI type '${rfi.rfi_type_id}'.`);
    }

    const audit = auditFields(aps, rfi, now);
    const status = rfi.status ?? "draft";
    aps.rfis.insert({
      project_id: projectId,
      rfi_id: rfi.id,
      payload: {
        id: rfi.id,
        customIdentifier: rfi.custom_identifier,
        title: rfi.title,
        question: rfi.question ?? "",
        virtualFolderUrn: `urn:adsk.wip:fs.folder:co.${Buffer.from(rfi.id).toString("base64url")}`,
        status,
        previousStatus: rfi.previous_status ?? null,
        workflowType: rfi.workflow_type ?? "US",
        assignedTo: actors(aps, rfi.assigned_to),
        managerId: userId(aps, rfi.manager_id),
        constructionManagerId: null,
        architects: [],
        reviewers: [],
        dueDate: rfi.due_date ?? null,
        locationDescription: rfi.location_description ?? "",
        locations: structuredClone(rfi.locations ?? []),
        commentsCount: 0,
        officialResponse: rfi.official_response ?? null,
        officialResponseStatus: rfi.official_response_status ?? "unanswered",
        officialResponseActors: [],
        officialResponseEditByManagerState: false,
        respondedAt: null,
        respondedBy: null,
        ...audit,
        closedAt: status === "closed" ? audit.updatedAt : null,
        closedBy: status === "closed" ? audit.updatedBy : null,
        containerId: bareProjectId(projectId),
        projectId: bareProjectId(projectId),
        suggestedAnswer: null,
        coReviewers: [],
        watchers: [],
        answeredAt: null,
        answeredBy: null,
        costImpact: "Unknown",
        scheduleImpact: "Unknown",
        priority: rfi.priority ?? "Normal",
        discipline: structuredClone(rfi.discipline ?? []),
        category: structuredClone(rfi.category ?? []),
        reference: rfi.reference ?? rfi.custom_identifier,
        customAttributes: [],
        rfiTypeId: rfi.rfi_type_id,
        bridgedSource: null,
        bridgedTarget: null,
        bridgeSyncOutdated: false,
        syncVersion: null,
        responses: [],
        draftResponses: [],
      },
    });
  }

  for (const collection of config.sheet_collections ?? []) {
    const projectId = seedProjectId(aps, collection.project_id);
    if (findProjectResource(aps.sheetCollections, projectId, "collection_id", collection.id)) continue;
    aps.sheetCollections.insert({
      project_id: projectId,
      collection_id: collection.id,
      payload: {
        id: collection.id,
        name: collection.name,
        ...namedAuditFields(aps, collection, now),
      },
    });
  }

  for (const versionSet of config.sheet_version_sets ?? []) {
    const projectId = seedProjectId(aps, versionSet.project_id);
    if (findProjectResource(aps.sheetVersionSets, projectId, "version_set_id", versionSet.id)) continue;
    const collection = versionSet.collection_id
      ? findProjectResource(aps.sheetCollections, projectId, "collection_id", versionSet.collection_id)
      : undefined;
    if (versionSet.collection_id && !collection) {
      throw new Error(`APS Sheet version set '${versionSet.id}' references unknown collection.`);
    }
    aps.sheetVersionSets.insert({
      project_id: projectId,
      version_set_id: versionSet.id,
      payload: {
        id: versionSet.id,
        name: versionSet.name,
        issuanceDate: versionSet.issuance_date,
        ...namedAuditFields(aps, versionSet, now),
        collection: collection ? { id: collection.collection_id, name: collection.payload.name } : null,
      },
    });
  }

  for (const sheet of config.sheets ?? []) {
    const projectId = seedProjectId(aps, sheet.project_id);
    if (findProjectResource(aps.sheets, projectId, "sheet_id", sheet.id)) continue;
    const versionSet = findProjectResource(aps.sheetVersionSets, projectId, "version_set_id", sheet.version_set_id);
    if (!versionSet) {
      throw new Error(`APS Sheet '${sheet.id}' references unknown version set '${sheet.version_set_id}'.`);
    }
    const collectionId = sheet.collection_id ?? versionSet.payload.collection?.id;
    const collection = collectionId
      ? findProjectResource(aps.sheetCollections, projectId, "collection_id", collectionId)
      : undefined;
    if (collectionId && !collection) {
      throw new Error(`APS Sheet '${sheet.id}' references unknown collection '${collectionId}'.`);
    }
    aps.sheets.insert({
      project_id: projectId,
      sheet_id: sheet.id,
      payload: {
        id: sheet.id,
        number: sheet.number,
        versionSet: {
          id: versionSet.version_set_id,
          name: versionSet.payload.name,
          issuanceDate: versionSet.payload.issuanceDate,
          deleted: false,
        },
        ...namedAuditFields(aps, sheet, now),
        title: sheet.title,
        uploadFileName: sheet.upload_file_name ?? "",
        uploadId: sheet.upload_id ?? "",
        tags: structuredClone(sheet.tags ?? []),
        paperSize: structuredClone(sheet.paper_size ?? [0, 0]),
        isCurrent: sheet.is_current ?? true,
        deleted: sheet.deleted ?? false,
        deletedAt: null,
        deletedBy: null,
        deletedByName: null,
        viewable: {
          urn: sheet.viewable_urn ?? "",
          guid: sheet.viewable_guid ?? "",
        },
        collection: collection ? { id: collection.collection_id, name: collection.payload.name } : null,
      },
    });
  }
}
