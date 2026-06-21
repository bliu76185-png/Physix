import type { Vector2 } from "../graph/types";
import type { DSLVector } from "../graph/types";

export const add = (a: Vector2, b: Vector2): Vector2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vector2, b: Vector2): Vector2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vector2, k: number): Vector2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vector2, b: Vector2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vector2): number => Math.hypot(a.x, a.y);
export const normalize = (a: Vector2): Vector2 => {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
};
export const zero = (): Vector2 => ({ x: 0, y: 0 });
export const fromDSLVector = (value: DSLVector | undefined): Vector2 => ({ x: value?.[0] ?? 0, y: value?.[1] ?? 0 });
export const toDSLVector = (value: Vector2): DSLVector => [value.x, value.y];

