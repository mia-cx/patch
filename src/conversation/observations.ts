import { createHash } from "node:crypto";
import type { Message } from "discord.js";
import type { LlmMessage } from "../llm/client.js";
import {
  type ObservationBatch,
  type ObservationInput,
  type ObservationLimits,
  decodeObservationView,
  validateObservationBatch,
} from "../llm/evidence.js";
import type { RemoraRequest } from "../llm/remora.js";
import type { HarnessStore, ObservationContext } from "../tools/store.js";
import type { TranscriptBlock } from "./types.js";

type Source = Omit<ObservationInput, "views" | "context">;
type Candidate = {
  source: Source;
  digest: string;
  views: ObservationInput["views"][number][];
  context: readonly ObservationContext[];
  frozen: boolean;
};

/** Compile exact source views after all tool insertions. Assistant display remains untracked. */
export class ConversationObservations {
  private readonly cutoff: bigint;
  private readonly bank: string;

  constructor(
    private readonly options: {
      store: HarnessStore;
      remora: RemoraRequest;
      message: Message;
      botUserId: string;
      startId: string;
      limits: ObservationLimits;
    },
  ) {
    const bank = options.remora.write_bank;
    if (!bank || !options.remora.turn)
      throw new Error("Observation destination is missing");
    this.bank = bank;
    this.cutoff = options.store.observationCutoff(bank, options.startId);
  }

  /** Bind only original human text from this destination channel after its cutover. */
  humanSource(block: TranscriptBlock): Source | undefined {
    if (
      block.role !== "human" ||
      !block.id ||
      !block.source ||
      block.channelId !== this.options.message.channelId ||
      BigInt(block.id) <= this.cutoff ||
      !block.source.text.trim()
    )
      return;
    return this.human(block.id, block.source.revision, block.authorId);
  }

  /** The current user body is literal, never the adapter's mention-stripped history text. */
  currentMessage(): LlmMessage {
    const message = this.options.message;
    return {
      role: "user",
      content: message.content,
      ...(BigInt(message.id) > this.cutoff && message.content.trim()
        ? {
            observationSources: [
              {
                source: this.human(
                  message.id,
                  message.editedTimestamp ?? 0,
                  message.author.id,
                ),
                start: 0,
                end: message.content.length,
              },
            ],
          }
        : {}),
    };
  }

  /** Freeze input manifests across parameter retries; generated attempt IDs belong to Remora. */
  request(messages: readonly LlmMessage[]): RemoraRequest {
    const { limits, store, remora, message, botUserId } = this.options;
    const candidates = new Map<string, Candidate>();
    for (const [messageIndex, rendered] of messages.entries()) {
      for (const segment of rendered.observationSources ?? []) {
        const source = segment.source;
        const text = decodeObservationView(
          rendered.content.slice(segment.start, segment.end),
          segment.encoding,
        );
        const digest = hash(JSON.stringify([source, text]));
        const candidate = candidates.get(source.id);
        if (candidate && candidate.digest !== digest)
          throw new Error("Observation source views conflict");
        const view = {
          message_index: messageIndex,
          start: Array.from(rendered.content.slice(0, segment.start)).length,
          end: Array.from(rendered.content.slice(0, segment.end)).length,
          ...(segment.encoding ? { encoding: segment.encoding } : {}),
        };
        if (candidate) candidate.views.push(view);
        else
          candidates.set(source.id, {
            source,
            digest,
            views: [view],
            context: [],
            frozen: false,
          });
      }
    }
    const currentId = `discord:message:${message.id}`;
    for (const candidate of candidates.values()) {
      const context = store.observationContext(
        this.bank,
        candidate.source.id,
        candidate.source.revision,
        candidate.digest,
      );
      if (context) {
        candidate.context = context;
        candidate.frozen = true;
      }
    }
    // A new turn must not inherit an already unavailable history chain after rollover.
    pruneUnavailable(candidates);
    const humans = [...candidates.values()].filter(
      (candidate) =>
        candidate.source.origin === "human_input" &&
        candidate.source.id !== currentId,
    );
    for (const candidate of candidates.values()) {
      // A new human can use the preceding observed human. Tool excerpts use the current turn.
      // Stored manifests win on retries and later history renders; context never slides silently.
      const parent =
        candidate.source.id === currentId
          ? humans.at(-1)
          : candidate.source.origin === "external_observation"
            ? candidates.get(currentId)
            : undefined;
      candidate.context = store.freezeObservation(
        this.bank,
        candidate.source.id,
        candidate.source.revision,
        candidate.digest,
        candidate.frozen
          ? candidate.context
          : parent
            ? [
                {
                  id: parent.source.id,
                  revision: parent.source.revision,
                  digest: parent.digest,
                },
              ]
            : [],
      );
    }
    pruneUnavailable(candidates);
    const inputs = [...candidates.values()].map((candidate) => ({
      ...candidate.source,
      views: candidate.views,
      context: candidate.context.map(({ id }) => id),
    }));
    const observations: ObservationBatch = {
      bank: this.bank,
      id: `patch:batch:${hash(JSON.stringify([this.bank, inputs.map(({ views: _, ...input }) => input), [...candidates.values()].map(({ digest }) => digest), botUserId]))}`,
      revision: 0,
      inputs,
      generated: {
        actor: {
          bank: this.bank,
          role: "assistant",
          id: `discord:user:${botUserId}`,
        },
      },
    };
    validateObservationBatch(observations, messages, limits);
    return {
      read_banks: remora.read_banks,
      speaker: { bank: this.bank, id: `discord:user:${message.author.id}` },
      ...(remora.recall ? { recall: remora.recall } : {}),
      observations,
    };
  }

  private human(id: string, revision: number, authorId: string): Source {
    return {
      id: `discord:message:${id}`,
      revision,
      origin: "human_input",
      actor: { bank: this.bank, role: "human", id: `discord:user:${authorId}` },
    };
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Missing or edited context removes historical dependents, never changes their manifest. */
function pruneUnavailable(candidates: Map<string, Candidate>) {
  let removed: boolean;
  do {
    removed = false;
    for (const [id, candidate] of candidates) {
      if (
        candidate.context.some((context) => {
          const parent = candidates.get(context.id);
          return (
            !parent ||
            parent.digest !== context.digest ||
            parent.source.revision !== context.revision
          );
        })
      ) {
        candidates.delete(id);
        removed = true;
      }
    }
  } while (removed);
}
