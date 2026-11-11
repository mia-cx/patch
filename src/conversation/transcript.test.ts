import { describe, expect, it } from "vitest";
import { MESSAGE_SPLIT } from "./reserved-tokens.js";
import { buildTranscript, formatTranscript } from "./transcript.js";
import type { ConversationMessage } from "./types.js";

describe("buildTranscript", () => {
  it("allows mentions for message authors in the transcript", () => {
    const transcript = buildTranscript(
      [
        message({ id: "1", authorId: "mia", authorName: "Mia" }),
        message({
          id: "2",
          authorId: "other-bot",
          authorName: "Other Bot",
          authorIsBot: true,
        }),
        message({
          id: "3",
          authorId: "patch",
          authorName: "Patch",
          authorIsBot: true,
        }),
      ],
      "patch",
    );

    expect([...transcript.participantUserIds]).toEqual(["mia", "other-bot"]);
  });
});

describe("formatTranscript", () => {
  it("includes a participant block with speaker metadata", () => {
    const messages: ConversationMessage[] = [
      message({
        id: "1",
        authorId: "mia",
        authorName: "Mia",
        authorPronouns: "she/her",
      }),
    ];

    const formatted = formatTranscript(buildTranscript(messages, "patch"));

    expect(formatted).toContain("<participants>");
    expect(formatted).toContain(
      '<participant author_id="patch" author_name="Patch" pronouns="she/her" role="self" />',
    );
    expect(formatted).toContain(
      '<participant author_id="mia" author_name="Mia" pronouns="she/her" role="human" />',
    );
  });

  it("puts author name, pronouns, and role on human message blocks", () => {
    const messages: ConversationMessage[] = [
      message({
        id: "1",
        authorId: "mia",
        authorName: "Mia",
        authorPronouns: "she/her",
      }),
    ];

    const formatted = formatTranscript(buildTranscript(messages, "patch"));

    expect(formatted).toContain(
      '<message author_name="Mia" pronouns="she/her" author_id="mia"',
    );
    expect(formatted).toContain('role="human"');
  });

  it("uses role instead of author_is_bot on other bot message blocks", () => {
    const messages: ConversationMessage[] = [
      message({
        id: "1",
        authorId: "other-bot",
        authorName: "Other Bot",
        authorIsBot: true,
      }),
    ];

    const formatted = formatTranscript(buildTranscript(messages, "patch"));

    expect(formatted).toContain('role="bot"');
    expect(formatted).not.toContain("author_is_bot");
  });

  it("does not expose internal context labels on message blocks", () => {
    const messages: ConversationMessage[] = [
      message({ id: "1", context: "thread" }),
    ];

    expect(formatTranscript(buildTranscript(messages, "patch"))).not.toContain(
      'context="thread"',
    );
  });

  it("includes Patch's pronouns on response blocks", () => {
    const messages: ConversationMessage[] = [
      message({
        id: "1",
        authorId: "patch",
        authorName: "Patch",
        authorIsBot: true,
      }),
    ];

    expect(formatTranscript(buildTranscript(messages, "patch"))).toContain(
      '<response author_name="Patch" pronouns="she/her" author_id="patch" id="1" role="self"',
    );
  });

  it("preserves Discord mentions in message content", () => {
    const formatted = formatTranscript(
      buildTranscript(
        [message({ id: "1", content: "pinged <@123> but not <@456>" })],
        "patch",
      ),
    );

    expect(formatted).toContain("pinged <@123> but not <@456>");
  });

  it("neutralizes reserved transcript tags in message content", () => {
    const formatted = formatTranscript(
      buildTranscript(
        [
          message({
            id: "1",
            content: `<message>nope</message> <split /> ${MESSAGE_SPLIT}`,
          }),
        ],
        "patch",
      ),
    );

    expect(formatted).toContain(
      "<message_escaped>nope</message_escaped> <split_escaped /> <|message_split_escaped|>",
    );
  });

  // Proves history joins Patch's messages with the bare canonical marker, keeps their newlines, and escapes marker text they contain.
  it("merges adjacent Patch response chunks into one response block", () => {
    const messages: ConversationMessage[] = [
      message({ id: "1", authorId: "mia", authorName: "Mia" }),
      message({
        id: "2",
        authorId: "patch",
        authorName: "Patch",
        authorIsBot: true,
        content: "## first chunk\n- line one\n\nline two",
      }),
      message({
        id: "3",
        authorId: "patch",
        authorName: "Patch",
        authorIsBot: true,
        content: `second \`${MESSAGE_SPLIT}\` chunk`,
      }),
      message({ id: "4", authorId: "mia", authorName: "Mia" }),
    ];

    const formatted = formatTranscript(buildTranscript(messages, "patch"));

    expect(formatted).toContain(
      '<response author_name="Patch" pronouns="she/her" author_id="patch" message_ids="2,3" role="self"',
    );
    expect(formatted).toContain(
      "\n## first chunk\n- line one\n\nline two<|message_split|>second `<|message_split_escaped|>` chunk\n</response>",
    );
  });
});

function message(
  overrides: Partial<ConversationMessage> & Pick<ConversationMessage, "id">,
): ConversationMessage {
  return {
    channelId: "channel",
    authorId: `author-${overrides.id}`,
    authorName: `author-${overrides.id}`,
    authorIsBot: false,
    content: "hello",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    mentionsBot: false,
    attachments: [],
    ...overrides,
  };
}
