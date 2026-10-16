import type { Message } from "discord.js";
import {
  escapeAttribute,
  escapeTranscriptText,
} from "../conversation/escape.js";
import type { LlmTool } from "../llm/client.js";
import type { ActionContext, ActionRegistry } from "./context.js";
import { isToolCallTrigger } from "./tool-calls.js";

export type ModelVisibleAction = {
  actionName: string;
  name: string;
  description: string;
  usage: string;
  inputSchemaJson: unknown;
  available: boolean;
  unavailableReason?: string | undefined;
};

/** Discover explicitly exposed model tools for the current message's channel. */
export async function buildModelVisibleActions(input: {
  message: Message;
  context: ActionContext;
  registry: ActionRegistry;
}): Promise<ModelVisibleAction[]> {
  return Promise.all(
    input.registry.actions.flatMap((action) =>
      action.triggers.filter(isToolCallTrigger).map(async (trigger) => {
        const availability = await action.availability({
          ...input.context,
          channel: input.message.channel,
        });

        const visible: ModelVisibleAction = {
          actionName: action.name,
          name: trigger.name,
          description: trigger.description,
          usage: trigger.usage,
          inputSchemaJson: trigger.input.jsonSchema,
          available: availability.available,
        };
        if (!availability.available)
          visible.unavailableReason = availability.reason;
        return visible;
      }),
    ),
  );
}

export function toLlmTools(
  actions: readonly ModelVisibleAction[],
  options: { include?: readonly string[] | undefined } = {},
): LlmTool[] {
  const include = options.include ? new Set(options.include) : undefined;
  return actions
    .filter((action) => action.available)
    .filter((action) => !include || include.has(action.name))
    .map((action) => ({
      type: "function" as const,
      function: {
        name: action.name,
        description: action.description,
        parameters: action.inputSchemaJson,
      },
    }));
}

export function formatAvailableActionsPrompt(
  actions: readonly ModelVisibleAction[],
): string {
  const availableActions = actions.filter((action) => action.available);
  if (availableActions.length === 0) return "";

  return [
    "# Available actions",
    "",
    "These are actions Patch can use in the current Discord context. Use an action when it is the direct way to satisfy the latest request. Do not describe this list, promise future action, or mention action metadata in visible chat.",
    "",
    "<available_actions>",
    ...availableActions.map(formatAvailableAction),
    "</available_actions>",
  ].join("\n");
}

function formatAvailableAction(action: ModelVisibleAction): string {
  return [
    `<action name="${escapeAttribute(action.name)}" action_name="${escapeAttribute(action.actionName)}">`,
    `<description>${escapeTranscriptText(action.description)}</description>`,
    `<usage>${escapeTranscriptText(action.usage)}</usage>`,
    `<input_schema>${escapeTranscriptText(JSON.stringify(action.inputSchemaJson))}</input_schema>`,
    "</action>",
  ].join("\n");
}
