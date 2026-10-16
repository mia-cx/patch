import type { Message } from "discord.js";
import type { DiscordAdapter } from "../discord/adapter.js";
import { toConversationMessage } from "../discord/discord-js-adapter.js";
import type { PronounProvider } from "../discord/pronouns.js";
import type { Logger } from "../logger.js";
import { reconstructReplyChain } from "./reply-chain.js";
import type { ConversationContextStore } from "./store.js";
import type { ConversationMessage, TranscriptContext } from "./types.js";

const DEFAULT_DM_CONTEXT_MESSAGE_LIMIT = 30;
const DEFAULT_THREAD_CONTEXT_MESSAGE_LIMIT = 30;
const DEFAULT_GUILD_RECENT_MESSAGE_LIMIT = 10;
const TRANSCRIPT_METADATA_CHARS_PER_MESSAGE = 450;
const DISCORD_HISTORY_PAGE_SIZE = 100;
const CONTEXT_RETAIN_RATIO = 0.5;

export type ContextBudget = {
  contextTokens: number;
  promptTokens: number;
  responseTokens?: number;
};

export type ConversationContextOptions = {
  store: ConversationContextStore;
  budget: ContextBudget;
  dmContextMessageLimit?: number;
  threadContextMessageLimit?: number;
  guildRecentMessageLimit?: number;
};

/** Rebuilds the active chat from its persisted boundary, resetting only when full. */
export async function reconstructConversationContext(
  adapter: DiscordAdapter,
  message: Message,
  botUserId: string,
  log: Logger,
  pronounProvider: PronounProvider | undefined,
  options: ConversationContextOptions,
): Promise<ConversationMessage[]> {
  const trigger = toConversationMessage(message, botUserId);
  const storedStart = options.store.getStart(message.channelId);
  // An edit to an older message gets its own view, without rewinding this chat.
  const historicalTrigger =
    storedStart !== undefined && BigInt(trigger.id) < BigInt(storedStart);
  const start = historicalTrigger ? undefined : storedStart;
  const initialLimit = !message.inGuild()
    ? (options.dmContextMessageLimit ?? DEFAULT_DM_CONTEXT_MESSAGE_LIMIT)
    : message.channel.isThread()
      ? (options.threadContextMessageLimit ??
        DEFAULT_THREAD_CONTEXT_MESSAGE_LIMIT)
      : (options.guildRecentMessageLimit ?? DEFAULT_GUILD_RECENT_MESSAGE_LIMIT);
  const recent = await fetchChannelContext(
    message,
    botUserId,
    initialLimit,
    options.budget,
    start,
  );
  let messages: ConversationMessage[];

  if (!message.inGuild()) {
    const botReplyChain = await fetchBotReplyChain(
      adapter,
      trigger,
      botUserId,
      log,
    );

    messages = [...recent, ...botReplyChain];
  } else if (message.channel.isThread()) {
    const botReplyChain = withContext(
      await fetchBotReplyChain(adapter, trigger, botUserId, log),
      "thread",
    );

    messages = [...withContext(recent, "thread"), ...botReplyChain];
  } else {
    const replyChain = message.reference?.messageId
      ? await reconstructReplyChain(adapter, trigger, log)
      : [trigger];
    messages = [
      ...withContext(recent, "neighbor"),
      ...withContext(replyChain, "reply_chain"),
    ];
  }

  const canonical = canonicalizeContextMessages(
    messages.filter((item) => !start || BigInt(item.id) >= BigInt(start)),
    trigger.id,
  );
  const enriched = await addAuthorPronouns(
    canonical,
    pronounProvider,
    message.guildId ?? undefined,
  );
  const selected = rolloverConversationContext(enriched, options.budget);
  const nextStart = selected[0]?.id;
  if (nextStart && !historicalTrigger && nextStart !== storedStart) {
    options.store.setStart(message.channelId, nextStart);
  }
  if (selected.length !== enriched.length) {
    log.info(
      {
        previousStart: storedStart,
        nextStart,
        before: enriched.length,
        after: selected.length,
      },
      "reset conversation context at token budget",
    );
  }
  return selected;
}

export function limitContextMessages(
  messages: ConversationMessage[],
  limit: number,
): ConversationMessage[] {
  if (messages.length <= limit) return messages;
  return messages.slice(-limit);
}

/** Keeps the whole context until full, then retains a recent suffix with headroom. */
export function rolloverConversationContext(
  messages: ConversationMessage[],
  budget: ContextBudget,
): ConversationMessage[] {
  const availableTokens = availableContextTokens(budget);
  if (estimateContextTokens(messages) <= availableTokens) return messages;

  const latest = messages.at(-1);
  if (!latest) return messages;
  if (estimateContextTokens([latest]) > availableTokens) {
    throw new Error("Latest message exceeds the conversation token budget");
  }

  const targetTokens = availableTokens * CONTEXT_RETAIN_RATIO;
  let start = messages.length - 1;
  while (
    start > 0 &&
    estimateContextTokens(messages.slice(start - 1)) <= targetTokens
  ) {
    start -= 1;
  }
  return messages.slice(start);
}

export function summarizeContext(messages: ConversationMessage[]) {
  return messages.map((message, index) => ({
    index,
    id: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    authorPronouns: message.authorPronouns,
    authorIsBot: message.authorIsBot,
    channelId: message.channelId,
    threadId: message.threadId,
    replyTo: message.replyTo,
    context: message.context,
    timestamp: message.timestamp.toISOString(),
    content: message.content,
  }));
}

function estimateContextTokens(messages: ConversationMessage[]): number {
  const chars = messages.reduce((total, message) => {
    const metadataBudget = TRANSCRIPT_METADATA_CHARS_PER_MESSAGE;
    return (
      total +
      message.content.length +
      message.authorName.length +
      (message.authorPronouns?.length ?? 0) +
      metadataBudget
    );
  }, 0);

  return Math.ceil(chars / 4);
}

function availableContextTokens(budget: ContextBudget): number {
  return Math.max(
    1,
    budget.contextTokens - budget.promptTokens - (budget.responseTokens ?? 0),
  );
}

async function fetchChannelContext(
  message: Message,
  botUserId: string,
  initialLimit: number,
  budget: ContextBudget,
  startMessageId?: string,
): Promise<ConversationMessage[]> {
  const messages = [toConversationMessage(message, botUserId)];
  let before = message.id;
  while (startMessageId || messages.length < initialLimit) {
    if (startMessageId && BigInt(before) <= BigInt(startMessageId)) break;
    const limit = startMessageId
      ? DISCORD_HISTORY_PAGE_SIZE
      : Math.min(DISCORD_HISTORY_PAGE_SIZE, initialLimit - messages.length);
    const fetched = await message.channel.messages.fetch({
      limit,
      before,
      cache: false,
    });
    for (const item of fetched.values()) {
      if (!startMessageId || BigInt(item.id) >= BigInt(startMessageId)) {
        messages.push(toConversationMessage(item, botUserId));
      }
    }
    const oldest = fetched.last();
    if (!oldest || fetched.size < limit) break;
    // Once full, only the recent suffix can survive the reset. Avoid fetching
    // an entire busy channel after a long offline interval.
    if (estimateContextTokens(messages) > availableContextTokens(budget)) break;
    before = oldest.id;
  }
  return messages;
}

async function fetchBotReplyChain(
  adapter: DiscordAdapter,
  trigger: ConversationMessage,
  botUserId: string,
  log: Logger,
): Promise<ConversationMessage[]> {
  if (!trigger.replyTo) return [];

  const chain = await reconstructReplyChain(adapter, trigger, log);
  const parent = chain.at(-2);
  return parent?.authorId === botUserId ? chain : [];
}

function withContext(
  messages: ConversationMessage[],
  context: TranscriptContext,
): ConversationMessage[] {
  return messages.map((message) => ({ ...message, context }));
}

export function canonicalizeContextMessages(
  messages: ConversationMessage[],
  triggerMessageId?: string,
): ConversationMessage[] {
  const messagesById = new Map<string, ConversationMessage>();

  for (const message of messages) {
    const existing = messagesById.get(message.id);
    messagesById.set(
      message.id,
      mergeDuplicateContextMessage(existing, message),
    );
  }

  const sorted = [...messagesById.values()].sort(compareContextMessages);
  if (!triggerMessageId) return sorted;

  const triggerIndex = sorted.findIndex(
    (message) => message.id === triggerMessageId,
  );
  if (triggerIndex === -1) return sorted;

  const [trigger] = sorted.splice(triggerIndex, 1);
  if (trigger) sorted.push(trigger);
  return sorted;
}

function mergeDuplicateContextMessage(
  existing: ConversationMessage | undefined,
  next: ConversationMessage,
): ConversationMessage {
  if (!existing) return next;
  if (existing.context === "reply_chain") return existing;
  if (next.context === "reply_chain") return next;
  return existing;
}

function compareContextMessages(
  left: ConversationMessage,
  right: ConversationMessage,
): number {
  const timestampDelta = left.timestamp.getTime() - right.timestamp.getTime();
  if (timestampDelta !== 0) return timestampDelta;
  return left.id.localeCompare(right.id);
}

async function addAuthorPronouns(
  messages: ConversationMessage[],
  pronounProvider: PronounProvider | undefined,
  guildId?: string,
): Promise<ConversationMessage[]> {
  if (!pronounProvider) return messages;

  const pronounsByAuthor = new Map<string, string>();
  await Promise.all(
    [...new Set(messages.map((message) => message.authorId))]
      .filter(
        (authorId) =>
          !messages.some(
            (message) => message.authorId === authorId && message.authorIsBot,
          ),
      )
      .map(async (authorId) => {
        const pronouns = await pronounProvider.getPronouns(authorId, guildId);
        if (pronouns) pronounsByAuthor.set(authorId, pronouns);
      }),
  );

  return messages.map((message) => {
    const authorPronouns = pronounsByAuthor.get(message.authorId);
    return authorPronouns ? { ...message, authorPronouns } : message;
  });
}
