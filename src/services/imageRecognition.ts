import { createDeepSeekClient, DeepSeekAPIError, type DeepSeekConfig } from "./deepseekClient";

export interface ImageRecognitionResult {
  success: boolean;
  text?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ImageRecognitionOptions {
  apiConfig?: DeepSeekConfig;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_OPTIONS: Required<ImageRecognitionOptions> = {
  apiConfig: {},
  temperature: 0.1,
  maxTokens: 2048,
};

export async function recognizePhysicsProblemImage(
  imageDataUrl: string,
  options: ImageRecognitionOptions = {}
): Promise<ImageRecognitionResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    const client = createDeepSeekClient(opts.apiConfig);
    const response = await client.chat(
      [
        {
          role: "system",
          content: [
            "You read physics problem images and convert them into plain text for a physics visualization DSL generator.",
            "Extract all visible text, equations, labels, values, units, object relationships, and event descriptions.",
            "If the image is a diagram without a written problem, describe the physical scene precisely.",
            "Return only the cleaned problem statement in Chinese when possible. Do not generate DSL JSON.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            { type: "text", text: "请识别这张图片中的物理题设或物理场景，并整理成可用于生成 DSL 的题设文本。" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      }
    );

    return {
      success: true,
      text: client.extractContent(response).trim(),
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
    };
  } catch (error) {
    const message =
      error instanceof DeepSeekAPIError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error";

    return {
      success: false,
      error:
        `${message}\nDeepSeek V4-Pro API 文档当前未明确列出图片/OCR输入能力；如果接口拒绝 image_url，请换用支持视觉的模型或后端 OCR 服务。`,
    };
  }
}
