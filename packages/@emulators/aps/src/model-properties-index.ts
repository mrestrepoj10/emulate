import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Store } from "@emulators/core";
import { bareProjectId } from "./acc.js";
import { DEFAULT_MODEL_PROPERTIES_INDEX_CONFIG, type ApsModelPropertiesIndexConfig } from "./config.js";
import {
  derivativeObjectTree,
  derivativeProperties,
  flattenDerivativeObjects,
  metadataViews,
  resolveDerivative,
  type DerivativeObject,
  type DerivativeSource,
  type MetadataView,
} from "./derivative-resources.js";
import type {
  ApsDocumentVersion,
  ApsProject,
  ApsPropertyIndex,
  ApsPropertyIndexQuery,
  ApsPropertyIndexState,
  ApsPropertyIndexType,
} from "./entities.js";
import { LMV_ID_OFFSET } from "./model-coordination.js";
import type { ApsStore } from "./store.js";

const CONFIG_KEY = "aps.modelPropertiesIndex";
const RETRY_AFTER_MS = 2_000;

// Keys of the synthetic fields the real service adds to every index. They are stable across
// real indexes, so the emulator reuses them verbatim.
export const STANDARD_FIELD_KEYS = {
  name: "p153cb174",
  schemaName: "p74a9a490",
  schemaVersion: "p137c14f2",
  isDocProperty: "p1490bcea",
  category: "p5eddc473",
  categoryId: "pa7275c45",
  parent: "p93e93af5",
  revitCategory: "p20d8441e",
  revitFamily: "p30db51f9",
  revitType: "p13b6b3a0",
} as const;

export interface ModelPropertyField {
  key: string;
  category: string;
  type: "String" | "Boolean" | "Integer" | "Double" | "DbKey";
  name: string;
  uom: string | null;
}

export interface ModelPropertyRow {
  svf2Id: number;
  lineageId: string;
  externalId: string;
  lmvId: number;
  databaseId: string;
  props: Record<string, unknown>;
  propsHash: string;
  propsIgnored: Record<string, number>;
  geomHash?: string;
  bboxMin?: { x: number; y: number; z: number };
  bboxMax?: { x: number; y: number; z: number };
  views: string[];
}

export type ModelPropertyDiffRowType = "OBJECT_ADDED" | "OBJECT_REMOVED" | "OBJECT_CHANGED";

export interface ModelPropertyDiffRow {
  type: ModelPropertyDiffRowType;
  svf2Id: number;
  lineageId: string;
  externalId: string;
  lmvId: number | null;
  databaseId: string | null;
  props: Record<string, unknown> | null;
  propsHash: string | null;
  propsIgnored: Record<string, number> | null;
  geomHash: string | null;
  bboxMin: ModelPropertyRow["bboxMin"] | null;
  bboxMax: ModelPropertyRow["bboxMax"] | null;
  views: string[];
  prev: Omit<ModelPropertyDiffRow, "type" | "svf2Id" | "lineageId" | "externalId" | "prev"> | null;
}

export interface ModelPropertySeedFile {
  lineageId: string;
  lineageUrn: string;
  versionUrn: string;
  databases: Array<{
    id: string;
    offsets: string;
    attributes: string;
    values: string;
    mapping: string;
    ids: string;
  }>;
  views: Array<{
    id: string;
    urn: string;
    is3d: boolean;
    viewableName: string;
    viewableId: string;
    viewableGuid: string;
  }>;
}

export interface ModelPropertyVersionIndex {
  version: ApsDocumentVersion;
  seedFile: ModelPropertySeedFile;
  fields: ModelPropertyField[];
  rows: ModelPropertyRow[];
}

export class ModelPropertiesQueryError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelPropertiesQueryError";
  }
}

export function getModelPropertiesIndexConfig(store: Store): ApsModelPropertiesIndexConfig {
  const configured = store.getData<Partial<ApsModelPropertiesIndexConfig>>(CONFIG_KEY) ?? {};
  return {
    ...DEFAULT_MODEL_PROPERTIES_INDEX_CONFIG,
    ...configured,
    fail_version_urns: [...(configured.fail_version_urns ?? DEFAULT_MODEL_PROPERTIES_INDEX_CONFIG.fail_version_urns)],
  };
}

export function setModelPropertiesIndexConfig(store: Store, input: Partial<ApsModelPropertiesIndexConfig>): void {
  const next = { ...getModelPropertiesIndexConfig(store), ...input };
  if (!Number.isInteger(next.processing_polls) || next.processing_polls < 0) {
    throw new Error("APS model_properties_index.processing_polls must be a non-negative integer.");
  }
  if (!Array.isArray(next.fail_version_urns) || next.fail_version_urns.some((urn) => typeof urn !== "string")) {
    throw new Error("APS model_properties_index.fail_version_urns must be a list of version URNs.");
  }
  store.setData(CONFIG_KEY, next);
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function shortHex(value: string, length = 8): string {
  return sha1(value).slice(0, length);
}

function opaqueId(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fieldKey(category: string, name: string): string {
  return `p${shortHex(`${category}\u0000${name}`)}`;
}

export function propertyIndexId(project: ApsProject, type: ApsPropertyIndexType, versionUrns: string[]): string {
  return opaqueId(`${type}:${bareProjectId(project.project_id)}:${versionUrns.join("\u0000")}`);
}

export function propertyQueryId(indexId: string, query: unknown, columns: Record<string, unknown> | null): string {
  return opaqueId(`query:${indexId}:${canonicalJson(query)}:${canonicalJson(columns)}`);
}

export function lineageIdFor(lineageUrn: string): string {
  return shortHex(lineageUrn, 7);
}

export function databaseIdFor(bubbleUrn: string): string {
  return shortHex(`database:${bubbleUrn}`);
}

export function viewIdFor(view: MetadataView): string {
  return shortHex(`view:${view.guid}`);
}

function standardField(
  key: string,
  category: string,
  name: string,
  type: ModelPropertyField["type"],
): ModelPropertyField {
  return { key, category, type, name, uom: null };
}

const DOCUMENT_FIELDS: ModelPropertyField[] = [
  standardField(STANDARD_FIELD_KEYS.name, "__name__", "name", "String"),
  standardField(STANDARD_FIELD_KEYS.schemaName, "__document__", "schema_name", "String"),
  standardField(STANDARD_FIELD_KEYS.schemaVersion, "__document__", "schema_version", "String"),
  standardField(STANDARD_FIELD_KEYS.isDocProperty, "__document__", "is_doc_property", "Boolean"),
  standardField(STANDARD_FIELD_KEYS.category, "__category__", "Category", "String"),
  standardField(STANDARD_FIELD_KEYS.categoryId, "__categoryId__", "CategoryId", "Integer"),
  standardField(STANDARD_FIELD_KEYS.parent, "__parent__", "parent", "DbKey"),
  standardField(STANDARD_FIELD_KEYS.revitCategory, "__category__", "_RC", "String"),
  standardField(STANDARD_FIELD_KEYS.revitFamily, "__category__", "_RFN", "String"),
  standardField(STANDARD_FIELD_KEYS.revitType, "__category__", "_RFT", "String"),
];

function fieldTypeFor(value: unknown): ModelPropertyField["type"] {
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "Integer" : "Double";
  return "String";
}

function bboxFor(externalId: string): Pick<ModelPropertyRow, "geomHash" | "bboxMin" | "bboxMax"> {
  const digest = sha1(`geometry:${externalId}`);
  const coordinate = (offset: number) => Number.parseInt(digest.slice(offset, offset + 4), 16) / 100;
  const min = { x: coordinate(0), y: coordinate(4), z: coordinate(8) };
  return {
    geomHash: digest.slice(12, 20),
    bboxMin: min,
    bboxMax: { x: min.x + 1 + coordinate(20) / 100, y: min.y + 1 + coordinate(24) / 100, z: min.z + 3 },
  };
}

interface FlattenedObject {
  object: DerivativeObject;
  parent: DerivativeObject | null;
  categoryNode: DerivativeObject | null;
  familyNode: DerivativeObject | null;
}

function flattenWithAncestors(objects: DerivativeObject[]): FlattenedObject[] {
  const output: FlattenedObject[] = [];
  const walk = (object: DerivativeObject, ancestors: DerivativeObject[]) => {
    const parent = ancestors.at(-1) ?? null;
    output.push({
      object,
      parent,
      categoryNode: ancestors.find((ancestor) => ancestor.category === "Category") ?? null,
      familyNode: ancestors.find((ancestor) => ancestor.category === "Family") ?? null,
    });
    for (const child of object.objects ?? []) walk(child, [...ancestors, object]);
  };
  for (const object of objects) walk(object, []);
  return output;
}

function rowsForView(
  source: DerivativeSource,
  version: ApsDocumentVersion,
  view: MetadataView,
  fields: Map<string, ModelPropertyField>,
): ModelPropertyRow[] {
  const tree = derivativeObjectTree(source, view);
  const propertyBags = new Map(
    derivativeProperties(source, view, flattenDerivativeObjects(tree)).map((entry) => [entry.objectid, entry]),
  );
  const lineageId = lineageIdFor(version.item_id);
  const databaseId = databaseIdFor(source.urn);
  const viewId = viewIdFor(view);

  return flattenWithAncestors(tree).map(({ object, parent, categoryNode, familyNode }) => {
    const bag = propertyBags.get(object.objectid)!;
    const props: Record<string, unknown> = {
      [STANDARD_FIELD_KEYS.name]: object.name,
      [STANDARD_FIELD_KEYS.category]: object.category === "Model" ? "Revit Document" : `Revit ${object.category}`,
    };
    if (object.category === "Model") {
      props[STANDARD_FIELD_KEYS.schemaName] = version.file_type;
      props[STANDARD_FIELD_KEYS.schemaVersion] = "1.0";
      props[STANDARD_FIELD_KEYS.isDocProperty] = true;
    }
    if (object.category === "Instance") {
      props[STANDARD_FIELD_KEYS.categoryId] = -2_000_000 - (Number.parseInt(shortHex(object.category, 3), 16) % 2_000);
      props[STANDARD_FIELD_KEYS.revitCategory] = categoryNode?.name ?? object.category;
      props[STANDARD_FIELD_KEYS.revitFamily] = familyNode?.name ?? source.name;
      props[STANDARD_FIELD_KEYS.revitType] = `${familyNode?.name ?? source.name} Type`;
    }
    for (const [category, values] of Object.entries(bag.properties)) {
      for (const [name, value] of Object.entries(values)) {
        const key = fieldKey(category, name);
        if (!fields.has(key)) fields.set(key, { key, category, type: fieldTypeFor(value), name, uom: null });
        props[key] = value;
      }
    }
    const propsIgnored: Record<string, number> = {};
    if (parent) propsIgnored[STANDARD_FIELD_KEYS.parent] = parent.objectid;
    const viewable = object.category === "Instance";
    return {
      svf2Id: object.objectid,
      lineageId,
      externalId: bag.externalId,
      lmvId: object.objectid + LMV_ID_OFFSET,
      databaseId,
      props,
      propsHash: shortHex(canonicalJson(props)),
      propsIgnored,
      ...(viewable ? bboxFor(bag.externalId) : {}),
      views: viewable ? [viewId] : [],
    };
  });
}

function seedFileFor(
  source: DerivativeSource,
  version: ApsDocumentVersion,
  views: MetadataView[],
): ModelPropertySeedFile {
  const resource = (name: string) => `urn:adsk.viewing:fs.file:${source.urn}/output/Resource/objects_${name}.json.gz`;
  return {
    lineageId: lineageIdFor(version.item_id),
    lineageUrn: version.item_id,
    versionUrn: version.version_id,
    databases: [
      {
        id: databaseIdFor(source.urn),
        offsets: resource("offs"),
        attributes: resource("attrs"),
        values: resource("vals"),
        mapping: resource("avs"),
        ids: resource("ids"),
      },
    ],
    views: views.map((view) => ({
      id: viewIdFor(view),
      urn: version.version_id,
      is3d: view.role === "3d",
      viewableName: view.role === "3d" ? "{3D}" : view.name,
      viewableId: view.role === "3d" ? version.viewable_id : `${version.viewable_id}-${viewIdFor(view)}`,
      viewableGuid: view.guid,
    })),
  };
}

export type VersionIndexResolution =
  | { kind: "ready"; index: ModelPropertyVersionIndex }
  | { kind: "pending"; version: ApsDocumentVersion }
  | { kind: "failed"; detail: string };

/**
 * Builds the index rows for one file version from the same Model Derivative fixtures the
 * metadata endpoints serve, so svf2Id and externalId agree with `GET .../metadata/:guid/properties`.
 */
export async function resolveVersionIndex(
  aps: ApsStore,
  store: Store,
  project: ApsProject,
  versionUrn: string,
): Promise<VersionIndexResolution> {
  const version = aps.documentVersions.findOneBy("version_id", versionUrn);
  if (!version || version.project_id !== project.project_id) {
    return { kind: "failed", detail: `The file version '${versionUrn}' was not found in the project.` };
  }
  if (getModelPropertiesIndexConfig(store).fail_version_urns.includes(versionUrn)) {
    return { kind: "failed", detail: `Indexing is configured to fail for '${versionUrn}'.` };
  }
  if (!version.bubble_urn) {
    return { kind: "failed", detail: `The file version '${versionUrn}' has no SVF2 derivative to index.` };
  }
  const derivative = await resolveDerivative(aps, store, version.bubble_urn);
  if (derivative.state === "missing") {
    return { kind: "failed", detail: `The file version '${versionUrn}' has no translation manifest.` };
  }
  if (derivative.state === "pending") return { kind: "pending", version };
  if (derivative.state === "failed") {
    return { kind: "failed", detail: `The SVF2 translation for '${versionUrn}' failed.` };
  }
  const source: DerivativeSource = { ...derivative.source, version };
  const views = metadataViews(aps, source);
  const fields = new Map(DOCUMENT_FIELDS.map((field) => [field.key, field]));
  const rows = views.flatMap((view) => rowsForView(source, version, view, fields));
  return {
    kind: "ready",
    index: { version, seedFile: seedFileFor(source, version, views), fields: [...fields.values()], rows },
  };
}

function previousSnapshot(row: ModelPropertyRow, props: Record<string, unknown>): ModelPropertyDiffRow["prev"] {
  return {
    lmvId: row.lmvId,
    databaseId: row.databaseId,
    props,
    propsHash: row.propsHash,
    propsIgnored: row.propsIgnored,
    geomHash: row.geomHash ?? null,
    bboxMin: row.bboxMin ?? null,
    bboxMax: row.bboxMax ?? null,
    views: row.views,
  };
}

export function diffRows(previous: ModelPropertyRow[], current: ModelPropertyRow[]): ModelPropertyDiffRow[] {
  const previousByExternalId = new Map(previous.map((row) => [row.externalId, row]));
  const output: ModelPropertyDiffRow[] = [];
  for (const row of current) {
    const before = previousByExternalId.get(row.externalId);
    previousByExternalId.delete(row.externalId);
    if (before && before.propsHash === row.propsHash && before.geomHash === row.geomHash) continue;
    const changedProps = before
      ? Object.fromEntries(
          Object.entries(before.props).filter(([key, value]) => canonicalJson(value) !== canonicalJson(row.props[key])),
        )
      : {};
    output.push({
      type: before ? "OBJECT_CHANGED" : "OBJECT_ADDED",
      svf2Id: row.svf2Id,
      lineageId: row.lineageId,
      externalId: row.externalId,
      lmvId: row.lmvId,
      databaseId: row.databaseId,
      props: row.props,
      propsHash: row.propsHash,
      propsIgnored: row.propsIgnored,
      geomHash: row.geomHash ?? null,
      bboxMin: row.bboxMin ?? null,
      bboxMax: row.bboxMax ?? null,
      views: row.views,
      prev: before ? previousSnapshot(before, changedProps) : null,
    });
  }
  for (const row of previousByExternalId.values()) {
    output.push({
      type: "OBJECT_REMOVED",
      svf2Id: row.svf2Id,
      lineageId: row.lineageId,
      externalId: row.externalId,
      lmvId: null,
      databaseId: null,
      props: null,
      propsHash: null,
      propsIgnored: null,
      geomHash: null,
      bboxMin: null,
      bboxMax: null,
      views: [],
      prev: previousSnapshot(row, row.props),
    });
  }
  return output;
}

export interface ResolvedPropertyIndex {
  index: ApsPropertyIndex;
  versions: ModelPropertyVersionIndex[];
  fields: ModelPropertyField[];
  rows: Array<ModelPropertyRow | ModelPropertyDiffRow>;
  stats: Record<string, number>;
}

async function resolvePropertyIndex(
  aps: ApsStore,
  store: Store,
  project: ApsProject,
  index: ApsPropertyIndex,
): Promise<
  { kind: "ready"; resolved: ResolvedPropertyIndex } | { kind: "pending" } | { kind: "failed"; detail: string }
> {
  const versions: ModelPropertyVersionIndex[] = [];
  for (const versionUrn of index.version_urns) {
    const resolution = await resolveVersionIndex(aps, store, project, versionUrn);
    if (resolution.kind !== "ready") return resolution;
    versions.push(resolution.index);
  }
  const fields = new Map<string, ModelPropertyField>();
  for (const version of versions) for (const field of version.fields) fields.set(field.key, field);
  if (index.type === "DIFF") {
    const [previous, current] = versions;
    const rows = diffRows(previous?.rows ?? [], current?.rows ?? []);
    const count = (type: ModelPropertyDiffRowType) => rows.filter((row) => row.type === type).length;
    return {
      kind: "ready",
      resolved: {
        index,
        versions,
        fields: [...fields.values()],
        rows,
        stats: { added: count("OBJECT_ADDED"), removed: count("OBJECT_REMOVED"), modified: count("OBJECT_CHANGED") },
      },
    };
  }
  const rows = versions.flatMap((version) => version.rows);
  return {
    kind: "ready",
    resolved: { index, versions, fields: [...fields.values()], rows, stats: { objects: rows.length } },
  };
}

export function ensurePropertyIndex(
  aps: ApsStore,
  project: ApsProject,
  type: ApsPropertyIndexType,
  versionUrns: string[],
): ApsPropertyIndex {
  const indexId = propertyIndexId(project, type, versionUrns);
  const existing = aps.propertyIndexes
    .findBy("index_id", indexId)
    .find((candidate) => candidate.project_id === project.project_id);
  if (existing) return existing;
  const now = new Date().toISOString();
  return aps.propertyIndexes.insert({
    project_id: project.project_id,
    index_id: indexId,
    type,
    version_urns: [...versionUrns],
    prev_version_urns: type === "DIFF" ? [versionUrns[0]!] : [],
    cur_version_urns: type === "DIFF" ? [versionUrns[1]!] : [],
    state: "PROCESSING",
    polls: 0,
    failure: null,
    requested_at: now,
    state_changed_at: now,
  });
}

export function findPropertyIndex(aps: ApsStore, project: ApsProject, indexId: string): ApsPropertyIndex | undefined {
  return aps.propertyIndexes
    .findBy("index_id", indexId)
    .find((candidate) => candidate.project_id === project.project_id);
}

function terminal(state: ApsPropertyIndexState): boolean {
  return state !== "PROCESSING";
}

/**
 * Observes an index job. Each observation counts as one poll: the job reports PROCESSING for
 * `processing_polls` observations, then settles into FINISHED or FAILED without any timers.
 */
export async function observePropertyIndex(
  aps: ApsStore,
  store: Store,
  project: ApsProject,
  index: ApsPropertyIndex,
): Promise<ApsPropertyIndex> {
  if (terminal(index.state)) return index;
  const polls = index.polls + 1;
  const now = new Date().toISOString();
  if (polls <= getModelPropertiesIndexConfig(store).processing_polls) {
    return aps.propertyIndexes.update(index.id, { polls }) ?? index;
  }
  const resolution = await resolvePropertyIndex(aps, store, project, index);
  if (resolution.kind === "pending") return aps.propertyIndexes.update(index.id, { polls }) ?? index;
  const next: Partial<ApsPropertyIndex> =
    resolution.kind === "failed"
      ? { polls, state: "FAILED", failure: resolution.detail, state_changed_at: now }
      : { polls, state: "FINISHED", state_changed_at: now };
  return aps.propertyIndexes.update(index.id, next) ?? index;
}

export async function resolveFinishedPropertyIndex(
  aps: ApsStore,
  store: Store,
  project: ApsProject,
  index: ApsPropertyIndex,
): Promise<ResolvedPropertyIndex | undefined> {
  if (index.state !== "FINISHED") return undefined;
  const resolution = await resolvePropertyIndex(aps, store, project, index);
  return resolution.kind === "ready" ? resolution.resolved : undefined;
}

export function ensurePropertyQuery(
  aps: ApsStore,
  index: ApsPropertyIndex,
  query: unknown,
  columns: Record<string, unknown> | null,
): ApsPropertyIndexQuery {
  const queryId = propertyQueryId(index.index_id, query, columns);
  const existing = aps.propertyIndexQueries
    .findBy("index_id", index.index_id)
    .find((candidate) => candidate.query_id === queryId && candidate.project_id === index.project_id);
  if (existing) return existing;
  const now = new Date().toISOString();
  return aps.propertyIndexQueries.insert({
    project_id: index.project_id,
    index_id: index.index_id,
    query_id: queryId,
    query: structuredClone(query),
    columns: columns ? structuredClone(columns) : null,
    state: "PROCESSING",
    polls: 0,
    failure: null,
    requested_at: now,
    state_changed_at: now,
  });
}

export function findPropertyQuery(
  aps: ApsStore,
  index: ApsPropertyIndex,
  queryId: string,
): ApsPropertyIndexQuery | undefined {
  return aps.propertyIndexQueries
    .findBy("index_id", index.index_id)
    .find((candidate) => candidate.query_id === queryId && candidate.project_id === index.project_id);
}

export async function observePropertyQuery(
  aps: ApsStore,
  store: Store,
  project: ApsProject,
  index: ApsPropertyIndex,
  query: ApsPropertyIndexQuery,
): Promise<{ index: ApsPropertyIndex; query: ApsPropertyIndexQuery }> {
  const observedIndex = await observePropertyIndex(aps, store, project, index);
  if (terminal(query.state)) return { index: observedIndex, query };
  const polls = query.polls + 1;
  const now = new Date().toISOString();
  let next: Partial<ApsPropertyIndexQuery> = { polls };
  if (observedIndex.state === "FAILED") {
    next = { polls, state: "FAILED", failure: observedIndex.failure, state_changed_at: now };
  } else if (observedIndex.state === "FINISHED" && polls > getModelPropertiesIndexConfig(store).processing_polls) {
    next = { polls, state: "FINISHED", state_changed_at: now };
  }
  return { index: observedIndex, query: aps.propertyIndexQueries.update(query.id, next) ?? query };
}

// ---------------------------------------------------------------------------------------------
// Query language: the JSON AST subset consumers use against index rows.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const SUPPORTED_CONDITIONS = new Set([
  "$and",
  "$or",
  "$not",
  "$eq",
  "$ne",
  "$lt",
  "$le",
  "$gt",
  "$ge",
  "$in",
  "$like",
  "$isnull",
  "$notnull",
]);
const SUPPORTED_EXPRESSIONS = new Set(["$count", "$lower", "$upper", "$to_string", "$coalesce"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePath(row: Row, path: string): unknown {
  const segments = path.split(".");
  if (segments[0] === "s") segments.shift();
  let current: unknown = row;
  for (const segment of segments) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return current === undefined ? null : current;
}

function unsupported(field: string, operator: string): never {
  throw new ModelPropertiesQueryError(field, `The operator '${operator}' is not supported.`);
}

export function evaluateExpression(row: Row, expression: unknown, field = "query"): unknown {
  if (typeof expression === "string") {
    if (expression.startsWith("'")) {
      if (!expression.endsWith("'") || expression.length < 2) {
        throw new ModelPropertiesQueryError(field, `The string literal ${expression} must be single quoted.`);
      }
      return expression.slice(1, -1).replaceAll("''", "'");
    }
    return resolvePath(row, expression.trim());
  }
  if (typeof expression === "number" || typeof expression === "boolean" || expression === null) return expression;
  if (Array.isArray(expression)) {
    throw new ModelPropertiesQueryError(field, "Arrays are not valid expressions.");
  }
  if (!isPlainObject(expression)) {
    throw new ModelPropertiesQueryError(field, "Expressions must be literals, property paths, or operator objects.");
  }
  const entries = Object.entries(expression);
  if (entries.length !== 1) {
    throw new ModelPropertiesQueryError(field, "Expression objects must contain exactly one operator.");
  }
  const [operator, operand] = entries[0]!;
  switch (operator) {
    case "$count": {
      const value = evaluateExpression(row, operand, field);
      return Array.isArray(value) ? value.length : value === null ? 0 : 1;
    }
    case "$lower":
    case "$upper": {
      const value = evaluateExpression(row, operand, field);
      if (value === null) return null;
      return operator === "$lower" ? String(value).toLowerCase() : String(value).toUpperCase();
    }
    case "$to_string": {
      const value = evaluateExpression(row, operand, field);
      return value === null ? null : String(value);
    }
    case "$coalesce": {
      if (!Array.isArray(operand)) throw new ModelPropertiesQueryError(field, "$coalesce expects an array.");
      for (const candidate of operand) {
        const value = evaluateExpression(row, candidate, field);
        if (value !== null) return value;
      }
      return null;
    }
    default:
      if (SUPPORTED_CONDITIONS.has(operator)) return evaluateCondition(row, expression, field);
      return unsupported(field, operator);
  }
}

function compare(left: unknown, right: unknown): number | null {
  if (left === null || right === null || left === undefined || right === undefined) return null;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number" || typeof right === "number") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) return null;
    return leftNumber - rightNumber;
  }
  if (typeof left === "boolean" || typeof right === "boolean") return left === right ? 0 : null;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function binaryOperands(operand: unknown, operator: string, field: string): [unknown, unknown] {
  if (!Array.isArray(operand) || operand.length !== 2) {
    throw new ModelPropertiesQueryError(field, `${operator} expects an array of two expressions.`);
  }
  return [operand[0], operand[1]];
}

function likeMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

export function evaluateCondition(row: Row, condition: unknown, field = "query"): boolean {
  if (typeof condition === "boolean") return condition;
  if (Array.isArray(condition)) return condition.some((child) => evaluateCondition(row, child, field));
  if (!isPlainObject(condition)) {
    throw new ModelPropertiesQueryError(field, "Conditions must be booleans, arrays, or operator objects.");
  }
  return Object.entries(condition).every(([operator, operand]) => {
    if (!operator.startsWith("$")) {
      const left = resolvePath(row, operator.trim());
      return compare(left, evaluateExpression(row, operand, field)) === 0;
    }
    switch (operator) {
      case "$and":
        if (!Array.isArray(operand)) throw new ModelPropertiesQueryError(field, "$and expects an array.");
        return operand.every((child) => evaluateCondition(row, child, field));
      case "$or":
        if (!Array.isArray(operand)) throw new ModelPropertiesQueryError(field, "$or expects an array.");
        return operand.some((child) => evaluateCondition(row, child, field));
      case "$not":
        return !evaluateCondition(row, operand, field);
      case "$eq":
      case "$ne":
      case "$lt":
      case "$le":
      case "$gt":
      case "$ge": {
        const [left, right] = binaryOperands(operand, operator, field);
        const result = compare(evaluateExpression(row, left, field), evaluateExpression(row, right, field));
        if (result === null) return false;
        if (operator === "$eq") return result === 0;
        if (operator === "$ne") return result !== 0;
        if (operator === "$lt") return result < 0;
        if (operator === "$le") return result <= 0;
        if (operator === "$gt") return result > 0;
        return result >= 0;
      }
      case "$in": {
        let subject: unknown;
        let candidates: unknown[];
        if (Array.isArray(operand)) {
          if (operand.length < 2) throw new ModelPropertiesQueryError(field, "$in expects a subject and values.");
          subject = evaluateExpression(row, operand[0], field);
          candidates = operand.slice(1);
        } else if (isPlainObject(operand) && Object.keys(operand).length === 1) {
          const [path, values] = Object.entries(operand)[0]!;
          if (!Array.isArray(values)) throw new ModelPropertiesQueryError(field, "$in expects an array of values.");
          subject = resolvePath(row, path.trim());
          candidates = values;
        } else {
          throw new ModelPropertiesQueryError(field, "$in expects an array or a single property object.");
        }
        return candidates.some((candidate) => compare(subject, evaluateExpression(row, candidate, field)) === 0);
      }
      case "$like": {
        const [left, right] = binaryOperands(operand, operator, field);
        const value = evaluateExpression(row, left, field);
        const pattern = evaluateExpression(row, right, field);
        if (value === null || pattern === null) return false;
        return likeMatches(String(value), String(pattern));
      }
      case "$isnull":
        return evaluateExpression(row, operand, field) === null;
      case "$notnull":
        return evaluateExpression(row, operand, field) !== null;
      default:
        return unsupported(field, operator);
    }
  });
}

/** Throws ModelPropertiesQueryError when the query or columns use unsupported syntax. */
export function validateQuery(query: unknown, columns: Record<string, unknown> | null): void {
  const probe: Row = { svf2Id: 0, lmvId: 0, externalId: "", lineageId: "", databaseId: "", props: {}, views: [] };
  evaluateCondition(probe, query, "query");
  if (columns) projectRow(probe, columns);
}

function columnName(alias: string): string {
  const trimmed = alias.trim();
  const path = trimmed.startsWith("s.") ? trimmed.slice(2) : trimmed;
  return path.split(".").at(-1) ?? path;
}

export function projectRow(row: Row, columns: Record<string, unknown> | null): Row {
  if (!columns) return row;
  const output: Row = {};
  for (const [alias, expression] of Object.entries(columns)) {
    if (expression === true) {
      output[columnName(alias)] = resolvePath(row, alias.trim());
    } else if (expression === false) {
      continue;
    } else {
      output[alias] = evaluateExpression(row, expression, "columns");
    }
  }
  return output;
}

export function runQuery(rows: object[], query: unknown, columns: Record<string, unknown> | null): Row[] {
  return rows
    .map((row) => row as Row)
    .filter((row) => evaluateCondition(row, query))
    .map((row) => projectRow(row, columns));
}

export function ndjsonGzip(rows: unknown[]): Buffer {
  return gzipSync(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

export const RETRY_AFTER_MILLISECONDS = RETRY_AFTER_MS;

export function supportedQueryOperators(): string[] {
  return [...SUPPORTED_CONDITIONS, ...SUPPORTED_EXPRESSIONS].sort();
}
