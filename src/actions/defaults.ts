import type { ActionRegistry } from "./context.js";
import { deleteMessagesAction } from "./delete.js";
import { leaveThreadAction } from "./leave.js";
import { modelAction } from "./model.js";
import { actionRegistry } from "./registry.js";
import { reloadRuntimeAction } from "./reload.js";

export function registerDefaultActions(
  registry: ActionRegistry = actionRegistry,
): void {
  registry.registerAction(deleteMessagesAction);
  registry.registerAction(leaveThreadAction);
  registry.registerAction(modelAction);
  registry.registerAction(reloadRuntimeAction);
}
