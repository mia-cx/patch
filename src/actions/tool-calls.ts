import type { Message } from "discord.js";
import type {
  ActionInput,
  TriggerDefinition,
  TriggerProvider,
} from "protocord";
import type { LlmToolCall } from "../llm/client.js";
import type {
  ActionContext,
  ActionPermission,
  ActionRegistry,
} from "./context.js";
import { authorizeAction } from "./permissions.js";

export const TOOL_CALL_PROVIDER_ID = "patch:tool-call";

type ToolCallTrigger<Input = unknown> = TriggerDefinition<
  Input,
  ActionContext,
  ActionPermission
> & {
  input: ActionInput<Input>;
};

type ToolCallEvent = {
  toolCall: LlmToolCall;
  message: Message;
};

/** Expose an explicitly selected action to Patch's model. */
export function toolCall<Input>(input: {
  name: string;
  description: string;
  usage: string;
  input: ActionInput<Input>;
}): ToolCallTrigger<Input> {
  return { ...input, providerId: TOOL_CALL_PROVIDER_ID };
}

/** Identify Patch's explicit model triggers without including Discord commands. */
export function isToolCallTrigger(
  trigger: TriggerDefinition<unknown, ActionContext, unknown>,
): trigger is ToolCallTrigger {
  return trigger.providerId === TOOL_CALL_PROVIDER_ID && "input" in trigger;
}

/** Parse model arguments while delegating the action lifecycle to Protocord. */
export function createToolCallProvider(): TriggerProvider<
  ActionContext,
  ToolCallTrigger,
  ToolCallEvent
> {
  return {
    id: TOOL_CALL_PROVIDER_ID,
    isTrigger: isToolCallTrigger,
    isEvent: (event): event is ToolCallEvent =>
      event !== null &&
      typeof event === "object" &&
      "toolCall" in event &&
      "message" in event,
    getTriggerKey: (trigger) => trigger.name,
    normalizeLookupKey: (key) => key,
    parse: (trigger, event) =>
      trigger.input.parse(JSON.parse(event.toolCall.arguments)),
    getInvocationDetails: (_trigger, { message }) => ({
      source: TOOL_CALL_PROVIDER_ID,
      channelId: message.channelId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      requester: {
        id: message.author.id,
        name: message.author.globalName ?? message.author.username,
      },
    }),
    present: () => {},
  };
}

/** Execute model tools through the same validation and permissions as commands. */
export async function dispatchToolCall(input: {
  registry: ActionRegistry;
  context: ActionContext;
  message: Message;
  toolCall: LlmToolCall;
}): Promise<void> {
  const result = await input.registry.dispatch({
    providerId: TOOL_CALL_PROVIDER_ID,
    triggerName: input.toolCall.name,
    event: { message: input.message, toolCall: input.toolCall },
    context: { ...input.context, channel: input.message.channel },
    authorize: authorizeAction,
  });
  if (!result.matched)
    throw new Error(`Unknown tool call: ${input.toolCall.name}`);
  if (result.outcome.status === "failed") throw result.outcome.error;
  if (result.outcome.status !== "executed")
    throw new Error(result.outcome.reason);
  if (result.presentationError !== undefined) throw result.presentationError;
}
