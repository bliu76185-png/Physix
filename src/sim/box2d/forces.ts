import type { CompiledGraph } from "../compiler";
import type { Field, Vector2, PhysicsObject, ForceComponent, DSLVector } from "../../graph/types";
import { add, fromDSLVector, length, normalize, scale, sub, zero } from "../vector";
import { getMass, isFixed } from "../forceBackend";
import type { Box2DModule } from "./bodies";
import { computeMotionProfileForces } from "../motionProfiles";

export type FieldForceMap = Map<string, Vector2>;

/**
 * Compute field forces from graph interactions.
 * All forces (gravity, electric, magnetic, drag) come through this pipeline.
 */
export function computeFieldForces(
  compiled: CompiledGraph,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  time: number = 0
): FieldForceMap {
  const forces = new Map<string, Vector2>();
  compiled.graph.objects.forEach(object => forces.set(object.id, zero()));

  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "field") continue;
    const field = compiled.graph.fields.find(item => item.id === interaction.field);
    if (!field) continue;

    const targetIds = interaction.applies_to ?? compiled.graph.objects.map(o => o.id);

    for (const id of targetIds) {
      const object = compiled.objectById.get(id);
      const snapshot = bodySnapshots.get(id);
      if (!object || !snapshot || isFixed(object)) continue;
      forces.set(
        id,
        add(
          forces.get(id) ?? zero(),
          evaluateFieldForce(object, field, snapshot.position, snapshot.velocity, time, bodySnapshots)
        )
      );
    }
  }

  return forces;
}

/**
 * Append drag forces to the force map.
 */
export function appendDragForces(
  compiled: CompiledGraph,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  forces: FieldForceMap
): FieldForceMap {
  for (const object of compiled.graph.objects) {
    const c = object.properties.drag_coefficient;
    if (c == null || c <= 0) continue;
    const snapshot = bodySnapshots.get(object.id);
    if (!snapshot || isFixed(object)) continue;

    const dragForce: Vector2 = {
      x: -c * snapshot.velocity.x,
      y: -c * snapshot.velocity.y
    };
    forces.set(object.id, add(forces.get(object.id) ?? zero(), dragForce));
  }
  return forces;
}

/**
 * Apply computed forces to Box2D bodies via ApplyForceToCenter.
 */
export function applyForcesToBodies(
  Box2D: Box2DModule,
  bodyById: Map<string, Box2D.b2Body>,
  forces: FieldForceMap
): void {
  for (const [id, force] of forces) {
    const body = bodyById.get(id);
    if (!body || body.GetType() === Box2D.b2_staticBody) continue;
    // ApplyForceToCenter expects force in Newtons (SI units)
    body.ApplyForceToCenter(
      new Box2D.b2Vec2(force.x, force.y),
      true
    );
  }
}

/**
 * Compute observable force components (for visualization).
 * Uses Box2D GetReactionForce/GetReactionTorque for precise constraint forces.
 */
export function computeObservableForceComponents(
  compiled: CompiledGraph,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  jointById?: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  dt: number = 0.016,
  time: number = 0
): Map<string, ForceComponent[]> {
  const components = new Map<string, ForceComponent[]>();

  // Field forces
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "field") continue;
    const field = compiled.graph.fields.find(item => item.id === interaction.field);
    if (!field) continue;
    const targetIds = interaction.applies_to ?? compiled.graph.objects.map(o => o.id);
    for (const id of targetIds) {
      const object = compiled.objectById.get(id);
      const snapshot = bodySnapshots.get(id);
      if (!object || !snapshot || isFixed(object)) continue;
      pushComponent(components, id, {
        id: interaction.id,
        label: field.metadata?.description ?? interaction.id,
        vector: evaluateFieldForce(object, field, snapshot.position, snapshot.velocity, time, bodySnapshots),
        source: "field"
      });
    }
  }

  // Constraint forces — use Box2D GetReactionForce for precision
  if (jointById && dt > 0) {
    const inv_dt = 1 / dt;

    for (const interaction of compiled.graph.interactions) {
      if (interaction.type !== "constraint") continue;
      if (interaction.model === "inequality") continue; // Contact forces handled separately

      const joints = jointById.get(interaction.id);
      if (!joints) continue;

      const [fromId, toId] = interaction.between;
      if (!fromId || !toId) continue;

      // Collect reaction force(s)
      let reactionForce: Vector2 = zero();

      if (Array.isArray(joints)) {
        // Multi-joint constraint (e.g., angle = 2 distance joints)
        for (const j of joints) {
          const rf = j.GetReactionForce(inv_dt);
          reactionForce = add(reactionForce, { x: rf.get_x(), y: rf.get_y() });
        }
      } else {
        const rf = (joints as Box2D.b2Joint).GetReactionForce(inv_dt);
        reactionForce = { x: rf.get_x(), y: rf.get_y() };
      }

      // Reaction force is the force applied to bodyA. bodyB gets the opposite.
      if (reactionForce.x === 0 && reactionForce.y === 0) continue;

      pushComponent(components, fromId, {
        id: interaction.id,
        label: reactionLabel(interaction),
        vector: reactionForce,
        source: "constraint"
      });
      pushComponent(components, toId, {
        id: interaction.id,
        label: reactionLabel(interaction),
        vector: scale(reactionForce, -1),
        source: "constraint"
      });
    }
  }

  for (const [id, vector] of computeMotionProfileForces(compiled, time)) {
    const profile = compiled.graph.motion_profiles?.find((item) => item.target === id && item.quantity === "force");
    pushComponent(components, id, {
      id: profile?.id ?? "motion_profile_force",
      label: profile?.label ?? "motion profile force",
      vector,
      source: "profile"
    });
  }

  return components;
}

const MAX_CONTACT_ITERATIONS = 256;

/**
 * Compute contact forces: combines Box2D impulse-based computation with
 * static-force residual compensation.
 *
 * Box2D contact impulses capture dynamic collision forces well, but for
 * resting bodies the velocity-level impulse is near-zero (the actual
 * support comes from position correction). We supplement this by computing
 * the residual force: F_residual = m*a - sum(known_forces). For bodies
 * at rest, F_residual ≈ support force.
 */
export function computeContactForceComponents(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>,
  knownForces: Map<string, Vector2>,
  dt: number,
  currentTime: number
): Map<string, ForceComponent[]> {
  const components = new Map<string, ForceComponent[]>();

  // ── Part 1: Impulse-based contact forces (dynamic collisions) ──
  const idByBody = new Map<Box2D.b2Body, string>();
  for (const [id, body] of bodyById) idByBody.set(body, id);

  let contact: Box2D.b2Contact | null = world.GetContactList();
  let iterations = 0;
  while (contact && iterations < MAX_CONTACT_ITERATIONS) {
    iterations += 1;
    if (!contact.IsTouching()) { contact = getContactNext(contact); continue; }

    const bodyA = contact.GetFixtureA().GetBody();
    const bodyB = contact.GetFixtureB().GetBody();
    const idA = idByBody.get(bodyA);
    const idB = idByBody.get(bodyB);
    if (!idA || !idB) { contact = getContactNext(contact); continue; }

    const manifold = contact.GetManifold();
    const normal = manifold.get_localNormal();
    const pointCount = manifold.get_pointCount();
    if (pointCount === 0) { contact = getContactNext(contact); continue; }

    const mp = manifold.get_points(0);
    const normalImpulse = mp.get_normalImpulse();
    const tangentImpulse = mp.get_tangentImpulse();
    const n: Vector2 = { x: normal.get_x(), y: normal.get_y() };
    const t: Vector2 = { x: -n.y, y: n.x };
    const invDt = 1 / Math.max(dt, 1e-6);

    const nForce = scale(n, normalImpulse * invDt);
    const fForce = scale(t, tangentImpulse * invDt);
    pushComponent(components, idA, { id: "support_dyn", label: "支持力(冲量) N", vector: scale(nForce, -1), source: "constraint" });
    pushComponent(components, idB, { id: "support_dyn", label: "支持力(冲量) N", vector: nForce, source: "constraint" });
    if (Math.abs(tangentImpulse) > 1e-9) {
      pushComponent(components, idA, { id: "friction_dyn", label: "摩擦力(冲量) f", vector: scale(fForce, -1), source: "constraint" });
      pushComponent(components, idB, { id: "friction_dyn", label: "摩擦力(冲量) f", vector: fForce, source: "constraint" });
    }
    contact = getContactNext(contact);
  }

  // ── Part 2: Residual force compensation for static support ──
  // For bodies at/near rest, F_support ≈ -(sum of known forces)
  const prevSnapshots = _prevFrameSnapshots ?? bodySnapshots;
  for (const [id, body] of bodyById) {
    const snapshot = bodySnapshots.get(id);
    const prev = prevSnapshots.get(id);
    if (!snapshot || !prev) continue;
    const object = compiled.objectById.get(id);
    if (!object || object.metadata?.fixed) continue;

    const mass = object.properties.mass ?? 1;
    if (mass <= 0) continue;

    // Observed acceleration
    const dv = sub(snapshot.velocity, prev.velocity);
    const accel = scale(dv, 1 / Math.max(dt, 1e-6));

    // Known forces from other sources
    const known = knownForces.get(id) ?? zero();
    const expected = scale(accel, mass);

    // Residual = what the engine must have provided via contacts
    const residual = sub(expected, known);

    // Only add residual if body is near-static or on-ground (avoid double-counting dynamic forces)
    const speed = Math.hypot(snapshot.velocity.x, snapshot.velocity.y);
    if (speed < 0.5 && Math.hypot(residual.x, residual.y) > 1e-6) {
      pushComponent(components, id, { id: "support_static", label: "支持力(残差) N", vector: residual, source: "constraint" });
    }
  }

  return components;
}

// Store previous frame snapshots for acceleration-based force residual.
// Updated by box2dStream at each frame boundary.
let _prevFrameSnapshots: Map<string, { position: Vector2; velocity: Vector2 }> | null = null;
export function setPreviousFrameSnapshots(
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>
) {
  _prevFrameSnapshots = new Map(snapshots);
}

/**
 * Compute drag and damping force components from object properties.
 * These forces are applied in appendDragForces and Box2D body defs,
 * but not previously displayed as separate force components.
 */
export function computeDragForceComponents(
  compiled: CompiledGraph,
  bodySnapshots: Map<string, { position: Vector2; velocity: Vector2 }>
): Map<string, ForceComponent[]> {
  const components = new Map<string, ForceComponent[]>();
  for (const object of compiled.graph.objects) {
    const snapshot = bodySnapshots.get(object.id);
    if (!snapshot) continue;
    const vel = snapshot.velocity;

    // drag_coefficient: F_drag = -c * v
    const c = object.properties.drag_coefficient;
    if (c != null && c > 0) {
      const dragForce = scale(vel, -c);
      if (Math.hypot(dragForce.x, dragForce.y) > 1e-9) {
        pushComponent(components, object.id, { id: "drag", label: "阻力 F_drag", vector: dragForce, source: "field" });
      }
    }

    // linear_damping: F_damp = -linear_damping * v  (approximate, applied by Box2D internally)
    const ld = object.properties.linear_damping;
    if (ld != null && ld > 0) {
      const dampForce = scale(vel, -ld);
      if (Math.hypot(dampForce.x, dampForce.y) > 1e-9) {
        pushComponent(components, object.id, { id: "linear_damping", label: "线性阻尼", vector: dampForce, source: "constraint" });
      }
    }
  }
  return components;
}

function getContactNext(contact: Box2D.b2Contact): Box2D.b2Contact | null {
  const next = contact.GetNext();
  if (!next) return null;
  const cur = (contact as unknown as { ptr?: number }).ptr;
  const nxt = (next as unknown as { ptr?: number }).ptr;
  return cur != null && cur === nxt ? null : next;
}

export function sumForceComponents(components: Map<string, ForceComponent[]>): Map<string, Vector2> {
  const totals = new Map<string, Vector2>();
  for (const [id, items] of components) {
    totals.set(id, items.reduce((sum, c) => add(sum, c.vector), zero()));
  }
  return totals;
}

/**
 * Merge two force component maps.
 */
export function mergeForceComponents(
  a: Map<string, ForceComponent[]>,
  b: Map<string, ForceComponent[]>
): Map<string, ForceComponent[]> {
  const result = new Map<string, ForceComponent[]>(
    [...a].map(([id, comps]) => [id, [...comps]])
  );
  for (const [id, comps] of b) {
    result.set(id, [...(result.get(id) ?? []), ...comps]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Field force evaluation (reused from XPBD fieldForces.ts logic)
// ---------------------------------------------------------------------------

function evaluateFieldForce(
  object: PhysicsObject,
  field: Field,
  position: Vector2,
  velocity: Vector2 = zero(),
  time: number = 0,
  bodySnapshots?: Map<string, { position: Vector2; velocity: Vector2 }>
): Vector2 {
  let baseForce: Vector2;

  if (field.model === "uniform") {
    if (isMagneticField(field)) {
      const magneticZ = field.vector[2] ?? 0;
      const charge = object.properties.charge ?? 0;
      baseForce = { x: charge * velocity.y * magneticZ, y: -charge * velocity.x * magneticZ };
    } else {
      const vector = fromDSLVector(field.vector);
      baseForce = isElectricField(field)
        ? scale(vector, object.properties.charge ?? 0)
        : scale(vector, getMass(object));
    }
  } else if (field.model === "radial") {
    // Resolve origin: use tracked object's position when origin_from is set
    let origin = fromDSLVector(field.origin);
    if (field.origin_from && bodySnapshots) {
      const tracked = bodySnapshots.get(field.origin_from);
      if (tracked) origin = tracked.position;
    }
    const delta = sub(position, origin);
    const dist = Math.max(length(delta), 1);
    const useCharge = field.metadata?.tags?.includes("charge") === true;
    const couplingFactor = useCharge ? (object.properties.charge ?? 0) : getMass(object);
    baseForce = scale(normalize(delta), (field.strength * couplingFactor) / (dist * dist));
  } else {
    const expression = typeof field.function === "string" ? field.function : field.function.expr;
    if (expression.trim() === "zero") baseForce = zero();
    else if (expression.trim() === "radial_out") baseForce = normalize(position);
    else if (expression.trim() === "radial_in") baseForce = scale(normalize(position), -1);
    else baseForce = zero();
  }

  // Apply field variation (spatial × temporal scaling)
  const variation = (field as { variation?: { spatial?: string; temporal?: string } }).variation;
  if (variation) {
    let scaleFactor = 1.0;
    if (variation.spatial) {
      scaleFactor *= evaluateExpression(variation.spatial, position.x, position.y, time);
    }
    if (variation.temporal) {
      scaleFactor *= evaluateExpression(variation.temporal, position.x, position.y, time);
    }
    baseForce = scale(baseForce, scaleFactor);
  }

  return baseForce;
}

function isElectricField(field: Field): boolean {
  return field.metadata?.tags?.includes("electric") === true || field.id.toLowerCase().includes("electric");
}

function isMagneticField(field: Field): boolean {
  return field.metadata?.tags?.includes("magnetic") === true || field.id.toLowerCase().includes("magnetic");
}

// Helpers

function pushComponent(components: Map<string, ForceComponent[]>, id: string, comp: ForceComponent) {
  const existing = components.get(id) ?? [];
  existing.push(comp);
  components.set(id, existing);
}

function reactionLabel(interaction: { id: string; model: string; metadata?: { description?: string; tags?: string[] } }): string {
  if (interaction.metadata?.description) return interaction.metadata.description;
  if (interaction.model === "spring" || interaction.metadata?.tags?.includes("spring")) return `${interaction.id} 弹簧力`;
  if (interaction.model === "distance" || interaction.metadata?.tags?.some((tag) => tag === "rope" || tag === "unilateral" || tag === "line")) {
    return `${interaction.id} 张力`;
  }
  return `${interaction.id} 约束反力`;
}

function isUnilateral(tags: string[] | undefined): boolean {
  return tags?.some(tag => tag === "unilateral" || tag === "rope" || tag === "line") === true;
}

// ---------------------------------------------------------------------------
// Simple expression evaluator for field variations
// Supports: + - * / ( ) sin cos exp abs  and variables x y t
// ---------------------------------------------------------------------------

function evaluateExpression(expr: string, x: number, y: number, t: number): number {
  try {
    const tokens = tokenize(expr.toLowerCase().replace(/\s+/g, ''));
    const result = parseExpression(tokens, 0, x, y, t);
    if (!Number.isFinite(result.value)) return 1; // clamp NaN/Infinity
    return result.value;
  } catch {
    console.warn(`[forces] Failed to evaluate field variation expression: "${expr}"`);
    return 1; // fallback: no scaling
  }
}

interface Token { type: 'num' | 'id' | 'op' | 'lparen' | 'rparen'; value: string; }

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; }
    else if (ch === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; }
    else if ('+-*/'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; }
    else if (ch.match(/[0-9.]/)) {
      let num = '';
      while (i < s.length && s[i].match(/[0-9.]/)) { num += s[i]; i++; }
      tokens.push({ type: 'num', value: num });
    } else if (ch.match(/[a-z]/)) {
      let id = '';
      while (i < s.length && s[i].match(/[a-z0-9_]/)) { id += s[i]; i++; }
      tokens.push({ type: 'id', value: id });
    } else { i++; }
  }
  return tokens;
}

interface ParseResult { value: number; pos: number; }

function parseExpression(tokens: Token[], pos: number, x: number, y: number, t: number): ParseResult {
  let left = parseTerm(tokens, pos, x, y, t);
  pos = left.pos;
  while (pos < tokens.length && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
    const op = tokens[pos].value;
    const right = parseTerm(tokens, pos + 1, x, y, t);
    left = {
      value: op === '+' ? left.value + right.value : left.value - right.value,
      pos: right.pos
    };
    pos = left.pos;
  }
  return left;
}

function parseTerm(tokens: Token[], pos: number, x: number, y: number, t: number): ParseResult {
  let left = parseFactor(tokens, pos, x, y, t);
  pos = left.pos;
  while (pos < tokens.length && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
    const op = tokens[pos].value;
    const right = parseFactor(tokens, pos + 1, x, y, t);
    left = {
      value: op === '*' ? left.value * right.value : left.value / (right.value === 0 ? 1 : right.value),
      pos: right.pos
    };
    pos = left.pos;
  }
  return left;
}

function parseFactor(tokens: Token[], pos: number, x: number, y: number, t: number): ParseResult {
  if (pos >= tokens.length) return { value: 0, pos };

  const token = tokens[pos];

  if (token.type === 'num') {
    return { value: Number(token.value), pos: pos + 1 };
  }

  if (token.type === 'id') {
    if (token.value === 'x') return { value: x, pos: pos + 1 };
    if (token.value === 'y') return { value: y, pos: pos + 1 };
    if (token.value === 't') return { value: t, pos: pos + 1 };
    if (token.value === 'pi') return { value: Math.PI, pos: pos + 1 };
    // Functions: sin, cos, exp, abs
    if (token.value === 'sin' || token.value === 'cos' || token.value === 'exp' || token.value === 'abs') {
      const fn = token.value;
      if (pos + 1 < tokens.length && tokens[pos + 1].type === 'lparen') {
        const inner = parseExpression(tokens, pos + 2, x, y, t);
        const val = inner.value;
        if (inner.pos < tokens.length && tokens[inner.pos].type === 'rparen') {
          let result: number;
          switch (fn) {
            case 'sin': result = Math.sin(val); break;
            case 'cos': result = Math.cos(val); break;
            case 'exp': result = Math.exp(Math.min(val, 100)); break; // clamp to avoid overflow
            case 'abs': result = Math.abs(val); break;
            default: result = val;
          }
          return { value: result, pos: inner.pos + 1 };
        }
      }
    }
    // unknown identifier → skip and warn
    console.warn(`[forces] Unknown variable in expression: "${token.value}"`);
    return { value: 0, pos: pos + 1 };
  }

  if (token.type === 'lparen') {
    const result = parseExpression(tokens, pos + 1, x, y, t);
    if (result.pos < tokens.length && tokens[result.pos].type === 'rparen') {
      return { value: result.value, pos: result.pos + 1 };
    }
    return result; // missing right paren, return anyway
  }

  // Unary minus
  if (token.type === 'op' && token.value === '-') {
    const right = parseFactor(tokens, pos + 1, x, y, t);
    return { value: -right.value, pos: right.pos };
  }

  return { value: 0, pos: pos + 1 };
}
