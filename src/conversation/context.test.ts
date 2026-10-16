import { describe, expect, it } from "vitest";
import {
  canonicalizeContextMessages,
  limitContextMessages,
} from "./context.js";
import type { ConversationMessage, TranscriptContext } from "./types.js";

describe("limitContextMessages", () => {
  it("keeps only the latest messages", () => {
    const messages = [
      message("1", "thread"),
      message("2", "thread"),
      message("3", "thread"),
      message("4", "thread"),
    ];

    expect(limitContextMessages(messages, 2).map((item) => item.id)).toEqual([
      "3",
      "4",
    ]);
  });

  it("leaves shorter contexts unchanged", () => {
    const messages = [message("1", "thread"), message("2", "thread")];

    expect(limitContextMessages(messages, 3)).toEqual(messages);
  });
});

describe("canonicalizeContextMessages", () => {
  it("deduplicates messages, sorts by timestamp and id, and keeps the trigger last", () => {
    const duplicateNeighbor = message("2", "neighbor");
    const duplicateReplyChain = message("2", "reply_chain");
    const canonical = canonicalizeContextMessages(
      [
        {
          ...message("3", "thread"),
          timestamp: new Date("2026-01-01T00:00:03.000Z"),
        },
        {
          ...message("latest", "thread"),
          timestamp: new Date("2026-01-01T00:00:01.000Z"),
        },
        {
          ...message("1", "thread"),
          timestamp: new Date("2026-01-01T00:00:01.000Z"),
        },
        duplicateNeighbor,
        duplicateReplyChain,
      ],
      "latest",
    );

    expect(canonical.map((item) => item.id)).toEqual(["1", "2", "3", "latest"]);
    expect(canonical.find((item) => item.id === "2")?.context).toBe(
      "reply_chain",
    );
  });
});

function message(id: string, context: TranscriptContext): ConversationMessage {
  return {
    id,
    channelId: "channel",
    authorId: `author-${id}`,
    authorName: `author-${id}`,
    authorIsBot: false,
    content: "x",
    timestamp: new Date(`2026-01-01T00:00:0${Math.min(id.length, 9)}.000Z`),
    mentionsBot: false,
    attachments: [],
    context,
  };
}
