import type { ConversationMessage } from "../conversation/types.js";
import { getBotIdentity } from "../identity.js";
import { readPromptFile } from "./files.js";

export type ClassifierPromptContext = {
  triggerKind: "dm_message" | "passive_guild_message";
  location: "dm" | "guild_channel" | "guild_thread";
  botUserId: string;
  latestMessage: {
    id: string;
    authorId: string;
    authorName: string;
    replyToMessageId?: string;
    userMentionCount: number;
    roleMentionCount: number;
    mentionsEveryone: boolean;
    attachmentCount: number;
  };
  channel: {
    id: string;
    type: string;
    name?: string;
  };
};

/** Keep Laya's decision instructions separate from conversation data and resolve reply authors without guessing addressees. */
export function buildClassifierQuestion(
  messages: ConversationMessage[],
  context: ClassifierPromptContext,
) {
  const identity = getBotIdentity();
  const format = (message: ConversationMessage) => {
    const parent = messages.find(
      (candidate) => candidate.id === message.replyTo?.messageId,
    );
    const name = (actor: ConversationMessage) =>
      messages.some(
        (other) =>
          other.authorName === actor.authorName &&
          other.authorId !== actor.authorId,
      )
        ? `${actor.authorName} [${actor.authorId}]`
        : actor.authorName;
    const role =
      message.authorId === context.botUserId
        ? `${identity.name}, the bot`
        : message.authorIsBot
          ? "another bot"
          : "human";
    const reply = message.replyTo
      ? ` replying to ${parent ? name(parent) : `unknown message ${message.replyTo.messageId}`}`
      : "";
    const attachments = message.attachments.length
      ? `\nAttachments: ${message.attachments.map((item) => item.filename).join(", ")}`
      : "";
    return `${name(message)} (${role})${reply}: ${message.content}${attachments}`;
  };
  const latest = messages.find(
    (message) => message.id === context.latestMessage.id,
  );
  if (!latest)
    throw new Error("Classifier context is missing the current message");
  const history = messages
    .filter((message) => message.id !== latest.id)
    .map(format)
    .join("\n");
  const otherAliases = identity.aliases.filter(
    (alias) => alias.toLowerCase() !== identity.name.toLowerCase(),
  );
  const aliases = otherAliases.length
    ? ` Aliases: ${otherAliases.join(", ")}.`
    : "";
  return {
    state: `Bot being considered: ${identity.name}. Pronouns: ${identity.pronouns}.${aliases}\nLocation: ${context.location}.\nRecent conversation, oldest first:\n${history}\n\nLATEST MESSAGE TO CLASSIFY:\n${format(latest)}\n\nShould ${identity.name} reply to this latest message?`,
    questions: {
      response: {
        type: "choice" as const,
        instructions: readPromptFile("20-classifier.md"),
        criteria: {
          respond:
            "The speaker addresses the bot, follows up with the bot, requests confirmation, corrects the bot, or invites a useful or playful comment.",
          "dont respond":
            "The speaker addresses another human, describes the bot to someone else, gives an ambient acknowledgement, leaves an unfinished thought, or requests silence.",
        },
      },
    },
  };
}
