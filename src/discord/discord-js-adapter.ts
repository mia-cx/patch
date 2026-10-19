import { randomUUID } from "node:crypto";
import {
  type Client,
  type Attachment as DiscordAttachment,
  GatewayIntentBits,
  type Message,
  type MessageCreateOptions,
  type MessageMentionOptions,
  type MessageReference,
  Partials,
} from "discord.js";
import type {
  Attachment,
  ConversationMessage,
  MessageRef,
} from "../conversation/types.js";
import { getBotIdentity } from "../identity.js";
import type { DiscordAdapter, ReplyOptions } from "./adapter.js";

export const discordClientOptions = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
};

export class DiscordJsAdapter implements DiscordAdapter {
  constructor(
    private readonly client: Client,
    public readonly botUserId: string,
  ) {}

  async fetchMessage(ref: MessageRef): Promise<ConversationMessage> {
    const channel = await this.client.channels.fetch(ref.channelId);
    if (!channel?.isTextBased())
      throw new Error(`Channel ${ref.channelId} is not text based`);

    // Reply-chain entries must reflect edits/deletions just like fetched history.
    const message = await channel.messages.fetch({
      message: ref.messageId,
      force: true,
      cache: false,
    });
    return toConversationMessage(message, this.botUserId);
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      !("sendTyping" in channel) ||
      typeof channel.sendTyping !== "function"
    )
      return;
    await channel.sendTyping();
  }

  async sendMessage(
    channelId: string,
    content: string,
    options: ReplyOptions = {},
  ): Promise<ConversationMessage> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      !("send" in channel) ||
      typeof channel.send !== "function"
    ) {
      throw new Error(`Channel ${channelId} cannot send messages`);
    }

    const message = await channel.send({
      content,
      allowedMentions: buildAllowedMentions(options.allowedMentionUsers),
      nonce: randomUUID().replaceAll("-", "").slice(0, 25),
      enforceNonce: true,
    });
    return toConversationMessage(message, this.botUserId);
  }

  async sendReply(
    target: MessageRef,
    content: string,
    options: ReplyOptions = {},
  ): Promise<ConversationMessage> {
    const channel = await this.client.channels.fetch(target.channelId);
    if (
      !channel ||
      !("send" in channel) ||
      typeof channel.send !== "function"
    ) {
      throw new Error(`Channel ${target.channelId} cannot send messages`);
    }

    const messageOptions: MessageCreateOptions = {
      content,
      reply: { messageReference: target.messageId, failIfNotExists: false },
      allowedMentions: buildAllowedMentions(options.allowedMentionUsers),
      nonce: randomUUID().replaceAll("-", "").slice(0, 25),
      enforceNonce: true,
    };

    const message = await channel.send(messageOptions);
    return toConversationMessage(message, this.botUserId);
  }
}

export function toConversationMessage(
  message: Message,
  botUserId: string,
): ConversationMessage {
  const converted: ConversationMessage = {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    authorIsBot: message.author.bot,
    content: stripBotMention(message.content, botUserId).trim(),
    timestamp: message.createdAt,
    mentionsBot: message.mentions.users.has(botUserId),
    attachments: [...message.attachments.values()].map(toAttachment),
  };

  if (message.channel?.isThread()) converted.threadId = message.channel.id;
  const replyTo = getReplyTo(message.reference);
  if (replyTo) converted.replyTo = replyTo;

  return converted;
}

function getReplyTo(
  reference: MessageReference | null,
): MessageRef | undefined {
  if (!reference?.messageId || !reference.channelId) return undefined;
  return { channelId: reference.channelId, messageId: reference.messageId };
}

function toAttachment(attachment: DiscordAttachment): Attachment {
  const converted: Attachment = {
    filename: attachment.name ?? attachment.id,
    url: attachment.url,
  };

  if (attachment.contentType) converted.mediaType = attachment.contentType;
  return converted;
}

function stripBotMention(content: string, botUserId: string): string {
  return content.replace(
    new RegExp(`<@!?${botUserId}>`, "g"),
    `@${getBotIdentity().name}`,
  );
}

function buildAllowedMentions(
  userIds: string[] | undefined,
): MessageMentionOptions {
  return {
    parse: [],
    users: userIds ?? [],
    roles: [],
    repliedUser: false,
  };
}
