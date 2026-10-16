import type { Message } from "discord.js";
import {
  buildModelVisibleActions,
  formatAvailableActionsPrompt,
  toLlmTools,
} from "../actions/action-context.js";
import type { ActionContext, ActionRegistry } from "../actions/context.js";
import { dispatchToolCall } from "../actions/tool-calls.js";
import type { ClassifierDecision } from "../classifier/response-classifier.js";
import type { Config } from "../config.js";
import {
  reconstructConversationContext,
  summarizeContext,
} from "../conversation/context.js";
import {
  escapeAttribute,
  escapeTranscriptText,
} from "../conversation/escape.js";
import type { ConversationContextStore } from "../conversation/store.js";
import {
  buildTranscript,
  formatTranscript,
} from "../conversation/transcript.js";
import type { ConversationMessage } from "../conversation/types.js";
import type { DiscordAdapter } from "../discord/adapter.js";
import { stripUnicodeEmoji } from "../discord/no-emoji.js";
import type { PronounProvider } from "../discord/pronouns.js";
import {
  needsSplitHintRepair,
  splitDiscordResponse,
} from "../discord/split.js";
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmTool,
} from "../llm/client.js";
import type { Logger } from "../logger.js";
import {
  type ResponseTranscriptMode,
  buildResponseContextBudget,
  buildResponseMessages,
} from "../prompts/response.js";

const FAILURE_MESSAGE =
  "sorry, brain fog. couldn't get my thoughts into a usable shape. try that again?";
const TYPING_WORDS_PER_MINUTE = 180;
const AVERAGE_WORD_CHARS = 5;
const MIN_FOLLOWUP_TYPING_DELAY_MS = 150;
const MAX_FOLLOWUP_TYPING_DELAY_MS = 12_000;

export type RespondOptions = {
  adapter: DiscordAdapter;
  message: Message;
  botUserId: string;
  config: Config;
  llm: LlmClient;
  logger: Logger;
  contextStore: ConversationContextStore;
  pronounProvider?: PronounProvider | undefined;
  contextMessages?: ConversationMessage[] | undefined;
  classifierDecision?: ClassifierDecision | undefined;
  silentFailure?: boolean | undefined;
  actionContext?: ActionContext | undefined;
  actionRegistry?: ActionRegistry | undefined;
};

export async function respond(options: RespondOptions): Promise<void> {
  const {
    adapter,
    message,
    botUserId,
    config,
    llm,
    logger,
    pronounProvider,
    contextStore,
    contextMessages,
    classifierDecision,
    silentFailure,
    actionContext,
    actionRegistry,
  } = options;
  const log = logger.child({
    messageId: message.id,
    channelId: message.channelId,
  });
  const typing = keepTyping(adapter, message.channelId, log);

  try {
    log.debug(
      { silentFailure: Boolean(silentFailure) },
      "response generation started",
    );
    const chain =
      contextMessages ??
      (await reconstructConversationContext(
        adapter,
        message,
        botUserId,
        log,
        pronounProvider,
        {
          store: contextStore,
          budget: buildResponseContextBudget(
            config,
            getResponseTranscriptMode(message),
          ),
          dmContextMessageLimit: config.dmContextMessageLimit,
          threadContextMessageLimit: config.threadContextMessageLimit,
          guildRecentMessageLimit: config.guildRecentMessageLimit,
        },
      ));
    const transcript = buildTranscript(chain, botUserId);
    const transcriptText = withClassifierDecisionBlock(
      formatTranscript(transcript),
      classifierDecision,
    );

    if (config.debugLogging) {
      log.debug({ transcript: transcriptText }, "built transcript");
    }

    const availableActions = await buildAvailableActions({
      message,
      actionContext,
      actionRegistry,
    });
    const availableActionsPrompt =
      formatAvailableActionsPrompt(availableActions);
    const tools = toLlmTools(availableActions);
    const promptMessages = buildResponseMessages(
      transcriptText,
      getResponseTranscriptMode(message),
      availableActionsPrompt,
    );

    if (config.llmTraceLogging) {
      log.debug(
        {
          context: summarizeContext(chain),
          transcript: transcriptText,
          availableActions,
          nativeTools: tools.map((tool) => tool.function.name),
          promptMessages,
        },
        "llm prompt trace",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);

    try {
      const generated = await generateResponse({
        llm,
        promptMessages,
        signal: controller.signal,
        enableThinking: config.llmEnableThinking,
        thinkingMaxTokens: config.llmThinkingMaxTokens,
        thinkingTimeoutMs: config.llmThinkingTimeoutMs,
        tools,
      });
      const { response } = generated;

      if (response.toolCalls?.length) {
        await executeToolCalls({
          response,
          message,
          actionContext,
          actionRegistry,
          log,
        });
        return;
      }

      const content = await repairMissingSplitHints({
        llm,
        content: generated.content,
        signal: controller.signal,
        log,
      });

      if (config.llmTraceLogging) {
        log.debug(
          { rawResponse: response.raw, sanitizedContent: content },
          "llm response trace",
        );
      } else {
        log.debug(
          { finishReason: response.finishReason, timings: response.timings },
          "llm response complete",
        );
      }

      await sendChunks(
        adapter,
        message,
        content,
        [...transcript.participantUserIds],
        log,
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    log.error({ error }, "failed to generate response");
    if (silentFailure) return;

    const failure = message.inGuild()
      ? message.reply({
          content: FAILURE_MESSAGE,
          allowedMentions: { parse: [], repliedUser: false },
        })
      : adapter.sendMessage(message.channelId, FAILURE_MESSAGE);

    await failure.catch((replyError) => {
      log.error({ error: replyError }, "failed to send failure response");
    });
  } finally {
    typing.stop();
  }
}

function buildAvailableActions(options: {
  message: Message;
  actionContext?: ActionContext | undefined;
  actionRegistry?: ActionRegistry | undefined;
}) {
  if (!options.actionContext || !options.actionRegistry) return [];

  return buildModelVisibleActions({
    message: options.message,
    context: options.actionContext,
    registry: options.actionRegistry,
  });
}

async function repairMissingSplitHints(options: {
  llm: LlmClient;
  content: string;
  signal: AbortSignal;
  log: Logger;
}): Promise<string> {
  if (!needsSplitHintRepair(options.content)) return options.content;

  options.log.debug(
    { contentLength: options.content.length },
    "repairing missing split hints",
  );

  const response = await options.llm.complete({
    messages: [
      {
        role: "system",
        content:
          "Repair Discord output formatting only. Preserve the exact words, order, casing, and punctuation. Replace casual message-separating line breaks or blank lines with literal <split />. If the text is a poem, list, quote, code, or structured markdown, return it unchanged. Output only the repaired text.",
      },
      { role: "user", content: options.content },
    ],
    temperature: 0,
    maxTokens: 768,
    enableThinking: false,
    signal: options.signal,
  });

  const repaired = stripUnicodeEmoji(response.content.trim());
  if (!repaired) return options.content;

  options.log.debug(
    {
      repaired: repaired !== options.content,
      stillNeedsRepair: needsSplitHintRepair(repaired),
      finishReason: response.finishReason,
      timings: response.timings,
    },
    "split hint repair complete",
  );
  return repaired;
}

async function executeToolCalls(options: {
  response: LlmResponse;
  message: Message;
  actionContext?: ActionContext | undefined;
  actionRegistry?: ActionRegistry | undefined;
  log: Logger;
}): Promise<void> {
  if (!options.actionContext || !options.actionRegistry) {
    throw new Error(
      "LLM returned tool calls but action execution is unavailable",
    );
  }

  for (const toolCall of options.response.toolCalls ?? []) {
    options.log.debug(
      {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      "executing LLM tool call action",
    );
    await dispatchToolCall({
      registry: options.actionRegistry,
      context: options.actionContext,
      message: options.message,
      toolCall,
    });
  }
}

function withClassifierDecisionBlock(
  transcript: string,
  decision: ClassifierDecision | undefined,
): string {
  if (!decision) return transcript;

  const block = `<classifier_decision should_respond="${String(decision.shouldRespond)}" confidence="${escapeAttribute(String(decision.confidence))}">\n${escapeTranscriptText(decision.reason)}\n</classifier_decision>`;
  // Per-turn guidance follows history so it cannot invalidate its cached prefix.
  return `${transcript}\n\n${block}`;
}

async function generateResponse(options: {
  llm: LlmClient;
  promptMessages: LlmMessage[];
  signal: AbortSignal;
  enableThinking: boolean;
  thinkingMaxTokens: number;
  thinkingTimeoutMs: number;
  tools: LlmTool[];
}): Promise<{ content: string; response: LlmResponse }> {
  return completeAndSanitize(options.llm, {
    messages: options.promptMessages,
    signal: options.signal,
    enableThinking: options.enableThinking,
    thinkingMaxTokens: options.thinkingMaxTokens,
    thinkingTimeoutMs: options.thinkingTimeoutMs,
    tools: options.tools,
  });
}

async function completeAndSanitize(
  llm: LlmClient,
  request: {
    messages: LlmMessage[];
    signal: AbortSignal;
    enableThinking?: boolean;
    thinkingMaxTokens: number;
    thinkingTimeoutMs: number;
    tools: LlmTool[];
  },
): Promise<{ content: string; response: LlmResponse }> {
  if (!request.enableThinking) {
    return completeAndRequireContent(llm, request);
  }

  const thinkingSignal = withTimeoutSignal(
    request.signal,
    request.thinkingTimeoutMs,
  );

  try {
    const response = await llm.complete({
      ...request,
      maxTokens: request.thinkingMaxTokens,
      signal: thinkingSignal.signal,
      ...(request.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
    });
    if (response.toolCalls?.length) return { content: "", response };
    const content = stripUnicodeEmoji(response.content.trim());
    if (content) return { content, response };

    throw new Error(
      `thinking response returned empty content; finishReason=${response.finishReason ?? "unknown"}; reasoningContentLength=${response.reasoningContent?.length ?? 0}`,
    );
  } catch (error) {
    if (request.signal.aborted) throw error;
    const reason = isAbortError(error) ? "timeout" : "empty_or_failed";
    // Fall back to a no-thinking request so Discord typing does not hang on long reasoning.
    const retry = await llm.complete({
      ...request,
      enableThinking: false,
      ...(request.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
    });
    if (retry.toolCalls?.length) return { content: "", response: retry };
    const retryContent = stripUnicodeEmoji(retry.content.trim());
    if (retryContent) return { content: retryContent, response: retry };

    throw new Error(
      `thinking attempt failed (${reason}) and no-thinking retry returned empty content; finishReason=${retry.finishReason ?? "unknown"}; reasoningContentLength=${retry.reasoningContent?.length ?? 0}`,
    );
  } finally {
    thinkingSignal.cleanup();
  }
}

async function completeAndRequireContent(
  llm: LlmClient,
  request: {
    messages: LlmMessage[];
    signal: AbortSignal;
    enableThinking?: boolean;
    tools: LlmTool[];
  },
): Promise<{ content: string; response: LlmResponse }> {
  const response = await llm.complete({
    ...request,
    ...(request.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
  });
  if (response.toolCalls?.length) return { content: "", response };
  const content = stripUnicodeEmoji(response.content.trim());
  if (content) return { content, response };

  throw new Error(
    `LLM returned empty content; finishReason=${response.finishReason ?? "unknown"}; reasoningContentLength=${response.reasoningContent?.length ?? 0}`,
  );
}

function withTimeoutSignal(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function sendChunks(
  adapter: DiscordAdapter,
  trigger: Message,
  content: string,
  participantUserIds: string[],
  log: Logger,
): Promise<void> {
  const chunks = splitDiscordResponse(content);
  log.debug(
    {
      chunkCount: chunks.length,
      allowedMentionUserCount: participantUserIds.length,
    },
    "sending Discord response chunks",
  );

  if (!trigger.inGuild()) {
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) {
        await waitForFollowupTyping(adapter, trigger.channelId, chunk, log);
      }
      log.debug(
        { index, chunkLength: chunk.length },
        "sending Discord message chunk",
      );
      await adapter.sendMessage(trigger.channelId, chunk, {
        allowedMentionUsers: participantUserIds,
      });
      log.debug({ index }, "sent Discord message chunk");
    }
    return;
  }

  const [first, ...rest] = chunks;
  if (!first) {
    log.warn("no Discord response chunks to send");
    return;
  }

  log.debug(
    { index: 0, chunkLength: first.length },
    "sending Discord reply chunk",
  );
  await adapter.sendReply(
    { channelId: trigger.channelId, messageId: trigger.id },
    first,
    { allowedMentionUsers: participantUserIds },
  );
  log.debug({ index: 0 }, "sent Discord reply chunk");

  for (const [offset, chunk] of rest.entries()) {
    const index = offset + 1;
    await waitForFollowupTyping(adapter, trigger.channelId, chunk, log);
    log.debug(
      { index, chunkLength: chunk.length },
      "sending Discord message chunk",
    );
    await adapter.sendMessage(trigger.channelId, chunk, {
      allowedMentionUsers: participantUserIds,
    });
    log.debug({ index }, "sent Discord message chunk");
  }
}

async function waitForFollowupTyping(
  adapter: DiscordAdapter,
  channelId: string,
  chunk: string,
  log: Logger,
): Promise<void> {
  const delayMs = followupTypingDelayMs(chunk);
  log.debug(
    { channelId, chunkLength: chunk.length, delayMs },
    "waiting before follow-up chunk",
  );
  await adapter
    .sendTyping(channelId)
    .catch((error) =>
      log.warn({ error, channelId }, "failed to send typing indicator"),
    );
  await sleep(delayMs);
}

function followupTypingDelayMs(chunk: string): number {
  const rawDelay =
    (chunk.length * 60_000) / (TYPING_WORDS_PER_MINUTE * AVERAGE_WORD_CHARS);
  return clamp(
    Math.round(rawDelay),
    MIN_FOLLOWUP_TYPING_DELAY_MS,
    MAX_FOLLOWUP_TYPING_DELAY_MS,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getResponseTranscriptMode(message: Message): ResponseTranscriptMode {
  if (!message.inGuild()) return "dm";
  if (message.channel.isThread()) return "thread";
  return "global";
}

function keepTyping(adapter: DiscordAdapter, channelId: string, log: Logger) {
  let stopped = false;

  const send = () => {
    adapter
      .sendTyping(channelId)
      .catch((error) =>
        log.warn({ error, channelId }, "failed to send typing indicator"),
      );
  };

  send();
  const interval = setInterval(() => {
    if (!stopped) send();
  }, 8_000);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}
