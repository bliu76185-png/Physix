export { createDeepSeekClient, DeepSeekAPIError } from "./deepseekClient";
export type {
  ChatChoice,
  ChatMessage,
  ChatResponse,
  ChatUsage,
  DeepSeekClient,
  DeepSeekConfig,
  MessageRole,
} from "./deepseekClient";

export { buildMessages, buildSystemPrompt, buildUserPrompt, buildUnifiedSystemPrompt, buildConversationStart, appendDSLRequest, appendRepairRequest } from "./schemaPrompt";
export { formatDSL, generateDSL, repairDSL } from "./dslGenerator";
export type { DSLGenerationOptions, DSLGenerationResult, DSLGenerationStage, DSLGenerationStageName, StageUpdate } from "./dslGenerator";
export { recognizePhysicsProblemImage } from "./imageRecognition";
export type { ImageRecognitionOptions, ImageRecognitionResult } from "./imageRecognition";
export { archiveGeneration } from "./generationArchive";
export type { ArchiveGenerationPayload, ArchiveGenerationResult } from "./generationArchive";
