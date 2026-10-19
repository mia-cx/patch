import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  escapeMarkdown,
} from "discord.js";
import { Schema } from "effect";
import { slashCommand } from "protocord";
import { MemoryManagementError, type MemoryRecord } from "../memory/client.js";
import type { EvidenceRecord } from "../memory/evidence.js";
import { memoryScopes, resolveMemoryBank } from "../memory/scope.js";
import { type Action, actionInput } from "./context.js";
import { isSlashInteraction } from "./permissions.js";

const Scope = Schema.Literals(memoryScopes);
const RecordKind = Schema.Literals(["fact", "evidence"]);
const ListKind = Schema.Literals(["all", "fact", "evidence"]);
const MemoryArgs = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("list"),
    scope: Scope,
    kind: Schema.optional(ListKind),
  }),
  Schema.Struct({
    operation: Schema.Literal("forget"),
    scope: Scope,
    ids: Schema.String,
    kind: Schema.optional(RecordKind),
  }),
  Schema.Struct({
    operation: Schema.Literal("forget_source"),
    scope: Scope,
    id: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    context_index: Schema.optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(15),
      ),
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("clear"),
    scope: Scope,
    confirm: Schema.Boolean,
  }),
]);
const NO_MENTIONS = { parse: [] as const, repliedUser: false };
const MAX_INLINE_LENGTH = 1900;
const scopeOption = {
  type: ApplicationCommandOptionType.String as const,
  name: "scope",
  description: "Which memories: personal, current channel, or server",
  choices: memoryScopes.map((value) => ({ name: value, value })),
};

/** Explicit storage controls through Protocord; never offered to the language model. */
export const memoryAction: Action<typeof MemoryArgs.Type> = {
  name: "memory",
  description: "Inspect and forget accessible saved memories.",
  input: actionInput(MemoryArgs),
  triggers: [
    slashCommand({
      name: "memory",
      description: "Inspect or forget saved memories",
      usage: "/memory list | forget ids:<IDs> | clear confirm:true [scope]",
      registration: { dmPermission: true },
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "list",
          description: "Show all memories you can read",
          options: [
            scopeOption,
            {
              type: ApplicationCommandOptionType.String,
              name: "kind",
              description: "Facts, quoted evidence, or both",
              choices: ["all", "fact", "evidence"].map((value) => ({
                name: value,
                value,
              })),
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "forget",
          description:
            "Forget specific memory IDs and restart memory-backed conversations",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "ids",
              description:
                "Memory IDs from /memory list, separated by spaces or commas",
              required: true,
              maxLength: 2000,
            },
            scopeOption,
            {
              type: ApplicationCommandOptionType.String,
              name: "kind",
              description: "Canonical fact or attributed quotation",
              choices: ["fact", "evidence"].map((value) => ({
                name: value,
                value,
              })),
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "forget-source",
          description:
            "Forget a listed quotation's source and its dependent copies",
          options: [
            {
              type: ApplicationCommandOptionType.Integer,
              name: "id",
              description: "Evidence ID from /memory list",
              required: true,
              minValue: 1,
              maxValue: Number.MAX_SAFE_INTEGER,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "context",
              description: "Supporting context index; omit for the main source",
              minValue: 0,
              maxValue: 15,
            },
            scopeOption,
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "clear",
          description:
            "Forget all memories in this scope and restart memory-backed conversations",
          options: [
            {
              type: ApplicationCommandOptionType.Boolean,
              name: "confirm",
              description:
                "Confirm forgetting every saved memory in the chosen scope",
              required: true,
            },
            scopeOption,
          ],
        },
      ],
      parse(interaction) {
        const scopeValue =
          interaction.options.getString("scope") ??
          (interaction.guildId ? "channel" : "personal");
        const scope = memoryScopes.find((value) => value === scopeValue);
        if (!scope) throw new Error("Unknown memory scope");
        const operation = interaction.options.getSubcommand(true);
        if (operation === "forget")
          return {
            operation,
            scope,
            ids: interaction.options.getString("ids", true),
            kind: Schema.decodeUnknownSync(RecordKind)(
              interaction.options.getString("kind") ?? "fact",
            ),
          };
        if (operation === "forget-source") {
          const context = interaction.options.getInteger("context");
          return {
            operation: "forget_source",
            scope,
            id: interaction.options.getInteger("id", true),
            ...(context !== null ? { context_index: context } : {}),
          };
        }
        if (operation === "clear")
          return {
            operation,
            scope,
            confirm: interaction.options.getBoolean("confirm", true),
          };
        if (operation === "list")
          return {
            operation,
            scope,
            kind: Schema.decodeUnknownSync(ListKind)(
              interaction.options.getString("kind") ?? "all",
            ),
          };
        throw new Error("Unknown memory operation");
      },
      async present(outcome, interaction) {
        if (outcome.status === "executed") return;
        const content =
          outcome.status === "failed"
            ? memoryFailure(outcome.error)
            : outcome.reason;
        if (interaction.replied)
          await interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
        else if (interaction.deferred)
          await interaction.editReply({
            content,
            allowedMentions: NO_MENTIONS,
          });
        else
          await interaction.reply({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_MENTIONS,
          });
      },
    }),
  ],
  availability: () => ({ available: true }),
  authorization: ({ input }) => ({
    kind: "memory",
    scope: input.scope,
    operation: input.operation === "list" ? "read" : "forget",
  }),
  async execute({ input, rawEvent }, context) {
    if (!isSlashInteraction(rawEvent))
      throw new Error("Memory controls require a slash command");
    const interaction = rawEvent;
    if (input.operation === "clear" && !input.confirm) {
      await interaction.editReply({
        content:
          "nothing deleted. use confirm:true to forget every memory in the chosen scope.",
        allowedMentions: NO_MENTIONS,
      });
      return;
    }
    const limits = await context.memory.getLimits();
    const evidence =
      input.operation === "forget_source" ||
      (input.operation === "forget" && input.kind === "evidence");
    if (evidence && !context.memory.supportsEvidence)
      throw new MemoryManagementError("unsupported_feature");
    const ids =
      input.operation === "forget"
        ? parseIds(input.ids, limits.forgetIds)
        : undefined;
    const bank = await resolveMemoryBank(input.scope, interaction);
    if (input.operation === "list") {
      if (input.kind === "evidence" && !context.memory.supportsEvidence)
        throw new MemoryManagementError("unsupported_feature");
      const snapshot =
        input.kind !== "evidence"
          ? await context.memory.listAll(
              bank.bank,
              interaction.attachmentSizeLimit,
            )
          : undefined;
      const quotations =
        input.kind !== "fact" && context.memory.supportsEvidence
          ? await context.memory.listAllEvidence(
              bank.bank,
              interaction.attachmentSizeLimit,
            )
          : undefined;
      await presentMemories(
        interaction,
        bank.label,
        snapshot?.data ?? [],
        quotations?.data,
      );
      return;
    }
    const requestId = interaction.id;
    if (Array.from(requestId).length > limits.requestIdChars)
      throw new MemoryManagementError("invalid_request_id");
    // The same credential may read derived facts in other banks. Hold every
    // generation until deletion and its Discord confirmation have settled.
    await context.queue.add(
      async () => {
        let fenced = false;
        try {
          const snapshot = evidence
            ? await context.memory.listEvidence(bank.bank)
            : await context.memory.list(bank.bank);
          const fallback = bank.channelId
            ? [bank.channelId]
            : [interaction.channelId];
          if (context.config.discordTrialDmChannelId)
            fallback.push(context.config.discordTrialDmChannelId);
          context.contextStore.resetMemoryContexts(fallback, interaction.id);
          fenced = true;
          context.harness?.store.invalidateConversationData();
          const request = {
            bank: bank.bank,
            request_id: requestId,
            expected_revision: snapshot.revision,
          };
          const result =
            input.operation === "forget_source"
              ? await context.memory.forgetEvidenceSource({
                  ...request,
                  id: input.id,
                  ...(input.context_index !== undefined
                    ? { context_index: input.context_index }
                    : {}),
                })
              : ids
                ? evidence
                  ? await context.memory.forgetEvidence({ ...request, ids })
                  : await context.memory.forget({ ...request, ids })
                : await context.memory.clear(request);
          const count = result.deleted_count;
          const place =
            input.scope === "personal" ? "your DM" : `this ${input.scope}`;
          const suppression = result.dependent_suppression.visible_active_count;
          const content =
            input.operation === "clear" && context.memory.supportsEvidence
              ? `${result.replayed ? "already completed: " : ""}cleared facts and evidence from ${place}. memory-backed conversations restarted.`
              : `${result.replayed ? "already completed: " : ""}forgot ${count} ${count === 1 ? "memory" : "memories"} from ${place}.${suppression ? ` ${suppression} dependent ${suppression === 1 ? "memory is" : "memories are"} no longer available.` : ""} memory-backed conversations restarted.`;
          context.logger.info(
            {
              bank: bank.bank,
              operation: input.operation,
              deletedCount: count,
              replayed: result.replayed,
              interactionId: interaction.id,
            },
            "memory mutation confirmed",
          );
          await interaction.editReply({
            content,
            allowedMentions: NO_MENTIONS,
          });
        } catch (error) {
          context.logger.warn(
            {
              error,
              bank: bank.bank,
              operation: input.operation,
              interactionId: interaction.id,
            },
            "memory command did not finish",
          );
          await interaction.editReply({
            content: `${memoryFailure(error)}${fenced ? " memory-backed conversation context was reset." : ""}`,
            allowedMentions: NO_MENTIONS,
          });
        }
      },
      { exclusive: true },
    );
  },
};

function parseIds(value: string, limit: number): number[] {
  const tokens = value.trim().split(/[\s,]+/u);
  const ids = tokens.map(Number);
  if (
    tokens.some((token) => !/^\d+$/u.test(token)) ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  )
    throw new MemoryManagementError("invalid_ids");
  if (ids.length > limit) throw new MemoryManagementError("too_many_ids");
  return ids;
}

async function presentMemories(
  interaction: ChatInputCommandInteraction,
  label: string,
  memories: readonly MemoryRecord[],
  evidence?: readonly EvidenceRecord[],
) {
  if (memories.length === 0 && !evidence?.length) {
    await interaction.editReply({
      content: `${label}: none saved.`,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  const listing = memories
    .map(
      (memory) =>
        `${evidence === undefined ? "" : "fact "}#${memory.id} ${escapeMarkdown(memory.text)}`,
    )
    .join("\n\n");
  const quotations = evidence
    ?.map((record) => {
      const provenance = (source: EvidenceRecord["source"]) => {
        const voice = source.actor?.actor
          ? `${source.actor.actor.role} ${source.actor.actor.id}`
          : (source.actor?.entity ?? "unknown");
        return [
          source.origin,
          `actor ${voice}`,
          ...(source.tool ? [`tool ${source.tool}`] : []),
          ...(source.url ? [source.url] : []),
        ]
          .map((value) => escapeMarkdown(value))
          .join("; ");
      };
      return `evidence #${record.id} (${provenance(record.source)}; subjects unresolved)\n${escapeMarkdown(record.text)}${record.context.map((item, index) => `\ncontext ${index} (${provenance(item.source)}): ${escapeMarkdown(item.text)}`).join("")}`;
    })
    .join("\n\n");
  const content = `${label}\n\n${[listing, quotations].filter(Boolean).join("\n\n")}`;
  if (content.length <= MAX_INLINE_LENGTH && !evidence?.length) {
    await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
    return;
  }
  const file = Buffer.from(
    JSON.stringify(
      evidence === undefined ? memories : { statements: memories, evidence },
      null,
      2,
    ),
  );
  if (file.byteLength > interaction.attachmentSizeLimit)
    throw new MemoryManagementError("export_too_large");
  await interaction.editReply({
    // Evidence includes source identities, spans and supporting contexts beyond its inline summary.
    content:
      content.length <= MAX_INLINE_LENGTH
        ? content
        : `${memories.length + (evidence?.length ?? 0)} saved memories. the file contains the full list and IDs.`,
    files: [new AttachmentBuilder(file, { name: "memories.json" })],
    allowedMentions: NO_MENTIONS,
  });
}

function memoryFailure(error: unknown): string {
  const code = error instanceof MemoryManagementError ? error.code : undefined;
  switch (code) {
    case "unsupported_feature":
      return "memory controls aren't enabled on this Remora server.";
    case "memory_forbidden":
    case "bank_forbidden":
      return "you don't have access to this memory bank or operation.";
    case "memory_not_found":
      return "one or more memory IDs aren't available. run /memory list again.";
    case "cursor_stale":
    case "invalid_cursor":
    case "memory_revision_conflict":
    case "policy_changed":
      return "memories or access changed. run /memory list and try again.";
    case "shared_evidence_conflict":
      return "these memories share evidence with other saved memories. select all related IDs or use /memory clear.";
    case "invalid_ids":
      return "use distinct whole-number IDs from /memory list, separated by spaces or commas.";
    case "too_many_ids":
      return "too many memory IDs for one command. forget a smaller batch.";
    case "export_too_large":
      return "the full memory list exceeds Discord's attachment limit.";
    default:
      return "couldn't confirm the memory command. run /memory list to check before trying again.";
  }
}
