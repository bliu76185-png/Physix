import type { PhysicsObject, Vector2 } from "../graph/types";
import { fromDSLVector, zero } from "./vector";

export function isFixed(object: PhysicsObject): boolean {
  return object.metadata?.role === "anchor" || object.metadata?.fixed === true || object.degrees_of_freedom.translation === false;
}

export function isExternallyDriven(object: PhysicsObject): boolean {
  return object.metadata?.role === "kinematic_driver";
}

export function isSolverDriven(object: PhysicsObject): boolean {
  return !isFixed(object) && !isExternallyDriven(object);
}

export function getMass(object: PhysicsObject): number {
  return isSolverDriven(object) ? object.properties.mass ?? 1 : Number.POSITIVE_INFINITY;
}

export function getInvMass(object: PhysicsObject): number {
  return isSolverDriven(object) ? 1 / getMass(object) : 0;
}

export function getInitialPosition(object: PhysicsObject, initialState: Record<string, { position?: unknown }>): Vector2 {
  const state = initialState[object.id];
  return fromDSLVector(Array.isArray(state?.position) ? state.position as [number, number] : undefined);
}

export function getInitialVelocity(object: PhysicsObject, initialState: Record<string, { velocity?: unknown }>): Vector2 {
  const state = initialState[object.id];
  return Array.isArray(state?.velocity) ? fromDSLVector(state.velocity as [number, number]) : zero();
}
