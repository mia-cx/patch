import type { ActionRegistry } from "./context.js";
import { deleteMessagesAction } from "./delete.js";
import { registerHarnessActions } from "./harness.js";
import { leaveThreadAction } from "./leave.js";
import { memoryAction } from "./memory.js";
import { modelAction } from "./model.js";
import { actionRegistry } from "./registry.js";
import { reloadRuntimeAction } from "./reload.js";
import { resetContextAction } from "./reset.js";

export function registerDefaultActions(
  registry: ActionRegistry = actionRegistry,
): void {
  registry.registerAction(deleteMessagesAction);
  registry.registerAction(leaveThreadAction);
  registry.registerAction(modelAction);
  registry.registerAction(reloadRuntimeAction);
  registry.registerAction(resetContextAction);
  registry.registerAction(memoryAction);
  registerHarnessActions(registry);
}
