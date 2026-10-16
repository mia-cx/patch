import type { DiscordAdapter } from "../discord/adapter.js";
import type { Logger } from "../logger.js";
import type { ConversationMessage } from "./types.js";

const MAX_REPLY_DEPTH = 8;

export async function reconstructReplyChain(
  adapter: DiscordAdapter,
  trigger: ConversationMessage,
  logger: Logger,
  startMessageId?: string,
): Promise<ConversationMessage[]> {
  const messagesById = new Map<string, ConversationMessage>();
  messagesById.set(trigger.id, trigger);

  const chain: ConversationMessage[] = [trigger];
  let current = trigger;

  for (let depth = 0; depth < MAX_REPLY_DEPTH; depth += 1) {
    if (!current.replyTo) break;
    if (
      startMessageId &&
      BigInt(current.replyTo.messageId) < BigInt(startMessageId)
    )
      break;

    const parent = await getMessage(
      adapter,
      current.replyTo.channelId,
      current.replyTo.messageId,
      messagesById,
      logger,
    );
    if (!parent) break;

    chain.push(parent);
    current = parent;
  }

  return [...chain].reverse();
}

async function getMessage(
  adapter: DiscordAdapter,
  channelId: string,
  messageId: string,
  messagesById: Map<string, ConversationMessage>,
  logger: Logger,
): Promise<ConversationMessage | undefined> {
  const cached = messagesById.get(messageId);
  if (cached) return cached;

  try {
    const message = await adapter.fetchMessage({ channelId, messageId });
    messagesById.set(message.id, message);
    return message;
  } catch (error) {
    logger.warn(
      { error, channelId, messageId },
      "failed to fetch reply-chain parent",
    );
    return undefined;
  }
}
