export interface DeepSeekConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  /** Disable extended thinking/reasoning (for GLM/Qwen models that default to on) */
  disableThinking?: boolean;
}

export type MessageRole = "system" | "user" | "assistant";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: MessageRole;
  content: string | ChatContentPart[];
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: ChatUsage;
}

export interface DeepSeekError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export class DeepSeekAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public apiError?: DeepSeekError
  ) {
    super(message);
    this.name = "DeepSeekAPIError";
  }
}

const defaultConfig: Required<Omit<DeepSeekConfig, "apiKey">> = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  timeout: 120_000,
  maxRetries: 3,
  temperature: 0.3,
  maxTokens: 8192,
  disableThinking: false,
};

export function createDeepSeekClient(config: DeepSeekConfig = {}) {
  const merged = { ...defaultConfig, ...config };
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";

  if (!apiKey) {
    throw new DeepSeekAPIError(
      "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or pass config.apiKey."
    );
  }

  async function chat(
    messages: ChatMessage[],
    overrides: Partial<Pick<DeepSeekConfig, "temperature" | "maxTokens" | "model">> = {}
  ): Promise<ChatResponse> {
    const url = `${merged.baseUrl}/chat/completions`;
    const body = {
      model: overrides.model ?? merged.model,
      messages,
      temperature: overrides.temperature ?? merged.temperature,
      max_tokens: overrides.maxTokens ?? merged.maxTokens,
      stream: false,
    };
    if (merged.disableThinking) {
      (body as Record<string, unknown>).thinking = { type: "disabled" };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= merged.maxRetries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), merged.timeout);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const apiError = errorBody as DeepSeekError;
          const message = apiError.error?.message ?? `HTTP ${response.status}`;
          throw new DeepSeekAPIError(message, response.status, apiError);
        }

        const data = (await response.json()) as ChatResponse;
        if (!data.choices || data.choices.length === 0) {
          throw new DeepSeekAPIError("API returned an empty choices array.");
        }

        return data;
      } catch (error) {
        lastError = error as Error;
        if (error instanceof DeepSeekAPIError && error.statusCode && error.statusCode < 500) {
          throw error;
        }

        if (attempt < merged.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
        }
      }
    }

    throw new DeepSeekAPIError(
      `Request failed after ${merged.maxRetries} retries: ${lastError?.message ?? "unknown error"}`
    );
  }

  function extractContent(response: ChatResponse): string {
    const choice = response.choices[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content) {
      const finishReason = choice?.finish_reason ?? "no-choice";
      console.error(
        `[deepseekClient] Empty response content. ` +
        `finish_reason=${finishReason}, ` +
        `model=${response.model}, ` +
        `usage={prompt:${response.usage?.prompt_tokens}, completion:${response.usage?.completion_tokens}}`
      );
      throw new DeepSeekAPIError(`API response did not include message content (finish_reason: ${finishReason}).`);
    }
    return content;
  }

  return { chat, extractContent };
}

export type DeepSeekClient = ReturnType<typeof createDeepSeekClient>;
