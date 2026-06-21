import { buildGraphIndex } from "./buildGraphIndex";
import { validateStableConstraintSpec } from "./stableConstraintSpec";
import { validateExecutionSupport } from "./validateExecutionSupport";
import { validateGraphIntegrity } from "./validateGraphIntegrity";
import type { DSLVector, PhysicsGraph, ValidationError, ValidationResult } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isVector = (value: unknown): value is DSLVector =>
  Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(isNumber);

const issue = (path: string, message: string): ValidationError => ({
  path,
  message,
  layer: "schema",
  severity: "error"
});

function validateSchemaShape(graph: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(graph)) return [issue("$", "graph must be an object")];

  if (graph.version !== "3.0") errors.push(issue("version", "version must be 3.0"));
  if (!isRecord(graph.world)) errors.push(issue("world", "world is required"));
  for (const key of ["objects", "interactions", "fields", "events"] as const) {
    if (!Array.isArray(graph[key])) errors.push(issue(key, `${key} must be an array`));
  }
  if (!isRecord(graph.initial_state)) errors.push(issue("initial_state", "initial_state is required"));
  if (!isRecord(graph.observables)) errors.push(issue("observables", "observables is required"));
  if (!isRecord(graph.timeline)) errors.push(issue("timeline", "timeline is required"));
  if (graph.variables !== undefined && !Array.isArray(graph.variables)) errors.push(issue("variables", "variables must be an array"));
  if (graph.motion_profiles !== undefined && !Array.isArray(graph.motion_profiles)) errors.push(issue("motion_profiles", "motion_profiles must be an array"));

  if (Array.isArray(graph.variables)) graph.variables.forEach((variable, i) => validateVariable(variable, i, errors));
  if (Array.isArray(graph.motion_profiles)) graph.motion_profiles.forEach((profile, i) => validateMotionProfile(profile, i, errors));
  if (isRecord(graph.world)) validateWorld(graph.world, errors);
  if (Array.isArray(graph.objects)) graph.objects.forEach((object, i) => validateObject(object, i, errors));
  if (isRecord(graph.initial_state)) validateInitialState(graph.initial_state, errors);
  if (Array.isArray(graph.interactions)) graph.interactions.forEach((interaction, i) => validateInteraction(interaction, i, errors));
  if (Array.isArray(graph.fields)) graph.fields.forEach((field, i) => validateField(field, i, errors));
  if (Array.isArray(graph.events)) graph.events.forEach((event, i) => validateEvent(event, i, errors));
  if (isRecord(graph.timeline)) validateTimeline(graph.timeline, errors);

  return errors;
}

function validateVariable(variable: unknown, index: number, errors: ValidationError[]) {
  const path = `variables[${index}]`;
  if (!isRecord(variable)) return errors.push(issue(path, "variable must be an object"));
  if (typeof variable.id !== "string" || variable.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (!isNumber(variable.min)) errors.push(issue(`${path}.min`, "min must be a finite number"));
  if (!isNumber(variable.max)) errors.push(issue(`${path}.max`, "max must be a finite number"));
  if (!isNumber(variable.default)) errors.push(issue(`${path}.default`, "default must be a finite number"));
  if (isNumber(variable.min) && isNumber(variable.max) && variable.min >= variable.max) {
    errors.push(issue(path, "min must be less than max"));
  }
  if (isNumber(variable.default) && isNumber(variable.min) && isNumber(variable.max) && (variable.default < variable.min || variable.default > variable.max)) {
    errors.push(issue(`${path}.default`, "default must be within min/max"));
  }
  if (variable.step !== undefined && (!isNumber(variable.step) || variable.step <= 0)) {
    errors.push(issue(`${path}.step`, "step must be > 0"));
  }
  if (!Array.isArray(variable.bindings) || variable.bindings.length === 0) {
    errors.push(issue(`${path}.bindings`, "bindings must be a non-empty array"));
  } else {
    variable.bindings.forEach((binding, bindingIndex) => {
      if (!isRecord(binding) || typeof binding.path !== "string" || binding.path.length === 0) {
        errors.push(issue(`${path}.bindings[${bindingIndex}].path`, "binding path is required"));
      }
    });
  }
}

function validateMotionProfile(profile: unknown, index: number, errors: ValidationError[]) {
  const path = `motion_profiles[${index}]`;
  if (!isRecord(profile)) return errors.push(issue(path, "motion profile must be an object"));
  if (typeof profile.id !== "string" || profile.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (typeof profile.target !== "string" || profile.target.length === 0) errors.push(issue(`${path}.target`, "target is required"));
  if (!["position", "velocity", "force", "rotation", "angular_velocity"].includes(String(profile.quantity))) {
    errors.push(issue(`${path}.quantity`, "invalid motion profile quantity"));
  }
  if (profile.mode !== undefined && profile.mode !== "set" && profile.mode !== "add") {
    errors.push(issue(`${path}.mode`, "mode must be set or add"));
  }
  if (profile.axis !== undefined && !["x", "y", "xy", "rotation"].includes(String(profile.axis))) {
    errors.push(issue(`${path}.axis`, "invalid motion profile axis"));
  }
  if (profile.expression === undefined && !Array.isArray(profile.keyframes)) {
    errors.push(issue(path, "motion profile requires expression or keyframes"));
  }
  if (Array.isArray(profile.keyframes)) {
    profile.keyframes.forEach((keyframe, keyframeIndex) => {
      if (!isRecord(keyframe)) return errors.push(issue(`${path}.keyframes[${keyframeIndex}]`, "keyframe must be an object"));
      if (!isNumber(keyframe.t) || keyframe.t < 0) errors.push(issue(`${path}.keyframes[${keyframeIndex}].t`, "keyframe t must be >= 0"));
      if (!(isNumber(keyframe.value) || isVector(keyframe.value))) {
        errors.push(issue(`${path}.keyframes[${keyframeIndex}].value`, "keyframe value must be a number or vector"));
      }
    });
  }
}

function validateWorld(world: Record<string, unknown>, errors: ValidationError[]) {
  if (!isRecord(world.units)) errors.push(issue("world.units", "units is required"));
  if (world.bounds !== undefined && (!isRecord(world.bounds) || !isVector(world.bounds.min) || !isVector(world.bounds.max))) {
    errors.push(issue("world.bounds", "bounds must include vector min and max"));
  }
  for (const banned of ["solver", "integrator", "iterations", "substeps", "dt"]) {
    if (banned in world) errors.push(issue(`world.${banned}`, `${banned} is runtime configuration and is not allowed in v3 DSL`));
  }
}

function validateObject(object: unknown, index: number, errors: ValidationError[]) {
  const path = `objects[${index}]`;
  if (!isRecord(object)) return errors.push(issue(path, "object must be an object"));
  if (typeof object.id !== "string" || object.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (object.type !== "particle" && object.type !== "rigid_body") errors.push(issue(`${path}.type`, "type must be particle or rigid_body"));
  if (!isRecord(object.properties)) errors.push(issue(`${path}.properties`, "properties is required"));
  if (!isRecord(object.degrees_of_freedom)) errors.push(issue(`${path}.degrees_of_freedom`, "degrees_of_freedom is required"));
  if (isRecord(object.geometry)) validateGeometry(object.geometry, `${path}.geometry`, errors);
  if (object.component !== undefined) validateComponent(object.component, `${path}.component`, errors);
}

function validateComponent(component: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(component)) return errors.push(issue(path, "component must be an object"));
  if (component.kind !== "inclined_plane") return errors.push(issue(`${path}.kind`, "component kind must be inclined_plane"));
  if (!isNumber(component.angle)) errors.push(issue(`${path}.angle`, "inclined_plane angle must be a finite number in radians"));
  if (!isNumber(component.length) || component.length <= 0) errors.push(issue(`${path}.length`, "inclined_plane length must be > 0"));
  if (component.thickness !== undefined && (!isNumber(component.thickness) || component.thickness <= 0)) {
    errors.push(issue(`${path}.thickness`, "inclined_plane thickness must be > 0"));
  }
}

function validateGeometry(geometry: Record<string, unknown>, path: string, errors: ValidationError[]) {
  if (geometry.type === "circle") {
    if (!isNumber(geometry.radius) || geometry.radius <= 0) errors.push(issue(`${path}.radius`, "circle radius must be > 0"));
  } else if (geometry.type === "box") {
    if (!isVector(geometry.size)) errors.push(issue(`${path}.size`, "box size must be a vector"));
  } else if (geometry.type === "polygon") {
    if (!Array.isArray(geometry.points) || geometry.points.length < 3 || !geometry.points.every(isVector)) {
      errors.push(issue(`${path}.points`, "polygon requires at least three vector points"));
    }
  } else {
    errors.push(issue(`${path}.type`, "geometry type must be circle, box, or polygon"));
  }
}

function validateInitialState(initialState: Record<string, unknown>, errors: ValidationError[]) {
  for (const [id, state] of Object.entries(initialState)) {
    if (!isRecord(state)) {
      errors.push(issue(`initial_state.${id}`, "state must be an object"));
      continue;
    }
    if (!isVector(state.position)) errors.push(issue(`initial_state.${id}.position`, "position must be a vector array"));
    if (!isVector(state.velocity)) errors.push(issue(`initial_state.${id}.velocity`, "velocity must be a vector array"));
  }
}

function validateInteraction(interaction: unknown, index: number, errors: ValidationError[]) {
  const path = `interactions[${index}]`;
  if (!isRecord(interaction)) return errors.push(issue(path, "interaction must be an object"));
  if (typeof interaction.id !== "string" || interaction.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (interaction.type === "constraint") {
    if (interaction.model !== "distance" && interaction.model !== "spring" && interaction.model !== "angle" && interaction.model !== "inequality" && interaction.model !== "weld" && interaction.model !== "hinge" && interaction.model !== "slider" && interaction.model !== "pulley" && interaction.model !== "wheel" && interaction.model !== "friction" && interaction.model !== "motor") {
      errors.push(issue(`${path}.model`, "constraint model must be distance, spring, angle, inequality, weld, hinge, slider, pulley, wheel, friction, or motor"));
    }
    if (!Array.isArray(interaction.between)) errors.push(issue(`${path}.between`, "constraint requires between array"));
    if (!isRecord(interaction.parameters)) errors.push(issue(`${path}.parameters`, "constraint requires parameters"));
  } else if (interaction.type === "field") {
    if (interaction.model !== "uniform" && interaction.model !== "radial" && interaction.model !== "custom") {
      errors.push(issue(`${path}.model`, "field interaction model must be uniform, radial, or custom"));
    }
    if (typeof interaction.field !== "string") errors.push(issue(`${path}.field`, "field interaction requires field id"));
  } else {
    errors.push(issue(`${path}.type`, "interaction type must be constraint or field"));
  }
}

function validateField(field: unknown, index: number, errors: ValidationError[]) {
  const path = `fields[${index}]`;
  if (!isRecord(field)) return errors.push(issue(path, "field must be an object"));
  if (typeof field.id !== "string" || field.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (field.model === "uniform") {
    if (!isVector(field.vector)) errors.push(issue(`${path}.vector`, "uniform field requires vector"));
  } else if (field.model === "radial") {
    if (!isVector(field.origin)) errors.push(issue(`${path}.origin`, "radial field requires origin"));
    if (!isNumber(field.strength)) errors.push(issue(`${path}.strength`, "radial field requires strength"));
  } else if (field.model === "custom") {
    if (typeof field.function !== "string" && !isRecord(field.function)) errors.push(issue(`${path}.function`, "custom field requires function expression"));
  } else {
    errors.push(issue(`${path}.model`, "field model must be uniform, radial, or custom"));
  }
}

function validateEvent(event: unknown, index: number, errors: ValidationError[]) {
  const path = `events[${index}]`;
  if (!isRecord(event)) return errors.push(issue(path, "event must be an object"));
  if (typeof event.id !== "string" || event.id.length === 0) errors.push(issue(`${path}.id`, "id is required"));
  if (!["condition", "impact", "constraint_saturated", "state_change", "time"].includes(String(event.trigger))) {
    errors.push(issue(`${path}.trigger`, "invalid event trigger"));
  }
  if (event.condition === undefined) errors.push(issue(`${path}.condition`, "event condition is required"));
  if (!isRecord(event.action)) errors.push(issue(`${path}.action`, "event action is required"));
}

function validateTimeline(timeline: Record<string, unknown>, errors: ValidationError[]) {
  if (!Array.isArray(timeline.keyframes)) return errors.push(issue("timeline.keyframes", "keyframes must be an array"));
  timeline.keyframes.forEach((keyframe, index) => {
    const path = `timeline.keyframes[${index}]`;
    if (!isRecord(keyframe)) return errors.push(issue(path, "keyframe must be an object"));
    if (!isNumber(keyframe.t) || keyframe.t < 0) errors.push(issue(`${path}.t`, "keyframe t must be >= 0"));
    if (keyframe.state === undefined && keyframe.event === undefined) errors.push(issue(path, "keyframe requires state or event"));
  });
}

export function validateGraph(graph: unknown): ValidationResult {
  const schemaErrors = validateSchemaShape(graph);
  if (schemaErrors.length > 0) return { valid: false, errors: schemaErrors, warnings: [] };

  const typedGraph = graph as PhysicsGraph;
  const index = buildGraphIndex(typedGraph);
  const issues = [
    ...validateGraphIntegrity(typedGraph, index),
    ...validateStableConstraintSpec(typedGraph),
    ...validateExecutionSupport(typedGraph)
  ];
  const errors = issues.filter((item) => item.severity === "error");
  const warnings = issues.filter((item) => item.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidGraph(graph: unknown): asserts graph is PhysicsGraph {
  const result = validateGraph(graph);
  if (!result.valid) {
    throw new Error(result.errors.map((error) => `${error.layer}:${error.path}: ${error.message}`).join("\n"));
  }
}
