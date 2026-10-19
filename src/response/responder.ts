import type { Message } from "discord.js";
import {
  buildModelVisibleActions,
  formatCompactActionsPrompt,
  toLlmTools,
} from "../actions/action-context.js";
import type { ActionContext, ActionRegistry } from "../actions/context.js";
import type { ClassifierDecision } from "../classifier/response-classifier.js";
import type { Config } from "../config.js";
import {
  reconstructConversationContext,
  rolloverConversationContext,
  summarizeContext,
} from "../conversation/context.js";
import {
  escapeAttribute,
  escapeTranscriptText,
} from "../conversation/escape.js";
import {
  ConversationObservations,
  ObservationAttemptInvalidated,
  observationNamespace,
} from "../conversation/observations.js";
import { buildRemoraRequest } from "../conversation/remora.js";
import type { ConversationContextStore } from "../conversation/store.js";
import {
  buildTranscript,
  formatTranscript,
  formatTranscriptMessages,
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
import type { CompletedGeneration } from "../llm/evidence.js";
import type { RemoraRequest } from "../llm/remora.js";
import type { Logger } from "../logger.js";
import {
  RESPONSE_TEMPLATE_TOKEN_MARGIN,
  type ResponseTranscriptMode,
  buildResponseContextBudget,
  buildResponseMessages,
  buildResponseSystemPrompt,
} from "../prompts/response.js";
import {
  OUTPUT_INSTRUCTIONS,
  TAGGED_TOOL_INSTRUCTIONS,
} from "../tools/output.js";
import { runToolTurn } from "../tools/turn.js";

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
  /** Host-owned scope mapping for isolated qualification; never accepted from model arguments. */
  remoraScope?: (message: Message) => RemoraRequest | undefined;
  /** Restrict execution while retaining the complete real tool catalog in the prompt. */
  toolExecutionAllowlist?: ReadonlySet<string>;
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
  if (!contextStore.allowsMessage(message.channelId, message.id)) return;
  const log = logger.child({
    messageId: message.id,
    channelId: message.channelId,
  });
  const typing = keepTyping(adapter, message.channelId, log);
  let observationAttempt: ConversationObservations | undefined;

  try {
    log.debug(
      { silentFailure: Boolean(silentFailure) },
      "response generation started",
    );
    const remora = options.remoraScope
      ? options.remoraScope(message)
      : buildRemoraRequest(config, message);
    let observations: ConversationObservations | undefined;
    if (remora && llm.observationLimits) {
      const store = actionContext?.harness?.store;
      if (!store)
        throw new Error(
          "Evidence formation requires the durable harness store",
        );
      observations = new ConversationObservations({
        store,
        remora,
        message,
        botUserId,
        startId: config.remoraObservationStartId ?? "",
        limits: llm.observationLimits,
        namespace: observationNamespace(config.llmBaseUrl, config.llmApiKey),
      });
    }
    observationAttempt = observations;
    const scopedActionContext = actionContext
      ? { ...actionContext, readBanks: remora?.read_banks ?? [] }
      : undefined;
    const availableActions = await buildAvailableActions({
      message,
      actionContext: scopedActionContext,
      actionRegistry,
    });
    const mode = config.llmToolMode ?? "auto";
    if (mode === "native" && llm.supportsTools === false)
      throw new Error("Backend does not support native tools");
    const tagged =
      mode === "tagged" || (mode === "auto" && llm.supportsTools === false);
    const enabledActions = mode === "off" ? [] : availableActions;
    const actionTools = toLlmTools(enabledActions);
    const tools = tagged ? [] : actionTools;
    const availableActionsPrompt = [
      OUTPUT_INSTRUCTIONS,
      ...(tagged && actionTools.length ? [TAGGED_TOOL_INSTRUCTIONS] : []),
      formatCompactActionsPrompt(enabledActions),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (remora) contextStore.recordMemoryContext(message.channelId);
    const budget = buildResponseContextBudget(
      config,
      getResponseTranscriptMode(message),
      remora !== undefined,
      availableActionsPrompt,
      tools,
    );
    const chain = contextMessages
      ? rolloverConversationContext(contextMessages, budget)
      : await reconstructConversationContext(
          adapter,
          message,
          botUserId,
          log,
          pronounProvider,
          {
            store: contextStore,
            budget,
            dmContextMessageLimit: config.dmContextMessageLimit,
            threadContextMessageLimit: config.threadContextMessageLimit,
            guildRecentMessageLimit: config.guildRecentMessageLimit,
          },
        );
    // The classifier assembled history before tool discovery; apply the final budget too.
    if (contextMessages && chain.length !== contextMessages.length) {
      const start = chain[0]?.id;
      const previous = contextStore.getStart(message.channelId);
      if (start && (!previous || BigInt(start) > BigInt(previous)))
        contextStore.setStart(message.channelId, start);
    }
    if (chain.length === 0) return;
    const transcript = buildTranscript(chain, botUserId);
    const history = remora
      ? {
          ...transcript,
          blocks: transcript.blocks.filter((block) => block.id !== message.id),
        }
      : transcript;
    const transcriptText = withClassifierDecisionBlock(
      formatTranscript(history),
      classifierDecision,
    );

    if (config.debugLogging) {
      log.debug({ transcript: transcriptText }, "built transcript");
    }

    const promptTranscript = remora
      ? formatTranscriptMessages(
          transcript,
          message.id,
          observations ? (block) => observations.humanSource(block) : undefined,
          observations
            ? (block) => observations.assistantBody(block)
            : undefined,
        )
      : transcriptText;
    if (Array.isArray(promptTranscript) && classifierDecision) {
      promptTranscript.push({
        role: "user",
        content: withClassifierDecisionBlock("", classifierDecision),
        observationUnknown: [
          {
            start: 0,
            end: withClassifierDecisionBlock("", classifierDecision).length,
          },
        ],
      });
    }
    const promptMessages = buildResponseMessages(
      promptTranscript,
      getResponseTranscriptMode(message),
      availableActionsPrompt,
      remora?.turn?.text,
    );
    if (observations)
      promptMessages[promptMessages.length - 1] = observations.currentMessage();

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
      const generated = await runToolTurn({
        messages: promptMessages,
        message,
        ...(scopedActionContext ? { context: scopedActionContext } : {}),
        ...(actionRegistry ? { registry: actionRegistry } : {}),
        visibleMessageIds: new Set([
          message.id,
          ...chain
            .filter((item) => item.channelId === message.channelId)
            .map((item) => item.id),
        ]),
        allowedTools: new Set(
          actionTools
            .map((tool) => tool.function.name)
            .filter(
              (name) => options.toolExecutionAllowlist?.has(name) ?? true,
            ),
        ),
        maxCalls: config.maxToolCalls ?? 3,
        maxInputChars: Math.max(
          0,
          (budget.contextTokens -
            (budget.responseTokens ?? 0) -
            RESPONSE_TEMPLATE_TOKEN_MARGIN) *
            4,
        ),
        nativeTools: tools,
        native: !tagged,
        signal: controller.signal,
        ...(observations
          ? { assertCurrent: () => observations.assertCurrent() }
          : {}),
        generate: async (messages, continuation, remainingCalls) => {
          // Keep the full persona. At exhaustion remove only the tool advertisement.
          const requestMessages: LlmMessage[] = continuation
            ? [
                {
                  role: "system",
                  content: buildResponseSystemPrompt(
                    getResponseTranscriptMode(message),
                    remainingCalls
                      ? availableActionsPrompt
                      : OUTPUT_INSTRUCTIONS,
                    "before-tools",
                  ),
                },
                ...messages.slice(1),
              ]
            : messages;
          const requestRemora = observations
            ? observations.request(requestMessages)
            : continuation && remora
              ? readOnlyRemora(remora)
              : remora;
          const result = await generateResponse({
            llm,
            promptMessages: requestMessages,
            signal: controller.signal,
            enableThinking: config.llmEnableThinking,
            thinkingMaxTokens: config.llmThinkingMaxTokens,
            thinkingTimeoutMs: config.llmThinkingTimeoutMs,
            tools: remainingCalls ? tools : [],
            ...(observations
              ? {
                  onResponse: (response: LlmResponse) => {
                    observations.capture(response, requestRemora?.observations);
                  },
                  beforeRequest: () => observations.assertCurrent(),
                }
              : {}),
            ...(requestRemora ? { remora: requestRemora } : {}),
          });
          return result.response;
        },
        onResponse(response) {
          if (!response.remora) return undefined;
          const receipt = response.remora.writes;
          if (receipt?.result.error) {
            log.warn(
              { remora: response.remora },
              "Remora automatic write failed",
            );
          } else {
            log.info({ remora: response.remora }, "Remora response received");
          }
          return observations?.capture(response);
        },
      });
      if (!generated.content) return;

      const repaired = await repairMissingSplitHints({
        llm,
        content: stripUnicodeEmoji(generated.content.trim()),
        signal: controller.signal,
        log,
        ...(observations ? { observations } : {}),
        ...(generated.generatedSource
          ? { source: generated.generatedSource }
          : {}),
      });
      observations?.assertCurrent();
      const content = repaired.content;

      if (config.llmTraceLogging) {
        log.debug({ sanitizedContent: content }, "llm response trace");
      } else {
        log.debug(
          { sourceCount: generated.sources.length },
          "llm response complete",
        );
      }

      const displayedParent = repaired.source;
      await sendChunks(
        adapter,
        message,
        withSources(content, generated.sources),
        [...transcript.participantUserIds],
        log,
        generated.replyTo,
        observations && displayedParent
          ? (sent) => observations.associate(sent, displayedParent)
          : undefined,
        observations ? () => observations.assertCurrent() : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (
      error instanceof ObservationAttemptInvalidated ||
      observationAttempt?.isCurrent() === false
    )
      return;
    log.error({ error }, "failed to generate response");
    if (silentFailure) return;

    const failure = adapter.sendMessage(message.channelId, FAILURE_MESSAGE);

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
  observations?: ConversationObservations;
  source?: CompletedGeneration;
}): Promise<{ content: string; source?: CompletedGeneration }> {
  if (!needsSplitHintRepair(options.content))
    return {
      content: options.content,
      ...(options.source ? { source: options.source } : {}),
    };

  options.log.debug(
    { contentLength: options.content.length },
    "repairing missing split hints",
  );

  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        "Repair Discord output formatting only. Preserve the exact words, order, casing, and punctuation. Replace casual message-separating line breaks or blank lines with literal <split />. If the text is a poem, list, quote, code, or structured markdown, return it unchanged. Output only the repaired text.",
    },
    { role: "user", content: options.content },
  ];
  const remora = options.observations
    ? options.observations.transformation(messages, options.source)
    : undefined;
  const response = await options.llm.complete({
    messages,
    temperature: 0,
    maxTokens: 768,
    enableThinking: false,
    signal: options.signal,
    ...(options.observations
      ? { beforeRequest: () => options.observations?.assertCurrent() }
      : {}),
    ...(remora
      ? {
          remora,
          onResponse: (reply: LlmResponse) => {
            options.observations?.capture(reply, remora.observations);
          },
        }
      : {}),
  });

  const repaired = stripUnicodeEmoji(response.content.trim());
  if (!repaired)
    return {
      content: options.content,
      ...(options.source ? { source: options.source } : {}),
    };

  options.log.debug(
    {
      repaired: repaired !== options.content,
      stillNeedsRepair: needsSplitHintRepair(repaired),
      finishReason: response.finishReason,
      timings: response.timings,
    },
    "split hint repair complete",
  );
  const source = remora ? options.observations?.capture(response) : undefined;
  return { content: repaired, ...(source ? { source } : {}) };
}

/** Follow-up reads retain speaker and recall policy without re-observing the human source. */
function readOnlyRemora(remora: RemoraRequest): RemoraRequest {
  const speaker =
    remora.speaker ??
    (remora.write_bank && remora.turn
      ? { bank: remora.write_bank, id: remora.turn.speaker_id }
      : undefined);
  return {
    read_banks: remora.read_banks,
    ...(speaker ? { speaker } : {}),
    ...(remora.recall ? { recall: remora.recall } : {}),
  };
}

function withSources(
  content: string,
  sources: Array<{ title: string; url: string; kind: string }>,
) {
  const missing = sources.filter((source) => !content.includes(source.url));
  if (!missing.length) return content;
  const links = missing.map(
    (source) =>
      `[${source.title.replaceAll(/[\[\]\\\r\n]/g, " ").slice(0, 90)}](${source.url.replaceAll("(", "%28").replaceAll(")", "%29")})${source.kind === "search" ? " (search)" : ""}`,
  );
  return `${content}\n\nSources: ${links.join(" · ")}`;
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
  remora?: RemoraRequest;
  onResponse?: (response: LlmResponse) => void;
  beforeRequest?: () => void;
}): Promise<{ content: string; response: LlmResponse }> {
  return completeAndSanitize(options.llm, {
    messages: options.promptMessages,
    signal: options.signal,
    enableThinking: options.enableThinking,
    thinkingMaxTokens: options.thinkingMaxTokens,
    thinkingTimeoutMs: options.thinkingTimeoutMs,
    tools: options.tools,
    ...(options.remora ? { remora: options.remora } : {}),
    ...(options.onResponse ? { onResponse: options.onResponse } : {}),
    ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
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
    remora?: RemoraRequest;
    onResponse?: (response: LlmResponse) => void;
    beforeRequest?: () => void;
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
    const content = response.content.trim();
    if (content) return { content, response };

    throw new Error(
      `thinking response returned empty content; finishReason=${response.finishReason ?? "unknown"}; reasoningContentLength=${response.reasoningContent?.length ?? 0}`,
    );
  } catch (error) {
    if (error instanceof ObservationAttemptInvalidated) throw error;
    if (request.signal.aborted) throw error;
    const reason = isAbortError(error) ? "timeout" : "empty_or_failed";
    // Fall back to a no-thinking request so Discord typing does not hang on long reasoning.
    const retry = await llm.complete({
      ...request,
      enableThinking: false,
      ...(request.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
    });
    if (retry.toolCalls?.length) return { content: "", response: retry };
    const retryContent = retry.content.trim();
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
    remora?: RemoraRequest;
  },
): Promise<{ content: string; response: LlmResponse }> {
  const response = await llm.complete({
    ...request,
    ...(request.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
  });
  if (response.toolCalls?.length) return { content: "", response };
  const content = response.content.trim();
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
  replyTo?: string,
  onSent?: (message: ConversationMessage) => void,
  assertCurrent?: () => void,
): Promise<void> {
  const chunks = splitDiscordResponse(content);
  log.debug(
    {
      chunkCount: chunks.length,
      allowedMentionUserCount: participantUserIds.length,
    },
    "sending Discord response chunks",
  );

  if (!replyTo) {
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) {
        await waitForFollowupTyping(adapter, trigger.channelId, chunk, log);
      }
      log.debug(
        { index, chunkLength: chunk.length },
        "sending Discord message chunk",
      );
      assertCurrent?.();
      const sent = await adapter.sendMessage(trigger.channelId, chunk, {
        allowedMentionUsers: participantUserIds,
      });
      onSent?.(sent);
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
  try {
    assertCurrent?.();
    const sent = await adapter.sendReply(
      { channelId: trigger.channelId, messageId: replyTo },
      first,
      { allowedMentionUsers: participantUserIds },
    );
    onSent?.(sent);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 10008
      )
    )
      throw error;
    assertCurrent?.();
    const sent = await adapter.sendMessage(trigger.channelId, first, {
      allowedMentionUsers: participantUserIds,
    });
    onSent?.(sent);
  }
  log.debug({ index: 0 }, "sent Discord reply chunk");

  for (const [offset, chunk] of rest.entries()) {
    const index = offset + 1;
    await waitForFollowupTyping(adapter, trigger.channelId, chunk, log);
    log.debug(
      { index, chunkLength: chunk.length },
      "sending Discord message chunk",
    );
    assertCurrent?.();
    const sent = await adapter.sendMessage(trigger.channelId, chunk, {
      allowedMentionUsers: participantUserIds,
    });
    onSent?.(sent);
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
