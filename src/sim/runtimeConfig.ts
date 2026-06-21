import type { PhysicsGraph } from "../graph/types";

export type SolverMode = "gauss_seidel" | "jacobi";

export interface RuntimeConfig {
  dt: number;
  duration: number;
  substeps: number;
  iterations: number;
  timeScale: number;
  stabilizationBeta: number;
  contactSlop: number;
  driftCorrectionPasses: number;
  solverMode: SolverMode;
  enableSleeping: boolean;
  sleepVelocityThreshold: number;
  sleepFrameThreshold: number;
  enableShapeMatching: boolean;
  gravity: number;
  /** Box2D velocity iterations per Step */
  velIterations: number;
  /** Box2D position iterations per Step */
  posIterations: number;
}

export function getRuntimeConfig(graph: PhysicsGraph): RuntimeConfig {
  const terminal = expressionToString(graph.timeline.terminal_condition);
  const durationMatch = terminal.match(/t\s*(?:>=|>|==)\s*([0-9.]+)/);
  const lastKeyframe = graph.timeline.keyframes.reduce((max, keyframe) => Math.max(max, keyframe.t), 0);
  const duration = durationMatch ? Number(durationMatch[1]) : Math.max(lastKeyframe, 6);

  const gravityVector = graph.world.gravity?.vector;
  const gravity = gravityVector
    ? Math.hypot(gravityVector[0], gravityVector[1])
    : graph.world.constants?.g ?? 980;

  return {
    dt: 0.016,
    duration,
    substeps: 4,
    iterations: 8,
    timeScale: 1,
    stabilizationBeta: 0.12,
    contactSlop: 0.01,
    driftCorrectionPasses: 1,
    solverMode: "gauss_seidel",
    enableSleeping: true,
    sleepVelocityThreshold: 0.5,
    sleepFrameThreshold: 30,
    enableShapeMatching: true,
    gravity,
    velIterations: 8,
    posIterations: 3,
  };
}

function expressionToString(expression: PhysicsGraph["timeline"]["terminal_condition"]): string {
  if (!expression) return "";
  return typeof expression === "string" ? expression : expression.expr;
}
