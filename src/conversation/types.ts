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
  /** Discord username, shown in brackets after the display name and used for `@username` mentions. */
  authorUsername: string;
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
  authorUsername: string;
  role: TranscriptRole;
  timestamp: Date;
  replyTo?: string;
  channelId?: string;
  content: string;
  source?: { text: string; revision: number };
  displayMessages?: { id: string; text: string; revision: number }[];
  attachments: Attachment[];
};

/** Someone other than Patch who spoke in the conversation; the only people Patch may ping. */
export type TranscriptParticipant = {
  id: string;
  username: string;
  name: string;
};

export type Transcript = {
  participants: TranscriptParticipant[];
  blocks: TranscriptBlock[];
};
