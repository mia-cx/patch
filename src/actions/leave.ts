import {
  MessageFlags,
  type MessageMentionOptions,
  type ThreadChannel,
} from "discord.js";
import { Schema } from "effect";
import { discordSlashCommandProviderId, slashCommand } from "protocord";
import {
  buildTranscript,
  formatTranscript,
} from "../conversation/transcript.js";
import { toConversationMessage } from "../discord/discord-js-adapter.js";
import { stripUnicodeEmoji } from "../discord/no-emoji.js";
import { splitDiscordResponse } from "../discord/split.js";
import { getBotIdentity } from "../identity.js";
import { askLlm } from "../llm/ask.js";
import type { LlmResponse } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { buildLeaveMessages } from "../prompts/leave.js";
import {
  type Action,
  type ActionContext,
  type ActionInvocation,
  actionInput,
} from "./context.js";
import { isSlashInteraction } from "./permissions.js";
import { toolCall } from "./tool-calls.js";

const LEAVE_COMMAND_NAME = "leave";
const LEAVE_MAX_TOKENS = 96;
const LEAVE_CONTEXT_MESSAGE_LIMIT = 10;
const NO_MENTIONS: MessageMentionOptions = {
  parse: [],
  users: [],
  roles: [],
  repliedUser: false,
};

const Farewell = Schema.String.annotate({
  description:
    "Exact Discord-visible farewell to send before leaving. May include <split /> for multiple Discord messages.",
});
const LeaveThreadArgs = Schema.Struct({ farewell: Schema.optional(Farewell) });
type LeaveInvocation = ActionInvocation<typeof LeaveThreadArgs.Type>;

export const leaveThreadAction: Action<typeof LeaveThreadArgs.Type> = {
  name: "leave_thread",
  description: "Say goodbye and leave the current thread.",
  input: actionInput(LeaveThreadArgs),
  triggers: [
    slashCommand({
      name: LEAVE_COMMAND_NAME,
      description: `Have ${getBotIdentity().name} say goodbye and leave this thread`,
      usage: "/leave",
      registration: { dmPermission: false },
      acknowledgement: "none",
      parse: () => ({}),
      async present(outcome, interaction) {
        if (outcome.status === "executed") return;
        const content =
          outcome.status === "failed"
            ? "couldn't leave cleanly. staying put."
            : outcome.reason;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content,
            allowedMentions: NO_MENTIONS,
          });
        } else {
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        }
      },
    }),
    toolCall({
      name: "leave_thread",
      description: "Send a farewell message, then leave the current thread.",
      usage:
        "Use when the latest user asks Patch to leave, exit, go away, stop participating, or otherwise remove herself from the current thread. Put the exact Discord-visible farewell in farewell.",
      input: actionInput(Schema.Struct({ farewell: Farewell })),
    }),
  ],
  availability(context) {
    if (!context.channel?.isThread()) {
      return { available: false, reason: "only available in threads" };
    }
    return { available: true };
  },
  authorization: () => undefined,
  async execute(invocation, context) {
    const botUserId = context.client.user?.id;
    if (!botUserId) throw new Error("Bot user is not ready");

    if (!invocation.channelId)
      throw new Error("leave_thread requires a channel");
    const channel = await context.client.channels.fetch(invocation.channelId);
    if (!channel?.isThread()) {
      throw new Error("leave_thread only works in threads");
    }

    if (invocation.source === discordSlashCommandProviderId) {
      const interaction = invocation.rawEvent;
      if (!isSlashInteraction(interaction))
        throw new Error("Expected a slash interaction");
      await interaction.deferReply();
      await context.queue.add(
        () => runSlashLeave(channel, { ...context, invocation, botUserId }),
        { priority: "leave", bucketKey: channel.id },
      );
      return;
    }

    const { farewell } = invocation.input;
    if (farewell === undefined)
      throw new Error("leave_thread requires a farewell");
    await leaveThread(channel, { ...context, invocation, botUserId, farewell });
  },
};

async function runSlashLeave(
  thread: ThreadChannel,
  options: ActionContext & { invocation: LeaveInvocation; botUserId: string },
): Promise<void> {
  const farewell = await generateSlashFarewell(thread, options);
  await leaveThread(thread, { ...options, farewell });
}

async function generateSlashFarewell(
  thread: ThreadChannel,
  options: ActionContext & { invocation: LeaveInvocation; botUserId: string },
): Promise<string> {
  const log = options.logger.child({
    channelId: thread.id,
    guildId: thread.guildId,
    operation: "leave-thread-farewell",
  });
  const transcript = await buildLeaveTranscript(
    thread,
    options.botUserId,
    cutoffTimestamp(options.invocation),
    log,
    options.config.threadContextMessageLimit,
  );
  return generateFarewell({
    ...options,
    transcript,
    requester: options.invocation.requester ?? {
      id: "unknown",
      name: "someone",
    },
  });
}

async function leaveThread(
  thread: ThreadChannel,
  options: ActionContext & {
    invocation: LeaveInvocation;
    botUserId: string;
    farewell: string;
  },
): Promise<void> {
  const log = options.logger.child({
    channelId: thread.id,
    guildId: thread.guildId,
    operation: "leave-thread",
  });

  await sendFarewell(
    options.invocation,
    thread,
    sanitizeFarewell(options.farewell),
    log,
  );
  await thread.leave();
}

function cutoffTimestamp(invocation: LeaveInvocation): number {
  if (isSlashInteraction(invocation.rawEvent))
    return invocation.rawEvent.createdTimestamp;
  return Date.now();
}

function sanitizeFarewell(farewell: string): string {
  const sanitized = stripUnicodeEmoji(farewell.trim());
  if (!sanitized) throw new Error("leave_thread farewell cannot be empty");
  return sanitized;
}

async function sendFarewell(
  invocation: LeaveInvocation,
  thread: ThreadChannel,
  farewell: string,
  log: Logger,
): Promise<void> {
  const [first, ...rest] = splitDiscordResponse(farewell);
  if (!first) throw new Error("leave farewell split into no chunks");

  log.debug({ chunkCount: rest.length + 1 }, "sending leave farewell chunks");
  const interaction = invocation.rawEvent;
  if (isSlashInteraction(interaction)) {
    await interaction.editReply({
      content: first,
      allowedMentions: NO_MENTIONS,
    });
  } else {
    await thread.send({ content: first, allowedMentions: NO_MENTIONS });
  }

  for (const [offset, chunk] of rest.entries()) {
    const index = offset + 1;
    log.debug(
      { index, chunkLength: chunk.length },
      "sending leave follow-up chunk",
    );
    await thread.send({ content: chunk, allowedMentions: NO_MENTIONS });
  }
}

async function buildLeaveTranscript(
  thread: ThreadChannel,
  botUserId: string,
  beforeTimestamp: number,
  log: Logger,
  configuredLimit: number,
): Promise<string> {
  const limit = Math.min(LEAVE_CONTEXT_MESSAGE_LIMIT, configuredLimit);

  try {
    const fetched = await thread.messages.fetch({ limit });
    const messages = [...fetched.values()]
      .filter((message) => message.createdTimestamp <= beforeTimestamp)
      .sort((left, right) => {
        const timestampDelta = left.createdTimestamp - right.createdTimestamp;
        if (timestampDelta !== 0) return timestampDelta;
        return left.id.localeCompare(right.id);
      })
      .map((message) => ({
        ...toConversationMessage(message, botUserId),
        context: "thread" as const,
      }));

    const transcript = formatTranscript(buildTranscript(messages, botUserId));
    log.debug(
      { messageCount: messages.length, transcript },
      "built leave transcript",
    );
    return transcript || "(no recent thread messages)";
  } catch (error) {
    log.warn({ error }, "failed to build leave transcript");
    return "(recent thread messages unavailable)";
  }
}

async function generateFarewell(options: {
  config: ActionContext["config"];
  llm: ActionContext["llm"];
  logger: ActionContext["logger"];
  transcript: string;
  requester: { id: string; name: string };
}): Promise<string> {
  return askLlm({
    llm: options.llm,
    logger: options.logger,
    label: "leave-thread-farewell",
    messages: buildLeaveMessages(options.requester, options.transcript),
    maxTokens: LEAVE_MAX_TOKENS,
    enableThinking: false,
    timeoutMs: options.config.llmTimeoutMs,
    parse: parseFarewellResponse,
  });
}

function parseFarewellResponse(response: LlmResponse): string {
  const content = stripUnicodeEmoji(response.content.trim());
  if (!content) {
    throw new Error(
      `LLM returned empty leave farewell; finishReason=${response.finishReason ?? "unknown"}; reasoningContentLength=${response.reasoningContent?.length ?? 0}`,
    );
  }
  return content;
}
