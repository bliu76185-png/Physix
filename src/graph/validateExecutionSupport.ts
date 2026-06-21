import type { PhysicsGraph, ValidationError } from "./types";

const executionWarning = (path: string, message: string): ValidationError => ({
  path,
  message,
  layer: "execution",
  severity: "warning"
});

export function validateExecutionSupport(graph: PhysicsGraph): ValidationError[] {
  const errors: ValidationError[] = [];

  graph.fields.forEach((field, i) => {
    if (field.model === "custom") {
      const expression = typeof field.function === "string" ? field.function : field.function.expr;
      if (!["zero", "radial_in", "radial_out"].includes(expression.trim())) {
        errors.push(executionWarning(`fields[${i}].function`, "custom field expressions are only partially executable; unsupported expressions fall back to zero force"));
      }
    }
    if (field.coupling?.law && field.coupling.law !== "q_v_cross_B") {
      errors.push(executionWarning(`fields[${i}].coupling.law`, "field coupling law is declared but not fully implemented by the runtime"));
    }
  });

  graph.events.forEach((event, i) => {
    if (event.action.type !== "control" && event.action.type !== "remove" && !Array.isArray(event.action.controls)) {
      errors.push(executionWarning(`events[${i}].action.type`, "event action is declared but only control/remove actions are executed by the Box2D runtime"));
    }
  });

  return errors;
}
