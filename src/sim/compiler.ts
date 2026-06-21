import type { PhysicsGraph, PhysicsObject } from "../graph/types";

export interface CompiledGraph {
  graph: PhysicsGraph;
  objectById: Map<string, PhysicsObject>;
}

export function compileGraph(graph: PhysicsGraph): CompiledGraph {
  return {
    graph,
    objectById: new Map(graph.objects.map((object) => [object.id, object]))
  };
}
