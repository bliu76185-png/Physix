/**
 * 渲染自检诊断模块
 *
 * 针对"主体未被渲染"问题，自动扫描用例，检测：
 * 1. Graph 数据完整性（对象定义、initial_state 覆盖、几何体有效性）
 * 2. 渲染条件阻断点（metadata.render.visible、geometry 缺失、world.bounds 缺失）
 * 3. Box2D 模拟帧数据完整性（每帧 nodes 是否包含所有对象、NaN/Infinity 检测）
 * 4. force 分量的覆盖率
 */

import { examples, type ExampleDefinition } from "../examples/index";
import { normalizeGraphToSI } from "../graph/normalizeToSI";
import { repairStableConstraintSpec } from "../graph/stableConstraintSpec";
import type {
  PhysicsGraph,
  PhysicsObject,
  StateFrame,
} from "../graph/types";
import { validateGraph } from "../graph/validateGraph";
import { generateBox2DStateStream } from "../sim/box2dStream";

// ============================================================================
// 类型定义
// ============================================================================

export type RenderStatus = "ok" | "warning" | "error";

export interface ObjectDiagnostic {
  objectId: string;
  type: string;
  geometryType: string | undefined;
  status: RenderStatus;
  issues: string[];
  /**
   * 从哪个渲染管道被阻断。
   * - "data" = graph 数据层（无几何/无初始状态/visible=false）
   * - "frame" = 模拟帧层（帧中缺少对应 node / NaN 位置）
   * - "render" = 绘制层（world.bounds 缺失、坐标出界）
   */
  blockageStage: "data" | "frame" | "render" | null;
}

export interface ExampleDiagnostic {
  exampleId: string;
  title: string;
  status: RenderStatus;
  summary: string;
  /** 所有对象诊断 */
  objects: ObjectDiagnostic[];
  /** Graph 层阻断 */
  graphIssues: string[];
  /** 全局数据异常 */
  globalIssues: string[];
}

export interface RenderDiagnosticReport {
  scannedAt: string;
  totalExamples: number;
  passed: number;
  warnings: number;
  errors: number;
  examples: ExampleDiagnostic[];
}

// ============================================================================
// 主入口
// ============================================================================

export async function runRenderDiagnostics(): Promise<RenderDiagnosticReport> {
  const report: RenderDiagnosticReport = {
    scannedAt: new Date().toISOString(),
    totalExamples: examples.length,
    passed: 0,
    warnings: 0,
    errors: 0,
    examples: [],
  };

  for (const example of examples) {
    const diag = await diagnoseExample(example);
    report.examples.push(diag);
    if (diag.status === "ok") report.passed += 1;
    else if (diag.status === "warning") report.warnings += 1;
    else report.errors += 1;
  }

  return report;
}

/**
 * 同步版本——仅 XPBD 快速扫描，不启动 WASM。
 */
export function runQuickDiagnostics(): RenderDiagnosticReport {
  const report: RenderDiagnosticReport = {
    scannedAt: new Date().toISOString(),
    totalExamples: examples.length,
    passed: 0,
    warnings: 0,
    errors: 0,
    examples: [],
  };

  for (const example of examples) {
    const diag = diagnoseExampleQuick(example);
    report.examples.push(diag);
    if (diag.status === "ok") report.passed += 1;
    else if (diag.status === "warning") report.warnings += 1;
    else report.errors += 1;
  }

  return report;
}

// ============================================================================
// 单个用例诊断（深度：XPBD + Box2D 双引擎）
// ============================================================================

async function diagnoseExample(example: ExampleDefinition): Promise<ExampleDiagnostic> {
  const base: ExampleDiagnostic = {
    exampleId: example.id,
    title: example.title,
    status: "ok",
    summary: "",
    objects: [],
    graphIssues: [],
    globalIssues: [],
  };

  // ---- Step 1: Graph 层静态检查 ----
  const rawGraph = example.graph;
  if (!rawGraph || typeof rawGraph !== "object") {
    base.status = "error";
    base.graphIssues.push("Graph is null or not an object");
    base.summary = "Graph 数据无效";
    return base;
  }

  const graphCheck = checkGraphIntegrity(rawGraph);
  base.objects = graphCheck.objectDiagnostics;
  base.graphIssues.push(...graphCheck.globalIssues);

  // ---- Step 2: SI 归一化 + 验证 ----
  let graph: PhysicsGraph;
  try {
    graph = normalizeGraphToSI(
      repairStableConstraintSpec(structuredClone(rawGraph))
    );
  } catch (err) {
    base.status = "error";
    base.graphIssues.push(
      `Graph 预处理失败: ${err instanceof Error ? err.message : String(err)}`
    );
    base.summary = "Graph 预处理异常";
    return base;
  }

  const validation = validateGraph(graph);
  if (!validation.valid) {
    base.status = "error";
    base.graphIssues.push(
      ...validation.errors.map((e) => `[${e.layer}] ${e.path}: ${e.message}`)
    );
    base.summary = `验证失败: ${validation.errors.length} errors`;
    return base;
  }

  // ---- Step 3: 逐帧深度扫描 (Box2D) ----
  let frames: StateFrame[] = [];
  try {
    frames = await generateBox2DStateStream(graph);
  } catch (err) {
    base.globalIssues.push(
      `Box2D 引擎启动失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const scan = scanFrames(graph, frames, "Box2D");
  base.globalIssues.push(...scan.frameIssues);
  mergeObjectIssues(base.objects, scan.objectIssues);

  // ---- Step 4: 判定最终状态 ----
  const objErrors = base.objects.filter((o) => o.status === "error").length;
  const objWarnings = base.objects.filter((o) => o.status === "warning").length;
  // 全局问题中，只有真正的阻断问题才算 error
  const blockingGlobalIssues = base.globalIssues.filter(
    (i) => !i.includes("No contact diagnostics")
  );

  if (objErrors > 0 || blockingGlobalIssues.length > 0) {
    base.status = "error";
    base.summary = `${objErrors} objects with errors, ${blockingGlobalIssues.length} blocking global issues`;
  } else if (objWarnings > 0 || base.globalIssues.length > 0) {
    base.status = "warning";
    base.summary = `${objWarnings} object warnings, ${base.globalIssues.length} global issues (non-blocking)`;
  } else {
    base.status = "ok";
    base.summary = `All ${graph.objects.length} objects render correctly`;
  }

  return base;
}

// ============================================================================
// 快速诊断（同名，仅 Box2D）
// ============================================================================

function diagnoseExampleQuick(example: ExampleDefinition): ExampleDiagnostic {
  const base: ExampleDiagnostic = {
    exampleId: example.id,
    title: example.title,
    status: "ok",
    summary: "",
    objects: [],
    graphIssues: [],
    globalIssues: [],
  };

  const rawGraph = example.graph;
  if (!rawGraph || typeof rawGraph !== "object") {
    base.status = "error";
    base.graphIssues.push("Graph is null or not an object");
    base.summary = "Graph 数据无效";
    return base;
  }

  const graphCheck = checkGraphIntegrity(rawGraph);
  base.objects = graphCheck.objectDiagnostics;
  base.graphIssues.push(...graphCheck.globalIssues);

  let graph: PhysicsGraph;
  try {
    graph = normalizeGraphToSI(
      repairStableConstraintSpec(structuredClone(rawGraph))
    );
  } catch (err) {
    base.status = "error";
    base.graphIssues.push(
      `Graph 预处理失败: ${err instanceof Error ? err.message : String(err)}`
    );
    base.summary = "Graph 预处理异常";
    return base;
  }

  const validation = validateGraph(graph);
  if (!validation.valid) {
    base.status = "error";
    base.graphIssues.push(
      ...validation.errors.map((e) => `[${e.layer}] ${e.path}: ${e.message}`)
    );
    base.summary = `验证失败: ${validation.errors.length} errors`;
    return base;
  }

  // Quick diagnostic only checks graph integrity, not full simulation
  const objErrors = base.objects.filter((o) => o.status === "error").length;
  const objWarnings = base.objects.filter((o) => o.status === "warning").length;

  if (objErrors > 0) {
    base.status = "error";
    base.summary = `${objErrors} objects with graph-level errors`;
  } else if (objWarnings > 0) {
    base.status = "warning";
    base.summary = `${objWarnings} objects with graph-level warnings`;
  } else {
    base.status = "ok";
    base.summary = `Graph integrity OK (${graph.objects.length} objects)`;
  }

  return base;
}

// ============================================================================
// Graph 完整性检查
// ============================================================================

interface GraphIntegrityResult {
  objectDiagnostics: ObjectDiagnostic[];
  globalIssues: string[];
}

function checkGraphIntegrity(graph: PhysicsGraph): GraphIntegrityResult {
  const result: GraphIntegrityResult = {
    objectDiagnostics: [],
    globalIssues: [],
  };

  // 全局：objects 是否为空
  if (!graph.objects || graph.objects.length === 0) {
    result.globalIssues.push("graph.objects is empty — nothing to render");
    return result;
  }

  // 全局：world.bounds 是否存在（影响场绘制）
  if (!graph.world.bounds) {
    result.globalIssues.push(
      "graph.world.bounds is missing — all field visuals will be hidden"
    );
  }

  // 全局：initial_state 是否覆盖所有对象
  const stateIds = new Set(Object.keys(graph.initial_state ?? {}));
  for (const obj of graph.objects) {
    if (!stateIds.has(obj.id)) {
      result.globalIssues.push(
        `Object '${obj.id}' missing from initial_state — may have undefined initial position`
      );
    }
  }

  // 逐对象检查
  for (const object of graph.objects) {
    const diag = checkObjectIntegrity(object, graph);
    result.objectDiagnostics.push(diag);
  }

  return result;
}

function checkObjectIntegrity(
  object: PhysicsObject,
  graph: PhysicsGraph
): ObjectDiagnostic {
  const issues: string[] = [];
  let blockageStage: ObjectDiagnostic["blockageStage"] = null;

  // 1. 渲染可见性（最高优先级阻断）
  if (object.metadata?.render?.visible === false) {
    issues.push(
      `metadata.render.visible = false — object explicitly hidden`
    );
    blockageStage = "data";
  }

  // 2. 几何体有效性
  if (!object.geometry) {
    issues.push(
      `geometry is undefined — nothing to draw (defaults to circle with radius from properties.radius=${object.properties.radius ?? "undefined"})`
    );
    if (object.properties.radius == null || object.properties.radius <= 0) {
      blockageStage = "data";
    }
  } else if (object.geometry.type === "circle") {
    if (object.geometry.radius <= 0) {
      issues.push(`circle radius = ${object.geometry.radius} — zero-size shape`);
      blockageStage = "data";
    }
  } else if (object.geometry.type === "box") {
    if (object.geometry.size[0] <= 0 || object.geometry.size[1] <= 0) {
      issues.push(
        `box size = [${object.geometry.size[0]}, ${object.geometry.size[1]}] — zero area`
      );
      blockageStage = "data";
    }
  } else if (object.geometry.type === "polygon") {
    if (!object.geometry.points || object.geometry.points.length < 3) {
      issues.push(
        `polygon has ${object.geometry.points?.length ?? 0} vertices — need ≥ 3`
      );
      blockageStage = "data";
    }
  }

  // 3. 初始状态检查
  const initState = graph.initial_state?.[object.id];
  if (!initState) {
    issues.push("missing from initial_state — position defaults to [0,0]");
    blockageStage = blockageStage ?? "data";
  }

  // 4. 固定对象检查（锚点无初始状态是可接受的）
  const isFixedObj =
    object.metadata?.role === "anchor" ||
    object.metadata?.fixed === true ||
    object.degrees_of_freedom?.translation === false;

  if (isFixedObj && !initState) {
    // 固定对象缺少初始位置 — 对渲染是问题
    issues.push(
      "fixed/anchor object missing initial_state.position — will render at origin [0,0]"
    );
  }

  // 5. 颜色检查
  if (!object.metadata?.render?.color) {
    // 非阻断，仅记录
    issues.push("no explicit render color — using default");
  }

  const status: RenderStatus =
    blockageStage !== null ? "error" : issues.length > 0 ? "warning" : "ok";

  return {
    objectId: object.id,
    type: object.type,
    geometryType: object.geometry?.type,
    status,
    issues,
    blockageStage,
  };
}

// ============================================================================
// 帧扫描
// ============================================================================

interface FrameScanResult {
  /** 全局层面的帧问题 */
  frameIssues: string[];
  /** 每个对象在各帧中的异常 */
  objectIssues: Map<string, string[]>;
}

function scanFrames(
  graph: PhysicsGraph,
  frames: StateFrame[],
  engineLabel: string
): FrameScanResult {
  const result: FrameScanResult = {
    frameIssues: [],
    objectIssues: new Map(),
  };

  if (frames.length === 0) {
    result.frameIssues.push(
      `[${engineLabel}] No frames generated — nothing to render`
    );
    return result;
  }

  // 逐帧检查
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const nodeIds = new Set(frame.nodes.map((n) => n.id));

    for (const object of graph.objects) {
      const node = frame.nodes.find((n) => n.id === object.id);

      // A. 帧中缺失节点 — 阻断渲染
      if (!node) {
        pushIssue(
          result.objectIssues,
          object.id,
          `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
            2
          )}: node missing — object not rendered`
        );
        continue;
      }

      // B. NaN/Infinity 位置 — 阻断渲染
      if (!isFinite(node.position.x) || !isFinite(node.position.y)) {
        pushIssue(
          result.objectIssues,
          object.id,
          `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
            2
          )}: position = [${node.position.x}, ${node.position.y}] — NaN/Infinity`
        );
      }

      // C. NaN/Infinity 速度
      if (!isFinite(node.velocity.x) || !isFinite(node.velocity.y)) {
        pushIssue(
          result.objectIssues,
          object.id,
          `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
            2
          )}: velocity = [${node.velocity.x}, ${node.velocity.y}] — NaN/Infinity`
        );
      }

      // D. force 分量为空（非 error，但影响 inspector 显示）
      if (
        (!node.forceComponents || node.forceComponents.length === 0) &&
        node.force.x === 0 &&
        node.force.y === 0
      ) {
        // 仅在对象应该是动态的且应该有受力时警告
        const isFixedObj =
          object.metadata?.role === "anchor" ||
          object.metadata?.fixed === true;
        if (!isFixedObj && graph.fields.length > 0) {
          pushIssue(
            result.objectIssues,
            object.id,
            `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
              2
            )}: force = [0,0] with no forceComponents (dynamic object, fields exist)`
          );
        }
      }

      // E. 旋转角度 NaN
      if (
        node.rotation != null &&
        !isFinite(node.rotation)
      ) {
        pushIssue(
          result.objectIssues,
          object.id,
          `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
            2
          )}: rotation = ${node.rotation} — NaN`
        );
      }
    }
  }

  // 全局：检查是否有某些帧丢失了整个对象集合
  const expectedCount = graph.objects.length;
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    if (frame.nodes.length < expectedCount) {
      const missing = expectedCount - frame.nodes.length;
      result.frameIssues.push(
        `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
          2
        )}: only ${frame.nodes.length}/${expectedCount} nodes (${missing} missing)`
      );
    }
    if (frame.nodes.length > expectedCount) {
      result.frameIssues.push(
        `[${engineLabel}] frame[${fi}] t=${frame.time.toFixed(
          2
        )}: ${frame.nodes.length}/${expectedCount} nodes (extra nodes detected)`
      );
    }
  }

  // 全局：诊断信息是否为空
  const diagFrames = frames.filter(
    (f) => (f.diagnostics?.contacts?.length ?? 0) > 0
  );
  if (diagFrames.length === 0 && frames.length > 0) {
    result.frameIssues.push(
      `[${engineLabel}] No contact diagnostics in any frame — contacts may not be detected`
    );
  }

  return result;
}

// 全局问题中，只有真正的阻断问题才算 error

function mergeObjectIssues(
  existing: ObjectDiagnostic[],
  newIssues: Map<string, string[]>
) {
  for (const obj of existing) {
    const extra = newIssues.get(obj.objectId);
    if (extra && extra.length > 0) {
      obj.issues.push(...extra);
      // 如果之前是 ok，现在有帧层问题
      if (obj.status === "ok" && extra.some((s) => s.includes("NaN") || s.includes("missing"))) {
        obj.status = "warning";
        obj.blockageStage = obj.blockageStage ?? "frame";
      }
    }
  }
  // 帧中存在但 graph.objects 中没有的对象（异常）
  for (const id of newIssues.keys()) {
    if (!existing.some((o) => o.objectId === id)) {
      existing.push({
        objectId: id,
        type: "unknown",
        geometryType: undefined,
        status: "error",
        issues: [...(newIssues.get(id) ?? [])],
        blockageStage: "frame",
      });
    }
  }
}

function pushIssue(map: Map<string, string[]>, objectId: string, issue: string) {
  const arr = map.get(objectId) ?? [];
  arr.push(issue);
  map.set(objectId, arr);
}

function isFinite(value: number): boolean {
  return typeof value === "number" && !Number.isNaN(value) && Number.isFinite(value);
}

// ============================================================================
// 格式化输出
// ============================================================================

export function formatReport(report: RenderDiagnosticReport): string {
  const lines: string[] = [];
  lines.push("=".repeat(70));
  lines.push(`  Render Diagnostic Report — ${report.scannedAt}`);
  lines.push(`  Scanned: ${report.totalExamples} | Passed: ${report.passed} | Warnings: ${report.warnings} | Errors: ${report.errors}`);
  lines.push("=".repeat(70));

  for (const example of report.examples) {
    const icon = example.status === "ok" ? "✓" : example.status === "warning" ? "⚠" : "✗";
    lines.push(`\n${icon} [${example.exampleId}] ${example.title}  — ${example.summary}`);

    // 阻断对象汇总
    const blockedObjects = example.objects.filter((o) => o.blockageStage !== null);
    if (blockedObjects.length > 0) {
      lines.push(`  Blocked objects (${blockedObjects.length}/${example.objects.length}):`);
      for (const obj of blockedObjects) {
        lines.push(`    • ${obj.objectId} [${obj.type}] @${obj.blockageStage} stage:`);
        for (const issue of obj.issues) {
          lines.push(`      - ${issue}`);
        }
      }
    }

    // Graph 问题
    if (example.graphIssues.length > 0) {
      lines.push(`  Graph Issues:`);
      for (const issue of example.graphIssues) {
        lines.push(`    - ${issue}`);
      }
    }

    // 全局问题
    if (example.globalIssues.length > 0) {
      lines.push(`  Global Issues:`);
      for (const issue of example.globalIssues) {
        lines.push(`    - ${issue}`);
      }
    }
  }

  lines.push("\n" + "=".repeat(70));
  return lines.join("\n");
}
