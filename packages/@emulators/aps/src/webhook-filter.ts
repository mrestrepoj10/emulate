import type { ApsWebhookFilter } from "./entities.js";

type Scalar = string | number | boolean | null;

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (bracketDepth === 0 && value.slice(index, index + delimiter.length) === delimiter) {
      parts.push(value.slice(start, index).trim());
      start = index + delimiter.length;
      index += delimiter.length - 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parseScalar(value: string): Scalar | undefined {
  const trimmed = value.trim();
  if (/^'(?:[^'\\]|\\.)*'$/.test(trimmed) || /^"(?:[^"\\]|\\.)*"$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(['"\\])/g, "$1");
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return undefined;
}

function parseArray(value: string): Scalar[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const result: Scalar[] = [];
  for (const part of splitTopLevel(body, ",")) {
    const scalar = parseScalar(part);
    if (scalar === undefined) return null;
    result.push(scalar);
  }
  return result;
}

function valueAtPath(payload: Record<string, unknown>, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function evaluateClause(payload: Record<string, unknown>, clause: string): boolean | null {
  const match = clause.match(/^@\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(==|!=|>=|<=|>|<|in)\s*(.+)$/);
  if (!match) return null;
  const [, path, operator, rawExpected] = match;
  const actual = valueAtPath(payload, path!);
  if (operator === "in") {
    const expected = parseArray(rawExpected!);
    return expected ? expected.some((candidate) => candidate === actual) : null;
  }
  const expected = parseScalar(rawExpected!);
  if (expected === undefined) return null;
  if (operator === "==") return actual === expected;
  if (operator === "!=") return actual !== expected;
  if (
    (typeof actual !== "number" || typeof expected !== "number") &&
    (typeof actual !== "string" || typeof expected !== "string")
  ) {
    return false;
  }
  if (operator === ">") return actual > expected;
  if (operator === ">=") return actual >= expected;
  if (operator === "<") return actual < expected;
  return actual <= expected;
}

function evaluateFilterString(filter: string, payload: Record<string, unknown>): boolean | null {
  const trimmed = filter.trim();
  if (!trimmed.startsWith("$[?(") || !trimmed.endsWith(")]")) return null;
  const expression = trimmed.slice(4, -2).trim();
  if (!expression) return null;
  const orGroups = splitTopLevel(expression, "||");
  let valid = true;
  let result = false;
  for (const group of orGroups) {
    const clauses = splitTopLevel(group, "&&");
    let groupMatches = true;
    for (const clause of clauses) {
      const clauseResult = evaluateClause(payload, clause);
      if (clauseResult === null) valid = false;
      if (clauseResult !== true) groupMatches = false;
    }
    if (groupMatches) result = true;
  }
  return valid ? result : null;
}

export function validateWebhookFilter(filter: ApsWebhookFilter): boolean {
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.length > 0 && filters.every((candidate) => evaluateFilterString(candidate, {}) !== null);
}

export function webhookFilterMatches(filter: ApsWebhookFilter | null, payload: Record<string, unknown>): boolean {
  if (filter === null) return true;
  const filters = Array.isArray(filter) ? filter : [filter];
  return filters.every((candidate) => evaluateFilterString(candidate, payload) === true);
}
