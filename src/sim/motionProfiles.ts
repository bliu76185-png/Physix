import type { CompiledGraph } from "./compiler";
import type { DSLVector, ForceComponent, MotionProfile, Vector2 } from "../graph/types";
import { add, scale, sub, zero } from "./vector";
import type { Box2DModule } from "./box2d/bodies";

export function computeMotionProfileForces(
  compiled: CompiledGraph,
  time: number
): Map<string, Vector2> {
  const forces = new Map<string, Vector2>();
  for (const profile of compiled.graph.motion_profiles ?? []) {
    if (profile.quantity !== "force" || !isProfileActive(profile, time)) continue;
    const value = profileValue(profile, time);
    const force = vectorFromProfileValue(value, profile.axis);
    forces.set(profile.target, add(forces.get(profile.target) ?? zero(), force));
  }
  return forces;
}

export function applyBox2DMotionProfiles(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  time: number
): void {
  for (const profile of compiled.graph.motion_profiles ?? []) {
    if (profile.quantity === "force" || !isProfileActive(profile, time)) continue;
    const body = bodyById.get(profile.target);
    if (!body) continue;
    const value = profileValue(profile, time);

    if (profile.quantity === "position") {
      const current = body.GetPosition();
      const currentVector = { x: current.get_x(), y: current.get_y() };
      const next = profile.mode === "add"
        ? add(currentVector, vectorFromProfileValue(value, profile.axis))
        : vectorFromProfileValue(value, profile.axis, currentVector);
      body.SetTransform(new Box2D.b2Vec2(next.x, next.y), body.GetAngle());
    } else if (profile.quantity === "velocity") {
      const current = body.GetLinearVelocity();
      const currentVector = { x: current.get_x(), y: current.get_y() };
      const next = vectorFromProfileValue(value, profile.axis, currentVector);
      if (profile.mode === "add") {
        const delta = vectorFromProfileValue(value, profile.axis);
        body.SetLinearVelocity(new Box2D.b2Vec2(currentVector.x + delta.x, currentVector.y + delta.y));
      } else {
        body.SetLinearVelocity(new Box2D.b2Vec2(next.x, next.y));
      }
    } else if (profile.quantity === "rotation") {
      const angle = scalarFromProfileValue(value);
      body.SetTransform(body.GetPosition(), profile.mode === "add" ? body.GetAngle() + angle : angle);
    } else if (profile.quantity === "angular_velocity") {
      const angularVelocity = scalarFromProfileValue(value);
      body.SetAngularVelocity(profile.mode === "add" ? body.GetAngularVelocity() + angularVelocity : angularVelocity);
    }
  }
}

function isProfileActive(profile: MotionProfile, time: number): boolean {
  const window = profile.time_window;
  return !window || (time >= window.start && time <= window.end);
}

function profileValue(profile: MotionProfile, time: number): number | DSLVector {
  if (profile.keyframes && profile.keyframes.length > 0) {
    return interpolateKeyframes(profile.keyframes, time);
  }
  if (profile.expression) {
    const expression = typeof profile.expression === "string" ? profile.expression : profile.expression.expr;
    return evaluateScalarExpression(expression, time);
  }
  return 0;
}

function interpolateKeyframes(keyframes: MotionProfile["keyframes"], time: number): number | DSLVector {
  const sorted = [...(keyframes ?? [])].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return 0;
  if (time <= sorted[0].t) return sorted[0].value;
  if (time >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time < a.t || time > b.t) continue;
    const alpha = (time - a.t) / Math.max(1e-9, b.t - a.t);
    if (Array.isArray(a.value) || Array.isArray(b.value)) {
      const av = Array.isArray(a.value) ? a.value : [a.value, a.value];
      const bv = Array.isArray(b.value) ? b.value : [b.value, b.value];
      return av.map((value, index) => value + ((bv[index] ?? 0) - value) * alpha) as DSLVector;
    }
    return a.value + (b.value - a.value) * alpha;
  }
  return sorted[sorted.length - 1].value;
}

function vectorFromProfileValue(value: number | DSLVector, axis: MotionProfile["axis"], fallback: Vector2 = zero()): Vector2 {
  if (Array.isArray(value)) return { x: value[0] ?? fallback.x, y: value[1] ?? fallback.y };
  if (axis === "y") return { x: fallback.x, y: value };
  if (axis === "xy") return { x: value, y: value };
  return { x: value, y: fallback.y };
}

function scalarFromProfileValue(value: number | DSLVector): number {
  return Array.isArray(value) ? value[0] ?? 0 : value;
}

function evaluateScalarExpression(expression: string, time: number): number {
  const expr = expression.replace(/\bt\b/g, `(${time})`);
  if (!/^[\d+\-*/().,\sincosqrtabpe]+$/i.test(expr)) return 0;
  const fn = new Function("sin", "cos", "sqrt", "abs", "pi", `return (${expr});`);
  const result = Number(fn(Math.sin, Math.cos, Math.sqrt, Math.abs, Math.PI));
  return Number.isFinite(result) ? result : 0;
}

/**
 * Compute the external force implied by motion profiles.
 *
 * For velocity profiles: F = m * (v_after - v_before) / dt
 * For position profiles: v_effective = (pos_after - pos_before) / dt,
 *                        then F = m * (v_effective - v_before) / dt
 * These are "implied" forces — they explain what external agent would be
 * needed to produce the prescribed motion. Displayed but not applied.
 */
export function computeMotionProfileInferredForces(
  compiled: CompiledGraph,
  beforeSnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  afterBodies: Map<string, Box2D.b2Body>,
  dt: number,
  time: number
): Map<string, ForceComponent[]> {
  const components = new Map<string, ForceComponent[]>();
  if (dt <= 0) return components;

  for (const profile of compiled.graph.motion_profiles ?? []) {
    if (!isProfileActive(profile, time)) continue;
    if (profile.quantity === "force") continue; // force profiles already handled by computeMotionProfileForces

    const body = afterBodies.get(profile.target);
    if (!body) continue;
    const before = beforeSnapshots.get(profile.target);
    if (!before) continue;

    const object = compiled.objectById.get(profile.target);
    const mass = object?.properties.mass ?? 1;
    const afterPos = body.GetPosition();
    const afterVel = body.GetLinearVelocity();

    let dv: Vector2;

    if (profile.quantity === "position") {
      // Position was set directly — compute effective velocity from displacement
      const dp = { x: afterPos.get_x() - before.position.x, y: afterPos.get_y() - before.position.y };
      const effectiveVel = scale(dp, 1 / dt);
      dv = sub(effectiveVel, before.velocity);
    } else {
      // Velocity or angular_velocity was set — compare before/after
      dv = { x: afterVel.get_x() - before.velocity.x, y: afterVel.get_y() - before.velocity.y };
    }

    const deltaMag = Math.hypot(dv.x, dv.y);
    if (deltaMag < 1e-9) continue;

    const force = scale(dv, mass / dt);
    const component: ForceComponent = {
      id: profile.id,
      label: profile.label ?? `motion profile: ${profile.quantity}`,
      vector: force,
      source: "profile",
    };
    const existing = components.get(profile.target) ?? [];
    existing.push(component);
    components.set(profile.target, existing);
  }

  return components;
}
