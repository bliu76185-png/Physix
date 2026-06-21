import { createDeepSeekClient, DeepSeekAPIError, type DeepSeekConfig } from "./deepseekClient";
import { repairStableConstraintSpec } from "../graph/stableConstraintSpec";
import type { PhysicsGraph, ValidationError } from "../graph/types";
import { validateGraph } from "../graph/validateGraph";
import {
  buildAnalysisMessages,
  buildBoundedRepairMessages,
  buildConversationStart,
  buildMessages,
  appendDSLRequest,
  appendRepairRequest,
} from "./schemaPrompt";

export type DSLGenerationStageName = "analysis" | "dsl" | "validation" | "repair";

export interface DSLGenerationStage {
  name: DSLGenerationStageName;
  status: "success" | "failed" | "skipped";
  output?: Record<string, unknown>;
  errors?: string[];
}

export interface StageUpdate {
  stage: DSLGenerationStageName;
  status: "started" | "completed" | "failed";
  /** First 800 chars of the raw model response (for live display). */
  preview?: string;
  /** Full raw model response text. */
  rawText?: string;
}

export interface DSLGenerationResult {
  success: boolean;
  dsl?: Record<string, unknown>;
  rawJson?: string;
  error?: string;
  stages?: DSLGenerationStage[];
  diagnostics?: ValidationError[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface DSLGenerationOptions {
  apiConfig?: DeepSeekConfig;
  temperature?: number;
  maxTokens?: number;
  staged?: boolean;
  /** Called when each generation stage starts or completes, with raw response previews. */
  onStageUpdate?: (update: StageUpdate) => void;
}

const DEFAULT_OPTIONS = {
  apiConfig: {} as DeepSeekConfig,
  temperature: 0.2,
  maxTokens: 16384,
  staged: true,
} as const;

function resolveOptions(options: DSLGenerationOptions) {
  return { ...DEFAULT_OPTIONS, ...options };
}

const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/g;

function extractJSON(text: string, label = "response"): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Try fenced and embedded JSON below.
  }

  // Try all fenced blocks — use the LAST one (restatement may come before JSON)
  const blockMatches = [...text.matchAll(JSON_BLOCK_RE)];
  for (let i = blockMatches.length - 1; i >= 0; i--) {
    const inner = blockMatches[i][1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // Try next.
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Report the shared extraction error below.
    }
  }

  // Log the raw response so failures can be diagnosed
  const preview = text.length > 600 ? text.slice(0, 600) + "…" : text;
  console.error(
    `[dslGenerator] JSON extraction failed for ${label}. ` +
    `Raw length: ${text.length}. Preview:\n${preview}`
  );
  throw new DeepSeekAPIError(`Could not extract valid JSON from the API response (${label}).`);
}

function validateDSLStructure(dsl: unknown): asserts dsl is Record<string, unknown> {
  if (typeof dsl !== "object" || dsl === null || Array.isArray(dsl)) {
    throw new DeepSeekAPIError("Generated DSL is not a valid JSON object.");
  }

  const obj = dsl as Record<string, unknown>;
  const required = ["version", "world", "objects", "initial_state", "timeline"];
  const missing = required.filter((key) => !(key in obj));
  if (missing.length > 0) {
    throw new DeepSeekAPIError(`Generated DSL is missing required fields: ${missing.join(", ")}`);
  }

  if (!Array.isArray(obj.objects) || obj.objects.length === 0) {
    throw new DeepSeekAPIError("DSL objects must be a non-empty array.");
  }

  if (typeof obj.initial_state !== "object" || obj.initial_state === null) {
    throw new DeepSeekAPIError("DSL initial_state must be an object.");
  }
}

function validateJSONObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeepSeekAPIError(`${label} is not a valid JSON object.`);
  }
}

function addUsage(
  usage: DSLGenerationResult["usage"],
  next: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): DSLGenerationResult["usage"] {
  return {
    promptTokens: (usage?.promptTokens ?? 0) + next.prompt_tokens,
    completionTokens: (usage?.completionTokens ?? 0) + next.completion_tokens,
    totalTokens: (usage?.totalTokens ?? 0) + next.total_tokens,
  };
}

function validationMessages(errors: ValidationError[]): string[] {
  return errors.map((error) => `${error.layer}:${error.path}: ${error.message}`);
}

function emit(
  onStageUpdate: DSLGenerationOptions["onStageUpdate"],
  stage: DSLGenerationStageName,
  status: StageUpdate["status"],
  rawText?: string
) {
  if (!onStageUpdate) return;
  const preview = rawText ? rawText.slice(0, 800) : undefined;
  onStageUpdate({ stage, status, preview, rawText });
}

function validateAndRepairLocally(dsl: Record<string, unknown>): {
  graph: Record<string, unknown>;
  errors: ValidationError[];
} {
  validateDSLStructure(dsl);
  const graph = repairStableConstraintSpec(structuredClone(dsl as unknown as PhysicsGraph)) as unknown as Record<string, unknown>;
  const result = validateGraph(graph);
  return { graph, errors: result.errors };
}

export async function generateDSL(
  problem: string,
  options: DSLGenerationOptions = {}
): Promise<DSLGenerationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const stages: DSLGenerationStage[] = [];
  try {
    const client = createDeepSeekClient(opts.apiConfig);
    let usage: DSLGenerationResult["usage"];

    if (!opts.staged) {
      const response = await client.chat(buildMessages(problem), {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
      usage = addUsage(usage, response.usage);

      const rawJson = extractJSON(client.extractContent(response), "single-shot-DSL");
      const dsl = JSON.parse(rawJson) as Record<string, unknown>;
      const { graph, errors } = validateAndRepairLocally(dsl);
      if (errors.length > 0) {
        throw new DeepSeekAPIError(`Generated DSL failed validation: ${validationMessages(errors).join("; ")}`);
      }

      return { success: true, dsl: graph, rawJson, usage };
    }

    // Multi-turn conversation: messages accumulate across stages.
    let messages = buildConversationStart(problem);

    // Stage 1: Analysis (extract IR)
    emit(opts.onStageUpdate, "analysis", "started");
    const analysisResponse = await client.chat(messages, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    usage = addUsage(usage, analysisResponse.usage);

    const analysisRawContent = client.extractContent(analysisResponse);
    const analysisRawJson = extractJSON(analysisRawContent, "analysis-IR");
    const ir = JSON.parse(analysisRawJson) as Record<string, unknown>;
    validateJSONObject(ir, "Generated IR");
    stages.push({ name: "analysis", status: "success", output: ir });
    emit(opts.onStageUpdate, "analysis", "completed", analysisRawContent);

    // Stage 2: DSL generation (extends conversation with IR context)
    emit(opts.onStageUpdate, "dsl", "started");
    messages = appendDSLRequest(messages, analysisRawContent);
    const dslResponse = await client.chat(messages, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    usage = addUsage(usage, dslResponse.usage);

    const dslRawContent = client.extractContent(dslResponse);
    const rawJson = extractJSON(dslRawContent, "DSL-generation");
    const dsl = JSON.parse(rawJson) as Record<string, unknown>;
    stages.push({ name: "dsl", status: "success", output: dsl });
    emit(opts.onStageUpdate, "dsl", "completed", dslRawContent);

    const initial = validateAndRepairLocally(dsl);
    if (initial.errors.length === 0) {
      stages.push({ name: "validation", status: "success" });
      stages.push({ name: "repair", status: "skipped" });
      return {
        success: true,
        dsl: initial.graph,
        rawJson,
        stages,
        usage,
      };
    }

    stages.push({ name: "validation", status: "failed", errors: validationMessages(initial.errors) });

    // Stage 3: Repair (extends conversation with errors + DSL context)
    emit(opts.onStageUpdate, "repair", "started");
    messages = appendRepairRequest(messages, dslRawContent, initial.errors);
    const repairResponse = await client.chat(messages, {
      temperature: Math.min(opts.temperature, 0.2),
      maxTokens: opts.maxTokens,
    });
    usage = addUsage(usage, repairResponse.usage);

    const repairRawJson = extractJSON(client.extractContent(repairResponse), "DSL-repair");
    const repairedDSL = JSON.parse(repairRawJson) as Record<string, unknown>;
    const repaired = validateAndRepairLocally(repairedDSL);
    if (repaired.errors.length > 0) {
      stages.push({ name: "repair", status: "failed", output: repaired.graph, errors: validationMessages(repaired.errors) });
      return {
        success: false,
        rawJson: repairRawJson,
        error: `Repair failed validation: ${validationMessages(repaired.errors).join("; ")}`,
        stages,
        diagnostics: repaired.errors,
        usage,
      };
    }

    stages.push({ name: "repair", status: "success", output: repaired.graph });
    emit(opts.onStageUpdate, "repair", "completed", client.extractContent(repairResponse));

    return {
      success: true,
      dsl: repaired.graph,
      rawJson: repairRawJson,
      stages,
      usage,
    };
  } catch (error) {
    const message =
      error instanceof DeepSeekAPIError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    if (options.onStageUpdate) {
      // Find the last active stage and mark it as failed
      const lastStarted = stages.length > 0 ? stages[stages.length - 1].name : "analysis";
      emit(options.onStageUpdate, lastStarted as DSLGenerationStageName, "failed", message);
    }

    return { success: false, error: message };
  }
}

export async function repairDSL(
  problem: string,
  dsl: Record<string, unknown>,
  errors: ValidationError[],
  options: DSLGenerationOptions = {}
): Promise<DSLGenerationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const stages: DSLGenerationStage[] = [];
  try {
    const client = createDeepSeekClient(opts.apiConfig);
    let usage: DSLGenerationResult["usage"];
    let ir: Record<string, unknown> | undefined;

    try {
      const analysisResponse = await client.chat(buildAnalysisMessages(problem), {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
      usage = addUsage(usage, analysisResponse.usage);
      const analysisRawJson = extractJSON(client.extractContent(analysisResponse), "repairDSL-analysis-IR");
      ir = JSON.parse(analysisRawJson) as Record<string, unknown>;
      validateJSONObject(ir, "Generated IR");
      stages.push({ name: "analysis", status: "success", output: ir });
    } catch (error) {
      stages.push({
        name: "analysis",
        status: "failed",
        errors: [error instanceof Error ? error.message : "Unknown analysis error"],
      });
    }

    const initial = validateAndRepairLocally(dsl);
    const repairErrors = initial.errors.length > 0 ? initial.errors : errors;
    stages.push({
      name: "validation",
      status: repairErrors.length > 0 ? "failed" : "success",
      errors: validationMessages(repairErrors),
    });

    const repairResponse = await client.chat(buildBoundedRepairMessages(problem, ir, initial.graph, repairErrors), {
      temperature: Math.min(opts.temperature, 0.2),
      maxTokens: opts.maxTokens,
    });
    usage = addUsage(usage, repairResponse.usage);

    const rawJson = extractJSON(client.extractContent(repairResponse), "repairDSL-repair");
    const repairedDSL = JSON.parse(rawJson) as Record<string, unknown>;
    const repaired = validateAndRepairLocally(repairedDSL);
    if (repaired.errors.length > 0) {
      stages.push({ name: "repair", status: "failed", output: repaired.graph, errors: validationMessages(repaired.errors) });
      return {
        success: false,
        rawJson,
        error: `Repair failed validation: ${validationMessages(repaired.errors).join("; ")}`,
        stages,
        diagnostics: repaired.errors,
        usage,
      };
    }

    stages.push({ name: "repair", status: "success", output: repaired.graph });
    return { success: true, dsl: repaired.graph, rawJson, stages, usage };
  } catch (error) {
    const message =
      error instanceof DeepSeekAPIError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    return { success: false, error: message };
  }
}

export function formatDSL(dsl: Record<string, unknown>): string {
  return JSON.stringify(dsl, null, 2);
}
