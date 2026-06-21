/**
 * Box2D Event Adapter — comprehensive event system for DSL physics events.
 *
 * Supported triggers:
 *   time         → t >= number
 *   condition    → obj.x/y/vx/vy op number, or distance(a,b) op number
 *   impact       → two specific bodies begin touching (new contact in this substep)
 *
 * Supported actions:
 *   control      → set/add/clamp velocity, position, impulse, force (per-substep)
 *   remove       → destroy a body or constraint (one-shot)
 *   modify       → change object properties at runtime (one-shot)
 *   modify_constraint → change constraint parameters (one-shot)
 *   switch_model → replace one constraint type with another (one-shot)
 *
 * For control actions that modify motion (velocity/position), an inferred_force
 * is automatically computed: F = m * Δv / dt, displayed as an event force component.
 */

import type { CompiledGraph } from "../compiler";
import type { ForceComponent, PhysicsEvent, Vector2 } from "../../graph/types";
import { fromDSLVector, add, scale, sub, zero } from "../vector";
import { getMass } from "../forceBackend";
import type { Box2DModule } from "./bodies";

// ── Types ────────────────────────────────────────────────────────────

export type Box2DEventForceMap = Map<string, ForceComponent[]>;

export interface EventRuntimeState {
  /** Events currently active (eventId → activation time) */
  activeEvents: Map<string, number>;
  /** Events that have ever been triggered (for retrigger guard) */
  triggeredEventIds: Set<string>;
  /** Per-substep inferred forces from control actions */
  eventForces: Box2DEventForceMap;
  /** One-shot actions already executed this activation */
  executedOneShots: Set<string>;
  /** Active contact pairs this substep (for impact detection) */
  activeContacts: Set<string>;
}

export function createEventRuntimeState(): EventRuntimeState {
  return {
    activeEvents: new Map(),
    triggeredEventIds: new Set(),
    eventForces: new Map(),
    executedOneShots: new Set(),
    activeContacts: new Set(),
  };
}

// ── Phase 1: Detection ───────────────────────────────────────────────

/**
 * Scan events and activate those whose trigger conditions are met.
 * Called once per substep, before the Box2D step.
 */
export function updateBox2DEventRuntimeState(
  compiled: CompiledGraph,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  state: EventRuntimeState,
  time: number
): void {
  // Track active contacts for impact detection
  state.activeContacts.clear();
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type === "constraint" && interaction.model === "inequality") {
      const [a, b] = interaction.between;
      if (a && b) {
        const pa = bodySnapshots.get(a);
        const pb = bodySnapshots.get(b);
        if (pa && pb) {
          const dist = Math.hypot(pb.position.x - pa.position.x, pb.position.y - pa.position.y);
          const contactDist = (compiled.objectById.get(a)?.properties.radius ?? 0)
            + (compiled.objectById.get(b)?.properties.radius ?? 0);
          if (dist <= contactDist * 1.01) {
            state.activeContacts.add(stablePairKey(a, b));
          }
        }
      }
    }
  }

  for (const event of compiled.graph.events) {
    if (state.triggeredEventIds.has(event.id) && event.guard?.retrigger !== "always") continue;
    if (state.activeEvents.has(event.id)) continue;
    if (!isEventConditionMet(compiled, bodySnapshots, jointById, state, event, time)) continue;
    state.triggeredEventIds.add(event.id);
    state.activeEvents.set(event.id, time);
    state.executedOneShots.delete(event.id); // allow re-execution on new activation
  }
}

// ── Phase 2: Application ─────────────────────────────────────────────

/**
 * Apply active events each substep. Handles both per-substep (control)
 * and one-shot (remove/modify/switch) actions.
 */
export function applyBox2DEventControls(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  world: Box2D.b2World,
  bodyById: Map<string, Box2D.b2Body>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  state: EventRuntimeState,
  dt: number,
  time: number
): void {
  state.eventForces.clear();

  for (const [eventId, startedAt] of [...state.activeEvents]) {
    const event = compiled.graph.events.find((e) => e.id === eventId);
    if (!event) continue;
    const action = event.action;

    // ── One-shot actions ──
    if (!state.executedOneShots.has(eventId)) {
      state.executedOneShots.add(eventId);

      if (action.type === "remove") {
        executeRemove(Box2D, world, compiled, bodyById, jointById, action);
      } else if (action.type === "modify") {
        executeModify(Box2D, compiled, bodyById, action);
      } else if (action.type === "modify_constraint") {
        executeModifyConstraint(Box2D, compiled, jointById, action);
      } else if (action.type === "switch_model") {
        executeSwitchModel(Box2D, world, compiled, bodyById, jointById, action);
      }
    }

    // ── Per-substep control actions ──
    if (action.type === "control" || Array.isArray(action.controls)) {
      const targetId = action.target;
      if (!targetId) continue;
      const body = bodyById.get(targetId);
      if (!body) continue;

      const object = compiled.objectById.get(targetId);
      const mass = object ? getMass(object) : 0;
      const velBefore = body.GetLinearVelocity();
      const beforeVel: Vector2 = { x: velBefore.get_x(), y: velBefore.get_y() };

      for (const control of action.controls ?? []) {
        applyControl(Box2D, body, control, startedAt, time, dt);
      }

      // Inferred force: F = m * Δv / dt
      if (action.inferred_force && Number.isFinite(mass) && mass > 0) {
        const velAfter = body.GetLinearVelocity();
        const dv: Vector2 = { x: velAfter.get_x() - beforeVel.x, y: velAfter.get_y() - beforeVel.y };
        const force = scale(dv, mass / dt);
        const components = state.eventForces.get(targetId) ?? [];
        components.push({
          id: action.inferred_force.id,
          label: action.inferred_force.label,
          vector: force,
          source: "event",
          event: event.id,
        });
        state.eventForces.set(targetId, components);
      }
    }

    // ── Deactivate finished events ──
    if (isEventFinished(event, startedAt, time + dt)) {
      state.activeEvents.delete(eventId);
    }
  }
}

// ── Condition evaluation ─────────────────────────────────────────────

function isEventConditionMet(
  compiled: CompiledGraph,
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  state: EventRuntimeState,
  event: PhysicsEvent,
  time: number
): boolean {
  const trigger = event.trigger;
  const expr = typeof event.condition === "string" ? event.condition : event.condition.expr;

  if (trigger === "time") return evalTimeCondition(expr, time);
  if (trigger === "impact") return evalImpactCondition(event, state);
  if (trigger === "constraint_saturated") return evalConstraintSaturated(compiled, snapshots, jointById, event, time);
  if (trigger === "condition" || trigger === "state_change") {
    return evalObjectCondition(snapshots, expr);
  }
  return false;
}

function evalTimeCondition(expr: string, time: number): boolean {
  const m = expr.match(/t\s*(>=|>|<=|<|==)\s*([0-9.]+)/);
  if (m) return compare(time, m[1], Number(m[2]));
  // Fallback: evaluate as math expression
  const val = tryEvalMathExpr(expr, new Map(), time);
  return val !== null && val > 0;
}

function evalConstraintSaturated(
  compiled: CompiledGraph,
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  event: PhysicsEvent,
  time: number
): boolean {
  // Check if constraint force exceeds its lambda_max
  const target = event.action.target;
  if (!target) return false;
  const interaction = compiled.graph.interactions.find((i) => i.id === target);
  if (!interaction || interaction.type !== "constraint") return false;
  const lambdaMax = interaction.metadata?.lambda_max;
  if (typeof lambdaMax !== "number" || lambdaMax <= 0) return false;

  const joint = jointById.get(target);
  if (!joint) return false;
  const force = getJointReactionForce(joint);
  const forceMag = Math.hypot(force.x, force.y);
  return forceMag >= lambdaMax;
}

function getJointReactionForce(joint: Box2D.b2Joint | Box2D.b2Joint[]): Vector2 {
  if (Array.isArray(joint)) {
    let total = zero();
    for (const j of joint) {
      const rf = j.GetReactionForce(1); // dt=1 for force magnitude check
      total = add(total, { x: rf.get_x(), y: rf.get_y() });
    }
    return total;
  }
  const rf = (joint as Box2D.b2Joint).GetReactionForce(1);
  return { x: rf.get_x(), y: rf.get_y() };
}

function evalImpactCondition(event: PhysicsEvent, state: EventRuntimeState): boolean {
  // Match if any pair in event.action's implicit targets are in active contacts
  const contacts = state.activeContacts;
  if (event.action.target) {
    // Single target → check all pairs involving this target
    for (const key of contacts) {
      const [a, b] = key.split(":");
      if (a === event.action.target || b === event.action.target) return true;
    }
    return false;
  }
  return contacts.size > 0;
}

function evalObjectCondition(
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  expr: string
): boolean {
  // Compound conditions with AND/OR
  if (expr.includes("&&") || expr.includes("||")) {
    const parts = splitCompound(expr);
    // OR has lower precedence: if any OR group is true, return true
    for (const orGroup of parts.or) {
      const allTrue = orGroup.every((sub) => evalAtomicCondition(snapshots, sub));
      if (allTrue) return true;
    }
    return false;
  }
  return evalAtomicCondition(snapshots, expr.trim());
}

/** Evaluate a single atomic condition (no && or ||). */
function evalAtomicCondition(
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  expr: string
): boolean {
  const t = expr.trim();

  // distance(a, b) op value
  const distMatch = t.match(/distance\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*(>=|>|<=|<|==)\s*(-?[0-9.]+)/);
  if (distMatch) {
    const sa = snapshots.get(distMatch[1]);
    const sb = snapshots.get(distMatch[2]);
    if (!sa || !sb) return false;
    const d = Math.hypot(sb.position.x - sa.position.x, sb.position.y - sa.position.y);
    return compare(d, distMatch[3], Number(distMatch[4]));
  }

  // obj.field op obj.field or obj.field op value
  const objCmp = t.match(/^([A-Za-z_]\w*)\.(x|y|vx|vy)\s*(>=|>|<=|<|==)\s*([A-Za-z_]\w*)?\.?(x|y|vx|vy)?\s*$/);
  if (objCmp) {
    const lhs = getField(snapshots, objCmp[1], objCmp[2]);
    const rhs = objCmp[4] && objCmp[5]
      ? getField(snapshots, objCmp[4], objCmp[5])
      : Number(objCmp[4]);
    if (lhs === null || rhs === null || (typeof rhs === "number" && !isFinite(rhs))) return false;
    return typeof rhs === "number" ? compare(lhs, objCmp[3], rhs) : compare(lhs, objCmp[3], rhs);
  }

  // Try treating as a numeric expression: convert to value and check > 0
  const val = tryEvalMathExpr(t, snapshots, 0);
  return val !== null && val > 0;
}

function getField(
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  id: string,
  field: string
): number | null {
  const s = snapshots.get(id);
  if (!s) return null;
  if (field === "x") return s.position.x;
  if (field === "y") return s.position.y;
  if (field === "vx") return s.velocity.x;
  if (field === "vy") return s.velocity.y;
  return null;
}

/** Split compound expression on && and ||. */
function splitCompound(expr: string): { or: string[][] } {
  const orGroups = expr.split(/\s*\|\|\s*/).map((orPart) =>
    orPart.split(/\s*&&\s*/).map((s) => s.trim())
  );
  return { or: orGroups };
}

/** Minimal math expression evaluator for conditions. */
function tryEvalMathExpr(
  expr: string,
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  time: number
): number | null {
  try {
    let s = expr.trim();
    // Replace distance(a,b) with computed value
    s = s.replace(/distance\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/g, (_, a, b) => {
      const sa = snapshots.get(a);
      const sb = snapshots.get(b);
      if (!sa || !sb) return "0";
      return String(Math.hypot(sb.position.x - sa.position.x, sb.position.y - sa.position.y));
    });
    // Replace obj.field with numeric value
    s = s.replace(/([A-Za-z_]\w*)\.(x|y|vx|vy)/g, (_, id, field) => {
      const val = getField(snapshots, id, field);
      return val !== null ? String(val) : "0";
    });
    // Replace t with current time
    s = s.replace(/\bt\b/g, String(time));

    // Safety check: only allow safe characters
    if (!/^[\d+\-*/().,\sinecospabqrt]+$/i.test(s) || s.length > 200) return null;

    const fn = new Function("sin", "cos", "sqrt", "abs", "pi", "exp", `return (${s});`);
    const result = Number(fn(Math.sin, Math.cos, Math.sqrt, Math.abs, Math.PI, Math.exp));
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// ── Control application ──────────────────────────────────────────────

function asVec(v: number[] | undefined): [number, number] | [number, number, number] {
  if (!v || v.length < 2) return [0, 0];
  return v.length >= 3 ? [v[0], v[1], v[2]] : [v[0], v[1]];
}

function applyControl(
  Box2D: Box2DModule,
  body: Box2D.b2Body,
  ctrl: NonNullable<PhysicsEvent["action"]["controls"]>[number],
  startedAt: number,
  time: number,
  dt: number
): void {
  const pos = body.GetPosition();
  const vel = body.GetLinearVelocity();
  const q = ctrl.quantity;

  if (q === "velocity") {
    const cur = { x: vel.get_x(), y: vel.get_y() };
    const next = applyVectorOp(cur, ctrl);
    body.SetLinearVelocity(new Box2D.b2Vec2(next.x, next.y));
    if (ctrl.operation === "set") {
      const p = body.GetPosition();
      body.SetTransform(new Box2D.b2Vec2(p.get_x() + next.x * dt, p.get_y() + next.y * dt), body.GetAngle());
    }
  } else if (q === "position") {
    const cur = { x: pos.get_x(), y: pos.get_y() };
    const next = applyVectorOp(cur, ctrl);
    body.SetTransform(new Box2D.b2Vec2(next.x, next.y), body.GetAngle());
  } else if (q === "impulse") {
    const imp = smoothImpulse(ctrl, startedAt, time, dt);
    body.ApplyLinearImpulseToCenter(new Box2D.b2Vec2(imp.x, imp.y), true);
  } else if (q === "force") {
    body.ApplyForceToCenter(new Box2D.b2Vec2(ctrl.value?.[0] ?? 0, ctrl.value?.[1] ?? 0), true);
  } else if (q === "acceleration") {
    const a = ctrl.value;
    const ax = a?.[0] ?? 0;
    const ay = a?.[1] ?? 0;
    const massData = new Box2D.b2MassData();
    body.GetMassData(massData);
    const m = massData.get_mass() > 0 ? massData.get_mass() : 1;
    massData.__destroy__();
    body.ApplyForceToCenter(new Box2D.b2Vec2(ax * m, ay * m), true);
  }
}

function applyVectorOp(cur: Vector2, ctrl: { operation?: string; value?: number[]; min?: number[]; max?: number[] }): Vector2 {
  const v = asVec(ctrl.value);
  if (ctrl.operation === "set") return fromDSLVector(v);
  if (ctrl.operation === "add") return add(cur, fromDSLVector(v));
  if (ctrl.operation === "clamp") {
    const mn = fromDSLVector(asVec(ctrl.min));
    const mx = fromDSLVector(asVec(ctrl.max));
    return { x: Math.max(mn.x, Math.min(mx.x, cur.x)), y: Math.max(mn.y, Math.min(mx.y, cur.y)) };
  }
  return cur;
}

// ── One-shot actions ─────────────────────────────────────────────────

function executeRemove(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  action: PhysicsEvent["action"]
): void {
  const target = action.target;
  if (!target) return;

  // Try removing a constraint first
  const joint = jointById.get(target);
  if (joint) {
    if (Array.isArray(joint)) {
      for (const j of joint) world.DestroyJoint(j);
    } else {
      world.DestroyJoint(joint as Box2D.b2Joint);
    }
    jointById.delete(target);
    return;
  }

  // Try removing a body
  const body = bodyById.get(target);
  if (body) {
    world.DestroyBody(body);
    bodyById.delete(target);
  }
}

function executeModify(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  action: PhysicsEvent["action"]
): void {
  const target = action.target;
  if (!target) return;
  const body = bodyById.get(target);
  if (!body) return;
  const object = compiled.objectById.get(target);
  if (!object) return;

  // Apply controls as modifications to object properties
  for (const ctrl of action.controls ?? []) {
    if (ctrl.quantity === "mass") {
      const newMass = ctrl.value?.[0];
      if (typeof newMass === "number" && newMass > 0) {
        const massData = new Box2D.b2MassData();
        body.GetMassData(massData);
        massData.set_mass(newMass);
        body.SetMassData(massData);
        massData.__destroy__();
        object.properties.mass = newMass;
      }
    }
  }
}

function executeModifyConstraint(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  action: PhysicsEvent["action"]
): void {
  const target = action.target;
  if (!target) return;
  const interaction = compiled.graph.interactions.find((i) => i.id === target);
  if (!interaction || interaction.type !== "constraint") return;

  // Update constraint parameters in the compiled graph
  for (const ctrl of action.controls ?? []) {
    if (ctrl.quantity === "stiffness" && typeof ctrl.value?.[0] === "number") {
      interaction.parameters.stiffness = ctrl.value[0];
    } else if (ctrl.quantity === "damping" && typeof ctrl.value?.[0] === "number") {
      interaction.parameters.damping = ctrl.value[0];
    } else if (ctrl.quantity === "rest_length" && typeof ctrl.value?.[0] === "number") {
      interaction.parameters.rest_length = ctrl.value[0];
      interaction.parameters.value = ctrl.value[0];
    }
  }
}

function executeSwitchModel(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  action: PhysicsEvent["action"]
): void {
  const from = action.from;
  const to = action.to;
  if (!from || !to) return;

  const interaction = compiled.graph.interactions.find((i) => i.id === from);
  if (!interaction || interaction.type !== "constraint") return;

  // Destroy old joint
  const oldJoint = jointById.get(from);
  if (oldJoint) {
    if (Array.isArray(oldJoint)) {
      for (const j of oldJoint) world.DestroyJoint(j);
    } else {
      world.DestroyJoint(oldJoint as Box2D.b2Joint);
    }
    jointById.delete(from);
  }

  // Update interaction metadata for the new model
  interaction.model = to as typeof interaction.model;
  if (to === "distance" || to === "spring") {
    interaction.metadata = {
      ...interaction.metadata,
      tags: action.to === "rope" || action.to === "unilateral" ? ["rope", "unilateral"] : undefined,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function smoothImpulse(
  ctrl: { value?: number[]; duration?: number | "instant" | "persistent" },
  startedAt: number,
  time: number,
  dt: number
): Vector2 {
  const total = fromDSLVector(asVec(ctrl.value));
  const dur = typeof ctrl.duration === "number" ? Math.max(ctrl.duration, dt) : dt;
  const t0 = clamp01((time - startedAt) / dur);
  const t1 = clamp01((time + dt - startedAt) / dur);
  return scale(total, smoothstep(t1) - smoothstep(t0));
}

function isEventFinished(event: PhysicsEvent, startedAt: number, time: number): boolean {
  const action = event.action;
  if (action.type === "remove" || action.type === "modify" || action.type === "modify_constraint" || action.type === "switch_model") {
    return true; // one-shot, deactivate after this substep
  }
  if (action.type === "control" && action.controls?.every((c) => c.quantity !== "impulse" || c.duration === "instant")) {
    return true; // velocity/position set is one-shot
  }
  if (action.controls?.every((c) => isImpulseFinished(c, startedAt, time)) === true) {
    return true;
  }
  return false;
}

function isImpulseFinished(ctrl: { quantity?: string; duration?: number | "instant" | "persistent" }, startedAt: number, time: number): boolean {
  if (ctrl.quantity !== "impulse") return false;
  const dur = typeof ctrl.duration === "number" ? ctrl.duration : 0;
  return time - startedAt >= dur;
}

function stablePairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function compare(value: number, op: string, target: number): boolean {
  if (op === ">=") return value >= target;
  if (op === ">") return value > target;
  if (op === "<=") return value <= target;
  if (op === "<") return value < target;
  return Math.abs(value - target) < 1e-6;
}

function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
