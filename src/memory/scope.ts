import {
  ChannelType,
  type ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";

export const memoryScopes = ["personal", "channel", "server"] as const;
export type MemoryScope = (typeof memoryScopes)[number];

type PermissionContext = Pick<
  ChatInputCommandInteraction,
  "guildId" | "memberPermissions"
>;

/** Shared memory follows Discord access; managing the bot never grants another person's bank. */
export function memoryPermissionFailure(
  scope: MemoryScope,
  operation: "read" | "forget",
  interaction: PermissionContext,
): string | undefined {
  if (scope === "personal") return;
  if (!interaction.guildId) return "choose personal memories in a DM.";
  const permissions = interaction.memberPermissions;
  const { ViewChannel, ReadMessageHistory, ManageMessages, ManageGuild } =
    PermissionsBitField.Flags;
  if (!permissions?.has([ViewChannel, ReadMessageHistory]))
    return "you need View Channel and Read Message History here.";
  if (operation === "read") return;
  const required = scope === "channel" ? ManageMessages : ManageGuild;
  if (!permissions.has(required))
    return scope === "channel"
      ? "you need Manage Messages to forget channel memories."
      : "you need Manage Server to forget server memories.";
}

type BankContext = {
  guildId: string | null;
  channelId: string;
  channel: { type: ChannelType } | null;
  user: { createDM(): Promise<{ id: string }> };
};

/** Resolve banks from the signed invocation, never a caller-supplied opaque bank ID. */
export async function resolveMemoryBank(
  scope: MemoryScope,
  interaction: BankContext,
) {
  if (scope === "personal") {
    const channelId =
      interaction.channel?.type === ChannelType.DM
        ? interaction.channelId
        : (await interaction.user.createDM()).id;
    return {
      scope,
      bank: `discord:dm:${channelId}`,
      label: "your personal memories",
      channelId,
    };
  }
  if (!interaction.guildId)
    throw new Error("Shared memory requires a server interaction");
  if (scope === "channel")
    return {
      scope,
      bank: `discord:channel:${interaction.channelId}`,
      label: "this channel's memories",
      channelId: interaction.channelId,
    };
  return {
    scope,
    bank: `discord:guild:${interaction.guildId}`,
    label: "this server's memories",
    guildId: interaction.guildId,
  };
}
