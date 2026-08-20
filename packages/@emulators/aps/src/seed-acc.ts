import { bareProjectId, projectForAccId } from "./acc.js";
import type { ApsAccActorSeed, ApsSeedConfig } from "./config.js";
import type { ApsStore } from "./store.js";

function seedProjectId(aps: ApsStore, projectId: string): string {
  const result = projectForAccId(aps, projectId, "bare-or-prefixed");
  if (result.kind !== "found") {
    throw new Error(`APS ACC resource references unknown project '${projectId}'.`);
  }
  return result.project.project_id;
}

function userId(aps: ApsStore, value: string | undefined): string {
  if (!value) return aps.users.all()[0]?.user_id ?? "";
  return aps.users.findOneBy("email", value)?.user_id ?? aps.users.findOneBy("user_id", value)?.user_id ?? value;
}

function actors(aps: ApsStore, values: ApsAccActorSeed[] | undefined): Array<{ id: string; type: string }> {
  return (values ?? []).map((actor) => ({ id: userId(aps, actor.id), type: actor.type ?? "user" }));
}

function resourceExists<T extends { project_id: string }>(
  resources: T[],
  projectId: string,
  identifier: (resource: T) => string,
  id: string,
): boolean {
  return resources.some((resource) => resource.project_id === projectId && identifier(resource) === id);
}

export function seedAccFromConfig(aps: ApsStore, config: ApsSeedConfig): void {
  const now = new Date().toISOString();

  for (const member of config.acc_project_users ?? []) {
    const projectId = seedProjectId(aps, member.project_id);
    const user = aps.users.findOneBy("email", member.user_email);
    if (!user) {
      throw new Error(`APS ACC project user references unknown user '${member.user_email}'.`);
    }
    if (resourceExists(aps.accProjectUsers.all(), projectId, (candidate) => candidate.user_id, user.user_id)) {
      continue;
    }
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
    if (resourceExists(aps.issueTypes.all(), projectId, (candidate) => candidate.issue_type_id, issueType.id)) {
      continue;
    }
    const createdBy = aps.accProjectUsers.findBy("project_id", projectId)[0]?.user_id ?? "";
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
      is_active: issueType.is_active ?? true,
      payload: {
        id: issueType.id,
        containerId: bareProjectId(projectId),
        title: issueType.title,
        isActive: issueType.is_active ?? true,
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
    if (resourceExists(aps.issues.all(), projectId, (candidate) => candidate.issue_id, issue.id)) continue;
    const issueType = aps.issueTypes
      .findBy("project_id", projectId)
      .find((candidate) => candidate.issue_type_id === issue.issue_type_id);
    const subtypes = (issueType?.payload.subtypes as Array<{ id?: string }> | undefined) ?? [];
    if (!issueType || !subtypes.some((subtype) => subtype.id === issue.issue_subtype_id)) {
      throw new Error(`APS issue '${issue.id}' references an unknown issue type or subtype.`);
    }

    const assignedTo = issue.assigned_to ? userId(aps, issue.assigned_to) : null;
    const createdBy = userId(aps, issue.created_by);
    const updatedBy = userId(aps, issue.updated_by ?? issue.created_by);
    const createdAt = issue.created_at ?? now;
    const updatedAt = issue.updated_at ?? createdAt;
    const status = issue.status ?? "open";
    const deleted = issue.deleted ?? false;
    const displayId = issue.display_id ?? aps.issues.findBy("project_id", projectId).length + 1;
    aps.issues.insert({
      project_id: projectId,
      issue_id: issue.id,
      issue_type_id: issue.issue_type_id,
      issue_subtype_id: issue.issue_subtype_id,
      display_id: displayId,
      title: issue.title,
      status,
      assigned_to: assignedTo,
      deleted,
      payload: {
        id: issue.id,
        containerId: bareProjectId(projectId),
        deleted,
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
        openedBy: createdBy,
        openedAt: createdAt,
        closedBy: status === "closed" ? updatedBy : null,
        closedAt: status === "closed" ? updatedAt : null,
        createdBy,
        createdAt,
        updatedBy,
        updatedAt,
        watchers: [],
        customAttributes: [],
        gpsCoordinates: null,
        snapshotHasMarkups: false,
      },
    });
  }

  for (const rfiType of config.rfi_types ?? []) {
    const projectId = seedProjectId(aps, rfiType.project_id);
    if (resourceExists(aps.rfiTypes.all(), projectId, (candidate) => candidate.rfi_type_id, rfiType.id)) {
      continue;
    }
    const status = rfiType.status ?? "active";
    aps.rfiTypes.insert({
      project_id: projectId,
      rfi_type_id: rfiType.id,
      status,
      payload: {
        id: rfiType.id,
        name: rfiType.name,
        wfType: rfiType.workflow_type ?? "US",
        status,
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
    if (resourceExists(aps.rfiAttributes.all(), projectId, (candidate) => candidate.attribute_id, attribute.id)) {
      continue;
    }
    const status = attribute.status ?? "active";
    aps.rfiAttributes.insert({
      project_id: projectId,
      attribute_id: attribute.id,
      status,
      payload: {
        id: attribute.id,
        name: attribute.name,
        type: attribute.type ?? "text",
        description: attribute.description ?? "",
        status,
        multipleChoice: attribute.multiple_choice ?? false,
        possibleValues: structuredClone(attribute.possible_values ?? []),
      },
    });
  }

  for (const rfi of config.rfis ?? []) {
    const projectId = seedProjectId(aps, rfi.project_id);
    if (resourceExists(aps.rfis.all(), projectId, (candidate) => candidate.rfi_id, rfi.id)) continue;
    if (!aps.rfiTypes.findBy("project_id", projectId).some((candidate) => candidate.rfi_type_id === rfi.rfi_type_id)) {
      throw new Error(`APS RFI '${rfi.id}' references unknown RFI type '${rfi.rfi_type_id}'.`);
    }

    const assignedTo = actors(aps, rfi.assigned_to);
    const status = rfi.status ?? "draft";
    const createdBy = userId(aps, rfi.created_by);
    const updatedBy = userId(aps, rfi.updated_by ?? rfi.created_by);
    const createdAt = rfi.created_at ?? now;
    const updatedAt = rfi.updated_at ?? createdAt;
    const reference = rfi.reference ?? rfi.custom_identifier;
    const priority = rfi.priority ?? "Normal";
    aps.rfis.insert({
      project_id: projectId,
      rfi_id: rfi.id,
      rfi_type_id: rfi.rfi_type_id,
      custom_identifier: rfi.custom_identifier,
      title: rfi.title,
      status,
      assigned_to: assignedTo.map((actor) => actor.id),
      reference,
      priority,
      payload: {
        id: rfi.id,
        customIdentifier: rfi.custom_identifier,
        title: rfi.title,
        question: rfi.question ?? "",
        virtualFolderUrn: `urn:adsk.wip:fs.folder:co.${Buffer.from(rfi.id).toString("base64url")}`,
        status,
        previousStatus: rfi.previous_status ?? null,
        workflowType: rfi.workflow_type ?? "US",
        assignedTo,
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
        createdBy,
        createdAt,
        updatedBy,
        updatedAt,
        closedAt: status === "closed" ? updatedAt : null,
        closedBy: status === "closed" ? updatedBy : null,
        containerId: bareProjectId(projectId),
        projectId: bareProjectId(projectId),
        suggestedAnswer: null,
        coReviewers: [],
        watchers: [],
        answeredAt: null,
        answeredBy: null,
        costImpact: "Unknown",
        scheduleImpact: "Unknown",
        priority,
        discipline: structuredClone(rfi.discipline ?? []),
        category: structuredClone(rfi.category ?? []),
        reference,
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
    if (resourceExists(aps.sheetCollections.all(), projectId, (candidate) => candidate.collection_id, collection.id)) {
      continue;
    }
    const createdAt = collection.created_at ?? now;
    aps.sheetCollections.insert({
      project_id: projectId,
      collection_id: collection.id,
      payload: {
        id: collection.id,
        name: collection.name,
        createdAt,
        createdBy: userId(aps, collection.created_by),
        createdByName: collection.created_by_name ?? "",
        updatedAt: collection.updated_at ?? createdAt,
        updatedBy: userId(aps, collection.updated_by ?? collection.created_by),
        updatedByName: collection.updated_by_name ?? collection.created_by_name ?? "",
      },
    });
  }

  for (const versionSet of config.sheet_version_sets ?? []) {
    const projectId = seedProjectId(aps, versionSet.project_id);
    if (resourceExists(aps.sheetVersionSets.all(), projectId, (candidate) => candidate.version_set_id, versionSet.id)) {
      continue;
    }
    const collection = versionSet.collection_id
      ? aps.sheetCollections
          .findBy("project_id", projectId)
          .find((candidate) => candidate.collection_id === versionSet.collection_id)
      : undefined;
    if (versionSet.collection_id && !collection) {
      throw new Error(`APS Sheet version set '${versionSet.id}' references unknown collection.`);
    }
    const createdAt = versionSet.created_at ?? now;
    aps.sheetVersionSets.insert({
      project_id: projectId,
      version_set_id: versionSet.id,
      collection_id: versionSet.collection_id ?? null,
      issuance_date: versionSet.issuance_date,
      payload: {
        id: versionSet.id,
        name: versionSet.name,
        issuanceDate: versionSet.issuance_date,
        createdAt,
        createdBy: userId(aps, versionSet.created_by),
        createdByName: versionSet.created_by_name ?? "",
        updatedAt: versionSet.updated_at ?? createdAt,
        updatedBy: userId(aps, versionSet.updated_by ?? versionSet.created_by),
        updatedByName: versionSet.updated_by_name ?? versionSet.created_by_name ?? "",
        collection: collection ? { id: collection.collection_id, name: collection.payload.name } : null,
      },
    });
  }

  for (const sheet of config.sheets ?? []) {
    const projectId = seedProjectId(aps, sheet.project_id);
    if (resourceExists(aps.sheets.all(), projectId, (candidate) => candidate.sheet_id, sheet.id)) continue;
    const versionSet = aps.sheetVersionSets
      .findBy("project_id", projectId)
      .find((candidate) => candidate.version_set_id === sheet.version_set_id);
    if (!versionSet) {
      throw new Error(`APS Sheet '${sheet.id}' references unknown version set '${sheet.version_set_id}'.`);
    }
    const collectionId = sheet.collection_id ?? versionSet.collection_id;
    const collection = collectionId
      ? aps.sheetCollections
          .findBy("project_id", projectId)
          .find((candidate) => candidate.collection_id === collectionId)
      : undefined;
    if (collectionId && !collection) {
      throw new Error(`APS Sheet '${sheet.id}' references unknown collection '${collectionId}'.`);
    }
    const createdAt = sheet.created_at ?? now;
    const deleted = sheet.deleted ?? false;
    aps.sheets.insert({
      project_id: projectId,
      sheet_id: sheet.id,
      version_set_id: sheet.version_set_id,
      collection_id: collectionId ?? null,
      number: sheet.number,
      title: sheet.title,
      tags: structuredClone(sheet.tags ?? []),
      is_current: sheet.is_current ?? true,
      deleted,
      payload: {
        id: sheet.id,
        number: sheet.number,
        versionSet: {
          id: versionSet.version_set_id,
          name: versionSet.payload.name,
          issuanceDate: versionSet.issuance_date,
          deleted: false,
        },
        createdAt,
        createdBy: userId(aps, sheet.created_by),
        createdByName: sheet.created_by_name ?? "",
        updatedAt: sheet.updated_at ?? createdAt,
        updatedBy: userId(aps, sheet.updated_by ?? sheet.created_by),
        updatedByName: sheet.updated_by_name ?? sheet.created_by_name ?? "",
        title: sheet.title,
        uploadFileName: sheet.upload_file_name ?? "",
        uploadId: sheet.upload_id ?? "",
        tags: structuredClone(sheet.tags ?? []),
        paperSize: structuredClone(sheet.paper_size ?? [0, 0]),
        isCurrent: sheet.is_current ?? true,
        deleted,
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
