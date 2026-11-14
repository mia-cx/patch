import { createHash } from "node:crypto";
import { ChannelType, type Message } from "discord.js";
import { Schema } from "effect";
import { observationNamespace } from "../conversation/observations.js";
import { buildRemoraRequest } from "../conversation/remora.js";
import { allowsConversation } from "../discord/scope.js";
import { MemoryManagementError } from "../memory/client.js";
import { MemoryMutationJournal } from "../memory/journal.js";
import {
  memoryPermissionFailure,
  memoryScopes,
  resolveMemoryBank,
} from "../memory/scope.js";
import {
  type MemoryToolOutcome,
  MemoryToolOutcomeSchema,
} from "../memory/tool-contract.js";
import {
  type ActionContext,
  type ActionRegistry,
  actionInput,
} from "./context.js";
import { isToolCallEvent, toolCall } from "./tool-calls.js";

export const MemorySaveArgs = Schema.Record(Schema.String, Schema.Never);
export const MemoryForgetArgs = Schema.Struct({
  scope: Schema.Literals(memoryScopes),
  kind: Schema.Literals(["fact", "evidence"]),
  id: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
});
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_CANDIDATES = 20;
const CANDIDATE_EXCERPT_CHARS = 120;
const DISCORD_MESSAGE_CHARS = 2_000;
const REQUEST_PREFIX =
  /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(remember|forget)\b[\s,:]+([\s\S]+)$/iu;

/** Register explicit controls separately from recurring followup registrations. */
export function registerMemoryTools(registry: ActionRegistry) {
  function register<S extends Schema.Decoder<unknown>>(
    name: string,
    description: string,
    schema: S,
    available: (context: ActionContext) => boolean,
    execute: (
      input: S["Type"],
      message: Message,
      context: ActionContext,
    ) => Promise<MemoryToolOutcome>,
  ) {
    const input = actionInput(schema);
    registry.registerAction({
      name,
      description,
      input,
      triggers: [toolCall({ name, description, usage: description, input })],
      availability: (context) =>
        context.harness && context.readBanks?.length && available(context)
          ? { available: true }
          : {
              available: false,
              reason: "memory operation unavailable in this conversation",
            },
      authorization: () => undefined,
      async execute(invocation, context) {
        if (
          !isToolCallEvent(invocation.rawEvent) ||
          !context.toolScope ||
          !context.harness
        )
          throw new Error("Memory tools require an authenticated human turn");
        const message = invocation.rawEvent.message;
        if (
          message.author.bot ||
          message.webhookId ||
          !allowsConversation(context.config, message)
        )
          throw new Error(
            "Memory tools require a human in the scoped conversation",
          );
        context.toolScope.signal.throwIfAborted();
        return Schema.decodeUnknownSync(MemoryToolOutcomeSchema, {
          onExcessProperty: "error",
        })(await execute(invocation.input, message, context));
      },
    });
  }
  register(
    "memory_save",
    "Save the current human's literal remember request. No paraphrases or other authors. Confirm only the returned receipt.",
    MemorySaveArgs,
    (context) => context.memory.supportsSave && Boolean(context.writeBank),
    async (_input, message, context) => {
      const request = REQUEST_PREFIX.exec(message.content.trim());
      if (
        request?.[1]?.toLowerCase() !== "remember" ||
        /^(?:that|this|it)[.!?]?$/iu.test(request[2]?.trim() ?? "")
      )
        return {
          memory_control: true,
          status: "clarification_required",
          content:
            "please say what you want me to remember in a direct remember request.",
        };
      const bound = buildRemoraRequest(
        context.config,
        message,
        message.guildId
          ? context.settings.getMemberRole(message.guildId)
          : undefined,
      );
      if (
        !bound?.write_bank ||
        bound.write_bank !== context.writeBank ||
        !context.readBanks?.includes(bound.write_bank)
      )
        throw new Error("No authorized memory write destination");
      // The same layers as an ordinary turn: a server save also reaches the server and the speaker.
      const layers = (bound.also_banks ?? []).map((layer) =>
        typeof layer === "string" ? layer : layer.bank,
      );
      const receipt = await context.memory.save({
        bank: bound.write_bank,
        ...(layers.length && context.memory.maxLayers >= layers.length
          ? { also_banks: layers }
          : {}),
        request_id: digest([
          "memory_save",
          message.id,
          message.editedTimestamp ?? 0,
        ]),
        source: {
          id: `discord:message:${message.id}`,
          revision: message.editedTimestamp ?? 0,
          actor_id: `discord:user:${message.author.id}`,
          text: message.content,
          observed_at: new Date(message.createdTimestamp).toISOString(),
        },
      });
      return {
        memory_control: true,
        status: receipt.status,
        receipt,
        content:
          receipt.status === "saved"
            ? `${receipt.replayed ? "already saved" : "saved"} as evidence #${receipt.saved_ids[0]}.`
            : "that save was completed earlier, but its memory has since been forgotten.",
      };
    },
  );
  register(
    "memory_forget",
    "Forget an exact authorized ID from a direct forget request. Omit id to list candidates for clarification; ambiguous requests delete nothing.",
    MemoryForgetArgs,
    (context) => context.memory.supportsManagement,
    async (input, message, context) => {
      const request = REQUEST_PREFIX.exec(message.content.trim());
      if (request?.[1]?.toLowerCase() !== "forget")
        return {
          memory_control: true,
          status: "clarification_required",
          content:
            "please make a direct forget request and identify the memory.",
        };
      if (input.scope === "personal" && message.channel.type !== ChannelType.DM)
        throw new Error("Manage personal memories in your DM");
      const permissions =
        message.guildId && "permissionsFor" in message.channel
          ? message.channel.permissionsFor(message.author)
          : null;
      const reason = memoryPermissionFailure(input.scope, "forget", {
        guildId: message.guildId,
        memberPermissions: permissions,
      });
      if (reason) throw new Error(reason);
      const bank = await resolveMemoryBank(input.scope, {
        guildId: message.guildId,
        channelId: message.channelId,
        channel: message.channel,
        user: message.author,
      });
      if (!context.readBanks?.includes(bank.bank))
        throw new Error("Memory bank is outside this conversation");
      if (input.kind === "evidence" && !context.memory.supportsEvidence)
        throw new MemoryManagementError("unsupported_feature");
      // Names and semantic matches are suggestions only. A current human must select
      // the namespace and ID; old tool outputs and retrieved quotes grant nothing.
      const selection =
        /^(fact|evidence)\s+#(\d+)(?:\s+(?:in|from)\s+(?:my|this|the)\s+(personal|channel|server))?[.!]?$/iu.exec(
          request[2]?.trim() ?? "",
        );
      const selected =
        selection &&
        selection[1]?.toLowerCase() === input.kind &&
        Number(selection[2]) === input.id &&
        (!selection[3] || selection[3].toLowerCase() === input.scope);
      if (!selected) {
        const page =
          input.kind === "evidence"
            ? await context.memory.listEvidence(bank.bank)
            : await context.memory.list(bank.bank);
        if (!page.data.length)
          return {
            memory_control: true,
            status: "clarification_required",
            candidates: [],
            content: "no memories were found in that scope. nothing forgotten.",
          };
        // The responder sends this as one Discord message; list only the candidates that fit.
        let content = `which memory should I forget? reply with "forget ${input.kind} #ID".`;
        const candidates: {
          id: number;
          kind: typeof input.kind;
          text: string;
        }[] = [];
        for (const { id, text } of page.data.slice(0, MAX_CANDIDATES)) {
          const line = `\n${input.kind} #${id}: ${text.slice(0, CANDIDATE_EXCERPT_CHARS)}`;
          if (content.length + line.length > DISCORD_MESSAGE_CHARS) break;
          content += line;
          candidates.push({ id, kind: input.kind, text });
        }
        return {
          memory_control: true,
          status: "clarification_required",
          candidates,
          content,
        };
      }
      if (input.id === undefined)
        throw new Error("An exact memory ID is required");
      const requestId = digest([
        "memory_forget",
        message.id,
        message.editedTimestamp ?? 0,
      ]);
      const namespace = observationNamespace(
        context.config.llmBaseUrl,
        context.config.llmApiKey,
      );
      const fingerprint = digest([
        bank.bank,
        input.kind,
        input.id,
        message.content,
        message.author.id,
      ]);
      const journal = new MemoryMutationJournal(context.config.settingsDbPath);
      try {
        let revision = journal.get(namespace, requestId, fingerprint);
        if (!revision) {
          const snapshot =
            input.kind === "evidence"
              ? await context.memory.listAllEvidence(bank.bank, 1_000_000)
              : await context.memory.listAll(bank.bank, 1_000_000);
          if (!snapshot.data.some(({ id }) => id === input.id))
            throw new MemoryManagementError("memory_not_found");
          revision = journal.freeze(
            namespace,
            requestId,
            fingerprint,
            snapshot.revision,
          );
        }
        const mutation = {
          bank: bank.bank,
          request_id: requestId,
          expected_revision: revision,
          ids: [input.id],
        };
        // Like /memory forget: other channels' generations finish first, and none
        // start until the backend deletion settles, so none can recall this memory.
        const receipt = await context.queue.add(
          async () => {
            context.toolScope?.signal.throwIfAborted();
            context.harness?.store.invalidateConversationData();
            context.harness?.web.invalidate();
            context.contextStore.resetMemoryContexts(
              [
                message.channelId,
                ...(context.config.discordTrialDmChannelId
                  ? [context.config.discordTrialDmChannelId]
                  : []),
              ],
              message.id,
            );
            return input.kind === "evidence"
              ? await context.memory.forgetEvidence(mutation)
              : await context.memory.forget(mutation);
          },
          { exclusive: true },
        );
        if (!receipt) throw new Error("Memory deletion did not run");
        return {
          memory_control: true,
          status: "forgotten",
          receipt,
          content: `${receipt.replayed ? "already forgotten" : "forgot"} ${input.kind} #${input.id}. memory-backed conversations restarted.`,
        };
      } finally {
        journal.close();
      }
    },
  );
}
