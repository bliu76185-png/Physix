/**
 * Box2D Simulation Stream
 * Main simulation loop using Box2D-WASM as the physics engine.
 * Outputs StateFrame array compatible with the rendering layer.
 */
import Box2DFactory from "box2d-wasm";
import { compileGraph, type CompiledGraph } from "./compiler";
import { getRuntimeConfig } from "./runtimeConfig";
import { applyBox2DMotionProfiles, computeMotionProfileForces, computeMotionProfileInferredForces } from "./motionProfiles";
import type { ForceComponent, PhysicsGraph, PhysicsObject, StateFrame, Vector2 } from "../graph/types";
import {
  createBox2DBodies,
  createBox2DJoints,
  createBox2DWorld,
  computeFieldForces,
  appendDragForces,
  applyForcesToBodies,
  computeObservableForceComponents,
  computeContactForceComponents,
  computeDragForceComponents,
  setPreviousFrameSnapshots,
  sumForceComponents,
  mergeForceComponents,
  snapshotBodies,
  extractStateFrame,
  createEmptySolverDiagnostics,
  collectBox2DSolverDiagnostics,
  createEventRuntimeState,
  updateBox2DEventRuntimeState,
  applyBox2DEventControls,
  type Box2DModule,
  type EventRuntimeState
} from "./box2d/index";

const MAX_CONTACT_ITERATIONS = 256;

export interface Box2DStreamOptions {
  signal?: AbortSignal;
  yieldEveryFrames?: number;
  onProgress?: (message: string) => void;
}

export async function generateBox2DStateStream(
  graph: PhysicsGraph,
  options: Box2DStreamOptions = {}
): Promise<StateFrame[]> {
  const { onProgress, signal, yieldEveryFrames = 12 } = options;
  const totalStarted = now();
  const profile = createProfile();
  throwIfAborted(signal);

  // Dev mode: pre-fetch WASM binary to bypass Emscripten's problematic fetch chain in Vite.
  // Prod mode: Vite's build-time asset resolution handles WASM via new URL in Box2D.js.
  const isDev = import.meta.env.DEV;
  let factoryOptions: Record<string, unknown> | undefined;

  if (isDev) {
    // SIMD detection (same as box2d-wasm entry.js)
    const hasSIMD = WebAssembly.validate(
      new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])
    );
    const wasmFile = hasSIMD ? "Box2D.simd.wasm" : "Box2D.wasm";
    try {
      console.log("[Box2D] Pre-fetching WASM binary:", wasmFile);
      const resp = await fetch(`/node_modules/box2d-wasm/dist/es/${wasmFile}`);
      const buf = await resp.arrayBuffer();
      factoryOptions = { wasmBinary: buf };
      console.log("[Box2D] WASM binary loaded:", buf.byteLength, "bytes");
      onProgress?.(`Box2D WASM binary loaded (${buf.byteLength} bytes). Initializing engine...`);
    } catch (e) {
      console.warn("[Box2D] WASM pre-fetch failed, falling back:", e);
      onProgress?.("Box2D WASM pre-fetch failed. Trying package fallback loader...");
    }
  }

  throwIfAborted(signal);
  console.log("[Box2D] Initializing WASM engine...");
  onProgress?.("Initializing Box2D WASM engine...");
  const initStarted = now();
  const Box2D: Box2DModule = await withTimeout(
    Box2DFactory(factoryOptions),
    10000,
    "Box2D WASM engine initialization timed out after 10s."
  );
  profile.initMs += now() - initStarted;
  throwIfAborted(signal);
  console.log("[Box2D] WASM engine ready.");
  onProgress?.("Box2D engine ready. Generating simulation frames...");
  const compiled = compileGraph(graph);
  const runtime = getRuntimeConfig(graph);

  // Create world first, then bodies, then joints (joints need bodies to exist)
  const setupStarted = now();
  const world = createBox2DWorld(Box2D);
  const bodyById = createBox2DBodies(Box2D, world, compiled);
  const jointById = createBox2DJoints(Box2D, world, compiled, bodyById);
  profile.setupMs += now() - setupStarted;

  const eventState: EventRuntimeState = createEventRuntimeState();
  const stickyPairs = new Map<string, { a: string; b: string; restLength: number }>();
  const workAccumulator = new Map<string, number>();
  const destroyedConstraints = new Set<string>();
  let profileInferredForces: Map<string, ForceComponent[]> = new Map();
  let contactForceAccumulator: Map<string, ForceComponent[]> = new Map();

  let pendingDiagnostics = createEmptySolverDiagnostics();
  const previousContactIds = new Set<string>();

  const frames: StateFrame[] = [];
  const dt = runtime.dt * runtime.timeScale;
  const totalFrames = Math.max(1, Math.floor(runtime.duration / dt));
  const subDt = dt / runtime.substeps;

  for (let frameIndex = 0; frameIndex <= totalFrames; frameIndex += 1) {
    throwIfAborted(signal);
    if (frameIndex > 0 && frameIndex % yieldEveryFrames === 0) {
      await yieldToMainThread();
      throwIfAborted(signal);
      onProgress?.(
        `Generating simulation frames... ${frameIndex}/${totalFrames} ` +
        `(step ${profile.stepMs.toFixed(1)}ms, diagnostics ${profile.diagnosticsMs.toFixed(1)}ms)`
      );
    }

    const currentTime = Number((frameIndex * dt).toFixed(4));

    // Compute energy and force components
    const bodySnapshots = snapshotBodies(bodyById);
    const springPEMap = computeSpringPE(compiled, bodySnapshots);
    const dragForces = computeDragForceComponents(compiled, bodySnapshots);
    const baseComponents = mergeForceComponents(
      mergeForceComponents(
        computeObservableForceComponents(compiled, bodySnapshots, jointById, dt, currentTime),
        eventState.eventForces
      ),
      profileInferredForces
    );
    const knownForces = sumForceComponents(baseComponents);
    const staticResidual = computeContactForceComponents(
      Box2D, world, compiled, bodyById, bodySnapshots, knownForces, dt, currentTime
    );
    const forceComponents = mergeForceComponents(
      mergeForceComponents(
        mergeForceComponents(baseComponents, contactForceAccumulator),
        dragForces
      ),
      staticResidual
    );
    const observableForces = sumForceComponents(forceComponents);
    setPreviousFrameSnapshots(bodySnapshots);

    // Build StateFrame (force = field + constraint + event components)
    frames.push(
      extractStateFrame(
        compiled, bodyById,
        currentTime,
        pendingDiagnostics,
        forceComponents,
        observableForces,
        dt,
        workAccumulator,
        springPEMap
      )
    );

    if (frameIndex === totalFrames) break;

    // Substepping loop
    profileInferredForces = new Map();
    contactForceAccumulator = new Map();
    let nextDiagnostics = createEmptySolverDiagnostics();
    for (let substep = 0; substep < runtime.substeps; substep += 1) {
      throwIfAborted(signal);
      const substepTime = frameIndex * dt + (substep + 1) * subDt;

      // 1. Handle time-based constraint activation/removal
      processConstraintEvents(Box2D, compiled, world, jointById, destroyedConstraints, substepTime);

      // 2. Compute and apply field forces (gravity + electric + magnetic + drag)
      const snapshots = snapshotBodies(bodyById);
      const forces = appendForceMaps(
        appendDragForces(compiled, snapshots, computeFieldForces(compiled, snapshots, substepTime)),
        computeMotionProfileForces(compiled, substepTime)
      );
      applyForcesToBodies(Box2D, bodyById, forces);

      // 2b. Snapshot pos+vel before profile, apply, compute inferred external force
      const preProfile = snapshotBodiesLight(bodyById);
      applyBox2DMotionProfiles(Box2D, compiled, bodyById, substepTime);
      const inferred = computeMotionProfileInferredForces(compiled, preProfile, bodyById, subDt, substepTime);
      for (const [id, comps] of inferred) {
        const existing = profileInferredForces.get(id) ?? [];
        profileInferredForces.set(id, [...existing, ...comps]);
      }

      // 3. Manage rope constraints: create/destroy joint per-substep
      manageRopeConstraints(Box2D, compiled, world, bodyById, jointById);

      // 4. Box2D physics step
      const stepStarted = now();
      world.Step(subDt, runtime.velIterations, runtime.posIterations);
      profile.stepMs += now() - stepStarted;

      // 4a. Apply per-contact pairwise friction/restitution overrides from DSL constraints
      applyContactOverrides(Box2D, compiled, world, bodyById);

      // 4b. Accumulate contact impulse from this substep (impulse-based only)
      const subContactForces = computeContactForceComponents(
        Box2D, world, compiled, bodyById, new Map(), new Map(), subDt, substepTime
      );
      contactForceAccumulator = mergeForceComponents(contactForceAccumulator, subContactForces);

      // 4b. Handle sticky contacts
      const stickyStarted = now();
      handleStickyContacts(Box2D, compiled, world, bodyById, stickyPairs);
      profile.stickyMs += now() - stickyStarted;

      // 5. Event controls
      const postStepSnapshots = snapshotBodies(bodyById);
      updateBox2DEventRuntimeState(compiled, postStepSnapshots, jointById, eventState, substepTime);
      applyBox2DEventControls(Box2D, compiled, world, bodyById, jointById, eventState, subDt, substepTime);

      // 6. Collect diagnostics
      const diagnosticsStarted = now();
      nextDiagnostics = mergeDiagnostics(
        nextDiagnostics,
        collectBox2DSolverDiagnostics(Box2D, world, previousContactIds)
      );
      profile.diagnosticsMs += now() - diagnosticsStarted;
    }

    pendingDiagnostics = nextDiagnostics;

    // Merge duplicate entries across substeps (sum vectors by component id)
    contactForceAccumulator = dedupeForceComponents(contactForceAccumulator);
    profileInferredForces = dedupeForceComponents(profileInferredForces);
  }

  const summary =
    `Box2D simulation profile: total ${(now() - totalStarted).toFixed(1)}ms, ` +
    `frames ${frames.length}, init ${profile.initMs.toFixed(1)}ms, ` +
    `setup ${profile.setupMs.toFixed(1)}ms, step ${profile.stepMs.toFixed(1)}ms, ` +
    `sticky ${profile.stickyMs.toFixed(1)}ms, diagnostics ${profile.diagnosticsMs.toFixed(1)}ms.`;
  console.log(`[Box2D] ${summary}`);
  onProgress?.(summary);
  return frames;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error("Box2D simulation cancelled.");
  error.name = "AbortError";
  throw error;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function snapshotBodiesLight(bodyById: Map<string, Box2D.b2Body>): Map<string, { position: Vector2; velocity: Vector2 }> {
  const map = new Map<string, { position: Vector2; velocity: Vector2 }>();
  for (const [id, body] of bodyById) {
    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();
    map.set(id, { position: { x: pos.get_x(), y: pos.get_y() }, velocity: { x: vel.get_x(), y: vel.get_y() } });
  }
  return map;
}

/**
 * Apply per-contact friction and restitution overrides from DSL inequality constraints.
 * Box2D body fixtures set defaults; this overrides for specific object pairs.
 */
function applyContactOverrides(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  world: Box2D.b2World,
  bodyById: Map<string, Box2D.b2Body>
) {
  // Build body→id reverse map
  const idByBody = new Map<Box2D.b2Body, string>();
  for (const [id, body] of bodyById) idByBody.set(body, id);

  // Collect per-pair override parameters from DSL inequality constraints
  const pairParams = new Map<string, { friction?: number; restitution?: number }>();
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "constraint" || interaction.model !== "inequality") continue;
    const [a, b] = interaction.between;
    if (!a || !b) continue;
    const p = interaction.parameters;
    if (p.friction != null || p.restitution != null) {
      const key = stablePairKey(a, b);
      pairParams.set(key, { friction: p.friction, restitution: p.restitution });
    }
  }
  if (pairParams.size === 0) return;

  // Iterate contacts and apply overrides
  let contact: Box2D.b2Contact | null = world.GetContactList();
  let iterations = 0;
  while (contact && iterations < 256) {
    iterations += 1;
    if (!contact.IsTouching()) { contact = getContactNext(contact); continue; }
    const idA = idByBody.get(contact.GetFixtureA().GetBody());
    const idB = idByBody.get(contact.GetFixtureB().GetBody());
    if (idA && idB) {
      const key = stablePairKey(idA, idB);
      const params = pairParams.get(key);
      if (params) {
        if (params.friction != null) contact.SetFriction(params.friction);
        if (params.restitution != null) contact.SetRestitution(params.restitution);
      }
    }
    contact = getContactNext(contact);
  }
}

function getContactNext(contact: Box2D.b2Contact): Box2D.b2Contact | null {
  const next = contact.GetNext();
  if (!next) return null;
  const cur = (contact as unknown as { ptr?: number }).ptr;
  const nxt = (next as unknown as { ptr?: number }).ptr;
  return cur != null && cur === nxt ? null : next;
}

function dedupeForceComponents(components: Map<string, ForceComponent[]>): Map<string, ForceComponent[]> {
  const result = new Map<string, ForceComponent[]>();
  for (const [id, comps] of components) {
    const merged = new Map<string, ForceComponent>();
    for (const comp of comps) {
      const existing = merged.get(comp.id);
      if (existing) {
        existing.vector = { x: existing.vector.x + comp.vector.x, y: existing.vector.y + comp.vector.y };
      } else {
        merged.set(comp.id, { ...comp });
      }
    }
    result.set(id, [...merged.values()]);
  }
  return result;
}

function createProfile() {
  return {
    diagnosticsMs: 0,
    initMs: 0,
    setupMs: 0,
    stepMs: 0,
    stickyMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Constraint event processing
// ---------------------------------------------------------------------------

interface ConstraintEventInfo {
  activationTime?: number;
  removalTime?: number;
}

function getConstraintEventTimes(compiled: CompiledGraph, constraintId: string): ConstraintEventInfo {
  const info: ConstraintEventInfo = {};
  for (const event of compiled.graph.events) {
    if (event.action.target !== constraintId) continue;
    const condition = typeof event.condition === "string" ? event.condition : event.condition.expr;
    const match = condition.match(/t\s*(?:>=|>|==)\s*([0-9.]+)/);
    if (!match) continue;
    const t = Number(match[1]);

    if (event.action.type === "remove") {
      info.removalTime = t;
    }
  }
  return info;
}

function processConstraintEvents(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  world: Box2D.b2World,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>,
  destroyedConstraints: Set<string>,
  currentTime: number
) {
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "constraint") continue;
    const times = getConstraintEventTimes(compiled, interaction.id);

    // Handle removal
    if (times.removalTime != null && currentTime >= times.removalTime && !destroyedConstraints.has(interaction.id)) {
      const joint = jointById.get(interaction.id);
      if (joint) {
        if (Array.isArray(joint)) {
          for (const j of joint) world.DestroyJoint(j);
        } else {
          world.DestroyJoint(joint);
        }
        jointById.delete(interaction.id);
      }
      destroyedConstraints.add(interaction.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Sticky contact handling
// ---------------------------------------------------------------------------

function handleStickyContacts(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  world: Box2D.b2World,
  bodyById: Map<string, Box2D.b2Body>,
  stickyPairs: Map<string, { a: string; b: string; restLength: number }>
) {
  // Build a quick id-to-object map
  const bodyToId = new Map<Box2D.b2Body, string>();
  for (const [id, body] of bodyById) {
    bodyToId.set(body, id);
  }

  let contact: Box2D.b2Contact | null = world.GetContactList();
  let contactIterations = 0;
  while (contact && contactIterations < MAX_CONTACT_ITERATIONS) {
    contactIterations += 1;
    if (!contact.IsTouching()) {
      contact = getNextContact(contact);
      continue;
    }

    const bodyA = contact.GetFixtureA().GetBody();
    const bodyB = contact.GetFixtureB().GetBody();
    const aId = bodyToId.get(bodyA);
    const bId = bodyToId.get(bodyB);
    if (!aId || !bId) {
      contact = getNextContact(contact);
      continue;
    }

    const objectA = compiled.objectById.get(aId);
    const objectB = compiled.objectById.get(bId);
    if (objectA?.properties.material === "sticky" && objectB?.properties.material === "sticky") {
      const key = stablePairKey(aId, bId);
      if (!stickyPairs.has(key)) {
        const restLen = getStickyRestLength(objectA, objectB);
        stickyPairs.set(key, { a: aId, b: bId, restLength: restLen });

        // Create a distance joint to lock the sticky pair
        const def = new Box2D.b2DistanceJointDef();
        def.set_bodyA(bodyA);
        def.set_bodyB(bodyB);
        def.get_localAnchorA().Set(0, 0);
        def.get_localAnchorB().Set(0, 0);
        def.set_length(restLen);
        def.set_stiffness(1e8);
        def.set_damping(1);
        def.set_collideConnected(false);
        world.CreateJoint(def);
        def.__destroy__();
      }
    }

    contact = getNextContact(contact);
  }
}

function getNextContact(contact: Box2D.b2Contact): Box2D.b2Contact | null {
  const next = contact.GetNext();
  if (!next) return null;
  const currentPtr = (contact as unknown as { ptr?: number }).ptr;
  const nextPtr = (next as unknown as { ptr?: number }).ptr;
  return currentPtr != null && currentPtr === nextPtr ? null : next;
}

function getStickyRestLength(objectA: PhysicsObject, objectB: PhysicsObject): number {
  const geomA = objectA.geometry;
  const geomB = objectB.geometry;

  if (geomA?.type === "circle" && geomB?.type === "circle") {
    return geomA.radius + geomB.radius;
  }
  if (geomA?.type === "box" && geomB?.type === "box") {
    return geomA.size[0] / 2 + geomB.size[0] / 2;
  }
  if (geomA?.type === "circle" && geomB?.type === "box") {
    return geomA.radius + geomB.size[0] / 2;
  }
  if (geomB?.type === "circle" && geomA?.type === "box") {
    return geomB.radius + geomA.size[0] / 2;
  }
  return 1.0;
}

// ---------------------------------------------------------------------------
// Spring potential energy computation
// ---------------------------------------------------------------------------

function computeSpringPE(
  compiled: CompiledGraph,
  snapshots: Map<string, { position: Vector2; velocity: Vector2 }>
): Map<string, number> {
  const peMap = new Map<string, number>();
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "constraint" || (interaction.model !== "distance" && interaction.model !== "spring")) continue;
    const compliance = interaction.parameters.compliance ?? 0;
    if (compliance <= 0) continue;
    const [aId, bId] = interaction.between;
    const restLen = interaction.parameters.value ?? interaction.parameters.rest_length;
    if (!aId || !bId || typeof restLen !== "number") continue;

    const pa = snapshots.get(aId);
    const pb = snapshots.get(bId);
    if (!pa || !pb) continue;

    const delta = { x: pb.position.x - pa.position.x, y: pb.position.y - pa.position.y };
    const dist = Math.hypot(delta.x, delta.y);
    const k = 1 / compliance;
    const x = Math.abs(dist - restLen);
    const totalPE = 0.5 * k * x * x;
    peMap.set(aId, (peMap.get(aId) ?? 0) + totalPE * 0.5);
    peMap.set(bId, (peMap.get(bId) ?? 0) + totalPE * 0.5);
  }
  return peMap;
}

// ---------------------------------------------------------------------------
// Diagnostics merge
// ---------------------------------------------------------------------------

function mergeDiagnostics(
  a: ReturnType<typeof createEmptySolverDiagnostics>,
  b: ReturnType<typeof createEmptySolverDiagnostics>
) {
  const eventIds = new Set(a.events.map(e => e.id));
  return {
    contactCount: Math.max(a.contactCount, b.contactCount),
    activeConstraintCount: Math.max(a.activeConstraintCount, b.activeConstraintCount),
    maxConstraintError: Math.max(a.maxConstraintError, b.maxConstraintError),
    lambdaNorm: a.lambdaNorm + b.lambdaNorm,
    maxLambdaRatio: Math.max(a.maxLambdaRatio, b.maxLambdaRatio),
    clampedConstraintCount: a.clampedConstraintCount + b.clampedConstraintCount,
    energyDrift: Math.max(a.energyDrift, b.energyDrift),
    totalNormalImpulse: a.totalNormalImpulse + b.totalNormalImpulse,
    totalFrictionImpulse: a.totalFrictionImpulse + b.totalFrictionImpulse,
    contacts: b.contacts.length > 0 ? b.contacts : a.contacts,
    events: [...a.events, ...b.events.filter(e => !eventIds.has(e.id))]
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function stablePairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function appendForceMaps(a: Map<string, Vector2>, b: Map<string, Vector2>): Map<string, Vector2> {
  for (const [id, force] of b) {
    const current = a.get(id) ?? { x: 0, y: 0 };
    a.set(id, { x: current.x + force.x, y: current.y + force.y });
  }
  return a;
}

// ---------------------------------------------------------------------------
// Rope constraint management – dynamic stiffness toggling per substep
// ---------------------------------------------------------------------------

/**
 * Check whether a constraint is a rope (unilateral distance).
 */
function isRopeConstraint(tags?: string[]): boolean {
  return tags?.some(t => t === "unilateral" || t === "rope" || t === "line") === true;
}

/**
 * Per-substep: for each rope constraint, check distance between the two bodies.
 *   - dist < ropeLength × 0.97  → destroy joint (rope slack, free motion)
 *   - dist ≥ ropeLength         → create joint (rope taut, constrained)
 *   - gap [0.97, 1.00)          → keep current state (hysteresis)
 */
function manageRopeConstraints(
  Box2D: Box2DModule,
  compiled: CompiledGraph,
  world: Box2D.b2World,
  bodyById: Map<string, Box2D.b2Body>,
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>
) {
  for (const interaction of compiled.graph.interactions) {
    if (interaction.type !== "constraint" || interaction.model !== "distance") continue;
    if (!isRopeConstraint(interaction.metadata?.tags)) continue;

    const ropeLength = interaction.parameters.value;
    if (typeof ropeLength !== "number") continue;

    const [aId, bId] = interaction.between;
    const bodyA = bodyById.get(aId);
    const bodyB = bodyById.get(bId);
    if (!bodyA || !bodyB) continue;

    const posA = bodyA.GetPosition();
    const posB = bodyB.GetPosition();
    const dist = Math.hypot(posB.get_x() - posA.get_x(), posB.get_y() - posA.get_y());

    const existing = jointById.get(interaction.id);
    const jointExists = existing != null && !Array.isArray(existing);

    // 3% hysteresis band: destroy at 0.97×ropeLength, create at 1.00×ropeLength
    if (dist < ropeLength * 0.97 && jointExists) {
      world.DestroyJoint(existing as Box2D.b2Joint);
      jointById.delete(interaction.id);
    } else if (dist >= ropeLength && !jointExists) {
      const compliance = interaction.parameters.compliance ?? 0;
      const stiff = compliance > 1e-9 ? 1 / compliance : 1e10;
      const jointDef = new Box2D.b2DistanceJointDef();
      jointDef.set_bodyA(bodyA);
      jointDef.set_bodyB(bodyB);
      (jointDef as any).get_localAnchorA().Set(0, 0);
      (jointDef as any).get_localAnchorB().Set(0, 0);
      jointDef.set_length(ropeLength);
      jointDef.set_stiffness(stiff);
      jointDef.set_damping(0);
      jointDef.set_collideConnected(false);
      const newJoint = world.CreateJoint(jointDef);
      jointDef.__destroy__();
      jointById.set(interaction.id, newJoint);
    }
  }
}
