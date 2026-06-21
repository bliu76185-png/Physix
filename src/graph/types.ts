export interface Vector2 {
  x: number;
  y: number;
}

export type DSLVector = [number, number] | [number, number, number];
export type ObjectType = "particle" | "rigid_body";
export type GeometryType = "circle" | "box" | "polygon";
export type InteractionType = "constraint" | "field";
export type ConstraintModel =
  | "distance"
  | "spring"
  | "angle"
  | "inequality"
  | "weld"
  | "hinge"
  | "slider"
  | "pulley"
  | "wheel"
  | "friction"
  | "motor";
export type FieldModel = "uniform" | "radial" | "custom";

export interface RenderMetadata {
  color?: string;
  visible?: boolean;
  debug?: boolean;
  fieldDensity?: number;
  pointShape?: "circle" | "square" | "diamond" | "cross";
  opacity?: number;
}

export interface Metadata {
  description?: string;
  tags?: string[];
  render?: RenderMetadata;
  fixed?: boolean;
  role?: "dynamic" | "anchor" | "kinematic_driver";
  priority?: 1 | 2 | 3 | 4 | 5;
  lambda_max?: number;
  contactAdsorption?: {
    enabled: boolean;
    velocityThreshold: number;
  };
  impulseSmoothing?: "ramp";
  repairedBy?: string[];
}

export interface ObjectProperties {
  mass?: number;
  charge?: number;
  inertia?: number;
  radius?: number;
  material?: string;
  restitution?: number;
  friction?: number;
  static_friction?: number;
  dynamic_friction?: number;
  drag_coefficient?: number;
  /** Box2D linear damping (velocity-proportional drag, F = -damping * v) */
  linear_damping?: number;
  /** Box2D angular damping (angular velocity-proportional drag) */
  angular_damping?: number;
}

export interface DegreesOfFreedom {
  translation?: boolean;
  rotation?: boolean;
}

export interface CircleGeometry {
  type: "circle";
  radius: number;
}

export interface BoxGeometry {
  type: "box";
  size: DSLVector;
}

export interface PolygonGeometry {
  type: "polygon";
  points: DSLVector[];
}

export type Geometry = CircleGeometry | BoxGeometry | PolygonGeometry;

export interface PhysicsObject {
  id: string;
  label?: string;
  type: ObjectType;
  properties: ObjectProperties;
  degrees_of_freedom: DegreesOfFreedom;
  geometry?: Geometry;
  component?: PhysicalComponent;
  metadata?: Metadata;
}

export type PhysicalComponent =
  | {
      kind: "inclined_plane";
      angle: number;
      length: number;
      thickness?: number;
      surface?: {
        friction?: number;
        restitution?: number;
      };
    };

export interface ObjectState {
  position: DSLVector;
  velocity: DSLVector;
  rotation?: number;
  angular_velocity?: number;
}

export interface ConstraintParameters {
  value?: number;
  rest_length?: number;
  compliance?: number;
  condition?: Expression;
  reference?: string;
  /** Pairwise friction coefficient. Overrides body-level friction for this contact pair. */
  friction?: number;
  /** Pairwise restitution coefficient. Overrides body-level restitution for this contact pair. */
  restitution?: number;
  /** Anchor point in world coordinates for joints (weld/hinge/slider/wheel/friction) */
  anchor?: DSLVector;
  /** Axis direction for prismatic/wheel joints in local-A coordinates */
  axis?: DSLVector;
  /** Enable joint limits (hinge/slider/wheel) */
  enable_limit?: boolean;
  /** Lower translation/angle limit */
  lower?: number;
  /** Upper translation/angle limit */
  upper?: number;
  /** Enable motor drive (hinge/slider/wheel) */
  enable_motor?: boolean;
  /** Motor target speed (hinge/slider/wheel) */
  motor_speed?: number;
  /** Max motor force for slider, max motor torque for hinge/wheel */
  max_force?: number;
  /** Max motor torque for hinge/wheel */
  max_torque?: number;
  /** Weld/Wheel/Mouse joint stiffness (N/m) */
  stiffness?: number;
  /** Weld/Wheel/Mouse joint damping (N·s/m) */
  damping?: number;
  /** Pulley: world-space ground anchor A */
  ground_anchor_a?: DSLVector;
  /** Pulley: world-space ground anchor B */
  ground_anchor_b?: DSLVector;
  /** Pulley: rest length A */
  length_a?: number;
  /** Pulley: rest length B */
  length_b?: number;
  /** Pulley/Gear ratio */
  ratio?: number;
  /** Motor joint: target linear offset */
  linear_offset?: DSLVector;
  /** Motor joint: target angular offset */
  angular_offset?: number;
  /** Motor joint: correction factor (0-1) */
  correction_factor?: number;
}

export interface ConstraintInteraction {
  id: string;
  type: "constraint";
  model: ConstraintModel;
  between: string[];
  parameters: ConstraintParameters;
  metadata?: Metadata;
}

export interface FieldInteraction {
  id: string;
  type: "field";
  model: FieldModel;
  field: string;
  applies_to?: string[];
  metadata?: Metadata;
}

export type Interaction = ConstraintInteraction | FieldInteraction;

export interface FieldVariation {
  /** Expression to scale field by position (can reference x, y) */
  spatial?: string;
  /** Expression to scale field by time (can reference t) */
  temporal?: string;
  domain?: {
    bounds?: { min: DSLVector; max: DSLVector };
    time_window?: { start: number; end: number };
  };
}

export interface FieldCoupling {
  depends_on?: Array<"position" | "velocity" | "acceleration" | "charge" | "mass" | "time" | "custom_state">;
  law?: string;
  frame?: "world" | "object" | string;
}

export interface UniformField {
  id: string;
  model: "uniform";
  vector: DSLVector;
  variation?: FieldVariation;
  coupling?: FieldCoupling;
  metadata?: Metadata;
}

export interface RadialField {
  id: string;
  model: "radial";
  /** Static origin in world coordinates. Ignored when origin_from references a moving object. */
  origin: DSLVector;
  strength: number;
  /** Object ID whose current position replaces the static origin dynamically (e.g. moving point charge). */
  origin_from?: string;
  variation?: FieldVariation;
  coupling?: FieldCoupling;
  metadata?: Metadata;
}

export interface CustomField {
  id: string;
  model: "custom";
  function: Expression;
  variation?: FieldVariation;
  coupling?: FieldCoupling;
  metadata?: Metadata;
}

export type Field = UniformField | RadialField | CustomField;

export type Expression = string | { type: "expression"; expr: string };

export type MotionProfileQuantity = "position" | "velocity" | "force" | "rotation" | "angular_velocity";
export type MotionProfileMode = "set" | "add";

export interface MotionProfileKeyframe {
  t: number;
  value: number | DSLVector;
}

export interface MotionProfile {
  id: string;
  label?: string;
  target: string;
  quantity: MotionProfileQuantity;
  mode?: MotionProfileMode;
  axis?: "x" | "y" | "xy" | "rotation";
  expression?: Expression;
  keyframes?: MotionProfileKeyframe[];
  time_window?: { start: number; end: number };
  metadata?: Metadata;
}

export interface EventAction {
  type: "modify" | "modify_constraint" | "switch_model" | "spawn" | "remove" | "control";
  target?: string;
  from?: string;
  to?: string;
  controls?: EventQuantityControl[];
  inferred_force?: EventInferredForce;
  [key: string]: unknown;
}

export interface EventQuantityControl {
  quantity: "position" | "velocity" | "force" | "impulse" | "acceleration" | "mass" | "stiffness" | "damping" | "rest_length";
  operation: "set" | "add" | "clamp";
  value?: DSLVector;
  min?: DSLVector;
  max?: DSLVector;
  duration?: "instant" | "persistent" | number;
}

export interface EventInferredForce {
  id: string;
  label?: string;
  mode: "counteract_to_hold_velocity" | "delta_velocity";
}

export interface PhysicsEvent {
  id: string;
  label?: string;
  trigger: "condition" | "impact" | "constraint_saturated" | "state_change" | "time";
  condition: Expression;
  action: EventAction;
  guard?: {
    retrigger?: "never" | "on_state_exit" | "after_cooldown" | "always";
    cooldown?: number;
    max_triggers?: number;
    state_latch?: boolean;
    cycle_group?: string;
    cycle_policy?: "block_same_tick" | "allow_next_keyframe" | "allow_with_cooldown";
  };
  metadata?: Metadata;
}

export interface Observables {
  position?: boolean;
  velocity?: boolean;
  acceleration?: boolean;
  energy?: boolean;
  momentum?: boolean;
  angular_momentum?: boolean;
  constraint_error?: boolean;
  events?: boolean;
  power?: boolean;
  work?: boolean;
}

export interface Keyframe {
  id?: string;
  t: number;
  state?: "initial" | Record<string, ObjectState>;
  event?: string;
  description?: string;
}

export interface Timeline {
  terminal_condition?: Expression;
  keyframes: Keyframe[];
}

export interface WorldConfig {
  units: {
    length: "m" | "cm" | "mm" | "px";
    time: "s";
    mass?: "kg" | "g";
    charge?: "C";
    angle?: "rad" | "deg";
  };
  scale?: number;
  bounds?: {
    min: DSLVector;
    max: DSLVector;
  };
  constants?: Record<string, number>;
  gravity?: {
    vector: DSLVector;
  };
}

export interface VariableBinding {
  path: string;
}

export interface VariableDefinition {
  id: string;
  label?: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  bindings: VariableBinding[];
  metadata?: Metadata;
}

export interface PhysicsGraph {
  version: "3.0";
  variables?: VariableDefinition[];
  motion_profiles?: MotionProfile[];
  world: WorldConfig;
  objects: PhysicsObject[];
  interactions: Interaction[];
  fields: Field[];
  initial_state: Record<string, ObjectState>;
  events: PhysicsEvent[];
  observables: Observables;
  timeline: Timeline;
}

export interface EnergyState {
  kinetic: number;
  potential: number;
  spring?: number;
}

export interface NodeState {
  id: string;
  position: Vector2;
  velocity: Vector2;
  force: Vector2;
  forceComponents?: ForceComponent[];
  energy: EnergyState;
  rotation?: number;
  angularVelocity?: number;
  power?: number;
  work?: number;
}

export interface ForceComponent {
  id: string;
  label?: string;
  vector: Vector2;
  source: "field" | "constraint" | "event" | "profile";
  event?: string;
}

export interface StateFrame {
  time: number;
  nodes: NodeState[];
  diagnostics?: SolverDiagnostics;
}

export interface SolverDiagnostics {
  contactCount: number;
  activeConstraintCount: number;
  maxConstraintError: number;
  lambdaNorm: number;
  maxLambdaRatio: number;
  clampedConstraintCount: number;
  energyDrift: number;
  totalNormalImpulse: number;
  totalFrictionImpulse: number;
  contacts: ContactDiagnostic[];
  events: SolverEvent[];
}

export interface ContactDiagnostic {
  id: string;
  bodyA: string;
  bodyB: string;
  point: Vector2;
  normal: Vector2;
  tangent: Vector2;
  penetration: number;
  normalImpulse: number;
  tangentImpulse: number;
}

export interface SolverEvent {
  id: string;
  type: "contact_created" | "contact_persisted" | "slip_detected" | "constraint_broken";
  contactId?: string;
  constraintId?: string;
  message?: string;
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationError {
  path: string;
  message: string;
  layer: "schema" | "constraint" | "execution";
  severity: ValidationSeverity;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}
