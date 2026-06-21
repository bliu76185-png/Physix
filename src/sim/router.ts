import type { PhysicsGraph } from "../graph/types";

export interface ExecutionPlan {
  useMatter: boolean;
  useCustomForces: boolean;
  reasons: string[];
}

export function createExecutionPlan(graph: PhysicsGraph): ExecutionPlan {
  const hasCollisionBodies = graph.objects.some((object) => object.geometry?.type === "circle" || object.geometry?.type === "box");
  const hasSprings = graph.interactions.some((interaction) => interaction.type === "constraint" && interaction.model === "distance" && (interaction.parameters.compliance ?? 0) > 0);
  const hasFields = graph.fields.length > 0;
  const hasConstraints = graph.interactions.some((interaction) => interaction.type === "constraint");

  return {
    useMatter: hasCollisionBodies || hasConstraints,
    useCustomForces: hasSprings || hasFields,
    reasons: [
      hasCollisionBodies ? "rigid bodies and collisions" : "",
      hasConstraints ? "constraints" : "",
      hasSprings ? "springs" : "",
      hasFields ? "continuous fields" : ""
    ].filter(Boolean)
  };
}
