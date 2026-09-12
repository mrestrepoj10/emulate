import type { ApsClashScenario, ApsClashScenarioVersion } from "./entities.js";

export type ClashStatus = "New" | "Existing" | "Resolved";

/** A clash identity that stays stable across model set versions. */
export interface ClashRecord {
  id: number;
  /** Stable object IDs of the left and right objects. */
  loid: number;
  roid: number;
  /** Document lineages (item IDs) of the left and right objects. */
  leftLineage: string;
  rightLineage: string;
  dist: number;
}

export interface ClashPoolRow {
  record: ClashRecord;
  status: ClashStatus;
}

export interface ClashPoolVersion {
  version: number;
  /** Rows reported in this version's clash file, ordered by clash ID. */
  rows: ClashPoolRow[];
}

const FIRST_CLASH_ID = 100_001;
const FIRST_STABLE_OBJECT_ID = 500_001;
export const LARGE_SCENARIO_CLASH_COUNT = 200_000;

/** mulberry32: a tiny seeded PRNG that yields floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDistinctIndexes(random: () => number, size: number, count: number): number[] {
  const indexes = Array.from({ length: size }, (_, index) => index);
  const picked: number[] = [];
  for (let i = 0; i < Math.min(count, size); i += 1) {
    const swap = i + Math.floor(random() * (size - i));
    [indexes[i], indexes[swap]] = [indexes[swap]!, indexes[i]!];
    picked.push(indexes[i]!);
  }
  return picked.sort((left, right) => left - right);
}

/**
 * Replays a clash scenario from version 1 and returns the clash file rows of every version.
 * The same scenario always yields the same rows; the PRNG is consumed in a fixed order.
 */
export function replayClashScenario(scenario: ApsClashScenario): ClashPoolVersion[] {
  const random = mulberry32(scenario.seed);
  let nextClashId = FIRST_CLASH_ID;
  let nextObjectId = FIRST_STABLE_OBJECT_ID;
  let alive: ClashRecord[] = [];
  const output: ClashPoolVersion[] = [];

  scenario.versions.forEach((step: ApsClashScenarioVersion, index) => {
    const version = index + 1;
    if (!step.succeeded) {
      output.push({ version, rows: [] });
      return;
    }
    const lineages = step.lineages;
    const inScope = (record: ClashRecord) =>
      lineages.includes(record.leftLineage) && lineages.includes(record.rightLineage);
    // Clashes whose documents are absent or not Succeeded in this version are not reported (no Resolved row);
    // they reappear as Existing once both documents are clashed again.
    const scoped = alive.filter(inScope);
    const outOfScope = alive.filter((record) => !inScope(record));

    const resolvedIndexes = new Set(pickDistinctIndexes(random, scoped.length, step.resolved));
    const rows: ClashPoolRow[] = scoped.map((record, position) => ({
      record,
      status: resolvedIndexes.has(position) ? "Resolved" : "Existing",
    }));
    alive = [...outOfScope, ...scoped.filter((_, position) => !resolvedIndexes.has(position))];

    const added = lineages.length >= 2 ? step.added : 0;
    for (let i = 0; i < added; i += 1) {
      const left = Math.floor(random() * lineages.length);
      const right = (left + 1 + Math.floor(random() * (lineages.length - 1))) % lineages.length;
      const record: ClashRecord = {
        id: nextClashId,
        loid: nextObjectId,
        roid: nextObjectId + 1,
        leftLineage: lineages[left]!,
        rightLineage: lineages[right]!,
        dist: Number((random() * 250).toFixed(4)),
      };
      nextClashId += 1;
      nextObjectId += 2;
      alive.push(record);
      rows.push({ record, status: "New" });
    }
    alive.sort((left, right) => left.id - right.id);
    rows.sort((left, right) => left.record.id - right.record.id);
    output.push({ version, rows });
  });

  return output;
}

/** Viewer object ID for a stable object in one document version; re-numbered per model set version. */
export function viewerObjectId(leafObjectIds: number[], stableObjectId: number, version: number): number {
  if (leafObjectIds.length === 0) return stableObjectId;
  return leafObjectIds[(stableObjectId + version) % leafObjectIds.length]!;
}
