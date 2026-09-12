import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { bareProjectId, projectForAccId } from "../acc.js";
import { apsAuth } from "../auth.js";
import type { ApsProject, ApsPropertyIndex, ApsPropertyIndexQuery, ApsPropertyIndexType } from "../entities.js";
import { isRecordObject, jsonObjectBody, optionalString } from "../helpers.js";
import {
  ensurePropertyIndex,
  ensurePropertyQuery,
  findPropertyIndex,
  findPropertyQuery,
  ModelPropertiesQueryError,
  ndjsonGzip,
  observePropertyIndex,
  observePropertyQuery,
  resolveFinishedPropertyIndex,
  RETRY_AFTER_MILLISECONDS,
  runQuery,
  validateQuery,
  type ResolvedPropertyIndex,
} from "../model-properties-index.js";
import { badInput, notFound, problem } from "../problem.js";
import { getApsStore } from "../store.js";

const MAX_BATCH_ITEMS = 1000;
const IMMUTABLE_CACHE = "public, max-age=2592000, immutable";

interface IndexKind {
  type: ApsPropertyIndexType;
  segment: "indexes" | "diffs";
  collection: "indexes" | "diffs";
  idField: "indexId" | "diffId";
  idParam: "indexId" | "diffId";
}

const INDEX_KIND: IndexKind = {
  type: "INDEX",
  segment: "indexes",
  collection: "indexes",
  idField: "indexId",
  idParam: "indexId",
};
const DIFF_KIND: IndexKind = {
  type: "DIFF",
  segment: "diffs",
  collection: "diffs",
  idField: "diffId",
  idParam: "diffId",
};

interface BatchItem {
  versionUrns: string[];
  query: unknown;
  columns: Record<string, unknown> | null;
}

type ParsedBatch = { ok: true; items: BatchItem[] } | { ok: false; field: string; detail: string };

function parseBatch(kind: IndexKind, body: Record<string, unknown>): ParsedBatch {
  const field = kind.collection === "indexes" ? "versions" : "diffs";
  const list = body[field];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BATCH_ITEMS) {
    return { ok: false, field, detail: `${field} must contain between 1 and ${MAX_BATCH_ITEMS} items.` };
  }
  const items: BatchItem[] = [];
  for (const [position, entry] of list.entries()) {
    if (!isRecordObject(entry))
      return { ok: false, field: `${field}[${position}]`, detail: "Each item must be an object." };
    const urnFields = kind.type === "INDEX" ? ["versionUrn"] : ["prevVersionUrn", "curVersionUrn"];
    const versionUrns: string[] = [];
    for (const urnField of urnFields) {
      const urn = optionalString(entry[urnField]);
      if (!urn) return { ok: false, field: `${field}[${position}].${urnField}`, detail: `${urnField} is required.` };
      versionUrns.push(urn);
    }
    const columns = entry.columns === undefined || entry.columns === null ? null : entry.columns;
    if (columns !== null && !isRecordObject(columns)) {
      return { ok: false, field: `${field}[${position}].columns`, detail: "columns must be an object." };
    }
    const hasQuery = entry.query !== undefined && entry.query !== null;
    if (!hasQuery && columns !== null) {
      return { ok: false, field: `${field}[${position}].query`, detail: "columns require a query." };
    }
    items.push({ versionUrns, query: hasQuery ? entry.query : undefined, columns });
  }
  return { ok: true, items };
}

function queryError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof ModelPropertiesQueryError) return badInput(c, error.field, error.message);
  throw error;
}

export function modelPropertiesIndexRoutes({ app, store, baseUrl }: RouteContext): void {
  const aps = getApsStore(store);
  app.use("/construction/index/v2/*", apsAuth(store, { scopes: ["data:read"], requireUser: true }));

  const projectUrl = (project: ApsProject) =>
    `${baseUrl}/construction/index/v2/projects/${bareProjectId(project.project_id)}`;
  const indexUrl = (kind: IndexKind, project: ApsProject, index: ApsPropertyIndex) =>
    `${projectUrl(project)}/${kind.segment}/${index.index_id}`;

  const retryAt = () => new Date(Date.now() + RETRY_AFTER_MILLISECONDS).toISOString();

  const errorsFor = (failure: string | null) =>
    failure === null ? [] : [{ type: "IndexingFailed", title: "The indexing job failed", detail: failure, errors: [] }];

  const statusPayload = (
    kind: IndexKind,
    project: ApsProject,
    index: ApsPropertyIndex,
    resolved: ResolvedPropertyIndex | undefined,
    query?: ApsPropertyIndexQuery,
  ) => {
    const self = indexUrl(kind, project, index);
    const job = query ?? index;
    const finished = job.state === "FINISHED";
    return {
      projectId: bareProjectId(project.project_id),
      [kind.idField]: index.index_id,
      ...(query ? { queryId: query.query_id } : {}),
      type: kind.type,
      state: job.state,
      selfUrl: query ? `${self}/queries/${query.query_id}` : self,
      ...(kind.type === "INDEX"
        ? { versionUrns: [...index.version_urns] }
        : { prevVersionUrns: [...index.prev_version_urns], curVersionUrns: [...index.cur_version_urns] }),
      updatedAt: job.state_changed_at,
      retryAt: retryAt(),
      stats: finished && resolved ? resolved.stats : null,
      manifestUrl: finished ? `${self}/manifest` : null,
      fieldsUrl: finished ? `${self}/fields` : null,
      propertiesUrl: finished ? `${self}/properties` : null,
      ...(query ? { queryResultsUrl: finished ? `${self}/queries/${query.query_id}/properties` : null } : {}),
      errors: errorsFor(job.failure),
    };
  };

  const projectForRequest = (c: Context<AppEnv>): ApsProject | Response => {
    const projectId = c.req.param("projectId");
    const result = projectForAccId(aps, projectId, "bare");
    if (result.kind === "invalid") {
      return badInput(c, "projectId", `The value '${projectId}' must not include the 'b.' prefix.`);
    }
    if (result.kind === "missing") return notFound(c, "The requested project");
    return result.project;
  };

  const indexForRequest = (c: Context<AppEnv>, kind: IndexKind, project: ApsProject): ApsPropertyIndex | Response => {
    const index = findPropertyIndex(aps, project, c.req.param(kind.idParam));
    if (!index || index.type !== kind.type)
      return notFound(c, `The requested ${kind.type === "INDEX" ? "index" : "diff"}`);
    return index;
  };

  const queryForRequest = (c: Context<AppEnv>, index: ApsPropertyIndex): ApsPropertyIndexQuery | Response => {
    const query = findPropertyQuery(aps, index, c.req.param("queryId"));
    return query ?? notFound(c, "The requested query");
  };

  const gzipResource = (c: Context<AppEnv>, body: Buffer) =>
    c.body(new Uint8Array(body), 200, {
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "Content-Length": String(body.length),
      "Cache-Control": IMMUTABLE_CACHE,
    });

  const finishedResource = async (
    c: Context<AppEnv>,
    kind: IndexKind,
    handler: (project: ApsProject, index: ApsPropertyIndex, resolved: ResolvedPropertyIndex) => Response,
  ): Promise<Response> => {
    const project = projectForRequest(c);
    if (project instanceof Response) return project;
    const index = indexForRequest(c, kind, project);
    if (index instanceof Response) return index;
    const resolved = await resolveFinishedPropertyIndex(aps, store, project, index);
    if (!resolved) return notFound(c, "The requested index resource");
    return handler(project, index, resolved);
  };

  const manifestPayload = (project: ApsProject, index: ApsPropertyIndex, resolved: ResolvedPropertyIndex) => ({
    schema: "2.0.0",
    projectId: bareProjectId(project.project_id),
    status: "Succeeded",
    createdAt: index.state_changed_at,
    seedFiles: resolved.versions.map((version) => version.seedFile),
    errors: [],
    stats: { ...resolved.stats, contentLength: ndjsonGzip(resolved.rows).length },
  });

  const register = (kind: IndexKind) => {
    const root = `/construction/index/v2/projects/:projectId/${kind.segment}`;

    app.post(`${root}:batch-status`, async (c) => {
      const project = projectForRequest(c);
      if (project instanceof Response) return project;
      if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
        return problem(c, 415, {
          type: "UnsupportedMediaType",
          title: "The request media type is not supported",
          detail: "The Content-Type header must be application/json.",
        });
      }
      const body = await jsonObjectBody(c);
      if (!body) return badInput(c, "body", "The request body must be a JSON object.");
      const parsed = parseBatch(kind, body);
      if (!parsed.ok) return badInput(c, parsed.field, parsed.detail);
      const field = kind.collection === "indexes" ? "versions" : "diffs";
      for (const [position, item] of parsed.items.entries()) {
        if (item.query === undefined) continue;
        try {
          validateQuery(item.query, item.columns);
        } catch (error) {
          if (error instanceof ModelPropertiesQueryError) {
            return badInput(c, `${field}[${position}].${error.field}`, error.message);
          }
          throw error;
        }
      }

      const statuses = [];
      for (const item of parsed.items) {
        const index = await observePropertyIndex(
          aps,
          store,
          project,
          ensurePropertyIndex(aps, project, kind.type, item.versionUrns),
        );
        if (item.query === undefined) {
          statuses.push(
            statusPayload(kind, project, index, await resolveFinishedPropertyIndex(aps, store, project, index)),
          );
          continue;
        }
        const observed = await observePropertyQuery(
          aps,
          store,
          project,
          index,
          ensurePropertyQuery(aps, index, item.query, item.columns),
        );
        const resolved = await resolveFinishedPropertyIndex(aps, store, project, observed.index);
        statuses.push(statusPayload(kind, project, observed.index, resolved, observed.query));
      }
      return c.json({ [kind.collection]: statuses });
    });

    app.get(`${root}/:${kind.idParam}`, async (c) => {
      const project = projectForRequest(c);
      if (project instanceof Response) return project;
      const found = indexForRequest(c, kind, project);
      if (found instanceof Response) return found;
      const index = await observePropertyIndex(aps, store, project, found);
      return c.json(
        statusPayload(kind, project, index, await resolveFinishedPropertyIndex(aps, store, project, index)),
      );
    });

    app.get(`${root}/:${kind.idParam}/manifest`, (c) =>
      finishedResource(c, kind, (project, index, resolved) =>
        c.json(manifestPayload(project, index, resolved), 200, { "Cache-Control": IMMUTABLE_CACHE }),
      ),
    );

    app.get(`${root}/:${kind.idParam}/fields`, (c) =>
      finishedResource(c, kind, (_project, _index, resolved) => gzipResource(c, ndjsonGzip(resolved.fields))),
    );

    app.get(`${root}/:${kind.idParam}/properties`, (c) =>
      finishedResource(c, kind, (_project, _index, resolved) => gzipResource(c, ndjsonGzip(resolved.rows))),
    );

    app.post(`${root}/:${kind.idParam}/queries`, async (c) => {
      const project = projectForRequest(c);
      if (project instanceof Response) return project;
      const found = indexForRequest(c, kind, project);
      if (found instanceof Response) return found;
      const body = await jsonObjectBody(c);
      if (!body) return badInput(c, "body", "The request body must be a JSON object.");
      const query = body.query ?? body.statement;
      if (query === undefined || query === null) return badInput(c, "query", "query is required.");
      const columns = body.columns === undefined || body.columns === null ? null : body.columns;
      if (columns !== null && !isRecordObject(columns)) return badInput(c, "columns", "columns must be an object.");
      try {
        validateQuery(query, columns);
      } catch (error) {
        return queryError(c, error);
      }
      const observed = await observePropertyQuery(
        aps,
        store,
        project,
        found,
        ensurePropertyQuery(aps, found, query, columns),
      );
      const resolved = await resolveFinishedPropertyIndex(aps, store, project, observed.index);
      return c.json(statusPayload(kind, project, observed.index, resolved, observed.query));
    });

    app.get(`${root}/:${kind.idParam}/queries/:queryId`, async (c) => {
      const project = projectForRequest(c);
      if (project instanceof Response) return project;
      const found = indexForRequest(c, kind, project);
      if (found instanceof Response) return found;
      const query = queryForRequest(c, found);
      if (query instanceof Response) return query;
      const observed = await observePropertyQuery(aps, store, project, found, query);
      const resolved = await resolveFinishedPropertyIndex(aps, store, project, observed.index);
      return c.json(statusPayload(kind, project, observed.index, resolved, observed.query));
    });

    app.get(`${root}/:${kind.idParam}/queries/:queryId/properties`, (c) =>
      finishedResource(c, kind, (_project, index, resolved) => {
        const query = queryForRequest(c, index);
        if (query instanceof Response) return query;
        if (query.state !== "FINISHED") return notFound(c, "The requested query result");
        const rows = runQuery(resolved.rows, query.query, query.columns);
        return gzipResource(c, ndjsonGzip(rows));
      }),
    );
  };

  register(INDEX_KIND);
  register(DIFF_KIND);
}
