import { getBotIdentity } from "../identity.js";
import { escapeAttribute, escapeTranscriptText } from "./escape.js";
import type {
  ConversationMessage,
  Transcript,
  TranscriptBlock,
  TranscriptParticipant,
} from "./types.js";

const SELF_AUTHOR_ID = "patch";
const MISSING_PRONOUNS = "missing";
const RESPONSE_SPLIT_MARKER = "\u0000patch-response-split\u0000";

export function buildTranscript(
  messages: ConversationMessage[],
  botUserId: string,
): Transcript {
  const identity = getBotIdentity();
  const blocks = messages.map((message): TranscriptBlock => {
    const isPatch = message.authorId === botUserId;
    const block: TranscriptBlock = {
      kind: isPatch ? "response" : "message",
      id: message.id,
      authorId: isPatch ? SELF_AUTHOR_ID : message.authorId,
      authorName: isPatch ? identity.name : message.authorName,
      role: isPatch ? "self" : message.authorIsBot ? "bot" : "human",
      timestamp: message.timestamp,
      context: message.context ?? "reply_chain",
      channelId: message.channelId,
      content: message.content,
      attachments: message.attachments,
    };

    if (isPatch) {
      block.authorPronouns = identity.pronouns;
    } else if (message.authorPronouns) {
      block.authorPronouns = message.authorPronouns;
    }
    if (message.replyTo) block.replyTo = message.replyTo.messageId;
    if (message.threadId) block.threadId = message.threadId;

    return block;
  });

  const mergedBlocks = mergeAdjacentPatchResponses(blocks);

  return {
    participants: collectParticipants(mergedBlocks),
    blocks: mergedBlocks,
    participantUserIds: new Set(
      mergedBlocks
        .filter((block) => block.kind === "message")
        .map((block) => block.authorId),
    ),
  };
}

/** Formats history first so new participants only change the prompt's suffix. */
export function formatTranscript(transcript: Transcript): string {
  return [
    ...transcript.blocks.map(formatBlock),
    formatParticipants(transcript.participants),
  ].join("\n\n");
}

function collectParticipants(
  blocks: TranscriptBlock[],
): TranscriptParticipant[] {
  const participants = new Map<string, TranscriptParticipant>();
  const identity = getBotIdentity();
  participants.set(SELF_AUTHOR_ID, {
    authorId: SELF_AUTHOR_ID,
    authorName: identity.name,
    pronouns: identity.pronouns,
    role: "self",
  });

  for (const block of blocks) {
    const participant: TranscriptParticipant = {
      authorId: block.authorId,
      authorName: block.authorName,
      pronouns: block.authorPronouns ?? MISSING_PRONOUNS,
      role: block.role,
    };
    const existing = participants.get(participant.authorId);
    if (!existing) {
      participants.set(participant.authorId, participant);
      continue;
    }

    if (
      existing.pronouns === MISSING_PRONOUNS &&
      participant.pronouns !== MISSING_PRONOUNS
    ) {
      participants.set(participant.authorId, {
        ...existing,
        pronouns: participant.pronouns,
      });
    }
  }

  return [...participants.values()];
}

function formatParticipants(participants: TranscriptParticipant[]): string {
  const rows = participants.map(formatParticipant).join("\n");
  return `<participants>\n${rows}\n</participants>`;
}

function formatParticipant(participant: TranscriptParticipant): string {
  const attributes: [string, string][] = [
    ["author_id", participant.authorId],
    ["author_name", participant.authorName],
    ["pronouns", participant.pronouns],
    ["role", participant.role],
  ];

  return `<participant ${attributes.map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(" ")} />`;
}

function mergeAdjacentPatchResponses(
  blocks: TranscriptBlock[],
): TranscriptBlock[] {
  const merged: TranscriptBlock[] = [];

  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous?.kind === "response" && block.kind === "response") {
      previous.messageIds = [
        ...(previous.messageIds ?? [previous.id].filter(isString)),
        ...(block.messageIds ?? [block.id].filter(isString)),
      ];
      previous.id = undefined;
      previous.content = `${previous.content}${RESPONSE_SPLIT_MARKER}${block.content}`;
      previous.attachments = [...previous.attachments, ...block.attachments];
      continue;
    }

    merged.push({ ...block });
  }

  return merged;
}

function formatBlock(block: TranscriptBlock): string {
  const tag = block.kind;
  const attributes = formatAttributes(block);
  const content = formatBlockContent(block);
  const attachments = block.attachments.map(formatAttachment).join("\n");
  const body = [content, attachments].filter(Boolean).join("\n");

  return `<${tag} ${attributes}>\n${body}\n</${tag}>`;
}

function formatBlockContent(block: TranscriptBlock): string {
  if (block.kind !== "response")
    return escapeTranscriptText(block.content.trim());

  return block.content
    .split(RESPONSE_SPLIT_MARKER)
    .map((chunk) => escapeTranscriptText(chunk.trim()))
    .filter(Boolean)
    .join("\n<split />\n");
}

function formatAttributes(block: TranscriptBlock): string {
  const attributes: [string, string][] = [];

  attributes.push(["author_name", block.authorName]);
  if (block.authorPronouns) attributes.push(["pronouns", block.authorPronouns]);
  attributes.push(["author_id", block.authorId]);
  if (block.id) attributes.push(["id", block.id]);
  if (block.messageIds?.length)
    attributes.push(["message_ids", block.messageIds.join(",")]);
  attributes.push(["role", block.role]);
  attributes.push(["timestamp", block.timestamp.toISOString()]);
  if (block.replyTo) attributes.push(["reply_to", block.replyTo]);

  return attributes
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(" ");
}

function formatAttachment(
  attachment: TranscriptBlock["attachments"][number],
): string {
  const attributes: [string, string][] = [["filename", attachment.filename]];
  if (attachment.mediaType)
    attributes.push(["media_type", attachment.mediaType]);
  attributes.push(["unavailable_for_v0", "true"]);
  return `<attachment ${attributes.map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(" ")} />`;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
