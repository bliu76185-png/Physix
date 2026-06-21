import { FileUp, Pause, Play, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateGraph, repairGraph } from "./ai/generateGraph";
import AIGenerator from "./components/AIGenerator";
import { examples } from "./examples";
import { FIXED_PIXELS_PER_METER, normalizeGraphToSI } from "./graph/normalizeToSI";
import { repairStableConstraintSpec } from "./graph/stableConstraintSpec";
import type { PhysicsGraph, PhysicsObject, StateFrame, Vector2 } from "./graph/types";
import { getVariableDefaults, materializeGraphVariables, mergeVariableValues, type VariableValues } from "./graph/variables";
import { validateGraph } from "./graph/validateGraph";
import { drawSimulation, screenToWorld, type CanvasView } from "./render/drawSimulation";
import { getRuntimeConfig } from "./sim/runtimeConfig";
import { deriveTimelineMarkers } from "./sim/timelineKeyframes";

const initialGraph = normalizeGraphToSI(structuredClone(examples[0].graph));
const initialView: CanvasView = { offset: { x: 0, y: 0 }, zoom: 1 };
type SimulationEngine = "box2d";

export default function App() {
  const [graph, setGraph] = useState<PhysicsGraph>(initialGraph);
  const [selectedExampleId, setSelectedExampleId] = useState(examples[0].id);
  const [prompt, setPrompt] = useState(examples[0].prompt);
  const [selectedNodeId, setSelectedNodeId] = useState(initialGraph.objects[0]?.id ?? "");
  type InspectorTarget = { kind: "object"; id: string } | { kind: "field"; id: string };
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget>({ kind: "object", id: initialGraph.objects[0]?.id ?? "" });
  const [isPlaying, setIsPlaying] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(getRuntimeConfig(initialGraph).duration);
  const [showFields, setShowFields] = useState(true);
  const [showVelocity, setShowVelocity] = useState(true);
  const [showForce, setShowForce] = useState(true);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [vectorScale, setVectorScale] = useState(1.0);
  const [simulationEngine, setSimulationEngine] = useState<SimulationEngine>("box2d");
  const [message, setMessage] = useState("Example loaded. You can play it or import a DSL JSON file.");
  const [showAIModal, setShowAIModal] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [view, setView] = useState<CanvasView>(initialView);
  const [variableValues, setVariableValues] = useState<VariableValues>(() => getVariableDefaults(initialGraph));
  const [problemList, setProblemList] = useState<string[]>([]);
  const [genExamples, setGenExamples] = useState<{ name: string; prompt: string }[]>([]);
  const [showProblemList, setShowProblemList] = useState(false);
  const [selectedMetricId, setSelectedMetricId] = useState("speed");
  const panStartRef = useRef<{ x: number; y: number; offset: Vector2 } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const disableBox2D = useMemo(() => new URLSearchParams(window.location.search).get("noBox2d") === "1", []);

  const resolvedGraph = useMemo(() => materializeGraphVariables(graph, variableValues), [graph, variableValues]);
  const simulationGraph = useMemo(() => withSimulationDuration(resolvedGraph, durationSeconds), [durationSeconds, resolvedGraph]);
  const validation = useMemo(() => validateGraph(simulationGraph), [simulationGraph]);
  const [frames, setFrames] = useState<StateFrame[]>([]);

  useEffect(() => {
    if (!validation.valid) {
      setFrames([]);
      return;
    }
    if (disableBox2D) {
      const staticFrames = generateStaticStateFrames(simulationGraph, durationSeconds);
      setFrames(staticFrames);
      setMessage(`Box2D disconnected. Static DSL preview ready (${staticFrames.length} frames).`);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const startedAt = Date.now();
    setMessage("Starting Box2D worker...");
    import("./sim/box2dWorkerClient")
      .then(({ generateBox2DStateStreamInWorker }) => {
        if (!cancelled) {
          setMessage(`Box2D worker client loaded in ${Date.now() - startedAt}ms. Starting worker...`);
        }
        return generateBox2DStateStreamInWorker(
          simulationGraph,
          {
            signal: controller.signal,
            onProgress: (progressMessage) => {
              if (!cancelled) setMessage(`[${Date.now() - startedAt}ms] ${progressMessage}`);
            },
          }
        );
      })
      .then((result) => {
        if (!cancelled) {
          setFrames(result);
          setMessage(`Box2D simulation ready (${result.length} frames) in ${Date.now() - startedAt}ms.`);
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setFrames([]);
          setMessage(`Box2D error: ${msg}. Check console for details.`);
          console.error("[Box2D] generateBox2DStateStream failed:", err);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [disableBox2D, durationSeconds, simulationGraph, validation.valid]);
  const timelineMarkers = useMemo(() => deriveTimelineMarkers(simulationGraph, frames), [frames, simulationGraph]);
  const currentFrame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))];
  const selectedNode = simulationGraph.objects.find((node) => node.id === selectedNodeId);
  const inspectorMetrics = useMemo(
    () => buildInspectorMetrics(simulationGraph, frames, selectedNodeId, frameIndex),
    [frameIndex, frames, selectedNodeId, simulationGraph]
  );
  const selectedMetric = inspectorMetrics.find((metric) => metric.id === selectedMetricId) ?? inspectorMetrics[0];
  const runtimeConfig = getRuntimeConfig(simulationGraph);
  const frameMs = runtimeConfig.dt * runtimeConfig.timeScale * 1000;

  useEffect(() => {
    setFrameIndex(0);
    setSelectedNodeId(graph.objects[0]?.id ?? "");
    setDurationSeconds(getRuntimeConfig(graph).duration);
    setVariableValues(getVariableDefaults(graph));
    setView(initialView);
  }, [graph]);

  useEffect(() => {
    setFrameIndex(0);
    setIsPlaying(false);
  }, [durationSeconds]);

  useEffect(() => {
    if (inspectorMetrics.length > 0 && !inspectorMetrics.some((metric) => metric.id === selectedMetricId)) {
      setSelectedMetricId(inspectorMetrics[0].id);
    }
  }, [inspectorMetrics, selectedMetricId]);

  useEffect(() => {
    setVariableValues((current) => mergeVariableValues(graph, current));
  }, [graph]);

  useEffect(() => {
    fetch("/api/problems").then(r => r.json()).then(d => { if (Array.isArray(d)) setProblemList(d); }).catch(() => {});
    // Discover generated DSL files
    fetch("/api/list-generated").then(r => r.json()).then(d => {
      if (Array.isArray(d)) setGenExamples(d);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isPlaying || frames.length === 0) return;
    const timer = window.setInterval(() => {
      setFrameIndex((index) => {
        if (index >= frames.length - 1) {
          setIsPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, Math.max(8, frameMs));
    return () => window.clearInterval(timer);
  }, [frameMs, frames.length, isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentFrame) return;
    drawSimulation(canvas, simulationGraph, currentFrame, frames.slice(0, frameIndex + 1), {
      showFields,
      showVelocity,
      showForce,
      showTrajectory,
      vectorScale,
      selectedNodeId,
      view,
    });
  }, [currentFrame, frameIndex, frames, selectedNodeId, showFields, showForce, showTrajectory, showVelocity, simulationGraph, view]);

  function loadExample(id: string) {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    setSelectedExampleId(example.id);
    setGraph(normalizeGraphToSI(structuredClone(example.graph)));
    setPrompt(example.prompt);
    setMessage(`${example.title} loaded.`);
    setIsPlaying(false);
  }

  function handleVariableChange(id: string, value: number) {
    setVariableValues((current) => mergeVariableValues(graph, { ...current, [id]: value }));
    setFrameIndex(0);
    setIsPlaying(false);
  }

  async function handleGenerate() {
    setMessage("Generating graph...");
    const generated = await generateGraph(prompt);
    const result = validateGraph(generated.graph);
    if (result.valid) {
      setGraph(normalizeGraphToSI(repairStableConstraintSpec(generated.graph)));
      setSelectedExampleId("generated");
      setMessage(generated.note);
      return;
    }

    const repaired = await repairGraph(prompt, generated.graph, result.errors);
    const repairedResult = validateGraph(repaired.graph);
    if (repairedResult.valid) {
      setGraph(normalizeGraphToSI(repairStableConstraintSpec(repaired.graph)));
      setSelectedExampleId("generated");
      setMessage("Initial generation failed validation; repair produced a runnable graph.");
    } else {
      const first = repairedResult.errors[0];
      setMessage(`Generation failed: ${first?.path ?? "unknown"} ${first?.message ?? ""}`);
    }
  }

  const handleAIDSL = useCallback((dsl: Record<string, unknown>) => {
    const result = parseImportedGraph(JSON.stringify(dsl, null, 2));
    if (!result.ok) {
      setMessage(`AI DSL validation failed: ${result.message}`);
      return;
    }

    setGraph(result.graph);
    setSelectedExampleId("ai-generated");
    setPrompt("");
    setFrameIndex(0);
    setIsPlaying(false);
    setMessage(
      `AI DSL imported. Simulation will start automatically.` +
        (result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : "")
    );
  }, []);

  const handleFileImport = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".json")) {
      setMessage("Error: choose a .json DSL file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = typeof event.target?.result === "string" ? event.target.result : "";
      const result = parseImportedGraph(content);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }

      setGraph(result.graph);
      setSelectedExampleId("imported");
      setPrompt("");
      setFrameIndex(0);
      setIsPlaying(false);
      setMessage(
        `Imported ${file.name}. Simulation will start automatically.` +
          (result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : "")
      );
    };
    reader.onerror = () => setMessage("Error: file read failed.");
    reader.readAsText(file, "utf-8");
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) handleFileImport(file);
  }, [handleFileImport]);

  const handleFileSelect = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleFileImport(file);
    event.target.value = "";
  }, [handleFileImport]);

  const handleCanvasMouseDown = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      offset: { ...view.offset },
    };
  }, [view.offset]);

  const handleCanvasMouseMove = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const panStart = panStartRef.current;
    if (!panStart) return;
    setView((current) => ({
      ...current,
      offset: {
        x: panStart.offset.x + event.clientX - panStart.x,
        y: panStart.offset.y + event.clientY - panStart.y,
      },
    }));
  }, []);

  const stopCanvasPan = useCallback(() => {
    panStartRef.current = null;
  }, []);

  const handleCanvasWheel = useCallback((event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setView((current) => {
      const nextZoom = clamp(current.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 6);
      const anchor = graphWorldCenter(simulationGraph);
      const world = screenToWorld(screen, { width: rect.width, height: rect.height }, current, anchor);
      return {
        zoom: nextZoom,
        offset: {
          x: screen.x - rect.width / 2 - (world.x - anchor.x) * FIXED_PIXELS_PER_METER * nextZoom,
          y: screen.y - rect.height / 2 + (world.y - anchor.y) * FIXED_PIXELS_PER_METER * nextZoom,
        },
      };
    });
  }, [simulationGraph]);

  return (
    <main className="app-shell">
      <section className="left-panel">
        <div className="brand">
          <h1>Physics Visualizer</h1>
          <p>Graph DSL driven 2D simulation</p>
        </div>

        <label className="field-label" htmlFor="example-select">Example</label>
        <select id="example-select" onChange={(event) => loadExample(event.target.value)} value={selectedExampleId}>
          <option value="generated">Generated result</option>
          <option value="imported">Imported result</option>
          {examples.map((example) => (
            <option key={example.id} value={example.id}>
              {example.title}
            </option>
          ))}
        </select>

        <label className="field-label" htmlFor="prompt">Prompt</label>
        <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} />
        <div style={{ marginTop: 10 }}>
          <label className="field-label" style={{ cursor: "pointer" }} onClick={() => setShowProblemList(!showProblemList)}>
            📚 Problem Bank ({problemList.length} prompts, {genExamples.length} generated) {showProblemList ? "▾" : "▸"}
          </label>
          {showProblemList && (
            <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #d7d5ca", borderRadius: 6, padding: 4, fontSize: "0.75rem", background: "#fafaf8" }}>
              {genExamples.length > 0 && (
                <>
                  <div style={{ padding: "2px 6px", fontWeight: 700, color: "#1f8a70", fontSize: "0.7rem" }}>✨ Generated DSLs (click to load)</div>
                  {genExamples.map((g, i) => (
                    <div
                      key={`gen${i}`}
                      style={{ padding: "3px 6px", cursor: "pointer", borderBottom: "1px solid #e6f4ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#1f8a70" }}
                      title={g.prompt}
                      onClick={async () => {
                        try {
                          const res = await fetch(`/examples/generated/${g.name}.json`);
                          const dsl = await res.json();
                          handleAIDSL(dsl);
                        } catch { setMessage("Failed to load generated DSL"); }
                      }}
                    >
                      ⬆️ {g.prompt.slice(0, 50)}
                    </div>
                  ))}
                  <div style={{ padding: "2px 6px", fontWeight: 700, color: "#5f6368", fontSize: "0.7rem", marginTop: 4 }}>📋 AI Prompts</div>
                </>
              )}
              {problemList.map((p, i) => (
                <div
                  key={i}
                  style={{ padding: "3px 6px", cursor: "pointer", borderBottom: "1px solid #eee", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  title={p}
                  onClick={() => { setPrompt(p); setShowProblemList(false); }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#e6f4ea")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {String(i + 1).padStart(2, "0")}. {p}
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="field-label" htmlFor="engine-select">Engine</label>
        <select
          id="engine-select"
          value={simulationEngine}
          onChange={(event) => {
            setSimulationEngine(event.target.value as SimulationEngine);
            setFrameIndex(0);
            setIsPlaying(false);
          }}
        >
          <option value="box2d">Box2D (WASM)</option>
        </select>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary-button" type="button" onClick={handleGenerate} style={{ flex: 1 }}>
            <Wand2 size={18} />
            Generate Graph
          </button>
          <button className="primary-button" type="button" onClick={() => setShowAIModal(true)} style={{ flex: 1, background: "#6c5ce7" }}>
            <Sparkles size={18} />
            AI Generate
          </button>
        </div>
        <p style={{ fontSize: "0.72rem", color: "#9ca3af", margin: "4px 0 0" }}>
          Configure the API key in the AI dialog. It is stored in this browser.
        </p>

        <div className="file-import-section">
          <label className="field-label">Import DSL JSON</label>
          <div
            className={`drop-zone ${isDragOver ? "drag-over" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <FileUp size={24} className="upload-icon" />
            <p className="drop-zone-text">Drop a JSON file here</p>
            <p className="drop-zone-hint">or click to choose a file</p>
            <input type="file" accept="application/json,.json" onChange={handleFileSelect} className="file-input" />
          </div>
        </div>

        <label className="field-label" htmlFor="duration-seconds">Duration (s)</label>
        <input
          id="duration-seconds"
          type="number"
          min={0.5}
          max={30}
          step={0.5}
          value={durationSeconds}
          onChange={(event) => setDurationSeconds(clampDuration(Number(event.target.value)))}
        />

        {graph.variables && graph.variables.length > 0 && (
          <div className="variable-controls">
            <label className="field-label">Variable Ranges</label>
            {graph.variables.map((variable) => {
              const value = variableValues[variable.id] ?? variable.default;
              return (
                <div className="variable-control" key={variable.id}>
                  <div className="variable-control-header">
                    <span>{variable.label ?? variable.id}</span>
                    <output>{formatVariableValue(value, variable.unit)}</output>
                  </div>
                  <input
                    type="range"
                    min={variable.min}
                    max={variable.max}
                    step={variable.step ?? inferVariableStep(variable.min, variable.max)}
                    value={value}
                    onChange={(event) => handleVariableChange(variable.id, Number(event.target.value))}
                  />
                  <div className="variable-control-range">
                    <span>{formatVariableValue(variable.min, variable.unit)}</span>
                    <span>{formatVariableValue(variable.max, variable.unit)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="toggles">
          <label><input type="checkbox" checked={showFields} onChange={(event) => setShowFields(event.target.checked)} /> Fields</label>
          <label><input type="checkbox" checked={showTrajectory} onChange={(event) => setShowTrajectory(event.target.checked)} /> Trajectory</label>
          <label><input type="checkbox" checked={showVelocity} onChange={(event) => setShowVelocity(event.target.checked)} /> Velocity</label>
          <label><input type="checkbox" checked={showForce} onChange={(event) => setShowForce(event.target.checked)} /> Force</label>
        </div>
        <label className="field-label" htmlFor="vector-scale">Vector Scale {vectorScale.toFixed(1)}x</label>
        <input
          id="vector-scale"
          type="range"
          min={0.2}
          max={5.0}
          step={0.1}
          value={vectorScale}
          onChange={(event) => setVectorScale(Number(event.target.value))}
        />

        <div className={validation.valid ? "status ok" : "status error"}>
          {validation.valid
            ? message
            : validation.errors.map((error) => `${error.layer}:${error.path}: ${error.message}`).join("\n")}
          {validation.valid && validation.warnings.length > 0
            ? `\n${validation.warnings.map((warning) => `warning:${warning.path}: ${warning.message}`).join("\n")}`
            : ""}
        </div>
      </section>

      <section className="stage-panel">
        <canvas
          ref={canvasRef}
          onClick={(event) => pickNode(event, simulationGraph, currentFrame, canvasRef.current, view, setSelectedNodeId)}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={stopCanvasPan}
          onMouseLeave={stopCanvasPan}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={handleCanvasWheel}
        />
        <div className="timeline">
          <button type="button" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" onClick={() => { setFrameIndex(0); setIsPlaying(false); }} aria-label="Reset">
            <RotateCcw size={20} />
          </button>
          <div className="timeline-track">
            <div className="timeline-markers">
              {timelineMarkers.map((marker) => {
                const isRange = marker.endFrameIndex != null && marker.endFrameIndex > marker.frameIndex;
                const left = markerPosition(marker.frameIndex, frames.length);
                const right = isRange ? markerPosition(marker.endFrameIndex!, frames.length) : left;
                const active = frameIndex >= marker.frameIndex && frameIndex <= (marker.endFrameIndex ?? marker.frameIndex);
                return (
                  <button
                    key={marker.id}
                    className={`timeline-marker ${marker.kind}${active ? " active" : ""}${isRange ? " range" : ""}`}
                    type="button"
                    style={isRange
                      ? { left: `${left}%`, width: `${Math.max(0.5, right - left)}%` }
                      : { left: `${left}%` }}
                    title={`${marker.label} ${marker.time.toFixed(2)}s${isRange ? ` – ${frames[marker.endFrameIndex!]?.time.toFixed(2) ?? ""}s` : ""}`}
                    aria-label={`${marker.label} ${marker.time.toFixed(2)}s`}
                    onClick={() => {
                      setFrameIndex(marker.frameIndex);
                      setIsPlaying(false);
                    }}
                  />
                );
              })}
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={frameIndex}
              onChange={(event) => {
                setFrameIndex(Number(event.target.value));
                setIsPlaying(false);
              }}
            />
          </div>
          <span>{currentFrame ? `${currentFrame.time.toFixed(2)}s` : "0.00s"}</span>
        </div>
      </section>

      <aside className="inspector">
        <h2>Inspector</h2>
        <label className="field-label" htmlFor="node-select">Target</label>
        <select
          id="node-select"
          value={`${inspectorTarget.kind}:${inspectorTarget.id}`}
          onChange={(event) => {
            const [kind, id] = event.target.value.split(":");
            setInspectorTarget({ kind: kind as "object" | "field", id });
            if (kind === "object") setSelectedNodeId(id);
          }}
        >
          <optgroup label="Objects">
            {simulationGraph.objects.map((node) => (
              <option key={`obj:${node.id}`} value={`object:${node.id}`}>
                {node.label ?? node.id}
              </option>
            ))}
          </optgroup>
          <optgroup label="Fields">
            {simulationGraph.fields.map((field) => (
              <option key={`fld:${field.id}`} value={`field:${field.id}`}>
                {field.metadata?.description ?? field.id}
              </option>
            ))}
          </optgroup>
        </select>
        {inspectorTarget.kind === "field" ? (
          <div className="inspector-content">
            {(() => {
              const field = simulationGraph.fields.find((f) => f.id === inspectorTarget.id);
              if (!field) return <p>Field not found.</p>;
              return (
                <dl>
                  <dt>ID</dt><dd>{field.id}</dd>
                  <dt>Model</dt><dd>{field.model}</dd>
                  {field.model === "uniform" && (
                    <>
                      <dt>Vector</dt><dd>{formatVector({x:field.vector[0],y:field.vector[1]}, "")}</dd>
                      {"variation" in field && (field as any).variation?.temporal && (
                        <><dt>Temporal</dt><dd>{(field as any).variation.temporal}</dd></>
                      )}
                      {"variation" in field && (field as any).variation?.spatial && (
                        <><dt>Spatial</dt><dd>{(field as any).variation.spatial}</dd></>
                      )}
                    </>
                  )}
                  {field.model === "radial" && (
                    <>
                      <dt>Origin</dt><dd>[{field.origin[0]}, {field.origin[1]}]</dd>
                      <dt>Strength</dt><dd>{field.strength}</dd>
                      {"origin_from" in field && field.origin_from && (
                        <><dt>Origin From</dt><dd>{field.origin_from}</dd></>
                      )}
                    </>
                  )}
                  {field.metadata?.tags && (
                    <><dt>Tags</dt><dd>{field.metadata.tags.join(", ")}</dd></>
                  )}
                  {field.metadata?.render && (
                    <><dt>Color</dt><dd style={{color:field.metadata.render.color}}>{field.metadata.render.color ?? "—"}</dd></>
                  )}
                </dl>
              );
            })()}
          </div>
        ) : selectedNode && currentFrame ? (
          <div className="inspector-content">
            <div className="object-summary">
              <span>{selectedNode.type}</span>
              <span>{selectedNode.geometry?.type ?? "none"}</span>
              {typeof selectedNode.properties.mass === "number" && <span>{formatScalar(selectedNode.properties.mass, "kg")}</span>}
            </div>

            <div className="metric-list">
              {inspectorMetrics.map((metric) => (
                <button
                  key={metric.id}
                  type="button"
                  className={`metric-row ${selectedMetric?.id === metric.id ? "selected" : ""}`}
                  onClick={() => setSelectedMetricId(metric.id)}
                  title={`Show ${metric.label} over time`}
                >
                  <span>{metric.label}</span>
                  <strong>{formatScalar(metric.currentValue, metric.unit)}</strong>
                </button>
              ))}
            </div>

            {selectedMetric && (
              <div className="metric-chart-panel">
                <div className="metric-chart-header">
                  <span>{selectedMetric.label} vs t</span>
                  <output>{formatScalar(selectedMetric.currentValue, selectedMetric.unit)}</output>
                </div>
                <MetricChart metric={selectedMetric} currentFrameIndex={frameIndex} />
              </div>
            )}
          </div>
        ) : (
          <p>Select an object.</p>
        )}
      </aside>
      <AIGenerator open={showAIModal} onClose={() => setShowAIModal(false)} onDSLGenerated={handleAIDSL} />
    </main>
  );
}

interface MetricPoint {
  time: number;
  value: number;
}

interface InspectorMetric {
  id: string;
  label: string;
  unit: string;
  currentValue: number;
  points: MetricPoint[];
}

function buildInspectorMetrics(
  graph: PhysicsGraph,
  frames: StateFrame[],
  objectId: string,
  frameIndex: number
): InspectorMetric[] {
  const object = graph.objects.find((item) => item.id === objectId);
  if (!object) return [];

  const metrics: InspectorMetric[] = [];
  const currentIndex = Math.min(frameIndex, Math.max(0, frames.length - 1));
  const addMetric = (id: string, label: string, unit: string, getter: (frame: StateFrame, index: number) => number | undefined) => {
    const points = frames.map((frame, index) => ({
      time: frame.time,
      value: finiteOrZero(getter(frame, index)),
    }));
    metrics.push({
      id,
      label,
      unit,
      currentValue: points[currentIndex]?.value ?? 0,
      points,
    });
  };
  const addConstant = (id: string, label: string, unit: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    metrics.push({
      id,
      label,
      unit,
      currentValue: value,
      points: frames.map((frame) => ({ time: frame.time, value })),
    });
  };

  addConstant("mass", "质量 m", "kg", object.properties.mass);
  addConstant("charge", "电荷量 q", "C", object.properties.charge);
  addConstant("radius", "半径 r", "m", object.properties.radius);
  addConstant("restitution", "恢复系数 e", "", object.properties.restitution);
  addConstant("friction", "摩擦系数 μ", "", object.properties.friction ?? object.properties.dynamic_friction);
  addConstant("linear_damping", "线性阻尼", "N·s/m", object.properties.linear_damping);
  addConstant("angular_damping", "角阻尼", "N·m·s/rad", object.properties.angular_damping);

  addMetric("position_x", "位置 x", "m", (frame) => getNode(frame, objectId)?.position.x);
  addMetric("position_y", "位置 y", "m", (frame) => getNode(frame, objectId)?.position.y);
  addMetric("position_mag", "位矢大小 |r|", "m", (frame) => magnitude(getNode(frame, objectId)?.position));
  addMetric("velocity_x", "速度 vx", "m/s", (frame) => getNode(frame, objectId)?.velocity.x);
  addMetric("velocity_y", "速度 vy", "m/s", (frame) => getNode(frame, objectId)?.velocity.y);
  addMetric("speed", "速率 |v|", "m/s", (frame) => magnitude(getNode(frame, objectId)?.velocity));
  addMetric("acceleration_x", "加速度 ax", "m/s²", (_frame, index) => accelerationAt(frames, objectId, index)?.x);
  addMetric("acceleration_y", "加速度 ay", "m/s²", (_frame, index) => accelerationAt(frames, objectId, index)?.y);
  addMetric("acceleration_mag", "加速度大小 |a|", "m/s²", (_frame, index) => magnitude(accelerationAt(frames, objectId, index)));
  addMetric("force_x", "合力 Fx", "N", (frame) => getNode(frame, objectId)?.force.x);
  addMetric("force_y", "合力 Fy", "N", (frame) => getNode(frame, objectId)?.force.y);
  addMetric("force_mag", "合力大小 |F|", "N", (frame) => magnitude(getNode(frame, objectId)?.force));
  addMetric("momentum_x", "动量 px", "kg·m/s", (frame) => (object.properties.mass ?? 0) * (getNode(frame, objectId)?.velocity.x ?? 0));
  addMetric("momentum_y", "动量 py", "kg·m/s", (frame) => (object.properties.mass ?? 0) * (getNode(frame, objectId)?.velocity.y ?? 0));
  addMetric("momentum_mag", "动量大小 |p|", "kg·m/s", (frame) => (object.properties.mass ?? 0) * finiteOrZero(magnitude(getNode(frame, objectId)?.velocity)));
  addMetric("kinetic_energy", "动能 Ek", "J", (frame) => getNode(frame, objectId)?.energy.kinetic);
  addMetric("potential_energy", "势能 Ep", "J", (frame) => getNode(frame, objectId)?.energy.potential);
  addMetric("spring_energy", "弹性势能 Es", "J", (frame) => getNode(frame, objectId)?.energy.spring);
  addMetric("total_energy", "机械能 E", "J", (frame) => {
    const node = getNode(frame, objectId);
    if (!node) return undefined;
    return node.energy.kinetic + node.energy.potential + (node.energy.spring ?? 0);
  });
  addMetric("rotation", "转角 θ", "rad", (frame) => getNode(frame, objectId)?.rotation);
  addMetric("angular_velocity", "角速度 ω", "rad/s", (frame) => getNode(frame, objectId)?.angularVelocity);
  addMetric("power", "功率 P", "W", (frame) => getNode(frame, objectId)?.power);
  addMetric("work", "功 W", "J", (frame) => getNode(frame, objectId)?.work);

  for (const component of collectForceComponentIds(frames, objectId)) {
    const label = component.label ?? component.id;
    addMetric(`force_component_${component.id}_x`, `${label} Fx`, "N", (frame) =>
      getForceComponent(frame, objectId, component.id)?.vector.x
    );
    addMetric(`force_component_${component.id}_y`, `${label} Fy`, "N", (frame) =>
      getForceComponent(frame, objectId, component.id)?.vector.y
    );
    addMetric(`force_component_${component.id}_mag`, `${label} |F|`, "N", (frame) =>
      magnitude(getForceComponent(frame, objectId, component.id)?.vector)
    );
  }

  return metrics.filter((metric) => metric.points.length > 0);
}

function MetricChart({ metric, currentFrameIndex }: { metric: InspectorMetric; currentFrameIndex: number }) {
  const width = 260;
  const height = 132;
  const padding = { left: 34, right: 10, top: 12, bottom: 24 };
  const finitePoints = metric.points.filter((point) => Number.isFinite(point.value));
  const minTime = finitePoints[0]?.time ?? 0;
  const maxTime = finitePoints[finitePoints.length - 1]?.time ?? 1;
  const values = finitePoints.map((point) => point.value);
  const rawMinValue = Math.min(...values, 0);
  const rawMaxValue = Math.max(...values, 0);
  const valueSpan = rawMaxValue - rawMinValue || 1;
  const minValue = rawMinValue - valueSpan * 0.08;
  const maxValue = rawMaxValue + valueSpan * 0.08;
  const xScale = (time: number) =>
    padding.left + ((time - minTime) / Math.max(1e-9, maxTime - minTime)) * (width - padding.left - padding.right);
  const yScale = (value: number) =>
    height - padding.bottom - ((value - minValue) / Math.max(1e-9, maxValue - minValue)) * (height - padding.top - padding.bottom);
  const polyline = finitePoints.map((point) => `${xScale(point.time).toFixed(2)},${yScale(point.value).toFixed(2)}`).join(" ");
  const currentPoint = metric.points[Math.min(currentFrameIndex, Math.max(0, metric.points.length - 1))];
  const currentX = currentPoint ? xScale(currentPoint.time) : padding.left;
  const currentY = currentPoint ? yScale(currentPoint.value) : height - padding.bottom;

  return (
    <svg className="metric-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric.label} over time`}>
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} />
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} />
      <text x={padding.left} y={height - 6}>0s</text>
      <text x={width - padding.right} y={height - 6} textAnchor="end">{`${maxTime.toFixed(1)}s`}</text>
      <text x={4} y={padding.top + 4}>{compactNumber(maxValue)}</text>
      <text x={4} y={height - padding.bottom}>{compactNumber(minValue)}</text>
      <polyline points={polyline} />
      <line className="metric-chart-time" x1={currentX} y1={padding.top} x2={currentX} y2={height - padding.bottom} />
      <circle cx={currentX} cy={currentY} r={3.5} />
    </svg>
  );
}

function parseImportedGraph(content: string): { ok: true; graph: PhysicsGraph; warnings: string[] } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, message: `Error: JSON parse failed - ${error instanceof Error ? error.message : "unknown error"}` };
  }

  const candidate = extractGraphCandidate(parsed);
  if (!candidate) {
    return { ok: false, message: "Error: no Graph DSL object found. Import a graph directly or an object with graph/dsl." };
  }

  let repairedGraph: PhysicsGraph;
  try {
    repairedGraph = repairStableConstraintSpec(structuredClone(candidate as PhysicsGraph));
  } catch {
    const validation = validateGraph(candidate);
    return {
      ok: false,
      message: validation.valid
        ? "Error: DSL repair failed."
        : `DSL validation failed: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
    };
  }

  const graph = normalizeGraphToSI(repairedGraph);
  const validation = validateGraph(graph);
  if (!validation.valid) {
    return {
      ok: false,
      message: `Validation failed after stable-spec repair and SI normalization: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
    };
  }

  return {
    ok: true,
    graph,
    warnings: validation.warnings.map((warning) => `${warning.path}: ${warning.message}`),
  };
}

function extractGraphCandidate(value: unknown): unknown | null {
  if (isRecord(value) && value.version === "3.0") return value;
  if (isRecord(value) && isRecord(value.graph)) return value.graph;
  if (isRecord(value) && isRecord(value.dsl)) return value.dsl;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatVector(vector: Vector2, unit: string) {
  return `{x:${vector.x.toFixed(3)}, y:${vector.y.toFixed(3)}} ${unit}`;
}

function formatScalar(value: number | undefined, unit: string): string {
  const formatted = compactNumber(finiteOrZero(value));
  return unit ? `${formatted} ${unit}` : formatted;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 10000 || abs < 0.001)) return value.toExponential(2);
  return value.toFixed(abs >= 100 ? 1 : abs >= 10 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "");
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function magnitude(vector: Vector2 | undefined): number | undefined {
  if (!vector) return undefined;
  return Math.hypot(vector.x, vector.y);
}

function getNode(frame: StateFrame, objectId: string) {
  return frame.nodes.find((node) => node.id === objectId);
}

function accelerationAt(frames: StateFrame[], objectId: string, index: number): Vector2 | undefined {
  const current = frames[index];
  const previous = frames[index - 1];
  const next = frames[index + 1];
  const a = previous ? getNode(previous, objectId) : getNode(current, objectId);
  const b = previous ? getNode(current, objectId) : next ? getNode(next, objectId) : undefined;
  if (!a || !b || !current) return undefined;
  const t0 = previous?.time ?? current.time;
  const t1 = previous ? current.time : next?.time;
  const dt = typeof t1 === "number" ? t1 - t0 : 0;
  if (dt <= 0) return undefined;
  return {
    x: (b.velocity.x - a.velocity.x) / dt,
    y: (b.velocity.y - a.velocity.y) / dt,
  };
}

function collectForceComponentIds(frames: StateFrame[], objectId: string): Array<{ id: string; label?: string }> {
  const components = new Map<string, string | undefined>();
  for (const frame of frames) {
    for (const component of getNode(frame, objectId)?.forceComponents ?? []) {
      if (!components.has(component.id)) components.set(component.id, component.label);
    }
  }
  return [...components.entries()].map(([id, label]) => ({ id, label }));
}

function getForceComponent(frame: StateFrame, objectId: string, componentId: string) {
  return getNode(frame, objectId)?.forceComponents?.find((component) => component.id === componentId);
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(30, Math.max(0.5, value));
}

function inferVariableStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (!Number.isFinite(span) || span === 0) return 0.1;
  return span <= 1 ? 0.01 : span <= 10 ? 0.1 : 1;
}

function formatVariableValue(value: number, unit: string | undefined): string {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return unit ? `${formatted} ${unit}` : formatted;
}

function withSimulationDuration(graph: PhysicsGraph, durationSeconds: number): PhysicsGraph {
  return {
    ...graph,
    timeline: {
      ...graph.timeline,
      terminal_condition: `t >= ${clampDuration(durationSeconds)}`,
    },
  };
}

function markerPosition(frameIndex: number, frameCount: number): number {
  return frameCount <= 1 ? 0 : (frameIndex / (frameCount - 1)) * 100;
}

function pickNode(
  event: ReactMouseEvent<HTMLCanvasElement>,
  graph: PhysicsGraph,
  frame: StateFrame | undefined,
  canvas: HTMLCanvasElement | null,
  view: CanvasView,
  setSelectedNodeId: (id: string) => void
) {
  if (event.button !== 0 || !frame || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const point = screenToWorld(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    { width: rect.width, height: rect.height },
    view,
    graphWorldCenter(graph)
  );
  const hit = graph.objects.find((node) => isPointInsideNode(point, node, frame));
  if (hit) setSelectedNodeId(hit.id);
}

function isPointInsideNode(point: Vector2, node: PhysicsObject, frame: StateFrame): boolean {
  const state = frame.nodes.find((item) => item.id === node.id);
  if (!state) return false;
  if (node.geometry?.type === "circle") {
    return Math.hypot(state.position.x - point.x, state.position.y - point.y) <= node.geometry.radius + 0.06;
  }
  if (node.geometry?.type === "box") {
    const [w, h] = node.geometry.size;
    return Math.abs(state.position.x - point.x) <= w / 2 && Math.abs(state.position.y - point.y) <= h / 2;
  }
  return false;
}

function graphWorldCenter(graph: PhysicsGraph): Vector2 {
  const bounds = graph.world.bounds;
  if (!bounds) return { x: 0, y: 0 };
  return {
    x: (bounds.min[0] + bounds.max[0]) / 2,
    y: (bounds.min[1] + bounds.max[1]) / 2,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function generateStaticStateFrames(graph: PhysicsGraph, durationSeconds: number): StateFrame[] {
  const frameTimes = [0, clampDuration(durationSeconds)];
  return frameTimes.map((time) => ({
    time,
    nodes: graph.objects.map((object) => {
      const state = graph.initial_state[object.id];
      const mass = object.properties.mass ?? 0;
      const velocity = vectorFromDSL(state?.velocity);
      return {
        id: object.id,
        position: vectorFromDSL(state?.position),
        velocity,
        force: { x: 0, y: 0 },
        energy: {
          kinetic: 0.5 * mass * (velocity.x ** 2 + velocity.y ** 2),
          potential: 0,
        },
        rotation: state?.rotation ?? 0,
        angularVelocity: state?.angular_velocity ?? 0,
      };
    }),
    diagnostics: {
      contactCount: 0,
      activeConstraintCount: 0,
      maxConstraintError: 0,
      lambdaNorm: 0,
      maxLambdaRatio: 0,
      clampedConstraintCount: 0,
      energyDrift: 0,
      totalNormalImpulse: 0,
      totalFrictionImpulse: 0,
      contacts: [],
      events: [],
    },
  }));
}

function vectorFromDSL(vector: PhysicsGraph["initial_state"][string]["position"] | undefined): Vector2 {
  return {
    x: vector?.[0] ?? 0,
    y: vector?.[1] ?? 0,
  };
}
