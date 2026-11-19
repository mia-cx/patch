import type { LlmMessage } from "../llm/client.js";
import type { ObservationInput } from "../llm/evidence.js";
import { escapeMessageSplit } from "./escape.js";
import { MESSAGE_SPLIT } from "./reserved-tokens.js";
import type {
  ConversationMessage,
  Transcript,
  TranscriptBlock,
  TranscriptParticipant,
} from "./types.js";

const RESPONSE_SPLIT_MARKER = "\u0000patch-response-split\u0000";

export function buildTranscript(
  messages: ConversationMessage[],
  botUserId: string,
): Transcript {
  const blocks = mergeAdjacentPatchResponses(
    messages.map((message): TranscriptBlock => {
      const isPatch = message.authorId === botUserId;
      return {
        kind: isPatch ? "response" : "message",
        id: message.id,
        authorId: message.authorId,
        authorName: message.authorName,
        authorUsername: message.authorUsername,
        role: isPatch ? "self" : message.authorIsBot ? "bot" : "human",
        timestamp: message.timestamp,
        channelId: message.channelId,
        content: message.content,
        ...(message.source ? { source: message.source } : {}),
        ...(isPatch && message.source
          ? { displayMessages: [{ id: message.id, ...message.source }] }
          : {}),
        ...(message.replyTo ? { replyTo: message.replyTo.messageId } : {}),
        attachments: message.attachments,
      };
    }),
  );
  const participants = new Map<string, TranscriptParticipant>();
  for (const block of blocks)
    if (block.kind === "message")
      participants.set(block.authorId, {
        id: block.authorId,
        username: block.authorUsername,
        name: block.authorName,
      });
  return { blocks, participants: [...participants.values()] };
}

/**
 * Render history in the voice LoRA's chat format: each human or bot message is a
 * `user` turn `DisplayName [username]: text`, and Patch's messages are plain
 * `assistant` turns. The current message goes last, after `beforeCurrent` notes.
 * A reply Patch already gave appears only once.
 *
 * With source callbacks, human text keeps an exact literal span for memory
 * evidence; the speaker prefix and attachment lines are unattributed frame text.
 */
export function formatTranscriptMessages(
  transcript: Transcript,
  currentMessageId: string,
  humanSource?: (
    block: TranscriptBlock,
  ) => Omit<ObservationInput, "views" | "context"> | undefined,
  assistantBody?: (block: TranscriptBlock) => LlmMessage | undefined,
  beforeCurrent: readonly string[] = [],
): LlmMessage[] {
  const observed = Boolean(humanSource || assistantBody);
  const render = (block: TranscriptBlock) =>
    block.kind === "response"
      ? formatResponse(block, assistantBody, observed)
      : formatMessage(block, humanSource, observed);
  const current = transcript.blocks.find(
    (block) => block.id === currentMessageId,
  );
  return [
    ...withoutRepeatedReplies(transcript.blocks)
      .filter((block) => block !== current)
      .map(render),
    ...beforeCurrent.map((content) => ({ role: "user" as const, content })),
    ...(current ? [render(current)] : []),
  ];
}

/**
 * Drop Patch's replies that repeat an earlier one word for word. The voice model
 * copies a reply it sees repeated, so two copies in history turn into a loop.
 */
function withoutRepeatedReplies(blocks: TranscriptBlock[]) {
  const said = new Set<string>();
  return blocks.filter((block) => {
    if (block.kind !== "response") return true;
    const text = block.content.trim().toLowerCase();
    if (said.has(text)) return false;
    said.add(text);
    return true;
  });
}

function formatMessage(
  block: TranscriptBlock,
  humanSource: Parameters<typeof formatTranscriptMessages>[2],
  observed: boolean,
): LlmMessage {
  const prefix = `${block.authorName} [${block.authorUsername}]: `;
  const text = block.source?.text ?? block.content;
  // A literal marker would split the history turn; escaped text no longer equals its source.
  const body = escapeMessageSplit(text);
  const content = [
    prefix + body,
    ...block.attachments.map(({ filename }) => `[attachment: ${filename}]`),
  ].join("\n");
  if (!observed) return { role: "user", content };
  const source = block.role === "human" ? humanSource?.(block) : undefined;
  const bodyEnd = prefix.length + body.length;
  if (!source || body !== text)
    return {
      role: "user",
      content,
      observationUnknown: [{ start: prefix.length, end: content.length }],
    };
  return {
    role: "user",
    content,
    observationSources: [
      { source, start: prefix.length, end: bodyEnd, encoding: "literal" },
    ],
    observationUnknown:
      bodyEnd < content.length ? [{ start: bodyEnd, end: content.length }] : [],
  };
}

function formatResponse(
  block: TranscriptBlock,
  assistantBody: Parameters<typeof formatTranscriptMessages>[3],
  observed: boolean,
): LlmMessage {
  const body = assistantBody?.(block);
  if (body) return body;
  const content = block.content
    .split(RESPONSE_SPLIT_MARKER)
    .map((chunk) => escapeMessageSplit(chunk.trim()))
    .filter(Boolean)
    .join(MESSAGE_SPLIT);
  return {
    role: "assistant",
    content,
    ...(observed
      ? { observationUnknown: [{ start: 0, end: content.length }] }
      : {}),
  };
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
      previous.displayMessages = [
        ...(previous.displayMessages ?? []),
        ...(block.displayMessages ?? []),
      ];
      continue;
    }

    merged.push({ ...block });
  }

  return merged;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
