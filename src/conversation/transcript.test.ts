import { describe, expect, it } from "vitest";
import { MESSAGE_SPLIT } from "./reserved-tokens.js";
import { buildTranscript, formatTranscriptMessages } from "./transcript.js";
import type { ConversationMessage } from "./types.js";

describe("buildTranscript", () => {
  // Proves only people who spoke, never Patch herself, become pingable participants.
  it("lists other speakers as participants", () => {
    const transcript = buildTranscript(
      [
        message({ id: "1", authorId: "mia", authorName: "Mia" }),
        message({
          id: "2",
          authorId: "other-bot",
          authorName: "Other Bot",
          authorIsBot: true,
        }),
        message({ id: "3", authorId: "patch", authorIsBot: true }),
      ],
      "patch",
    );

    expect(transcript.participants).toEqual([
      { id: "mia", username: "mia", name: "Mia" },
      { id: "other-bot", username: "other bot", name: "Other Bot" },
    ]);
  });
});

describe("formatTranscriptMessages", () => {
  // Proves history matches the voice LoRA's chat format: named user turns, plain assistant turns, current message last.
  it("renders a multi-speaker guild history as plain chat turns", () => {
    const transcript = buildTranscript(
      [
        message({ id: "1", authorId: "mia", authorName: "Mia", content: "a" }),
        message({
          id: "2",
          authorId: "noor",
          authorName: "Noor",
          content: "b",
        }),
        message({
          id: "3",
          authorId: "patch",
          authorIsBot: true,
          content: "c",
        }),
        message({
          id: "4",
          authorId: "patch",
          authorIsBot: true,
          content: "d",
        }),
        message({
          id: "5",
          authorId: "mia",
          authorName: "Mia",
          content: "look",
          replyTo: { channelId: "channel", messageId: "3" },
          attachments: [{ filename: "cat.png", url: "https://cdn.example/x" }],
        }),
      ],
      "patch",
    );

    expect(formatTranscriptMessages(transcript, "5")).toEqual([
      { role: "user", content: "Mia [mia]: a" },
      { role: "user", content: "Noor [noor]: b" },
      { role: "assistant", content: `c${MESSAGE_SPLIT}d` },
      { role: "user", content: "Mia [mia]: look\n[attachment: cat.png]" },
    ]);
  });

  // Proves memory evidence keeps the exact human text while the speaker prefix and attachment line stay frame text.
  it("binds exact human text and leaves the prefix unattributed", () => {
    const text = "  <@123> hi\r\n";
    const source = { id: "discord:message:1", revision: 0 } as const;
    const [rendered] = formatTranscriptMessages(
      buildTranscript(
        [
          message({
            id: "1",
            authorName: "Mia",
            authorUsername: "mia",
            content: "hi",
            source: { text, revision: 0 },
            attachments: [{ filename: "a.txt" }],
          }),
        ],
        "patch",
      ),
      "1",
      () => ({ ...source, origin: "human_input" }),
    );

    const prefix = "Mia [mia]: ";
    expect(rendered?.content).toBe(`${prefix}${text}\n[attachment: a.txt]`);
    const span = rendered?.observationSources?.[0];
    expect(rendered?.content.slice(span?.start, span?.end)).toBe(text);
    expect(rendered?.observationUnknown).toEqual([
      {
        start: prefix.length + text.length,
        end: rendered?.content.length,
      },
    ]);
  });

  // Proves history joins Patch's messages with the bare canonical marker, keeps their newlines, and escapes marker text they contain.
  it("merges adjacent Patch messages into one assistant turn", () => {
    const transcript = buildTranscript(
      [
        message({
          id: "2",
          authorId: "patch",
          authorIsBot: true,
          content: "## first chunk\n- line one\n\nline two",
        }),
        message({
          id: "3",
          authorId: "patch",
          authorIsBot: true,
          content: `second \`${MESSAGE_SPLIT}\` chunk`,
        }),
      ],
      "patch",
    );

    expect(formatTranscriptMessages(transcript, "4")).toEqual([
      {
        role: "assistant",
        content:
          "## first chunk\n- line one\n\nline two<|message_split|>second `<|message_split_escaped|>` chunk",
      },
    ]);
  });
});

function message(
  overrides: Partial<ConversationMessage> & Pick<ConversationMessage, "id">,
): ConversationMessage {
  const authorName = overrides.authorName ?? `author-${overrides.id}`;
  return {
    channelId: "channel",
    authorId: `author-${overrides.id}`,
    authorName,
    authorUsername: authorName.toLowerCase(),
    authorIsBot: false,
    content: "hello",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    mentionsBot: false,
    attachments: [],
    ...overrides,
  };
}
