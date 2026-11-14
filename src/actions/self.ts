import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  type ChatInputCommandInteraction,
  InteractionContextType,
} from "discord.js";
import { Schema } from "effect";
import { slashCommand } from "protocord";
import { SELF_BANK } from "../conversation/remora.js";
import { getBotIdentity } from "../identity.js";
import { MemoryManagementError } from "../memory/client.js";
import { isApplicationTeamMember } from "../memory/self.js";
import { type Action, type ActionContext, actionInput } from "./context.js";
import { isSlashInteraction } from "./permissions.js";

const SelfArgs = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("add"), statement: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("list") }),
  Schema.Struct({
    operation: Schema.Literal("forget"),
    id: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
]);
const MAX_REPLY = 1900;

/**
 * Patch's self: facts about her alone, kept in one global bank that every
 * conversation reads and none writes. Only the Discord application's team can add or
 * forget them. The command is user-installed, so it appears only for people who added
 * Patch to their own account (never to server admins), in servers and DMs alike; the
 * handler refuses anyone outside the team anyway.
 */
export const selfAction: Action<typeof SelfArgs.Type, string> = {
  name: "self",
  description: "Manage facts about Patch herself.",
  input: actionInput(SelfArgs),
  triggers: [
    slashCommand({
      name: "self",
      description: `Facts about ${getBotIdentity().name} herself (app team only)`,
      usage: "/self add statement:<about Patch> | list | forget id:<ID>",
      registration: {
        integrationTypes: [ApplicationIntegrationType.UserInstall],
        contexts: [
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        ],
      },
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "add",
          description: `Teach ${getBotIdentity().name} a fact about herself`,
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "statement",
              description: `In her voice ("I love teal") or by name ("${getBotIdentity().name} loves teal")`,
              required: true,
              maxLength: 4000,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "list",
          description: "Show the stored self facts with their IDs",
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "forget",
          description: "Forget one stored self fact",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "id",
              description: "ID from /self list",
              required: true,
              minValue: 1,
              maxValue: Number.MAX_SAFE_INTEGER,
            },
          ],
        },
      ],
      parse(interaction) {
        const operation = interaction.options.getSubcommand(true);
        if (operation === "add")
          return {
            operation,
            statement: interaction.options.getString("statement", true),
          };
        if (operation === "forget")
          return { operation, id: interaction.options.getInteger("id", true) };
        if (operation === "list") return { operation };
        throw new Error("Unknown self operation");
      },
    }),
  ],
  availability: (context) =>
    context.selfMemory
      ? { available: true }
      : { available: false, reason: "self memory is not configured" },
  authorization: () => "team",
  async execute({ input, rawEvent }, context) {
    if (!isSlashInteraction(rawEvent))
      throw new Error("Self memory requires a slash command");
    // Authorization already checked the team; check again where the write happens.
    if (!(await isApplicationTeamMember(rawEvent.client, rawEvent.user.id)))
      return "nope, that's for Patch's team only.";
    const self = context.selfMemory;
    if (!self) throw new MemoryManagementError("unsupported_feature");
    if (input.operation === "add")
      return add(rawEvent, input.statement, self, context);
    if (input.operation === "list") return list(self);
    const page = await self.listEvidence(SELF_BANK);
    const result = await self.forgetEvidence({
      bank: SELF_BANK,
      ids: [input.id],
      request_id: rawEvent.id,
      expected_revision: page.revision,
    });
    context.logger.info(
      { userId: rawEvent.user.id, deleted: result.deleted_ids },
      "forgot self fact",
    );
    return `${result.replayed ? "already done: " : ""}forgot self fact #${input.id}.`;
  },
};

async function add(
  interaction: ChatInputCommandInteraction,
  statement: string,
  self: NonNullable<ActionContext["selfMemory"]>,
  context: ActionContext,
) {
  const identity = getBotIdentity();
  const receipt = await self.saveStatement({
    bank: SELF_BANK,
    request_id: interaction.id,
    source: {
      id: `discord:interaction:${interaction.id}`,
      revision: 0,
      // Her stable self: the bot's user ID, so renames keep the same identity.
      entity_id: `discord:user:${interaction.client.user.id}`,
      label: identity.name,
      aliases: identity.aliases.slice(0, 8),
      text: statement,
      observed_at: new Date(interaction.createdTimestamp).toISOString(),
    },
  });
  context.logger.info(
    {
      userId: interaction.user.id,
      saved: receipt.saved_ids,
      atoms: receipt.atoms,
    },
    "added self fact",
  );
  const lines = [
    `saved #${receipt.saved_ids.join(", #")}${receipt.replayed ? " (already saved)" : ""}:`,
    ...receipt.atoms.map((atom) => `- ${atom}`),
    ...(receipt.context.length
      ? ["context:", ...receipt.context.map((atom) => `- ${atom}`)]
      : []),
    ...(receipt.attached.length
      ? [`attached to #${receipt.attached.join(", #")}`]
      : []),
  ];
  return clip(lines.join("\n"));
}

/** Each fact with its atoms, and the context records attached to it nested beneath. */
async function list(self: NonNullable<ActionContext["selfMemory"]>) {
  const page = await self.listAllEvidence(SELF_BANK, 1_000_000);
  if (!page.data.length) return "no self facts yet.";
  const listed = new Set(page.data.map((record) => record.id));
  const nested = (record: (typeof page.data)[number]) =>
    record.attached_to?.some((id) => listed.has(id)) ?? false;
  return clip(
    page.data
      .filter((record) => !nested(record))
      .map((record) =>
        [
          `#${record.id}: ${record.text}`,
          ...(record.atoms ?? []).map((atom) => `  - ${atom}`),
          ...page.data
            .filter((other) => other.attached_to?.includes(record.id))
            .map((other) => `  - #${other.id}: ${other.text}`),
        ].join("\n"),
      )
      .join("\n"),
  );
}

function clip(text: string) {
  return text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY - 1)}…` : text;
}
