import type { Interaction } from "discord.js";
import { handleDiscordInteraction } from "protocord";
import type { ActionContext, ActionRegistry } from "../../actions/context.js";
import { authorizeAction } from "../../actions/permissions.js";

/** Dispatch Discord events through Protocord and report action/presentation failures. */
export async function dispatchInteraction(input: {
  interaction: Interaction;
  context: ActionContext;
  registry: ActionRegistry;
}): Promise<void> {
  const { interaction, context, registry } = input;
  const handled = await handleDiscordInteraction(
    registry,
    interaction,
    { ...context, channel: interaction.channel },
    authorizeAction,
  );
  if (!handled.handled) return;
  if (handled.type === "autocomplete") return;
  const { result } = handled;
  if (result.outcome.status === "failed") {
    context.logger.error(
      {
        error: result.outcome.error,
        action: result.actionName,
        interactionId: interaction.id,
      },
      "action trigger failed",
    );
  }
  if (result.presentationError !== undefined) {
    context.logger.error(
      {
        error: result.presentationError,
        action: result.actionName,
        interactionId: interaction.id,
      },
      "failed to present action result",
    );
  }
}
