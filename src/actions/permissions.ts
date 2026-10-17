import {
  type ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";
import type { Authorize } from "protocord";
import type { Config } from "../config.js";
import { memoryPermissionFailure } from "../memory/scope.js";
import type { ActionContext, ActionPermission } from "./context.js";

type OwnerConfig = Pick<Config, "botOwnerUserIds">;

type DeletePermissionInput = {
  userId: string;
  guildId?: string | null | undefined;
  memberPermissions?: ChatInputCommandInteraction["memberPermissions"];
};

export function isOwner(userId: string, config: OwnerConfig): boolean {
  return config.botOwnerUserIds.has(userId);
}

export function canDeleteBotMessages(
  input: DeletePermissionInput,
  config: OwnerConfig,
): boolean {
  if (isOwner(input.userId, config)) return true;
  if (!input.guildId) return true;
  return Boolean(
    input.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages),
  );
}

/** Apply Patch's owner and moderation policies during Protocord dispatch. */
export const authorizeAction: Authorize<ActionContext, ActionPermission> = (
  permission,
  invocation,
  context,
) => {
  if (typeof permission !== "string") {
    const interaction = invocation.rawEvent;
    if (!isSlashInteraction(interaction))
      return { authorized: false, reason: "use /memory to manage memories." };
    const reason = memoryPermissionFailure(
      permission.scope,
      permission.operation,
      interaction,
    );
    return reason ? { authorized: false, reason } : { authorized: true };
  }
  const userId = invocation.requester?.id;
  if (permission === "owner") {
    return userId && isOwner(userId, context.config)
      ? { authorized: true }
      : { authorized: false, reason: "nope, owner-only." };
  }
  const interaction = invocation.rawEvent;
  const allowed =
    userId &&
    isSlashInteraction(interaction) &&
    canDeleteBotMessages(
      {
        userId,
        guildId: interaction.guildId,
        memberPermissions: interaction.memberPermissions,
      },
      context.config,
    );
  return allowed
    ? { authorized: true }
    : { authorized: false, reason: "nope, you need Manage Messages here." };
};

/** Narrow a Discord event at the action/interaction seam. */
export function isSlashInteraction(
  event: unknown,
): event is ChatInputCommandInteraction {
  return (
    event !== null &&
    typeof event === "object" &&
    "isChatInputCommand" in event &&
    typeof event.isChatInputCommand === "function" &&
    event.isChatInputCommand()
  );
}
