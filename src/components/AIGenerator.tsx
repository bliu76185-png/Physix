import { AlertTriangle, CheckCircle2, Circle, Image as ImageIcon, Loader, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { generateDSL, type DSLGenerationResult, type StageUpdate } from "../services/dslGenerator";
import { archiveGeneration } from "../services/generationArchive";
import { recognizePhysicsProblemImage } from "../services/imageRecognition";

export interface AIGeneratorProps {
  open: boolean;
  onClose: () => void;
  onDSLGenerated: (dsl: Record<string, unknown>) => void;
}

const STORAGE_KEY = "deepseek-api-key";
const STORAGE_MODEL = "ai-model-preset";

interface ModelPreset {
  label: string;
  baseUrl: string;
  model: string;
}

const MODEL_PRESETS: ModelPreset[] = [
  { label: "DeepSeek V4 Flash", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  { label: "DeepSeek V4 Pro", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" },
  { label: "智谱 GLM-5.2", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2" },
  { label: "MiniMax M3", baseUrl: "https://api.minimax.chat/v1", model: "minimax-m3" },
  { label: "通义 Qwen-Max", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max" },
  { label: "Custom", baseUrl: "", model: "" },
];

function loadModelPreset(): ModelPreset {
  try {
    const saved = localStorage.getItem(STORAGE_MODEL);
    if (saved) return JSON.parse(saved) as ModelPreset;
  } catch { /* ignore */ }
  return MODEL_PRESETS[0];
}

export default function AIGenerator({ open, onClose, onDSLGenerated }: AIGeneratorProps) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");
  const [modelPreset, setModelPreset] = useState<ModelPreset>(loadModelPreset);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [result, setResult] = useState<DSLGenerationResult | null>(null);
  const [error, setError] = useState("");
  const [archiveStatus, setArchiveStatus] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [imageName, setImageName] = useState("");
  const [stageLog, setStageLog] = useState<StageUpdate[]>([]);
  const [showFullLog, setShowFullLog] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setError("");
      setResult(null);
      setArchiveStatus("");
      setStageLog([]);
      setShowFullLog(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    if (value) {
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const handleImageSelect = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file for recognition.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      setImageDataUrl(result);
      setImageName(file.name);
      setError("");
    };
    reader.onerror = () => setError("Image read failed.");
    reader.readAsDataURL(file);
  }, []);

  const handleRecognizeImage = useCallback(async () => {
    if (!imageDataUrl) return;
    if (!apiKey.trim()) {
      setError("Configure an API key before recognizing images.");
      return;
    }

    setRecognizing(true);
    setError("");
    try {
      const response = await recognizePhysicsProblemImage(imageDataUrl, {
        apiConfig: getApiConfig(),
      });
      if (response.success && response.text) {
        setProblem(response.text);
        setResult(null);
      } else {
        setError(response.error ?? "Image recognition failed.");
      }
    } catch (recognizeError) {
      setError(recognizeError instanceof Error ? recognizeError.message : "Unknown image recognition error");
    } finally {
      setRecognizing(false);
    }
  }, [apiKey, imageDataUrl]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!problem.trim()) return;
      if (!apiKey.trim()) {
        setError("Configure an API key before generating DSL.");
        return;
      }

      setLoading(true);
      setError("");
      setResult(null);
      setArchiveStatus("");
      setStageLog([]);

      const config = getApiConfig();

      try {
        const log: StageUpdate[] = [];
        const response = await generateDSL(problem, {
          apiConfig: config,
          temperature: 0.2,
          onStageUpdate: (update) => {
            log.push(update);
            setStageLog([...log]);
          },
        });

        setResult(response);
        const archive = await archiveGeneration({ problem, result: response, imageName });
        setArchiveStatus(
          archive.ok && archive.dir
            ? `Saved generation record: ${archive.dir}`
            : `Generation record not saved: ${archive.error ?? "unknown archive error"}`
        );

        if (response.success && response.dsl) {
          // Persist to examples/generated/ for auto-indexing on next load
          saveExampleToDisk(problem, response.dsl).catch(() => {});
          onDSLGenerated(response.dsl);
        }
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [apiKey, imageName, onDSLGenerated, problem]
  );

  if (!open) return null;

  function getApiConfig() {
    const preset = modelPreset.label === "Custom"
      ? { baseUrl: customBaseUrl.trim(), model: customModel.trim() }
      : modelPreset;
    return { apiKey: apiKey.trim(), baseUrl: preset.baseUrl, model: preset.model };
  }

  function handleModelChange(label: string) {
    const preset = MODEL_PRESETS.find((p) => p.label === label) ?? MODEL_PRESETS[0];
    setModelPreset(preset);
    localStorage.setItem(STORAGE_MODEL, JSON.stringify(preset));
    if (label !== "Custom") {
      setCustomBaseUrl("");
      setCustomModel("");
    }
  }

  function stageLabel(stage: string): string {
    switch (stage) {
      case "analysis": return "IR 分析";
      case "dsl": return "DSL 生成";
      case "validation": return "校验";
      case "repair": return "修复";
      default: return stage;
    }
  }

  async function saveExampleToDisk(problem: string, dsl: Record<string, unknown>) {
    try {
      const res = await fetch("/api/save-generated-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem, dsl }),
      });
      const data = await res.json() as { ok: boolean; fileName?: string; error?: string };
      if (data.ok) {
        console.log(`[AIGenerator] Saved example to examples/generated/${data.fileName}`);
      }
    } catch {
      // Non-critical: save failure doesn't affect generation flow
    }
  }

  function extractRestatement(rawText: string): string {
    // Extract the restatement section from the analysis response
    // (everything before the ```json block or first { of IR JSON)
    const jsonBlockIdx = rawText.indexOf("```json");
    const braceIdx = rawText.lastIndexOf('{\n  "summary"');
    const cutoff = jsonBlockIdx > 0 ? jsonBlockIdx : braceIdx > 0 ? braceIdx : rawText.length;
    return rawText.slice(0, cutoff).trim() || rawText.slice(0, 600);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            <Sparkles size={20} />
            AI Physics DSL
          </span>
          <button className="icon-button" onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="api-key">
              DeepSeek API Key
              <span className="field-hint">
                {" "}from{" "}
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                  platform.deepseek.com/api_keys
                </a>
              </span>
            </label>
            <input
              id="api-key"
              type="password"
              className="api-key-input"
              value={apiKey}
              onChange={(event) => handleApiKeyChange(event.target.value)}
              placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="model-select">Model</label>
            <select
              id="model-select"
              value={modelPreset.label}
              onChange={(event) => handleModelChange(event.target.value)}
            >
              {MODEL_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>
            {modelPreset.label === "Custom" && (
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                <input
                  className="api-key-input"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
                <input
                  className="api-key-input"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="model-name"
                />
              </div>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="ai-problem">
              Physics Problem
            </label>
            <textarea
              ref={inputRef}
              id="ai-problem"
              value={problem}
              onChange={(event) => setProblem(event.target.value)}
              rows={8}
              placeholder={`Example: a 1 kg ball falls from 1.8 m and collides with a fixed floor.\n\nExample: two blocks of 1 kg and 2 kg collide on ice with opposite velocities of 2 m/s and 3 m/s.`}
              disabled={loading}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="problem-image">
              Image Recognition
              <span className="field-hint"> DeepSeek V4-Pro image input may depend on API support</span>
            </label>
            <div className="image-recognition-panel">
              <label className="secondary-button image-upload-button" htmlFor="problem-image">
                <ImageIcon size={16} />
                Choose Image
              </label>
              <input id="problem-image" type="file" accept="image/*" onChange={handleImageSelect} hidden />
              <button
                type="button"
                className="secondary-button"
                onClick={handleRecognizeImage}
                disabled={loading || recognizing || !imageDataUrl}
              >
                {recognizing ? <Loader size={16} className="spin" /> : <Sparkles size={16} />}
                识图填题设
              </button>
            </div>
            {imageDataUrl && (
              <div className="image-preview">
                <img src={imageDataUrl} alt={imageName || "Selected physics problem"} />
                <span>{imageName}</span>
                <button type="button" className="icon-button" onClick={() => { setImageDataUrl(""); setImageName(""); }} title="Remove image">
                  <X size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Live stage progress */}
          {loading && stageLog.length > 0 && (
            <div className="stage-progress">
              {stageLog.map((update, i) => (
                <div key={i} className={`stage-progress-item stage-${update.status}`}>
                  <span className="stage-progress-label">
                    {update.status === "started" ? "⏳" : update.status === "completed" ? "✅" : "❌"}
                    {" "}{stageLabel(update.stage)}
                    {update.status === "started" && "…"}
                  </span>
                  {update.status === "completed" && update.preview && update.stage === "analysis" && (
                    <details className="restatement-preview">
                      <summary>查看 AI 结构化重述</summary>
                      <pre>{extractRestatement(update.rawText ?? update.preview)}</pre>
                    </details>
                  )}
                  {update.status === "failed" && update.preview && (
                    <details className="stage-error-detail">
                      <summary>查看错误详情</summary>
                      <pre>{update.preview}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && <div className="status error">{error}</div>}
          {archiveStatus && <div className={`archive-status ${archiveStatus.startsWith("Saved") ? "ok" : "error"}`}>{archiveStatus}</div>}

          {result && (
            <>
              {/* Collapsible full log */}
              {stageLog.length > 0 && (
                <details className="full-log-viewer" open={showFullLog} onToggle={(e) => setShowFullLog((e.target as HTMLDetailsElement).open)}>
                  <summary className="full-log-summary">
                    📋 完整生成日志（{stageLog.length} 阶段，{result.usage?.totalTokens ?? "?"} tokens）
                  </summary>
                  <div className="full-log-content">
                    {stageLog.map((update, i) => (
                      <div key={i} className="log-entry">
                        <div className="log-entry-header">
                          {update.status === "completed" ? "✅" : "❌"} {stageLabel(update.stage)}
                          {" "}— {update.rawText ? `${update.rawText.length} chars` : "no output"}
                        </div>
                        {update.rawText && (
                          <pre className="log-entry-body">{update.rawText}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {result && result.stages && (
            <div className={`status ${result.success ? "ok" : "error"}`}>
              <div>
                {result.success
                  ? `Generated. Tokens: ${result.usage?.totalTokens ?? "?"} (input ${result.usage?.promptTokens ?? "?"}, output ${result.usage?.completionTokens ?? "?"})`
                  : `Failed: ${result.error}`}
              </div>
              {result.stages && result.stages.length > 0 && (
                <div className="ai-stage-list">
                  {result.stages.map((stage) => (
                    <div key={stage.name} className={`ai-stage ai-stage-${stage.status}`} title={stage.errors?.join("\n")}>
                      {stage.status === "success" ? (
                        <CheckCircle2 size={14} />
                      ) : stage.status === "failed" ? (
                        <AlertTriangle size={14} />
                      ) : (
                        <Circle size={14} />
                      )}
                      <span>{stage.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={loading || !problem.trim()}>
              {loading ? (
                <>
                  <Loader size={16} className="spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Generate DSL
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
