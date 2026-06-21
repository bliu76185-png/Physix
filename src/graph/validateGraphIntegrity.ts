import { buildGraphIndex, type GraphIndex } from "./buildGraphIndex";
import type { PhysicsGraph, ValidationError } from "./types";

const error = (path: string, message: string): ValidationError => ({
  path,
  message,
  layer: "constraint",
  severity: "error"
});

export function validateGraphIntegrity(graph: PhysicsGraph, index: GraphIndex = buildGraphIndex(graph)): ValidationError[] {
  const issues: ValidationError[] = [];

  for (const duplicate of index.duplicateIds) {
    issues.push(error(duplicate.path, `${duplicate.collection} id "${duplicate.id}" must be unique`));
  }

  graph.objects.forEach((object, i) => {
    if (!graph.initial_state[object.id]) {
      issues.push(error(`initial_state.${object.id}`, "every object must have explicit initial state"));
    }
    if (object.type === "rigid_body" && object.degrees_of_freedom.rotation && typeof object.properties.inertia !== "number") {
      issues.push(error(`objects[${i}].properties.inertia`, "rotating rigid_body requires inertia"));
    }
  });

  Object.keys(graph.initial_state).forEach((id) => {
    if (!index.objects.has(id)) {
      issues.push(error(`initial_state.${id}`, "initial_state key must reference an existing object"));
    }
  });

  graph.interactions.forEach((interaction, i) => {
    if (interaction.type === "constraint") {
      interaction.between.forEach((objectId, objectIndex) => {
        if (!index.objects.has(objectId)) {
          issues.push(error(`interactions[${i}].between[${objectIndex}]`, "constraint endpoint must reference an existing object"));
        }
      });
      if ((interaction.model === "distance" || interaction.model === "spring") && interaction.between.length !== 2) {
        issues.push(error(`interactions[${i}].between`, `${interaction.model} constraint requires exactly two objects`));
      }
      if ((interaction.model === "distance" || interaction.model === "spring") && typeof interaction.parameters.value !== "number" && typeof interaction.parameters.rest_length !== "number") {
        issues.push(error(`interactions[${i}].parameters.value`, `${interaction.model} constraint requires numeric value or rest_length`));
      }
    } else {
      if (!index.fields.has(interaction.field)) {
        issues.push(error(`interactions[${i}].field`, "field interaction must reference an existing field"));
      }
      interaction.applies_to?.forEach((objectId, objectIndex) => {
        if (!index.objects.has(objectId)) {
          issues.push(error(`interactions[${i}].applies_to[${objectIndex}]`, "field target must reference an existing object"));
        }
      });
    }
  });

  graph.fields.forEach((field, i) => {
    if (field.model === "radial" && field.origin_from && !index.objects.has(field.origin_from)) {
      issues.push(error(`fields[${i}].origin_from`, "radial field origin_from must reference an existing object"));
    }
  });

  graph.events.forEach((event, i) => {
    const target = event.action.target;
    if (target && !index.objects.has(target) && !index.interactions.has(target) && !index.fields.has(target)) {
      issues.push(error(`events[${i}].action.target`, "event action target must reference an object, interaction, or field"));
    }
  });

  graph.motion_profiles?.forEach((profile, i) => {
    if (!index.objects.has(profile.target)) {
      issues.push(error(`motion_profiles[${i}].target`, "motion profile target must reference an existing object"));
    }
  });

  graph.timeline.keyframes.forEach((keyframe, i) => {
    if (keyframe.event && !index.events.has(keyframe.event)) {
      issues.push(error(`timeline.keyframes[${i}].event`, "keyframe event must reference an existing event"));
    }
  });

  return issues;
}
