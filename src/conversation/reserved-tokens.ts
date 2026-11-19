export const RESERVED_TRANSCRIPT_TOKENS = [
  "participants",
  "participant",
  "classifier_decision",
  "message",
  "response",
  "attachment",
  "split",
  "tool_call",
  "tool_result",
  "bot_action",
] as const;

/**
 * Canonical boundary between Patch's Discord messages, in model output and in
 * history. The adapter tokenizer maps it to a single token.
 */
export const MESSAGE_SPLIT = "<|message_split|>";

/** Inert stand-in for marker text that is content rather than a boundary. */
export const ESCAPED_MESSAGE_SPLIT = "<|message_split_escaped|>";
