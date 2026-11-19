import { ApplicationCommandOptionType, PermissionsBitField } from "discord.js";
import { Schema } from "effect";
import { slashCommand } from "protocord";
import { type Action, actionInput } from "./context.js";

const MemberRoleArgs = Schema.Struct({
  guildId: Schema.String,
  roleId: Schema.optional(Schema.String),
  reset: Schema.Boolean,
});

/**
 * Server admins choose the role whose access makes a channel public. Channels and
 * threads that role can't see keep their memories out of the server-wide bank.
 */
export const memberRoleAction: Action<typeof MemberRoleArgs.Type, string> = {
  name: "member_role",
  description: "Show or set the role that defines public channels for memory.",
  input: actionInput(MemberRoleArgs),
  triggers: [
    slashCommand({
      name: "member-role",
      description:
        "Role whose visible channels count as public for server memory",
      usage: "/member-role [role:<role>] [reset:true]",
      registration: {
        dmPermission: false,
        defaultMemberPermissions: PermissionsBitField.Flags.ManageGuild,
      },
      options: [
        {
          type: ApplicationCommandOptionType.Role,
          name: "role",
          description: "Members role; leave empty to show the current one",
        },
        {
          type: ApplicationCommandOptionType.Boolean,
          name: "reset",
          description: "Go back to @everyone",
        },
      ],
      parse: (interaction) => {
        if (!interaction.guildId) throw new Error("Server only");
        return {
          guildId: interaction.guildId,
          roleId: interaction.options.getRole("role")?.id,
          reset: interaction.options.getBoolean("reset") ?? false,
        };
      },
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => "manage_server",
  async execute({ input }, context) {
    const { guildId, roleId, reset } = input;
    if (reset || roleId === guildId) {
      context.settings.setMemberRole(guildId, undefined);
      return "public channels are now the ones @everyone can see.";
    }
    if (roleId) {
      context.settings.setMemberRole(guildId, roleId);
      return `public channels are now the ones <@&${roleId}> can see.`;
    }
    const current = context.settings.getMemberRole(guildId);
    return current
      ? `public channels are the ones <@&${current}> can see.`
      : "public channels are the ones @everyone can see.";
  },
};
