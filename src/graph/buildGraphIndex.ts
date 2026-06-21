import type { Field, Interaction, PhysicsEvent, PhysicsGraph, PhysicsObject } from "./types";

export interface GraphIndex {
  objects: Map<string, PhysicsObject>;
  interactions: Map<string, Interaction>;
  fields: Map<string, Field>;
  events: Map<string, PhysicsEvent>;
  duplicateIds: Array<{ collection: string; id: string; path: string }>;
}

function addUnique<T extends { id: string }>(
  map: Map<string, T>,
  item: T,
  collection: string,
  path: string,
  duplicateIds: GraphIndex["duplicateIds"]
) {
  if (map.has(item.id)) duplicateIds.push({ collection, id: item.id, path });
  else map.set(item.id, item);
}

export function buildGraphIndex(graph: PhysicsGraph): GraphIndex {
  const duplicateIds: GraphIndex["duplicateIds"] = [];
  const index: GraphIndex = {
    objects: new Map(),
    interactions: new Map(),
    fields: new Map(),
    events: new Map(),
    duplicateIds
  };

  graph.objects.forEach((object, i) => addUnique(index.objects, object, "objects", `objects[${i}].id`, duplicateIds));
  graph.interactions.forEach((interaction, i) => addUnique(index.interactions, interaction, "interactions", `interactions[${i}].id`, duplicateIds));
  graph.fields.forEach((field, i) => addUnique(index.fields, field, "fields", `fields[${i}].id`, duplicateIds));
  graph.events.forEach((event, i) => addUnique(index.events, event, "events", `events[${i}].id`, duplicateIds));

  return index;
}

