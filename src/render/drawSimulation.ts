import { FIXED_PIXELS_PER_METER } from "../graph/normalizeToSI";
import type { Field, ForceComponent, PhysicsGraph, PhysicsObject, StateFrame, Vector2 } from "../graph/types";

export interface CanvasView {
  offset: Vector2;
  zoom: number;
}

export interface DrawOptions {
  showFields: boolean;
  showVelocity: boolean;
  showForce: boolean;
  showTrajectory: boolean;
  vectorScale?: number;
  selectedNodeId?: string;
  view?: CanvasView;
}

interface CanvasSize {
  width: number;
  height: number;
}

export function drawSimulation(
  canvas: HTMLCanvasElement,
  graph: PhysicsGraph,
  frame: StateFrame,
  history: StateFrame[],
  options: DrawOptions
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const size = { width: rect.width, height: rect.height };
  const view = options.view ?? { offset: { x: 0, y: 0 }, zoom: 1 };
  const anchor = graphWorldCenter(graph);

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = "#f7f7f2";
  context.fillRect(0, 0, rect.width, rect.height);
  drawGridAndAxes(context, size, view, anchor);

  context.save();
  applyWorldTransform(context, size, view, anchor);
  if (options.showFields) drawFields(context, graph, frame);
  if (options.showTrajectory) drawTrajectories(context, history, graph);
  drawInteractions(context, graph, frame);
  drawSolverDiagnostics(context, frame);

  for (const object of graph.objects) {
    if (object.metadata?.render?.visible === false) continue;
    const state = frame.nodes.find((item) => item.id === object.id);
    if (!state) continue;
    drawObject(context, object, state.position, options.selectedNodeId === object.id, state.rotation);
    if (!shouldHideRuntimeVectors(object) && options.showVelocity) {
      drawVector(context, state.position, state.velocity, "#2c7be5", 0.24 * (options.vectorScale ?? 1), "v");
    }
    if (!shouldHideRuntimeVectors(object) && options.showForce) {
      drawForceComponents(context, state.position, state, options.vectorScale ?? 1);
    }
  }
  context.restore();
}

export function screenToWorld(
  screen: Vector2,
  size: CanvasSize,
  view: CanvasView,
  anchor: Vector2
): Vector2 {
  const scale = FIXED_PIXELS_PER_METER * view.zoom;
  return {
    x: anchor.x + (screen.x - size.width / 2 - view.offset.x) / scale,
    y: anchor.y - (screen.y - size.height / 2 - view.offset.y) / scale,
  };
}

function worldToScreen(world: Vector2, size: CanvasSize, view: CanvasView, anchor: Vector2): Vector2 {
  const scale = FIXED_PIXELS_PER_METER * view.zoom;
  return {
    x: size.width / 2 + view.offset.x + (world.x - anchor.x) * scale,
    y: size.height / 2 + view.offset.y - (world.y - anchor.y) * scale,
  };
}

function applyWorldTransform(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  view: CanvasView,
  anchor: Vector2
) {
  const scale = FIXED_PIXELS_PER_METER * view.zoom;
  context.translate(size.width / 2 + view.offset.x, size.height / 2 + view.offset.y);
  context.scale(scale, -scale);
  context.translate(-anchor.x, -anchor.y);
}

function drawGridAndAxes(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  view: CanvasView,
  anchor: Vector2
) {
  const spacing = FIXED_PIXELS_PER_METER * view.zoom;
  const origin = worldToScreen({ x: 0, y: 0 }, size, view, anchor);
  const startX = ((origin.x % spacing) + spacing) % spacing;
  const startY = ((origin.y % spacing) + spacing) % spacing;

  context.strokeStyle = "#deded6";
  context.lineWidth = 1;
  for (let x = startX; x <= size.width; x += spacing) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, size.height);
    context.stroke();
  }
  for (let y = startY; y <= size.height; y += spacing) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size.width, y);
    context.stroke();
  }

  context.strokeStyle = "#343a40";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, origin.y);
  context.lineTo(size.width, origin.y);
  context.moveTo(origin.x, 0);
  context.lineTo(origin.x, size.height);
  context.stroke();
}

function shouldHideRuntimeVectors(object: PhysicsObject): boolean {
  return object.type === "rigid_body" || object.metadata?.fixed === true;
}

function drawForceComponents(context: CanvasRenderingContext2D, position: Vector2, state: StateFrame["nodes"][number], vectorScale: number) {
  const components = state.forceComponents ?? [];
  const baseScale = 0.05 * vectorScale;
  if (components.length === 0) {
    drawVector(context, position, state.force, "#d9480f", baseScale, "F");
    return;
  }

  for (const component of components) {
    drawVector(
      context,
      position,
      component.vector,
      forceComponentColor(component.source),
      baseScale,
      forceComponentLabel(component),
      component.source === "event"
    );
  }
}

function forceComponentColor(source: ForceComponent["source"]): string {
  if (source === "field") return "#2f9e44";
  if (source === "constraint") return "#7048e8";
  if (source === "profile") return "#0b7285";
  return "#7b2cbf";
}

function forceComponentLabel(component: ForceComponent): string {
  return component.label ?? component.id;
}

function drawFields(context: CanvasRenderingContext2D, graph: PhysicsGraph, frame: StateFrame) {
  const bounds = graph.world.bounds;
  if (!bounds) return;
  for (const field of graph.fields) {
    if (field.metadata?.render?.visible === false) continue;
    const minX = bounds.min[0];
    const minY = bounds.min[1];
    const maxX = bounds.max[0];
    const maxY = bounds.max[1];
    const density = Math.max(0.25, field.metadata?.render?.fieldDensity ?? defaultFieldDensity(field));
    const spacing = 0.56 / density;
    const color = field.metadata?.render?.color ?? defaultFieldColor(field);
    const shape = field.metadata?.render?.pointShape ?? defaultFieldShape(field);
    const opacity = field.metadata?.render?.opacity ?? 0.58;

    context.save();
    context.globalAlpha = opacity;
    for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
      for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
        const position = { x, y };
        const vector = evaluateVisualFieldVector(field, position, frame);
        drawFieldSample(context, position, vector, color, shape);
      }
    }
    context.restore();
  }
}

/**
 * Compute the visual field vector (direction + magnitude) at a world-space position.
 * Mirrors the force evaluation in forces.ts so the rendered arrows reflect both
 * the correct direction AND the relative field strength (1/r² falloff for radial
 * fields, charge coupling, variation scaling, etc.).
 */
function evaluateVisualFieldVector(field: Field, position: Vector2, frame: StateFrame): Vector2 {
  const time = frame.time;
  let dir: Vector2;       // unit direction
  let magnitude: number;  // visual strength before variation

  // ---- Resolve direction and base magnitude per field model ----
  if (field.model === "uniform") {
    // Uniform field: constant direction, baseline magnitude = 1
    const fLen = Math.hypot(field.vector[0], field.vector[1]);
    dir = fLen > 0 ? { x: field.vector[0] / fLen, y: field.vector[1] / fLen } : { x: 0, y: -1 };
    magnitude = 1.0;

    // Electric fields: visual magnitude ∝ |qE| (charge coupling shown as stronger arrows)
    if (isElectricField(field)) {
      magnitude = fLen > 0 ? fLen : 1.0;
    }

  } else if (field.model === "radial") {
    // Resolve dynamic origin (origin_from tracks a moving object)
    let origin = { x: field.origin[0], y: field.origin[1] };
    if (field.origin_from) {
      const tracked = frame.nodes.find((n) => n.id === field.origin_from);
      if (tracked) origin = tracked.position;
    }
    const dx = position.x - origin.x;
    const dy = position.y - origin.y;
    const dist = Math.max(0.15, Math.hypot(dx, dy));
    dir = { x: dx / dist, y: dy / dist };
    // 1/r² visual falloff, normalized so dist=1m → |strength|
    // Negative strength flips direction (attractive field)
    magnitude = Math.abs(field.strength) / (dist * dist);
    if (field.strength < 0) {
      dir = { x: -dir.x, y: -dir.y };
    }

  } else if (field.model === "custom") {
    const expression = typeof field.function === "string" ? field.function : field.function.expr;
    if (expression.trim() === "zero") {
      dir = { x: 0, y: 0 };
      magnitude = 0;
    } else if (expression.trim() === "radial_out") {
      const d = Math.max(0.15, Math.hypot(position.x, position.y));
      dir = { x: position.x / d, y: position.y / d };
      magnitude = 1.0 / (d * d);
    } else if (expression.trim() === "radial_in") {
      const d = Math.max(0.15, Math.hypot(position.x, position.y));
      dir = { x: -position.x / d, y: -position.y / d };
      magnitude = 1.0 / (d * d);
    } else {
      const val = tryEvaluateExpression(expression, position.x, position.y, time);
      dir = Number.isFinite(val) ? { x: Math.sign(val), y: 0 } : { x: 0, y: 0 };
      magnitude = Number.isFinite(val) ? Math.abs(val) : 0;
    }

  } else {
    return { x: 0, y: 0 };
  }

  // ---- Apply variation scaling (spatial × temporal expressions) ----
  let visScale = magnitude;
  const variation = (field as { variation?: { spatial?: string; temporal?: string } }).variation;
  if (variation) {
    if (variation.spatial) {
      visScale *= tryEvaluateExpression(variation.spatial, position.x, position.y, time);
    }
    if (variation.temporal) {
      visScale *= tryEvaluateExpression(variation.temporal, position.x, position.y, time);
    }
  }

  // ---- Clamp to visual range [0.05, 2.5] ----
  // Negative scale flips direction (e.g. sin(t) < 0 reverses arrows)
  const absScale = Math.max(0.05, Math.min(Math.abs(visScale), 2.5));
  const flip = visScale < 0 ? -1 : 1;

  return { x: dir.x * absScale * flip, y: dir.y * absScale * flip };
}

/** Minimal expression evaluator for visual field rendering. Supports + - * / ( ) sin cos abs and x y t. */
function tryEvaluateExpression(expr: string, x: number, y: number, t: number): number {
  try {
    const sanitized = expr.toLowerCase().replace(/\s+/g, "");
    // Simple direct value
    if (/^-?[\d.]+$/.test(sanitized)) return Number(sanitized);
    // Simple variable lookup
    if (sanitized === "x") return x;
    if (sanitized === "y") return y;
    if (sanitized === "t") return t;
    // sin/cos/abs
    const sinMatch = sanitized.match(/^sin\((.+)\)$/);
    if (sinMatch) return Math.sin(tryEvaluateExpression(sinMatch[1], x, y, t));
    const cosMatch = sanitized.match(/^cos\((.+)\)$/);
    if (cosMatch) return Math.cos(tryEvaluateExpression(cosMatch[1], x, y, t));
    const absMatch = sanitized.match(/^abs\((.+)\)$/);
    if (absMatch) return Math.abs(tryEvaluateExpression(absMatch[1], x, y, t));
    // Simple binary: a+b, a-b, a*b, a/b
    for (const op of ["+", "-", "*", "/"]) {
      const idx = findTopLevelOp(sanitized, op);
      if (idx > 0) {
        const left = tryEvaluateExpression(sanitized.slice(0, idx), x, y, t);
        const right = tryEvaluateExpression(sanitized.slice(idx + 1), x, y, t);
        if (op === "+") return left + right;
        if (op === "-") return left - right;
        if (op === "*") return left * right;
        if (op === "/") return right !== 0 ? left / right : 1;
      }
    }
    return 1;
  } catch {
    return 1;
  }
}

function findTopLevelOp(expr: string, op: string): number {
  let depth = 0;
  for (let i = expr.length - 1; i >= 0; i--) {
    if (expr[i] === ")") depth++;
    else if (expr[i] === "(") depth--;
    else if (depth === 0 && expr[i] === op) return i;
  }
  return -1;
}

function drawFieldSample(
  context: CanvasRenderingContext2D,
  position: Vector2,
  vector: Vector2,
  color: string,
  shape: "circle" | "square" | "diamond" | "cross"
) {
  const magnitude = Math.hypot(vector.x, vector.y);
  const direction = magnitude === 0 ? { x: 1, y: 0 } : { x: vector.x / magnitude, y: vector.y / magnitude };
  // Arrow length scales with visual magnitude: base=0.15 × [0.05..2.5] → [0.0075..0.375]
  const arrowLen = 0.15 * magnitude;

  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 0.014 * Math.max(0.4, magnitude);
  drawFieldPoint(context, position, shape);
  if (magnitude < 1e-9) return;

  context.beginPath();
  context.moveTo(position.x, position.y);
  context.lineTo(position.x + direction.x * arrowLen, position.y + direction.y * arrowLen);
  context.stroke();
}

function drawFieldPoint(
  context: CanvasRenderingContext2D,
  position: Vector2,
  shape: "circle" | "square" | "diamond" | "cross"
) {
  const r = 0.026;
  if (shape === "circle") {
    context.beginPath();
    context.arc(position.x, position.y, r, 0, Math.PI * 2);
    context.fill();
    return;
  }
  if (shape === "square") {
    context.fillRect(position.x - r, position.y - r, r * 2, r * 2);
    return;
  }
  if (shape === "diamond") {
    context.beginPath();
    context.moveTo(position.x, position.y - r * 1.5);
    context.lineTo(position.x + r * 1.5, position.y);
    context.lineTo(position.x, position.y + r * 1.5);
    context.lineTo(position.x - r * 1.5, position.y);
    context.closePath();
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(position.x - r * 1.5, position.y);
  context.lineTo(position.x + r * 1.5, position.y);
  context.moveTo(position.x, position.y - r * 1.5);
  context.lineTo(position.x, position.y + r * 1.5);
  context.stroke();
}

function defaultFieldColor(field: Field): string {
  if (isElectricField(field)) return "#c92a2a";
  if (field.id.toLowerCase().includes("gravity")) return "#2f9e44";
  if (field.model === "radial") return "#7048e8";
  return "#495057";
}

function defaultFieldShape(field: Field): "circle" | "square" | "diamond" | "cross" {
  if (isElectricField(field)) return "diamond";
  if (field.id.toLowerCase().includes("gravity")) return "circle";
  if (field.model === "radial") return "square";
  return "cross";
}

function defaultFieldDensity(field: Field): number {
  if (isElectricField(field)) return 1.25;
  if (field.id.toLowerCase().includes("gravity")) return 0.85;
  return 1;
}

function isElectricField(field: Field): boolean {
  return field.id.toLowerCase().includes("electric") || field.metadata?.tags?.includes("electric") === true;
}

function drawObject(context: CanvasRenderingContext2D, object: PhysicsObject, position: Vector2, selected: boolean, angle?: number) {
  context.save();
  const fill = object.metadata?.render?.color ?? (object.metadata?.fixed ? "#6c757d" : "#1f8a70");
  if (object.geometry?.type === "circle") {
    context.beginPath();
    context.arc(position.x, position.y, object.geometry.radius, 0, Math.PI * 2);
    context.fillStyle = fill;
    context.fill();
    context.lineWidth = selected ? 0.04 : 0.02;
    context.strokeStyle = selected ? "#f08c00" : "#123";
    context.stroke();
  } else if (object.geometry?.type === "box") {
    const [w, h] = object.geometry.size;
    context.translate(position.x, position.y);
    if (angle != null) context.rotate(angle);
    context.fillStyle = fill;
    context.strokeStyle = selected ? "#f08c00" : "#343a40";
    context.lineWidth = selected ? 0.04 : 0.02;
    context.fillRect(-w / 2, -h / 2, w, h);
    context.strokeRect(-w / 2, -h / 2, w, h);
  } else if (object.geometry?.type === "polygon") {
    context.translate(position.x, position.y);
    if (angle != null) context.rotate(angle);
    context.beginPath();
    const points = object.geometry.points;
    context.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) context.lineTo(points[i][0], points[i][1]);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = selected ? "#f08c00" : "#343a40";
    context.lineWidth = selected ? 0.04 : 0.02;
    context.stroke();
  }
  context.restore();
}

function drawInteractions(context: CanvasRenderingContext2D, graph: PhysicsGraph, frame: StateFrame) {
  for (const interaction of graph.interactions) {
    if (interaction.type !== "constraint") continue;
    const { model, between, parameters, metadata } = interaction;
    const color = metadata?.render?.color ?? constraintColor(model, metadata?.tags);
    const positions = between
      .map(id => frame.nodes.find(n => n.id === id)?.position)
      .filter(Boolean) as Vector2[];
    if (positions.length < 2 && model !== "inequality") continue;

    switch (model) {
      case "distance":
        drawDistanceConstraint(context, positions[0], positions[1], parameters, metadata?.tags);
        break;
      case "spring":
        drawSpringConstraint(context, positions[0], positions[1], color);
        break;
      case "angle":
        if (positions.length >= 3) drawAngleConstraint(context, positions[0], positions[1], positions[2], parameters.compliance ?? 0);
        break;
      case "weld":
        drawWeldConstraint(context, positions[0], positions[1], color);
        break;
      case "hinge":
        drawHingeConstraint(context, positions[0], positions[1], parameters, color);
        break;
      case "slider":
        drawSliderConstraint(context, positions[0], positions[1], parameters, color);
        break;
      case "pulley":
        drawPulleyConstraint(context, positions[0], positions[1], parameters, color);
        break;
      case "wheel":
        drawWheelConstraint(context, positions[0], positions[1], parameters, color);
        break;
      case "friction":
        drawFrictionConstraint(context, positions[0], positions[1], color);
        break;
      case "motor":
        drawMotorConstraint(context, positions[0], positions[1], parameters, color);
        break;
      case "inequality":
        break; // Rendered by collision diagnostics
    }
  }
}

// ---- Constraint color palette ----
function constraintColor(model: string, tags?: string[]): string {
  const isRope = tags?.some(t => t === "rope" || t === "unilateral" || t === "line");
  if (model === "distance" && isRope) return "#845ef7";  // Rope violet
  switch (model) {
    case "distance": return "#7048e8";
    case "spring":   return "#2f9e44";
    case "hinge":    return "#e8590c";
    case "slider":   return "#1c7ed6";
    case "weld":     return "#d9480f";
    case "pulley":   return "#2f9e44";
    case "wheel":    return "#ae3ec9";
    case "friction": return "#f08c00";
    case "motor":    return "#e64980";
    case "angle":    return "#0b7285";
    default:         return "#495057";
  }
}

function isRopeConstraint(tags?: string[]): boolean {
  return tags?.some(t => t === "rope" || t === "unilateral" || t === "line") === true;
}

// ---- distance: line, dashed=rope/compliance ----
function drawDistanceConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { compliance?: number }, tags?: string[]
) {
  const rope = isRopeConstraint(tags);
  const compliance = params.compliance ?? 0;
  const dash = rope ? [0.06, 0.05] : (compliance > 0 ? [0.08, 0.06] : []);
  const color = rope ? "#845ef7" : "#7048e8";

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.03;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);

  // Rope: draw small slack indicator arc when within maxLength
  if (rope) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < (params as { value?: number }).value! * 0.98) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const perpX = -(to.y - from.y) / Math.max(1e-6, dist);
      const perpY = (to.x - from.x) / Math.max(1e-6, dist);
      ctx.beginPath();
      ctx.arc(midX + perpX * 0.15, midY + perpY * 0.15, 0.08, 0, Math.PI * 2);
      ctx.strokeStyle = "#adb5bd";
      ctx.lineWidth = 0.015;
      ctx.setLineDash([0.03, 0.03]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawSpringConstraint(ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2, color: string) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.max(1e-6, Math.hypot(dx, dy));
  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;
  const lead = Math.min(0.18, dist * 0.18);
  const turns = 8;
  const amplitude = 0.08;

  ctx.strokeStyle = color;
  ctx.lineWidth = 0.026;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(from.x + ux * lead, from.y + uy * lead);
  for (let i = 0; i <= turns; i += 1) {
    const t = lead + ((dist - lead * 2) * i) / turns;
    const side = i % 2 === 0 ? -1 : 1;
    ctx.lineTo(from.x + ux * t + nx * amplitude * side, from.y + uy * t + ny * amplitude * side);
  }
  ctx.lineTo(to.x - ux * lead, to.y - uy * lead);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

// ---- angle: two lines + arc at middle body ----
function drawAngleConstraint(
  ctx: CanvasRenderingContext2D, a: Vector2, b: Vector2, c: Vector2,
  compliance: number
) {
  const color = "#0b7285";
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.setLineDash(compliance > 0 ? [0.06, 0.05] : []);

  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  ctx.setLineDash([]);

  // Angle arc at b
  const angleAB = Math.atan2(a.y - b.y, a.x - b.x);
  const angleCB = Math.atan2(c.y - b.y, c.x - b.x);
  ctx.beginPath();
  ctx.arc(b.x, b.y, 0.18, angleAB, angleCB, angleAB > angleCB);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.018;
  ctx.setLineDash([0.04, 0.04]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---- weld: thick line + weld spots ----
function drawWeldConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2, color: string
) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.06;
  ctx.stroke();

  // Weld spots (3 small circles along the line)
  const spots = 3;
  for (let i = 0; i < spots; i++) {
    const t = (i + 1) / (spots + 1);
    const sx = from.x + (to.x - from.x) * t;
    const sy = from.y + (to.y - from.y) * t;
    ctx.beginPath();
    ctx.arc(sx, sy, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = "#fff3bf";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.015;
    ctx.stroke();
  }
}

// ---- hinge: pivot circle + lines to bodies ----
function drawHingeConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { anchor?: number[] }, color: string
) {
  const pivot = params.anchor
    ? { x: params.anchor[0], y: params.anchor[1] }
    : from;

  // Lines from pivot to each body
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.022;
  ctx.setLineDash([0.04, 0.04]);
  ctx.beginPath(); ctx.moveTo(pivot.x, pivot.y); ctx.lineTo(from.x, from.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pivot.x, pivot.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.setLineDash([]);

  // Pivot circle
  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 0.08, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.stroke();

  // Pivot cross
  ctx.beginPath();
  ctx.moveTo(pivot.x - 0.04, pivot.y); ctx.lineTo(pivot.x + 0.04, pivot.y);
  ctx.moveTo(pivot.x, pivot.y - 0.04); ctx.lineTo(pivot.x, pivot.y + 0.04);
  ctx.stroke();
}

// ---- slider: rail axis + guide lines ----
function drawSliderConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { axis?: number[] }, color: string
) {
  const axisDir = params.axis
    ? { x: params.axis[0], y: params.axis[1] }
    : { x: to.x - from.x, y: to.y - from.y };
  const len = Math.hypot(axisDir.x, axisDir.y);
  if (len < 1e-6) return;
  const ux = axisDir.x / len;
  const uy = axisDir.y / len;
  const nx = -uy; // perpendicular
  const ny = ux;

  const railHalf = Math.max(1.5, len * 0.6);
  // Rail guide lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.018;
  ctx.setLineDash([0.08, 0.04]);

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(from.x - ux * railHalf + nx * 0.08 * side, from.y - uy * railHalf + ny * 0.08 * side);
    ctx.lineTo(from.x + ux * railHalf + nx * 0.08 * side, from.y + uy * railHalf + ny * 0.08 * side);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Center axis
  ctx.beginPath();
  ctx.moveTo(from.x - ux * railHalf, from.y - uy * railHalf);
  ctx.lineTo(from.x + ux * railHalf, from.y + uy * railHalf);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.setLineDash([0.02, 0.06]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Slider block at body B
  ctx.fillStyle = "rgba(28, 126, 214, 0.25)";
  ctx.fillRect(to.x - 0.12, to.y - 0.12, 0.24, 0.24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.022;
  ctx.strokeRect(to.x - 0.12, to.y - 0.12, 0.24, 0.24);
}

// ---- pulley: ground anchors + ropes to bodies ----
function drawPulleyConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { ground_anchor_a?: number[]; ground_anchor_b?: number[] }, color: string
) {
  const ga = params.ground_anchor_a
    ? { x: params.ground_anchor_a[0], y: params.ground_anchor_a[1] }
    : { x: from.x, y: from.y + 1 };
  const gb = params.ground_anchor_b
    ? { x: params.ground_anchor_b[0], y: params.ground_anchor_b[1] }
    : { x: to.x, y: to.y + 1 };

  // Rope lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.setLineDash([0.03, 0.04]);

  ctx.beginPath(); ctx.moveTo(ga.x, ga.y); ctx.lineTo(from.x, from.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(gb.x, gb.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.setLineDash([]);

  // Ground anchor markers
  for (const anchor of [ga, gb]) {
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 0.06, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.022;
    ctx.stroke();

    // Cross mark at anchor
    ctx.beginPath();
    ctx.moveTo(anchor.x - 0.03, anchor.y); ctx.lineTo(anchor.x + 0.03, anchor.y);
    ctx.moveTo(anchor.x, anchor.y - 0.03); ctx.lineTo(anchor.x, anchor.y + 0.03);
    ctx.stroke();
  }

  // Pulley wheel at midpoint
  const midX = (ga.x + gb.x) / 2;
  const midY = Math.min(ga.y, gb.y) - 0.15;
  ctx.beginPath();
  ctx.arc(midX, midY, 0.1, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.stroke();
}

// ---- wheel: axis line + spring zigzag ----
function drawWheelConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { axis?: number[] }, color: string
) {
  const axis = params.axis
    ? { x: params.axis[0], y: params.axis[1] }
    : { x: 0, y: 1 };
  const len = Math.hypot(axis.x, axis.y);
  if (len < 1e-6) return;
  const ux = axis.x / len;
  const uy = axis.y / len;

  // Axis line through body A
  const half = 1.2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.018;
  ctx.setLineDash([0.04, 0.05]);
  ctx.beginPath();
  ctx.moveTo(from.x - ux * half, from.y - uy * half);
  ctx.lineTo(from.x + ux * half, from.y + uy * half);
  ctx.stroke();
  ctx.setLineDash([]);

  // Spring zigzag from body B along axis toward body A
  const segs = 4;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const springLen = Math.min(dist * 0.7, 0.8);
  const waveAmp = 0.1;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const bx = to.x + (from.x - to.x) * t * (springLen / dist);
    const by = to.y + (from.y - to.y) * t * (springLen / dist);
    const offset = (i % 2 === 0 ? 1 : -1) * waveAmp;
    ctx.lineTo(bx + offset * (-uy), by + offset * ux);
  }
  ctx.lineTo(from.x, from.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.02;
  ctx.stroke();
}

// ---- friction: contact line + friction marks ----
function drawFrictionConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2, color: string
) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.03;
  ctx.setLineDash([0.06, 0.05]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Friction marks: small perpendicular ticks
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.max(1e-6, Math.hypot(dx, dy));
  const nx = -dy / dist;
  const ny = dx / dist;
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t = (i + 0.5) / ticks;
    const tx = from.x + dx * t;
    const ty = from.y + dy * t;
    ctx.beginPath();
    ctx.moveTo(tx - nx * 0.08, ty - ny * 0.08);
    ctx.lineTo(tx + nx * 0.08, ty + ny * 0.08);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.018;
    ctx.stroke();
  }
}

// ---- motor: target offset + correction arrow ----
function drawMotorConstraint(
  ctx: CanvasRenderingContext2D, from: Vector2, to: Vector2,
  params: { linear_offset?: number[]; angular_offset?: number }, color: string
) {
  // Target position (from + linear_offset)
  const offset = params.linear_offset
    ? { x: params.linear_offset[0], y: params.linear_offset[1] }
    : { x: 0, y: 0 };
  const target = { x: from.x + offset.x, y: from.y + offset.y };

  // Dashed line showing correction direction
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.025;
  ctx.setLineDash([0.04, 0.05]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Target marker
  ctx.beginPath();
  ctx.arc(target.x, target.y, 0.07, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(230, 73, 128, 0.2)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.022;
  ctx.stroke();

  // Correction arrowhead at body B toward target
  const cdx = target.x - to.x;
  const cdy = target.y - to.y;
  const cdist = Math.max(1e-6, Math.hypot(cdx, cdy));
  const cux = cdx / cdist;
  const cuy = cdy / cdist;
  if (cdist > 0.05) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(
      to.x + cux * 0.25,
      to.y + cuy * 0.25
    );
    ctx.lineTo(
      to.x + cux * 0.12 - cuy * 0.06,
      to.y + cuy * 0.12 + cux * 0.06
    );
    ctx.lineTo(
      to.x + cux * 0.12 + cuy * 0.06,
      to.y + cuy * 0.12 - cux * 0.06
    );
    ctx.closePath();
    ctx.fill();
  }
}

function drawTrajectories(context: CanvasRenderingContext2D, history: StateFrame[], graph: PhysicsGraph) {
  for (const object of graph.objects) {
    if (object.metadata?.fixed) continue;
    context.beginPath();
    history.forEach((frame, index) => {
      const position = frame.nodes.find((state) => state.id === object.id)?.position;
      if (!position) return;
      if (index === 0) context.moveTo(position.x, position.y);
      else context.lineTo(position.x, position.y);
    });
    context.strokeStyle = "rgba(31, 138, 112, 0.45)";
    context.lineWidth = 0.02;
    context.stroke();
  }
}

function drawSolverDiagnostics(context: CanvasRenderingContext2D, frame: StateFrame) {
  const contacts = frame.diagnostics?.contacts ?? [];
  if (contacts.length === 0) return;

  context.save();
  for (const contact of contacts) {
    drawDiagnosticLine(context, contact.point, contact.normal, "#c92a2a", 0.26);
    drawDiagnosticLine(context, contact.point, contact.tangent, "#0b7285", 0.18, [0.06, 0.05]);
  }
  context.restore();
}

function drawDiagnosticLine(
  context: CanvasRenderingContext2D,
  origin: Vector2,
  direction: Vector2,
  color: string,
  length: number,
  dash: number[] = []
) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 0.025;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(origin.x, origin.y);
  context.lineTo(origin.x + direction.x * length, origin.y + direction.y * length);
  context.stroke();
  context.restore();
}

function drawVector(
  context: CanvasRenderingContext2D,
  origin: Vector2,
  vector: Vector2,
  color: string,
  factor: number,
  _label: string,
  dashed = false
) {
  const end: Vector2 = { x: origin.x + vector.x * factor, y: origin.y + vector.y * factor };
  const angle = Math.atan2(end.y - origin.y, end.x - origin.x);
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 0.04;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash(dashed ? [0.12, 0.08] : []);
  context.beginPath();
  context.moveTo(origin.x, origin.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - 0.14 * Math.cos(angle - 0.45), end.y - 0.14 * Math.sin(angle - 0.45));
  context.lineTo(end.x - 0.14 * Math.cos(angle + 0.45), end.y - 0.14 * Math.sin(angle + 0.45));
  context.closePath();
  context.fill();
  context.restore();
}

function graphWorldCenter(graph: PhysicsGraph): Vector2 {
  const bounds = graph.world.bounds;
  if (!bounds) return { x: 0, y: 0 };
  return {
    x: (bounds.min[0] + bounds.max[0]) / 2,
    y: (bounds.min[1] + bounds.max[1]) / 2,
  };
}
