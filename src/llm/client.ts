import type { Config } from "../config.js";
import type { ModelSettingProvider } from "../settings/store.js";
import {
  type RemoraRequest,
  type RemoraResponse,
  parseRemoraCapabilities,
  parseRemoraResponse,
} from "./remora.js";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

export type LlmToolChoice =
  | "auto"
  | "none"
  | {
      type: "function";
      function: { name: string };
    };

export type LlmToolCall = {
  id?: string | undefined;
  type: "function";
  name: string;
  arguments: string;
};

export type LlmRequest = {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  tools?: readonly LlmTool[];
  toolChoice?: LlmToolChoice;
  remora?: RemoraRequest;
  signal?: AbortSignal;
};

export type LlmResponse = {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  toolCalls?: LlmToolCall[];
  timings?: unknown;
  remora?: RemoraResponse;
  raw?: unknown;
};

export class LlmClient {
  private maxOutputTokens = Number.POSITIVE_INFINITY;

  constructor(
    private readonly config: Config,
    private readonly settings?: ModelSettingProvider,
  ) {}

  /** Checks capabilities and bounds shared config/output limits before Discord connects. */
  async initializeRemora() {
    const response = await fetch(
      `${this.config.llmBaseUrl}/remora/capabilities`,
      {
        headers: { Authorization: `Bearer ${this.config.llmApiKey}` },
        signal: AbortSignal.timeout(this.config.llmTimeoutMs),
      },
    );
    if (!response.ok)
      throw new Error(
        `Remora capabilities failed: ${response.status} ${await response.text()}`,
      );
    const capabilities = parseRemoraCapabilities(await response.json());
    const { features, limits } = capabilities;
    if (
      !features.memory ||
      !features.automatic_writes ||
      !features.source_revisions ||
      !features.prefix_cache
    )
      throw new Error(
        "Remora requires memory, automatic writes, source revisions, and prefix caching",
      );
    if (this.config.llmEnableThinking && !features.thinking)
      throw new Error(
        "Remora backend does not support LLM_ENABLE_THINKING=true",
      );
    if (
      this.config.llmTemperature !== 0 &&
      capabilities.backend === "transformers"
    )
      throw new Error("The Remora HF profile requires LLM_TEMPERATURE=0");
    if (
      this.config.activityUpdatesEnabled &&
      capabilities.backend === "transformers"
    )
      throw new Error(
        "The Remora HF profile requires ACTIVITY_UPDATES_ENABLED=false; activity requests use sampling",
      );
    const bankCount = new Set(this.config.remoraReadBanks).size + 1;
    if (
      bankCount > limits.max_read_banks ||
      (bankCount > 1 && !features.multi_bank)
    )
      throw new Error("REMORA_READ_BANKS exceeds backend bank capabilities");
    this.config.llmContextTokens = Math.min(
      this.config.llmContextTokens,
      limits.context_tokens,
    );
    this.maxOutputTokens = limits.max_output_tokens;
    this.config.llmMaxTokens = Math.min(
      this.config.llmMaxTokens,
      limits.max_output_tokens,
    );
    this.config.llmThinkingMaxTokens = Math.min(
      this.config.llmThinkingMaxTokens,
      limits.max_output_tokens,
    );
    return capabilities;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.config.llmBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.config.llmApiKey}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `LLM models request failed: ${response.status} ${response.statusText} ${body}`,
      );
    }

    const json = (await response.json()) as OpenAiModelsResponse;
    return json.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body: LlamaChatCompletionRequest = {
      model: this.settings?.getLlmModel() ?? this.config.llmModel,
      messages: request.messages,
      chat_template_kwargs: {
        enable_thinking:
          request.enableThinking ?? this.config.llmEnableThinking,
      },
      cache_prompt: true,
      temperature: request.temperature ?? this.config.llmTemperature,
      max_tokens: Math.min(
        request.maxTokens ?? this.config.llmMaxTokens,
        this.maxOutputTokens,
      ),
    };
    if (request.tools && request.tools.length > 0)
      body.tools = [...request.tools];
    if (request.toolChoice) body.tool_choice = request.toolChoice;
    if (request.remora) body.remora = request.remora;

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.llmApiKey}`,
      },
      body: JSON.stringify(body),
    };
    if (request.signal) requestInit.signal = request.signal;

    const response = await fetch(
      `${this.config.llmBaseUrl}/chat/completions`,
      requestInit,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `LLM request failed: ${response.status} ${response.statusText} ${body}`,
      );
    }

    const json = (await response.json()) as LlamaChatCompletionResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";

    const result: LlmResponse = { content };
    if (request.remora)
      result.remora = parseRemoraResponse(json.remora, request.remora);
    if (choice?.message?.reasoning_content)
      result.reasoningContent = choice.message.reasoning_content;
    if (choice?.finish_reason) result.finishReason = choice.finish_reason;
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    if (json.timings) result.timings = json.timings;
    result.raw = json;
    return result;
  }
}

type OpenAiModelsResponse = {
  data: Array<{ id?: string }>;
};

type LlamaChatCompletionRequest = {
  model: string;
  messages: LlmMessage[];
  chat_template_kwargs: { enable_thinking: boolean };
  cache_prompt: boolean;
  temperature: number;
  max_tokens: number;
  tools?: LlmTool[] | undefined;
  tool_choice?: LlmToolChoice | undefined;
  remora?: RemoraRequest;
};

type LlamaChatCompletionResponse = {
  remora?: unknown;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: unknown;
    };
  }>;
  timings?: unknown;
};

function parseToolCalls(toolCalls: unknown): LlmToolCall[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.flatMap((toolCall) => {
    if (!toolCall || typeof toolCall !== "object") return [];
    const input = toolCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (input.type !== "function") return [];
    const name = input.function?.name;
    const args = input.function?.arguments;
    if (typeof name !== "string") return [];

    const parsed: LlmToolCall = {
      type: "function",
      name,
      arguments: typeof args === "string" ? args : "{}",
    };
    if (typeof input.id === "string") parsed.id = input.id;
    return [parsed];
  });
}
