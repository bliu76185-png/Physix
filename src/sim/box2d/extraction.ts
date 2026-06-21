import type { CompiledGraph } from "../compiler";
import type { Vector2, ForceComponent, StateFrame, NodeState, SolverDiagnostics } from "../../graph/types";
import { getMass } from "../forceBackend";
import { zero } from "../vector";
import type { Box2DModule } from "./bodies";

/**
 * Extract positions and velocities from Box2D bodies as plain Vector2 snapshots.
 */
export function snapshotBodies(
  bodyById: Map<string, Box2D.b2Body>
): Map<string, { position: Vector2; velocity: Vector2 }> {
  const snapshots = new Map<string, { position: Vector2; velocity: Vector2 }>();
  for (const [id, body] of bodyById) {
    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();
    snapshots.set(id, {
      position: { x: pos.get_x(), y: pos.get_y() },
      velocity: { x: vel.get_x(), y: vel.get_y() }
    });
  }
  return snapshots;
}

/**
 * Build a StateFrame from Box2D body data.
 * Force comes from pre-computed field/constraint/event force components,
 * NOT from velocity delta (which would be ~0 at frame boundaries).
 */
export function extractStateFrame(
  compiled: CompiledGraph,
  bodyById: Map<string, Box2D.b2Body>,
  time: number,
  diagnostics: SolverDiagnostics,
  forceComponents: Map<string, ForceComponent[]>,
  observableForces: Map<string, Vector2>,
  dt: number,
  workAccumulator: Map<string, number>,
  springPEMap: Map<string, number>
): StateFrame {
  const nodes: NodeState[] = [];

  for (const object of compiled.graph.objects) {
    const body = bodyById.get(object.id);
    if (!body) continue;

    const pos = body.GetPosition();
    const vel = body.GetLinearVelocity();
    const mass = getMass(object);
    const finiteMass = Number.isFinite(mass) ? mass : 0;

    // Force from pre-computed observable force components (field + constraint + event)
    const force = observableForces.get(object.id) ?? zero();

    // Kinetic energy: 0.5 * m * v² + 0.5 * I * ω²
    const inertia = object.properties.inertia ?? 0;
    const angVel = body.GetAngularVelocity();
    const kinetic =
      0.5 * finiteMass * (vel.get_x() ** 2 + vel.get_y() ** 2) +
      (inertia > 0 ? 0.5 * inertia * angVel ** 2 : 0);

    // Potential energy: -m * g · r
    let potential = 0;
    const uniformGravity = compiled.graph.fields.find(f => f.model === "uniform");
    if (uniformGravity && finiteMass > 0) {
      potential = -finiteMass * (
        uniformGravity.vector[0] * pos.get_x() + uniformGravity.vector[1] * pos.get_y()
      );
    }

    // Power and work
    let power: number | undefined;
    let work: number | undefined;
    if (compiled.graph.observables.power || compiled.graph.observables.work) {
      power = force.x * vel.get_x() + force.y * vel.get_y();
      if (compiled.graph.observables.work && dt > 0) {
        const prev = workAccumulator.get(object.id) ?? 0;
        work = prev + power * dt;
        workAccumulator.set(object.id, work);
      }
    }

    nodes.push({
      id: object.id,
      position: { x: pos.get_x(), y: pos.get_y() },
      velocity: { x: vel.get_x(), y: vel.get_y() },
      force,
      forceComponents: forceComponents.get(object.id),
      energy: {
        kinetic,
        potential,
        spring: springPEMap.get(object.id)
      },
      rotation: body.GetAngle(),
      angularVelocity: angVel,
      power,
      work
    });
  }

  return { time, nodes, diagnostics };
}
