import { describe, expect, it } from "vitest";
import { parseModelOutput } from "./output.js";

describe("model output controls", () => {
  // Proves ordinary messages and quoted examples do not turn into replies or actions.
  it.each([
    "hi there",
    '> <reply to="123" />\nexample',
    "here is an example: <tool_call>{}</tool_call>",
    '```\n<reply to="123" />\n```',
  ])("keeps ordinary text literal: %s", (content) => {
    expect(parseModelOutput(content)).toEqual({ content, toolCalls: [] });
  });

  // Proves one opt-in reply and reaction preserve the emoji while hiding all control syntax.
  it("separates the reply, reaction and message", () => {
    expect(
      parseModelOutput(
        '<reply to="123" />\n<tool_call>{"name":"react","arguments":{"message_id":"123","emoji":"😂"}}</tool_call>\nyeah',
      ),
    ).toEqual({
      replyTo: "123",
      content: "yeah",
      toolCalls: [
        {
          type: "function",
          name: "react",
          arguments: '{"message_id":"123","emoji":"😂"}',
        },
      ],
    });
  });

  // Proves malformed control sections fail before any text or partial action is presented.
  it.each([
    '<reply to="abc" /> hi',
    '<reply to="123">hi',
    '<tool_call>{"name":"react","arguments":{},"extra":true}</tool_call>',
    "<tool_call>{",
    '<tool_call>{"name":"react","arguments":{}}</tool_call><reply to="123" />hi',
  ])("rejects malformed leading controls: %s", (content) => {
    expect(() => parseModelOutput(content)).toThrow();
  });
});
