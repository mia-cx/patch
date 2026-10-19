export type TranscriptContext = "reply_chain" | "neighbor" | "thread";

export type MessageRef = {
  channelId: string;
  messageId: string;
};

export type Attachment = {
  filename: string;
  mediaType?: string;
  url?: string;
};

export type ConversationMessage = {
  id: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  authorPronouns?: string;
  authorIsBot: boolean;
  content: string;
  /** Original SDK text, before mention stripping or transcript rendering. */
  source?: { text: string; revision: number };
  timestamp: Date;
  replyTo?: MessageRef;
  mentionsBot: boolean;
  attachments: Attachment[];
  context?: TranscriptContext;
};

export type TranscriptRole = "self" | "human" | "bot";

export type TranscriptBlock = {
  kind: "message" | "response";
  id?: string | undefined;
  messageIds?: string[];
  authorId: string;
  authorName: string;
  authorPronouns?: string;
  role: TranscriptRole;
  timestamp: Date;
  replyTo?: string;
  context: TranscriptContext;
  channelId?: string;
  threadId?: string;
  content: string;
  source?: { text: string; revision: number };
  displayMessages?: { id: string; text: string; revision: number }[];
  attachments: Attachment[];
};

export type TranscriptParticipant = {
  authorId: string;
  authorName: string;
  pronouns: string;
  role: TranscriptRole;
};

export type Transcript = {
  participants: TranscriptParticipant[];
  blocks: TranscriptBlock[];
  participantUserIds: Set<string>;
};
