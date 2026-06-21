import type {
  DSLVector,
  Field,
  Geometry,
  ObjectProperties,
  ObjectState,
  PhysicsGraph,
  WorldConfig
} from "./types";

export const FIXED_PIXELS_PER_METER = 100;

type LengthUnit = WorldConfig["units"]["length"];
type MassUnit = NonNullable<WorldConfig["units"]["mass"]>;
type AngleUnit = NonNullable<WorldConfig["units"]["angle"]>;

const lengthFactors: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  px: 1 / FIXED_PIXELS_PER_METER
};

const massFactors: Record<MassUnit, number> = {
  kg: 1,
  g: 0.001
};

export function normalizeGraphToSI(graph: PhysicsGraph): PhysicsGraph {
  const lengthFactor = lengthFactors[graph.world.units.length] ?? 1;
  const massFactor = graph.world.units.mass ? massFactors[graph.world.units.mass] ?? 1 : 1;
  const angleFactor = angleToRadiansFactor(graph.world.units.angle);
  // px→SI: px has y-down, SI has y-up → negate y-component
  const ySign = graph.world.units.length === "px" ? -1 : 1;

  return {
    ...graph,
    world: normalizeWorld(graph.world, lengthFactor, ySign),
    objects: graph.objects.map((object) => ({
      ...object,
      properties: normalizeProperties(object.properties, lengthFactor, massFactor),
      geometry: object.geometry ? normalizeGeometry(object.geometry, lengthFactor, ySign) : undefined
    })),
    initial_state: Object.fromEntries(
      Object.entries(graph.initial_state).map(([id, state]) => [id, normalizeObjectState(state, lengthFactor, angleFactor, ySign)])
    ),
    interactions: graph.interactions.map((interaction) => {
      if (interaction.type !== "constraint") return interaction;
      return {
        ...interaction,
        parameters: {
          ...interaction.parameters,
          value: typeof interaction.parameters.value === "number"
            ? interaction.parameters.value * lengthFactor
            : interaction.parameters.value,
          rest_length: typeof interaction.parameters.rest_length === "number"
            ? interaction.parameters.rest_length * lengthFactor
            : interaction.parameters.rest_length
        }
      };
    }),
    fields: graph.fields.map((field) => normalizeField(field, lengthFactor, ySign))
  };
}

function normalizeWorld(world: WorldConfig, lengthFactor: number, ySign: number): WorldConfig {
  return {
    ...world,
    units: {
      length: "m",
      time: "s",
      mass: "kg",
      charge: world.units.charge ?? "C",
      angle: "rad"
    },
    scale: FIXED_PIXELS_PER_METER,
    bounds: world.bounds
      ? normalizeBounds(world.bounds.min, world.bounds.max, lengthFactor, ySign)
      : undefined,
    gravity: world.gravity
      ? {
          vector: flipY(scaleVector(world.gravity.vector, lengthFactor), ySign)
        }
      : undefined
  };
}

function flipY(v: DSLVector, ySign: number): DSLVector {
  return ySign === -1 ? [v[0], -v[1], v[2] ?? 0] as DSLVector : v;
}

function normalizeBounds(minRaw: DSLVector, maxRaw: DSLVector, lengthFactor: number, ySign: number) {
  const a = flipY(scaleVector(minRaw, lengthFactor), ySign);
  const b = flipY(scaleVector(maxRaw, lengthFactor), ySign);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])] as DSLVector,
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] as DSLVector,
  };
}

function normalizeProperties(properties: ObjectProperties, lengthFactor: number, massFactor: number): ObjectProperties {
  return {
    ...properties,
    mass: typeof properties.mass === "number" ? properties.mass * massFactor : properties.mass,
    inertia: typeof properties.inertia === "number"
      ? properties.inertia * massFactor * lengthFactor * lengthFactor
      : properties.inertia,
    radius: typeof properties.radius === "number" ? properties.radius * lengthFactor : properties.radius
  };
}

function normalizeGeometry(geometry: Geometry, lengthFactor: number, ySign: number): Geometry {
  if (geometry.type === "circle") {
    return { ...geometry, radius: geometry.radius * lengthFactor };
  }
  if (geometry.type === "box") {
    return { ...geometry, size: scaleVector(geometry.size, lengthFactor) };
  }
  return {
    ...geometry,
    points: geometry.points.map((point) => flipY(scaleVector(point, lengthFactor), ySign))
  };
}

function normalizeObjectState(state: ObjectState, lengthFactor: number, angleFactor: number, ySign: number): ObjectState {
  return {
    ...state,
    position: flipY(scaleVector(state.position, lengthFactor), ySign),
    velocity: flipY(scaleVector(state.velocity, lengthFactor), ySign),
    rotation: typeof state.rotation === "number" ? state.rotation * angleFactor : state.rotation,
    angular_velocity: typeof state.angular_velocity === "number" ? state.angular_velocity * angleFactor : state.angular_velocity
  };
}

function normalizeField(field: Field, lengthFactor: number, ySign: number): Field {
  if (field.model === "uniform") {
    if (isMagneticField(field)) return field;
    return { ...field, vector: flipY(scaleVector(field.vector, lengthFactor), ySign) };
  }
  if (field.model === "radial") {
    return {
      ...field,
      origin: flipY(scaleVector(field.origin, lengthFactor), ySign),
      strength: field.strength * lengthFactor ** 3
    };
  }
  return field;
}

function isMagneticField(field: Field): boolean {
  return field.metadata?.tags?.includes("magnetic") === true || field.coupling?.law === "q_v_cross_B";
}

function scaleVector(vector: DSLVector, factor: number): DSLVector {
  return vector.map((value) => value * factor) as DSLVector;
}

function angleToRadiansFactor(unit: AngleUnit | undefined): number {
  return unit === "deg" ? Math.PI / 180 : 1;
}
