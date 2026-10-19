import { ChannelType, type Message } from "discord.js";
import { Schema } from "effect";
import type { Config } from "../config.js";
import { summarizeContext } from "../conversation/context.js";
import type { ConversationMessage } from "../conversation/types.js";
import type { Logger } from "../logger.js";
import {
  type ClassifierPromptContext,
  buildClassifierQuestion,
} from "../prompts/classifier.js";

const CLASSIFIER_CONTEXT_TOKENS = 8192;
const CLASSIFIER_QUESTION_TOKENS = 512;
const SystemOneResponse = Schema.Struct({
  answers: Schema.Struct({
    response: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.Literals(["respond", "dont respond"]),
      answer_confidence: Schema.Number.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(1),
      ),
      abstention: Schema.optional(
        Schema.Literals(["passed", "abstained", "unevaluated"]),
      ),
    }),
  }),
  // A decision over a silently clipped conversation is unusable.
  usage: Schema.Struct({ truncated: Schema.Literal(false) }),
});

export type ClassifierDecision = {
  shouldRespond: boolean;
  confidence: number;
  reason: string;
};

/** Classify reply timing with Laya; failures abstain without calling the response model. */
export async function classifyShouldRespond(options: {
  message: Message;
  botUserId: string;
  config: Pick<
    Config,
    | "classifierBaseUrl"
    | "classifierApiKey"
    | "classifierModel"
    | "classifierTimeoutMs"
  >;
  logger: Logger;
  llmTraceLogging: boolean;
  contextMessages: ConversationMessage[];
}): Promise<ClassifierDecision> {
  const {
    message,
    botUserId,
    config,
    logger,
    llmTraceLogging,
    contextMessages,
  } = options;
  const log = logger.child({
    messageId: message.id,
    channelId: message.channelId,
    operation: "response-classifier",
  });

  const started = performance.now();
  try {
    const promptContext = buildClassifierPromptContext(message, botUserId);
    const question = buildClassifierQuestion(contextMessages, promptContext);
    if (llmTraceLogging) {
      log.debug(
        {
          context: summarizeContext(contextMessages),
          classifierContext: promptContext,
          question,
        },
        "classifier prompt trace",
      );
    }
    const response = await fetch(`${config.classifierBaseUrl}/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.classifierApiKey
          ? { Authorization: `Bearer ${config.classifierApiKey}` }
          : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(config.classifierTimeoutMs),
      body: JSON.stringify({
        model: config.classifierModel,
        max_len: CLASSIFIER_CONTEXT_TOKENS,
        head_max_len: CLASSIFIER_QUESTION_TOKENS,
        ...question,
      }),
    });
    if (!response.ok)
      throw new Error(`System 1 classifier returned HTTP ${response.status}`);
    const { answers } = Schema.decodeUnknownSync(SystemOneResponse)(
      await response.json(),
    );
    const answer = answers.response;
    const decision = {
      shouldRespond:
        answer.abstention !== "abstained" && answer.choice === "respond",
      // This is the winning option's probability, not Laya's entropy-based confidence. No calibration threshold is assumed.
      confidence: answer.answer_confidence,
      reason: answer.abstention === "abstained" ? "abstained" : answer.choice,
    };
    log.debug(
      {
        decision,
        model: config.classifierModel,
        elapsedMs: performance.now() - started,
      },
      "classifier decision",
    );
    return decision;
  } catch (error) {
    log.warn(
      { error, elapsedMs: performance.now() - started },
      "System 1 classifier unavailable; remaining silent",
    );
    return {
      shouldRespond: false,
      confidence: 0,
      reason: "classifier unavailable",
    };
  }
}

function buildClassifierPromptContext(
  message: Message,
  botUserId: string,
): ClassifierPromptContext {
  const channelName =
    "name" in message.channel ? message.channel.name : undefined;
  const replyToMessageId = message.reference?.messageId;

  return {
    triggerKind: message.inGuild() ? "passive_guild_message" : "dm_message",
    location: classifyLocation(message),
    botUserId,
    latestMessage: {
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.displayName,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      userMentionCount: message.mentions.users.size,
      roleMentionCount: message.mentions.roles.size,
      mentionsEveryone: message.mentions.everyone,
      attachmentCount: message.attachments.size,
    },
    channel: {
      id: message.channelId,
      type: ChannelType[message.channel.type] ?? String(message.channel.type),
      ...(channelName ? { name: channelName } : {}),
    },
  };
}

function classifyLocation(
  message: Message,
): ClassifierPromptContext["location"] {
  if (!message.inGuild()) return "dm";
  return message.channel.isThread() ? "guild_thread" : "guild_channel";
}
