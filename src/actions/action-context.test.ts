import { describe, expect, it } from "vitest";
import { formatAvailableActionsPrompt, toLlmTools } from "./action-context.js";

describe("action context", () => {
  it("omits the prompt section when no actions are available", () => {
    expect(
      formatAvailableActionsPrompt([
        {
          actionName: "leave_thread",
          name: "leave_thread",
          description: "Leave the current thread.",
          usage: '{"name":"leave_thread","arguments":{}}',
          inputSchemaJson: { type: "object" },
          available: false,
          unavailableReason: "only available in threads",
        },
      ]),
    ).toBe("");
  });

  it("renders available action metadata for the system prompt", () => {
    const prompt = formatAvailableActionsPrompt([
      {
        actionName: "leave_thread",
        name: "leave_thread",
        description: "Leave the current thread after sending a short farewell.",
        usage: '{"name":"leave_thread","arguments":{}}',
        inputSchemaJson: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        available: true,
      },
    ]);

    expect(prompt).toContain("# Available actions");
    expect(prompt).toContain('<action name="leave_thread"');
    expect(prompt).toContain("Leave the current thread");
    expect(prompt).toContain("additionalProperties");
  });

  it("projects selected available actions into native LLM tools", () => {
    const tools = toLlmTools(
      [
        {
          actionName: "leave_thread",
          name: "leave_thread",
          description: "Leave the current thread.",
          usage: "Use to leave.",
          inputSchemaJson: { type: "object" },
          available: true,
        },
        {
          actionName: "wait",
          name: "wait",
          description: "Wait quietly.",
          usage: "Use to wait.",
          inputSchemaJson: { type: "object" },
          available: true,
        },
      ],
      { include: ["leave_thread"] },
    );

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "leave_thread",
          description: "Leave the current thread.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);
  });
});
