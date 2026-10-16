import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { Schema } from "effect";
import { slashCommand } from "protocord";
import { type Action, actionInput } from "./context.js";
import { isSlashInteraction } from "./permissions.js";

const ResetArgs = Schema.Struct({});
const NO_MENTIONS = { parse: [] as const, repliedUser: false };

/** Explicit owner control; never exposed as a model tool. */
export const resetContextAction: Action<typeof ResetArgs.Type> = {
  name: "reset_context",
  description:
    "Start the current conversation afresh on the next human message.",
  input: actionInput(ResetArgs),
  triggers: [
    slashCommand({
      name: "context",
      description: "Control this conversation's context",
      usage: "/context reset",
      registration: { dmPermission: true },
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "reset",
          description: "Start fresh from your next message",
        },
      ],
      parse(interaction) {
        if (interaction.options.getSubcommand(true) !== "reset")
          throw new Error("Unknown context command");
        return {};
      },
      async present(outcome, interaction) {
        if (outcome.status === "executed") return;
        const content =
          outcome.status === "failed"
            ? "couldn't reset context. try again."
            : outcome.reason;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content,
            allowedMentions: NO_MENTIONS,
          });
        } else {
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        }
      },
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => "owner",
  async execute(invocation, context) {
    const interaction = invocation.rawEvent;
    if (!invocation.channelId || !isSlashInteraction(interaction))
      throw new Error("reset_context requires a channel slash command");
    const channelId = invocation.channelId;
    // Hold the channel through confirmation: active generations finish before
    // success, and queued pre-reset turns are rejected by the persisted boundary.
    await context.queue.add(
      () =>
        context.contextStore.resetAfterConfirmation(channelId, () =>
          interaction.editReply({
            content:
              "context reset. your next message starts a new conversation.",
            allowedMentions: NO_MENTIONS,
          }),
        ),
      { priority: "leave", bucketKey: channelId },
    );
    context.logger.info(
      { channelId, userId: invocation.requester?.id },
      "reset conversation context",
    );
  },
};
