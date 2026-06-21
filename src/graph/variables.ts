import type { PhysicsGraph, VariableDefinition } from "./types";

export type VariableValues = Record<string, number>;

export function getVariableDefaults(graph: PhysicsGraph): VariableValues {
  return Object.fromEntries(
    (graph.variables ?? []).map((variable) => [variable.id, clampVariableValue(variable, variable.default)])
  );
}

export function mergeVariableValues(graph: PhysicsGraph, current: VariableValues): VariableValues {
  return Object.fromEntries(
    (graph.variables ?? []).map((variable) => [
      variable.id,
      clampVariableValue(variable, current[variable.id] ?? variable.default),
    ])
  );
}

export function materializeGraphVariables(graph: PhysicsGraph, values: VariableValues): PhysicsGraph {
  if (!graph.variables || graph.variables.length === 0) return graph;

  const materialized = structuredClone(graph);
  for (const variable of materialized.variables ?? []) {
    const value = clampVariableValue(variable, values[variable.id] ?? variable.default);
    for (const binding of variable.bindings) {
      setByPath(materialized, binding.path, value);
    }
  }
  return materialized;
}

function clampVariableValue(variable: VariableDefinition, value: number): number {
  if (!Number.isFinite(value)) return variable.default;
  return Math.min(variable.max, Math.max(variable.min, value));
}

function setByPath(target: unknown, path: string, value: number): void {
  const segments = parsePath(path);
  if (segments.length === 0) return;

  let current: unknown = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = readSegment(current, segments[i]);
    if (current == null) return;
  }

  writeSegment(current, segments[segments.length - 1], value);
}

type PathSegment =
  | { kind: "property"; key: string }
  | { kind: "index"; index: number }
  | { kind: "id"; collection: string; id: string };

function parsePath(path: string): PathSegment[] {
  return path.split(".").flatMap((raw) => parseRawSegment(raw.trim())).filter(Boolean);
}

function parseRawSegment(raw: string): PathSegment[] {
  if (!raw) return [];

  const idMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\[id=([A-Za-z_][A-Za-z0-9_-]*)\]$/);
  if (idMatch) return [{ kind: "id", collection: idMatch[1], id: idMatch[2] }];

  const indexMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\[(\d+)\]$/);
  if (indexMatch) {
    return [
      { kind: "property", key: indexMatch[1] },
      { kind: "index", index: Number(indexMatch[2]) },
    ];
  }

  const bareIndex = raw.match(/^\[(\d+)\]$/);
  if (bareIndex) return [{ kind: "index", index: Number(bareIndex[1]) }];

  return [{ kind: "property", key: raw }];
}

function readSegment(target: unknown, segment: PathSegment): unknown {
  if (segment.kind === "property") {
    return isRecord(target) ? target[segment.key] : undefined;
  }
  if (segment.kind === "index") {
    return Array.isArray(target) ? target[segment.index] : undefined;
  }
  if (!isRecord(target)) return undefined;
  const collection = target[segment.collection];
  return Array.isArray(collection)
    ? collection.find((item) => isRecord(item) && item.id === segment.id)
    : undefined;
}

function writeSegment(target: unknown, segment: PathSegment, value: number): void {
  if (segment.kind === "property" && isRecord(target)) {
    target[segment.key] = value;
  } else if (segment.kind === "index" && Array.isArray(target)) {
    target[segment.index] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
