import {
  createActionRegistry,
  createDiscordInteractionProviders,
} from "protocord";
import type {
  ActionContext,
  ActionPermission,
  ActionRegistry,
} from "./context.js";
import { createToolCallProvider } from "./tool-calls.js";

/** Compose Patch's Discord and model triggers on the shared action runtime. */
export function createPatchActionRegistry(): ActionRegistry {
  return createActionRegistry<ActionContext, ActionPermission>({
    providers: [
      ...createDiscordInteractionProviders<ActionContext>(),
      createToolCallProvider(),
    ],
  });
}

export const actionRegistry = createPatchActionRegistry();
