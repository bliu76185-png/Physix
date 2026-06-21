import type { ConstraintInteraction, PhysicsGraph, StateFrame } from "../graph/types";

export interface TimelineMarker {
  id: string;
  label: string;
  /** Start frame of the marker range */
  frameIndex: number;
  /** Optional end frame for range markers (event/constraint transitions span multiple frames) */
  endFrameIndex?: number;
  time: number;
  kind: "boundary" | "dsl" | "event" | "constraint" | "discontinuity";
}

/** Tolerance window in frames for merging nearby markers into a range */
const RANGE_TOLERANCE = 3;

export function deriveTimelineMarkers(graph: PhysicsGraph, frames: StateFrame[]): TimelineMarker[] {
  if (frames.length === 0) return [];
  const raw: TimelineMarker[] = [
    createMarker("start", "Start", 0, frames, "boundary"),
    createMarker("end", "End", frames.length - 1, frames, "boundary"),
  ];

  for (const keyframe of graph.timeline.keyframes) {
    const index = nearestFrameIndex(frames, keyframe.t);
    if (keyframe.event) {
      raw.push(createMarker(`dsl_${keyframe.event}`, `DSL:${keyframe.event}`, index, frames, "dsl"));
      raw.push(createRangeMarker(`event_${keyframe.event}`, `Event:${keyframe.event}`, index, frames, "event"));
    } else {
      raw.push(createMarker(`dsl_${keyframe.id ?? keyframe.t}`, "DSL keyframe", index, frames, "dsl"));
    }
  }

  for (const event of graph.events) {
    const index = firstMatchingFrameIndex(graph, frames, event.condition);
    if (index !== undefined) {
      raw.push(createRangeMarker(`event_${event.id}`, `Event:${event.id}`, index, frames, "event"));
    }
  }

  for (const interaction of graph.interactions) {
    if (interaction.type !== "constraint" || interaction.model !== "distance") continue;
    const index = firstDistanceCrossingFrameIndex(interaction, frames);
    if (index !== undefined) {
      raw.push(createRangeMarker(`constraint_${interaction.id}`, `Constraint:${interaction.id}`, index, frames, "constraint"));
    }
  }

  detectDiscontinuities(frames).forEach((index, i) => {
    raw.push(createMarker(`jump_${i}_${index}`, "Discontinuity", index, frames, "discontinuity"));
  });

  return mergeNearbyMarkers(raw, frames.length);
}

/** Create a range marker centered at index ± tolerance. */
function createRangeMarker(
  id: string, label: string, index: number, frames: StateFrame[], kind: TimelineMarker["kind"]
): TimelineMarker {
  const start = Math.max(0, index - RANGE_TOLERANCE);
  const end = Math.min(frames.length - 1, index + RANGE_TOLERANCE);
  return {
    id,
    label,
    frameIndex: start,
    endFrameIndex: end,
    time: frames[start]?.time ?? 0,
    kind,
  };
}

/** Merge overlapping same-kind markers into a single range. */
function mergeNearbyMarkers(markers: TimelineMarker[], frameCount: number): TimelineMarker[] {
  const byKind = new Map<string, TimelineMarker[]>();
  for (const m of markers) {
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind)!.push(m);
  }

  const result: TimelineMarker[] = [];
  for (const [kind, group] of byKind) {
    if (kind === "boundary" || kind === "discontinuity") {
      result.push(...group);
      continue;
    }
    // Sort by frameIndex and merge overlapping
    group.sort((a, b) => a.frameIndex - b.frameIndex);
    let current = group[0];
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      const curEnd = current.endFrameIndex ?? current.frameIndex;
      if (next.frameIndex <= curEnd + RANGE_TOLERANCE) {
        // Merge: extend range
        current.endFrameIndex = Math.max(curEnd, next.endFrameIndex ?? next.frameIndex);
        current.label = current.label.replace(/\s*\+\s*/, " + ") + " + " + next.label;
      } else {
        result.push(current);
        current = next;
      }
    }
    result.push(current);
  }

  // Clamp to frame range
  for (const m of result) {
    m.frameIndex = Math.max(0, Math.min(frameCount - 1, m.frameIndex));
    if (m.endFrameIndex != null) m.endFrameIndex = Math.max(0, Math.min(frameCount - 1, m.endFrameIndex));
  }

  return result.sort((a, b) => a.frameIndex - b.frameIndex);
}

function createMarker(
  id: string,
  label: string,
  frameIndex: number,
  frames: StateFrame[],
  kind: TimelineMarker["kind"]
): TimelineMarker {
  return {
    id,
    label,
    frameIndex,
    time: frames[frameIndex]?.time ?? 0,
    kind,
  };
}

function nearestFrameIndex(frames: StateFrame[], time: number): number {
  return frames.reduce(
    (best, frame, index) => (Math.abs(frame.time - time) < Math.abs(frames[best].time - time) ? index : best),
    0
  );
}

function firstMatchingFrameIndex(
  _graph: PhysicsGraph,
  frames: StateFrame[],
  condition: PhysicsGraph["events"][number]["condition"]
) {
  const expression = typeof condition === "string" ? condition : condition.expr;
  const match = expression.match(/([A-Za-z_][A-Za-z0-9_-]*)\.(x|y|vx|vy)\s*(>=|>|<=|<|==)\s*(-?[0-9.]+)/);
  if (!match) {
    const timeMatch = expression.match(/t\s*(>=|>|<=|<|==)\s*([0-9.]+)/);
    return timeMatch ? frames.findIndex((frame) => compare(frame.time, timeMatch[1], Number(timeMatch[2]))) : undefined;
  }

  const [, objectId, quantity, operator, targetText] = match;
  const target = Number(targetText);
  const index = frames.findIndex((frame) => {
    const state = frame.nodes.find((node) => node.id === objectId);
    if (!state) return false;
    const value =
      quantity === "x"
        ? state.position.x
        : quantity === "y"
          ? state.position.y
          : quantity === "vx"
            ? state.velocity.x
            : state.velocity.y;
    return compare(value, operator, target);
  });
  return index >= 0 ? index : undefined;
}

function firstDistanceCrossingFrameIndex(interaction: ConstraintInteraction, frames: StateFrame[]) {
  const [a, b] = interaction.between;
  const target = interaction.parameters.value;
  if (!a || !b || typeof target !== "number") return undefined;
  const tolerance = Math.max(0.005, target * 0.005);

  for (let i = 1; i < frames.length; i += 1) {
    const previous = distanceAt(frames[i - 1], a, b);
    const current = distanceAt(frames[i], a, b);
    if (previous === undefined || current === undefined) continue;
    if ((previous < target && current >= target) || (previous > target && current <= target)) return i;
    if (previous < target - tolerance && current >= target - tolerance) return i;
    if (previous > target + tolerance && current <= target + tolerance) return i;
  }
  return undefined;
}

function distanceAt(frame: StateFrame, a: string, b: string): number | undefined {
  const stateA = frame.nodes.find((node) => node.id === a);
  const stateB = frame.nodes.find((node) => node.id === b);
  if (!stateA || !stateB) return undefined;
  return Math.hypot(stateB.position.x - stateA.position.x, stateB.position.y - stateA.position.y);
}

function detectDiscontinuities(frames: StateFrame[]): number[] {
  const result: number[] = [];
  for (let i = 2; i < frames.length; i += 1) {
    if (hasLargeStateJump(frames[i - 2], frames[i - 1], frames[i])) result.push(i);
  }
  return result.slice(0, 12);
}

function hasLargeStateJump(a: StateFrame, b: StateFrame, c: StateFrame): boolean {
  return c.nodes.some((current) => {
    const previous = b.nodes.find((node) => node.id === current.id);
    const beforePrevious = a.nodes.find((node) => node.id === current.id);
    if (!previous || !beforePrevious) return false;
    const velocityDelta = vectorDelta(previous.velocity, current.velocity);
    const priorVelocityDelta = Math.max(vectorDelta(beforePrevious.velocity, previous.velocity), 1);
    const forceDelta = vectorDelta(previous.force, current.force);
    const priorForceDelta = Math.max(vectorDelta(beforePrevious.force, previous.force), 1);
    return velocityDelta > Math.max(1.2, priorVelocityDelta * 4) || forceDelta > Math.max(4, priorForceDelta * 5);
  });
}

function vectorDelta(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function compare(value: number, operator: string, target: number): boolean {
  if (operator === ">=") return value >= target;
  if (operator === ">") return value > target;
  if (operator === "<=") return value <= target;
  if (operator === "<") return value < target;
  return Math.abs(value - target) < 1e-6;
}
