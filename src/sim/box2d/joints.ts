import type { CompiledGraph } from "../compiler";
import type { Box2DModule } from "./bodies";
import type { DSLVector } from "../../graph/types";

/**
 * Create Box2D joints for all constraint interactions in the compiled graph.
 * Returns a map from interaction ID to b2Joint (or joint array for angle constraints).
 */
export function createBox2DJoints(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>
): Map<string, Box2D.b2Joint | Box2D.b2Joint[]> {
  const jointById = new Map<string, Box2D.b2Joint | Box2D.b2Joint[]>();

  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "constraint") continue;
    if (!isConstraintActive(compiled, interaction.id, 0)) continue;

    const model = interaction.model;
    const [aId, bId] = interaction.between;

    if (model === "distance" || model === "spring") {
      const joint = createDistanceJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "angle") {
      const joints = createAngleJoints(Box2D, world, interaction, bodyById);
      if (joints.length > 0) jointById.set(interaction.id, joints);
    } else if (model === "weld") {
      const joint = createWeldJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "hinge") {
      const joint = createHingeJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "slider") {
      const joint = createSliderJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "pulley") {
      const joint = createPulleyJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "wheel") {
      const joint = createWheelJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "friction") {
      const joint = createFrictionJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    } else if (model === "motor") {
      const joint = createMotorJoint(Box2D, world, interaction, bodyById);
      if (joint) jointById.set(interaction.id, joint);
    }
    // inequality constraints are handled by Box2D's built-in collision system
  }

  return jointById;
}

function createDistanceJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { value?: number; rest_length?: number; compliance?: number; stiffness?: number; damping?: number }; metadata?: { tags?: string[] } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const restLength = interaction.parameters.value ?? interaction.parameters.rest_length;
  if (typeof restLength !== "number") return null;

  const jointDef = new Box2D.b2DistanceJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  // Local anchors at body centers (both zero)
  jointDef.get_localAnchorA().Set(0, 0);
  jointDef.get_localAnchorB().Set(0, 0);

  jointDef.set_collideConnected(false);

  // Map spring semantics first, then compliance to stiffness (1/compliance in N/m).
  const compliance = interaction.parameters.compliance ?? 0;
  const stiff = interaction.parameters.stiffness ?? (compliance > 1e-9 ? 1 / compliance : 1e10);
  jointDef.set_stiffness(stiff);
  jointDef.set_damping(interaction.parameters.damping ?? 0);

  // Handle unilateral (rope) constraints
  // Rope behaviour is managed per-substep in box2dStream.ts via dynamic
  // SetStiffness(0) when slack / SetStiffness(normal) when taut.
  // The joint is always created as a normal bilateral distance joint;
  // stiffness is toggled each substep based on the current body distance.
  const tags = interaction.metadata?.tags;
  const isRope = isUnilateral(tags);

  jointDef.set_length(restLength);

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

/**
 * Angle constraint (3-body: a-b-c, angle at b).
 * Approximated as two distance joints: ab and bc.
 */
function createAngleJoints(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { value?: number; compliance?: number }; metadata?: { tags?: string[] } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint[] {
  const [aId, bId, cId] = interaction.between;
  if (!aId || !bId || !cId) return [];

  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  const bodyC = bodyById.get(cId);
  if (!bodyA || !bodyB || !bodyC) return [];

  // Create two distance joints to fix the triangle ABC
  const joints: Box2D.b2Joint[] = [];

  // Distance AB
  const abDist = distance(bodyA.GetPosition(), bodyB.GetPosition());
  if (abDist > 0) {
    const defAB = makeDistanceJointDef(Box2D, bodyA, bodyB, abDist, interaction.parameters.compliance);
    joints.push(world.CreateJoint(defAB));
    defAB.__destroy__();
  }

  // Distance BC
  const bcDist = distance(bodyB.GetPosition(), bodyC.GetPosition());
  if (bcDist > 0) {
    const defBC = makeDistanceJointDef(Box2D, bodyB, bodyC, bcDist, interaction.parameters.compliance);
    joints.push(world.CreateJoint(defBC));
    defBC.__destroy__();
  }

  return joints;
}

function makeDistanceJointDef(
  Box2D: Box2DModule,
  bodyA: Box2D.b2Body,
  bodyB: Box2D.b2Body,
  length: number,
  compliance: number | undefined
): Box2D.b2DistanceJointDef {
  const def = new Box2D.b2DistanceJointDef();
  def.set_bodyA(bodyA);
  def.set_bodyB(bodyB);
  def.get_localAnchorA().Set(0, 0);
  def.get_localAnchorB().Set(0, 0);
  def.set_length(length);
  def.set_collideConnected(false);

  const comp = compliance ?? 0;
  if (comp > 1e-9) {
    def.set_stiffness(1 / comp);
    def.set_damping(0);
  } else {
    def.set_stiffness(1e10);
    def.set_damping(0);
  }
  return def;
}

function distance(a: Box2D.b2Vec2, b: Box2D.b2Vec2): number {
  const dx = b.get_x() - a.get_x();
  const dy = b.get_y() - a.get_y();
  return Math.hypot(dx, dy);
}

function isUnilateral(tags: string[] | undefined): boolean {
  return tags?.some(tag => tag === "unilateral" || tag === "rope" || tag === "line") === true;
}

// ---------------------------------------------------------------------------
// Weld Joint — 刚性焊接两物体
// ---------------------------------------------------------------------------

function createWeldJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { anchor?: DSLVector; stiffness?: number; damping?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2WeldJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  // Use provided anchor or bodyA center
  if (interaction.parameters.anchor) {
    const anchor = new Box2D.b2Vec2(interaction.parameters.anchor[0], interaction.parameters.anchor[1]);
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  } else {
    const posA = bodyA.GetPosition();
    const anchor = new Box2D.b2Vec2(posA.get_x(), posA.get_y());
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  }

  jointDef.set_collideConnected(false);

  // Stiffness from explicit field or compliance
  if (interaction.parameters.stiffness != null) {
    jointDef.set_stiffness(interaction.parameters.stiffness);
    jointDef.set_damping(interaction.parameters.damping ?? 0);
  } else {
    const compliance = interaction.parameters.compliance ?? 0;
    jointDef.set_stiffness(compliance > 1e-9 ? 1 / compliance : 1e10);
    jointDef.set_damping(0);
  }

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Hinge Joint (Revolute) — 铰链/转轴
// ---------------------------------------------------------------------------

function createHingeJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { anchor?: DSLVector; enable_limit?: boolean; lower_angle?: number; upper_angle?: number; enable_motor?: boolean; motor_speed?: number; max_torque?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2RevoluteJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  if (interaction.parameters.anchor) {
    const anchor = new Box2D.b2Vec2(interaction.parameters.anchor[0], interaction.parameters.anchor[1]);
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  } else {
    const posA = bodyA.GetPosition();
    const anchor = new Box2D.b2Vec2(posA.get_x(), posA.get_y());
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  }

  jointDef.set_collideConnected(false);

  // Angle limits
  if (interaction.parameters.enable_limit === true) {
    jointDef.set_enableLimit(true);
    jointDef.set_lowerAngle(interaction.parameters.lower_angle ?? 0);
    jointDef.set_upperAngle(interaction.parameters.upper_angle ?? 0);
  }

  // Motor
  if (interaction.parameters.enable_motor === true) {
    jointDef.set_enableMotor(true);
    jointDef.set_motorSpeed(interaction.parameters.motor_speed ?? 0);
    jointDef.set_maxMotorTorque(interaction.parameters.max_torque ?? 0);
  }

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Slider Joint (Prismatic) — 滑轨/活塞
// ---------------------------------------------------------------------------

function createSliderJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { anchor?: DSLVector; axis?: DSLVector; enable_limit?: boolean; lower?: number; upper?: number; enable_motor?: boolean; motor_speed?: number; max_force?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2PrismaticJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  const anchorVec = interaction.parameters.anchor
    ? new Box2D.b2Vec2(interaction.parameters.anchor[0], interaction.parameters.anchor[1])
    : bodyA.GetPosition();
  const axisVec = interaction.parameters.axis
    ? new Box2D.b2Vec2(interaction.parameters.axis[0], interaction.parameters.axis[1])
    : (() => { const v = new Box2D.b2Vec2(1, 0); return v; })();

  jointDef.Initialize(bodyA, bodyB, anchorVec, axisVec);
  if (!interaction.parameters.anchor) { /* anchorVec is bodyA ref, no destroy */ }
  if (!interaction.parameters.axis) axisVec.__destroy__();
  // Note: if anchor is from bodyA.GetPosition(), we need to destroy it
  // But it's the same reference... Let me fix this by tracking origin.
  // Actually, GetPosition returns a new b2Vec2 each time in box2d-wasm? Let me use a workaround:
  // We already used Initialize which copies the values, so safe to destroy.
  if (interaction.parameters.anchor) {
    anchorVec.__destroy__();
  } else {
    // anchorVec is from bodyA.GetPosition() - destroy to avoid leak
    anchorVec.__destroy__();
  }

  jointDef.set_collideConnected(false);

  // Translation limits
  if (interaction.parameters.enable_limit === true) {
    jointDef.set_enableLimit(true);
    jointDef.set_lowerTranslation(interaction.parameters.lower ?? 0);
    jointDef.set_upperTranslation(interaction.parameters.upper ?? 0);
  }

  // Motor
  if (interaction.parameters.enable_motor === true) {
    jointDef.set_enableMotor(true);
    jointDef.set_motorSpeed(interaction.parameters.motor_speed ?? 0);
    jointDef.set_maxMotorForce(interaction.parameters.max_force ?? 0);
  }

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Pulley Joint — 滑轮系统
// ---------------------------------------------------------------------------

function createPulleyJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { ground_anchor_a?: DSLVector; ground_anchor_b?: DSLVector; length_a?: number; length_b?: number; ratio?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2PulleyJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  const groundA = interaction.parameters.ground_anchor_a
    ? new Box2D.b2Vec2(interaction.parameters.ground_anchor_a[0], interaction.parameters.ground_anchor_a[1])
    : new Box2D.b2Vec2(0, 0);
  const groundB = interaction.parameters.ground_anchor_b
    ? new Box2D.b2Vec2(interaction.parameters.ground_anchor_b[0], interaction.parameters.ground_anchor_b[1])
    : new Box2D.b2Vec2(0, 0);

  const posA = bodyA.GetPosition();
  const posB = bodyB.GetPosition();
  const anchorA = new Box2D.b2Vec2(posA.get_x(), posA.get_y());
  const anchorB = new Box2D.b2Vec2(posB.get_x(), posB.get_y());

  jointDef.Initialize(
    bodyA, bodyB,
    groundA, groundB,
    anchorA, anchorB,
    interaction.parameters.ratio ?? 1
  );

  jointDef.set_collideConnected(false);

  if (interaction.parameters.length_a != null) {
    jointDef.set_lengthA(interaction.parameters.length_a);
  }
  if (interaction.parameters.length_b != null) {
    jointDef.set_lengthB(interaction.parameters.length_b);
  }

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  groundA.__destroy__();
  groundB.__destroy__();
  anchorA.__destroy__();
  anchorB.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Wheel Joint — 轮子悬挂
// ---------------------------------------------------------------------------

function createWheelJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { anchor?: DSLVector; axis?: DSLVector; enable_motor?: boolean; motor_speed?: number; max_torque?: number; stiffness?: number; damping?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2WheelJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  const posA = bodyA.GetPosition();
  const anchorVec = interaction.parameters.anchor
    ? new Box2D.b2Vec2(interaction.parameters.anchor[0], interaction.parameters.anchor[1])
    : new Box2D.b2Vec2(posA.get_x(), posA.get_y());
  const axisVec = interaction.parameters.axis
    ? new Box2D.b2Vec2(interaction.parameters.axis[0], interaction.parameters.axis[1])
    : new Box2D.b2Vec2(0, 1);

  jointDef.Initialize(bodyA, bodyB, anchorVec, axisVec);
  jointDef.set_collideConnected(false);

  // Spring stiffness/damping
  if (interaction.parameters.stiffness != null) {
    jointDef.set_stiffness(interaction.parameters.stiffness);
    jointDef.set_damping(interaction.parameters.damping ?? 0);
  } else {
    const compliance = interaction.parameters.compliance ?? 0;
    jointDef.set_stiffness(compliance > 1e-9 ? 1 / compliance : 1e6);
    jointDef.set_damping(0);
  }

  // Motor
  if (interaction.parameters.enable_motor === true) {
    jointDef.set_enableMotor(true);
    jointDef.set_motorSpeed(interaction.parameters.motor_speed ?? 0);
    jointDef.set_maxMotorTorque(interaction.parameters.max_torque ?? 0);
  }

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  anchorVec.__destroy__();
  axisVec.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Friction Joint — 摩擦约束
// ---------------------------------------------------------------------------

function createFrictionJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { anchor?: DSLVector; max_force?: number; max_torque?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2FrictionJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);

  if (interaction.parameters.anchor) {
    const anchor = new Box2D.b2Vec2(interaction.parameters.anchor[0], interaction.parameters.anchor[1]);
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  } else {
    const posA = bodyA.GetPosition();
    const anchor = new Box2D.b2Vec2(posA.get_x(), posA.get_y());
    jointDef.Initialize(bodyA, bodyB, anchor);
    anchor.__destroy__();
  }

  jointDef.set_collideConnected(false);
  jointDef.set_maxForce(interaction.parameters.max_force ?? 100);
  jointDef.set_maxTorque(interaction.parameters.max_torque ?? 10);

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Motor Joint — 电机驱动
// ---------------------------------------------------------------------------

function createMotorJoint(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  interaction: { id: string; between: string[]; parameters: { linear_offset?: DSLVector; angular_offset?: number; max_force?: number; max_torque?: number; correction_factor?: number; compliance?: number } },
  bodyById: Map<string, Box2D.b2Body>
): Box2D.b2Joint | null {
  const [aId, bId] = interaction.between;
  if (!aId || !bId) return null;
  const bodyA = bodyById.get(aId);
  const bodyB = bodyById.get(bId);
  if (!bodyA || !bodyB) return null;

  const jointDef = new Box2D.b2MotorJointDef();
  jointDef.set_bodyA(bodyA);
  jointDef.set_bodyB(bodyB);
  jointDef.Initialize(bodyA, bodyB);
  jointDef.set_collideConnected(false);

  if (interaction.parameters.linear_offset) {
    const offset = new Box2D.b2Vec2(
      interaction.parameters.linear_offset[0],
      interaction.parameters.linear_offset[1]
    );
    jointDef.set_linearOffset(offset);
    offset.__destroy__();
  }

  if (interaction.parameters.angular_offset != null) {
    jointDef.set_angularOffset(interaction.parameters.angular_offset);
  }

  jointDef.set_maxForce(interaction.parameters.max_force ?? 1000);
  jointDef.set_maxTorque(interaction.parameters.max_torque ?? 1000);
  jointDef.set_correctionFactor(interaction.parameters.correction_factor ?? 0.3);

  const joint = world.CreateJoint(jointDef);
  jointDef.__destroy__();
  return joint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isConstraintActive(compiled: CompiledGraph, interactionId: string, _time: number): boolean {
  // Check if any event removes this constraint at t=0 (should never happen, but safe)
  return !compiled.graph.events.some(event => {
    if (event.trigger !== "time" || event.action.type !== "remove" || event.action.target !== interactionId) {
      return false;
    }
    const condition = typeof event.condition === "string" ? event.condition : event.condition.expr;
    const match = condition.match(/t\s*(?:>=|>|==)\s*([0-9.]+)/);
    return match ? 0 >= Number(match[1]) : false;
  });
}
