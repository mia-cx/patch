import {
  ESCAPED_MESSAGE_SPLIT,
  MESSAGE_SPLIT,
  RESERVED_TRANSCRIPT_TOKENS,
} from "./reserved-tokens.js";

export function escapeTranscriptText(value: string): string {
  return escapeMessageSplit(neutralizeReservedTranscriptTokens(value));
}

/** Keeps message text from rendering as a real message boundary token. */
export function escapeMessageSplit(value: string): string {
  return value.replaceAll(MESSAGE_SPLIT, ESCAPED_MESSAGE_SPLIT);
}

/**
 * Hides the marker inside serialized JSON without changing its decoded value.
 * Valid because the marker has no characters JSON escapes, so it only occurs
 * inside string literals.
 */
export function escapeJsonMessageSplit(json: string): string {
  return json.replaceAll(MESSAGE_SPLIT, "\\u003c|message_split|\\u003e");
}

export function escapeAttribute(value: string): string {
  return escapeXml(value).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function neutralizeReservedTranscriptTokens(value: string): string {
  let escaped = value;

  for (const token of RESERVED_TRANSCRIPT_TOKENS) {
    escaped = escaped.replace(
      new RegExp(`<(\\s*/?\\s*)${token}(?=[\\s>/])`, "gi"),
      `<$1${token}_escaped`,
    );
  }

  return escaped;
}
