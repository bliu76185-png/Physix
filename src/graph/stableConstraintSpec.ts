import type {
  ConstraintInteraction,
  EventQuantityControl,
  Metadata,
  PhysicsGraph,
  PhysicsObject,
  ValidationError
} from "./types";

export const STABLE_CONSTRAINT_SPEC_VERSION = "Stable Constraint Spec v1.0";
export const MIN_COMPLIANCE = 1e-6;
export const MIN_EVENT_DURATION_SECONDS = 0.01;
export const DEFAULT_LAMBDA_MAX_FACTOR = 50;
export const DEFAULT_CONTACT_ADSORPTION_VELOCITY_THRESHOLD = 2;

const issue = (path: string, message: string, severity: ValidationError["severity"] = "error"): ValidationError => ({
  path,
  message,
  layer: "constraint",
  severity
});

export function validateStableConstraintSpec(graph: PhysicsGraph): ValidationError[] {
  const issues: ValidationError[] = [];

  graph.objects.forEach((object, index) => {
    const role = object.metadata?.role;
    if (!role) {
      issues.push(issue(`objects[${index}].metadata.role`, "object must declare role: dynamic, anchor, or kinematic_driver"));
    }
    if (role === "anchor" && isDynamicObject(object)) {
      issues.push(issue(`objects[${index}]`, "anchor must not have dynamic translation or rotation degrees of freedom"));
    }
    if (role === "dynamic" && object.metadata?.fixed === true) {
      issues.push(issue(`objects[${index}].metadata.role`, "fixed objects must be anchor, not dynamic"));
    }
  });

  const hardGeometricConstraints = graph.interactions.filter(
    (interaction): interaction is ConstraintInteraction =>
      interaction.type === "constraint" &&
      isGeometricConstraint(interaction) &&
      (interaction.parameters.compliance ?? 0) < MIN_COMPLIANCE
  );

  graph.interactions.forEach((interaction, index) => {
    if (interaction.type !== "constraint") return;
    const compliance = interaction.parameters.compliance;
    if (typeof compliance !== "number" || compliance < MIN_COMPLIANCE) {
      issues.push(issue(`interactions[${index}].parameters.compliance`, `constraint compliance must be >= ${MIN_COMPLIANCE}`));
    }
    if (!isValidPriority(interaction.metadata?.priority)) {
      issues.push(issue(`interactions[${index}].metadata.priority`, "constraint must declare priority 1..5"));
    }
    if (typeof interaction.metadata?.lambda_max !== "number" || interaction.metadata.lambda_max <= 0) {
      issues.push(issue(`interactions[${index}].metadata.lambda_max`, "constraint must declare positive lambda_max clamp"));
    }
    if (isContactConstraint(interaction) && !isValidContactAdsorption(interaction.metadata?.contactAdsorption)) {
      issues.push(issue(`interactions[${index}].metadata.contactAdsorption`, "contact constraints must smooth high-frequency micro jitter with enabled adsorption and positive velocityThreshold"));
    }
  });

  const cycle = findConstraintCycle(hardGeometricConstraints);
  if (cycle) {
    issues.push(issue("interactions", `redundant closed-loop hard geometric constraints are not stable; cycle: ${cycle.join(" -> ")}`));
  }

  graph.events.forEach((event, eventIndex) => {
    event.action.controls?.forEach((control, controlIndex) => {
      if (control.quantity === "impulse") {
        if (control.duration === "instant") {
          issues.push(issue(`events[${eventIndex}].action.controls[${controlIndex}].duration`, "instant impulses are forbidden; use duration >= 0.01s"));
        }
        if (typeof control.duration === "number" && control.duration < MIN_EVENT_DURATION_SECONDS) {
          issues.push(issue(`events[${eventIndex}].action.controls[${controlIndex}].duration`, "impulse duration must be >= 0.01s"));
        }
        if (event.metadata?.impulseSmoothing !== "ramp") {
          issues.push(issue(`events[${eventIndex}].metadata.impulseSmoothing`, "impulse events must use ramp smoothing"));
        }
      }
    });
  });

  return issues;
}

export function repairStableConstraintSpec(graph: PhysicsGraph): PhysicsGraph {
  let repaired = structuredClone(graph);
  repaired = repairSemanticComponents(repaired);
  repaired = repairObjectRoles(repaired);
  repaired = repairConstraintMetadata(repaired);
  repaired = repairEventControls(repaired);
  return repaired;
}

function repairSemanticComponents(graph: PhysicsGraph): PhysicsGraph {
  return {
    ...graph,
    objects: graph.objects.map((object) => {
      if (object.component?.kind !== "inclined_plane") return object;
      const angle = object.component.angle;
      const length = object.component.length;
      const thickness = object.component.thickness ?? Math.max(0.12, length * 0.08);
      const friction = object.component.surface?.friction ?? object.properties.friction;
      const restitution = object.component.surface?.restitution ?? object.properties.restitution;
      return {
        ...object,
        type: "rigid_body",
        properties: {
          ...object.properties,
          mass: object.properties.mass ?? 1000000,
          inertia: object.properties.inertia ?? 1000000,
          friction,
          restitution,
          material: object.properties.material ?? "inclined_plane"
        },
        degrees_of_freedom: {
          translation: false,
          rotation: false
        },
        geometry: object.geometry ?? {
          type: "polygon",
          points: inclinedPlanePoints(length, thickness, angle)
        },
        metadata: markRepaired({
          ...object.metadata,
          fixed: true,
          role: "anchor",
          tags: [...new Set([...(object.metadata?.tags ?? []), "inclined_plane"])]
        })
      };
    }),
    interactions: graph.interactions.map((interaction) => {
      if (interaction.type !== "constraint" || interaction.model !== "spring") return interaction;
      const stiffness = interaction.parameters.stiffness;
      const compliance = interaction.parameters.compliance ?? (typeof stiffness === "number" && stiffness > 0 ? 1 / stiffness : MIN_COMPLIANCE);
      const restLength = interaction.parameters.rest_length ?? interaction.parameters.value;
      return {
        ...interaction,
        parameters: {
          ...interaction.parameters,
          value: restLength,
          rest_length: restLength,
          compliance
        },
        metadata: markRepaired({
          ...interaction.metadata,
          tags: [...new Set([...(interaction.metadata?.tags ?? []), "spring"])],
          description: interaction.metadata?.description ?? "spring tension / elastic force"
        })
      };
    })
  };
}

function inclinedPlanePoints(length: number, thickness: number, angle: number): [number, number][] {
  const base = length;
  const height = Math.tan(angle) * length;
  const normalLength = Math.max(thickness, 1e-6);
  const dx = -height;
  const dy = base;
  const norm = Math.max(Math.hypot(dx, dy), 1e-6);
  const nx = (dx / norm) * normalLength;
  const ny = (dy / norm) * normalLength;
  return [
    [-base / 2, -height / 2],
    [base / 2, height / 2],
    [base / 2 + nx, height / 2 + ny],
    [-base / 2 + nx, -height / 2 + ny]
  ];
}

function repairObjectRoles(graph: PhysicsGraph): PhysicsGraph {
  return {
    ...graph,
    objects: graph.objects.map((object) => {
      const role = object.metadata?.role ?? inferObjectRole(object);
      return {
        ...object,
        metadata: markRepaired({
          ...object.metadata,
          role
        })
      };
    })
  };
}

function repairConstraintMetadata(graph: PhysicsGraph): PhysicsGraph {
  return {
    ...graph,
    interactions: graph.interactions.map((interaction) => {
      if (interaction.type !== "constraint") return interaction;
      return {
        ...interaction,
        parameters: {
          ...interaction.parameters,
          compliance: Math.max(interaction.parameters.compliance ?? MIN_COMPLIANCE, MIN_COMPLIANCE)
        },
        metadata: markRepaired({
          ...interaction.metadata,
          priority: interaction.metadata?.priority ?? defaultPriority(interaction),
          lambda_max: interaction.metadata?.lambda_max ?? estimateLambdaMax(graph, interaction),
          contactAdsorption: isContactConstraint(interaction)
            ? repairContactAdsorption(interaction.metadata?.contactAdsorption)
            : interaction.metadata?.contactAdsorption
        })
      };
    })
  };
}

function repairEventControls(graph: PhysicsGraph): PhysicsGraph {
  return {
    ...graph,
    events: graph.events.map((event) => {
      let changed = false;
      const controls = event.action.controls?.map((control): EventQuantityControl => {
        if (control.quantity !== "impulse") return control;
        const duration = typeof control.duration === "number"
          ? Math.max(control.duration, MIN_EVENT_DURATION_SECONDS)
          : MIN_EVENT_DURATION_SECONDS;
        changed = true;
        return { ...control, duration };
      });

      if (!changed) return event;
      return {
        ...event,
        action: {
          ...event.action,
          controls
        },
        metadata: markRepaired({
          ...event.metadata,
          impulseSmoothing: "ramp"
        })
      };
    })
  };
}

function inferObjectRole(object: PhysicsObject): NonNullable<Metadata["role"]> {
  if (object.metadata?.fixed === true || object.degrees_of_freedom.translation === false) return "anchor";
  if (object.metadata?.tags?.includes("kinematic") === true) return "kinematic_driver";
  return "dynamic";
}

function isDynamicObject(object: PhysicsObject): boolean {
  return object.degrees_of_freedom.translation === true || object.degrees_of_freedom.rotation === true;
}

function defaultPriority(interaction: ConstraintInteraction): NonNullable<Metadata["priority"]> {
  if (isContactConstraint(interaction)) return 2;
  if (interaction.metadata?.tags?.includes("contact")) return 2;
  if (interaction.metadata?.tags?.includes("friction")) return 3;
  if (interaction.metadata?.tags?.includes("kinematic")) return 4;
  if (interaction.parameters.compliance && interaction.parameters.compliance > 1e-3) return 5;
  return 1;
}

function estimateLambdaMax(graph: PhysicsGraph, interaction: ConstraintInteraction): number {
  const gravity = graph.fields.find((field) => field.model === "uniform" && field.id.toLowerCase().includes("gravity"));
  const g = gravity && gravity.model === "uniform" ? Math.hypot(gravity.vector[0], gravity.vector[1]) : 9.8;
  const masses = interaction.between
    .map((id) => graph.objects.find((object) => object.id === id)?.properties.mass)
    .filter((mass): mass is number => typeof mass === "number" && Number.isFinite(mass) && mass > 0);
  const representativeMass = masses.length > 0 ? Math.max(...masses) : 1;
  return DEFAULT_LAMBDA_MAX_FACTOR * representativeMass * g;
}

function isGeometricConstraint(interaction: ConstraintInteraction): boolean {
  return (
    interaction.model === "distance" ||
    interaction.model === "spring" ||
    interaction.model === "angle" ||
    interaction.model === "weld" ||
    interaction.model === "hinge" ||
    interaction.model === "slider" ||
    interaction.model === "pulley" ||
    interaction.model === "wheel" ||
    interaction.model === "friction" ||
    interaction.model === "motor"
  );
}

function isValidPriority(priority: unknown): priority is NonNullable<Metadata["priority"]> {
  return priority === 1 || priority === 2 || priority === 3 || priority === 4 || priority === 5;
}

function isContactConstraint(interaction: ConstraintInteraction): boolean {
  return interaction.model === "inequality" || interaction.metadata?.tags?.includes("contact") === true;
}

function isValidContactAdsorption(value: unknown): value is NonNullable<Metadata["contactAdsorption"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Metadata["contactAdsorption"])?.enabled === true &&
    typeof (value as Metadata["contactAdsorption"])?.velocityThreshold === "number" &&
    Number.isFinite((value as Metadata["contactAdsorption"])?.velocityThreshold) &&
    ((value as Metadata["contactAdsorption"])?.velocityThreshold ?? 0) > 0
  );
}

function repairContactAdsorption(value: Metadata["contactAdsorption"]): NonNullable<Metadata["contactAdsorption"]> {
  return {
    enabled: true,
    velocityThreshold: Math.max(
      value?.velocityThreshold ?? DEFAULT_CONTACT_ADSORPTION_VELOCITY_THRESHOLD,
      Number.EPSILON
    )
  };
}

function findConstraintCycle(constraints: ConstraintInteraction[]): string[] | null {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  const find = (value: string): string => {
    if (!parent.has(value)) {
      parent.set(value, value);
      rank.set(value, 0);
      return value;
    }
    const current = parent.get(value)!;
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };

  const union = (a: string, b: string): boolean => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return false;
    const rankA = rank.get(rootA) ?? 0;
    const rankB = rank.get(rootB) ?? 0;
    if (rankA < rankB) parent.set(rootA, rootB);
    else if (rankA > rankB) parent.set(rootB, rootA);
    else {
      parent.set(rootB, rootA);
      rank.set(rootA, rankA + 1);
    }
    return true;
  };

  const seen: string[] = [];
  for (const constraint of constraints) {
    if (constraint.between.length < 2) continue;
    const [a, b] = constraint.between;
    if (!a || !b) continue;
    if (!union(a, b)) return [...seen, constraint.id];
    seen.push(constraint.id);
  }
  return null;
}

function markRepaired(metadata: Metadata): Metadata {
  return {
    ...metadata,
    repairedBy: [...new Set([...(metadata.repairedBy ?? []), STABLE_CONSTRAINT_SPEC_VERSION])]
  };
}
