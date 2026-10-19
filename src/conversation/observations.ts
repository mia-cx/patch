import { createHash } from "node:crypto";
import type { Message } from "discord.js";
import type { LlmMessage, LlmResponse } from "../llm/client.js";
import {
  type CompletedGeneration,
  type ObservationBatch,
  type ObservationInput,
  type ObservationLimits,
  type ObservationReference,
  type ObservationSegment,
  decodeObservationView,
  validateObservationBatch,
} from "../llm/evidence.js";
import type { RemoraRequest } from "../llm/remora.js";
import type {
  ConsumedSource,
  HarnessStore,
  ObservationContext,
} from "../tools/store.js";
import type { ConversationMessage, TranscriptBlock } from "./types.js";

type Source = Omit<ObservationInput, "views" | "context">;
type Candidate = {
  source: Source;
  digest: string;
  views: ObservationInput["views"][number][];
  context: readonly ObservationContext[];
  proposed: readonly string[] | undefined;
  frozen: boolean;
};

/** A privacy fence cancels presentation and side effects as well as retention. */
export class ObservationAttemptInvalidated extends Error {}

/** Exact input coverage and authenticated generated parents share one durable forgetting epoch. */
export class ConversationObservations {
  private readonly cutoff: bigint;
  readonly bank: string;
  readonly epoch: number;
  private readonly namespace: string;
  private readonly sourceRevisions = new Map<string, number>();
  private consumed: readonly ConsumedSource[] = [];

  constructor(
    private readonly options: {
      store: HarnessStore;
      remora: RemoraRequest;
      message: Message;
      botUserId: string;
      startId: string;
      limits: ObservationLimits;
      namespace?: string;
    },
  ) {
    const bank = options.remora.write_bank;
    if (!bank || !options.remora.turn)
      throw new Error("Observation destination is missing");
    this.bank = bank;
    this.namespace = options.namespace ?? "";
    this.cutoff = options.store.observationCutoff(bank, options.startId);
    this.epoch = options.store.privacyEpoch();
  }

  /** Only actual new human messages in this destination can supply a human actor. */
  humanSource(block: TranscriptBlock): Source | undefined {
    if (
      block.role === "human" &&
      block.id &&
      block.source &&
      block.channelId === this.options.message.channelId &&
      BigInt(block.id) > this.cutoff
    )
      this.observeRevision(block.id, block.source.revision);
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

  currentMessage(): LlmMessage {
    const message = this.options.message;
    if (BigInt(message.id) > this.cutoff)
      this.observeRevision(message.id, message.editedTimestamp ?? 0);
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
        : { observationUnknown: [{ start: 0, end: message.content.length }] }),
    };
  }

  /** Preserve each chunk's actual Discord identity even when transcript rendering merges replies. */
  assistantBody(block: TranscriptBlock): LlmMessage | undefined {
    const pieces = block.displayMessages;
    if (!pieces?.length || pieces.length !== (block.messageIds?.length ?? 1))
      return;
    const result: LlmMessage = {
      role: "assistant",
      content: "",
      observationSources: [],
      observationReferences: [],
      observationParents: [],
      observationUnknown: [],
    };
    const sources: ObservationSegment[] = [];
    const references: NonNullable<
      LlmMessage["observationReferences"]
    >[number][] = [];
    const parents: CompletedGeneration[] = [];
    const unknown: { start: number; end: number }[] = [];
    for (const piece of pieces) {
      if (BigInt(piece.id) > this.cutoff)
        this.observeRevision(piece.id, piece.revision);
      if (result.content) result.content += "\n<split />\n";
      const start = result.content.length;
      // HTTP serialization already escapes dialogue. Encoding it again here adds
      // literal quotation marks to the assistant's historical speech.
      result.content += piece.text;
      const end = result.content.length;
      const parent =
        BigInt(piece.id) > this.cutoff
          ? this.options.store.displayParent(
              this.namespace,
              this.bank,
              piece.id,
              piece.revision,
              piece.text,
            )
          : undefined;
      if (!parent) {
        unknown.push({ start, end });
        continue;
      }
      const offset = parent.text.indexOf(piece.text);
      if (piece.text && offset >= 0) {
        references.push({
          source: parent,
          start,
          end,
          source_start: scalar(parent.text.slice(0, offset)),
          source_end: scalar(parent.text.slice(0, offset + piece.text.length)),
          encoding: "literal",
        });
      } else {
        sources.push({
          source: {
            id: `discord:message:${piece.id}`,
            revision: piece.revision,
            origin: "unattributed_input",
          },
          start,
          end,
          encoding: "literal",
          context: [parent.id],
        });
        parents.push(parent);
      }
    }
    return {
      ...result,
      observationSources: sources,
      observationReferences: references,
      observationParents: parents,
      observationUnknown: unknown,
    };
  }

  /** Called by LlmClient before trimming, parsing, parameter fallback or display formatting. */
  capture(
    response: LlmResponse,
    batch?: ObservationBatch,
  ): CompletedGeneration | undefined {
    this.assertCurrent();
    let output: CompletedGeneration | undefined;
    for (const source of response.remora?.observations?.generated ?? []) {
      const text = source.source_id.endsWith(":output")
        ? response.content
        : response.reasoningContent;
      if (text === undefined) continue;
      if (!batch) {
        if (source.source_id.endsWith(":output"))
          output = this.options.store.generation(
            this.namespace,
            this.bank,
            source.source_id,
            source.revision,
          );
        continue;
      }
      const captured = this.options.store.captureGeneration(
        this.namespace,
        this.bank,
        { id: source.source_id, revision: source.revision, text },
        ["admitted", "rejected", "empty"].includes(source.outcome),
        this.epoch,
        this.consumedSources(batch),
      );
      if (
        ["admitted", "rejected", "empty"].includes(source.outcome) &&
        !captured
      )
        throw new ObservationAttemptInvalidated(
          "Observation ancestry changed during inference",
        );
      if (source.source_id.endsWith(":output")) output = captured;
    }
    return output;
  }

  associate(message: ConversationMessage, parent: CompletedGeneration) {
    this.assertCurrent();
    this.options.store.associateDisplay(
      this.namespace,
      this.bank,
      message.id,
      message.source?.revision ?? 0,
      message.source?.text ?? message.content,
      parent,
      this.epoch,
    );
  }

  /** A formatting call is a real new attempt with its own generated parent, never invented span equality. */
  transformation(
    messages: LlmMessage[],
    parent?: CompletedGeneration,
  ): RemoraRequest {
    const last = messages.at(-1);
    if (!last) throw new Error("Missing transformation source");
    last.observationSources = parent
      ? [
          {
            source: {
              id: `patch:transform:${hash(JSON.stringify([parent.id, last.content]))}`,
              revision: 0,
              origin: "unattributed_input",
            },
            start: 0,
            end: last.content.length,
            context: [parent.id],
          },
        ]
      : [];
    last.observationParents = parent ? [parent] : [];
    if (!parent)
      last.observationUnknown = [{ start: 0, end: last.content.length }];
    return { ...this.request(messages), recall: { allow: [] } };
  }

  /** Compile final arrays after tool insertions. Sampling and rendering positions are not source identity. */
  request(messages: readonly LlmMessage[]): RemoraRequest {
    const { limits, store, remora, message, botUserId } = this.options;
    this.assertCurrent();
    const candidates = new Map<string, Candidate>();
    // Restored dependency references are not visible dialogue. Only rendered
    // assistant turns can supply the question that precedes the current human.
    const visibleAssistants: string[] = [];
    const references = new Map<
      string,
      {
        source: CompletedGeneration;
        views: ObservationReference["views"][number][];
      }
    >();
    const reference = (source: CompletedGeneration) => {
      const previous = references.get(source.id);
      if (
        previous &&
        referenceDigest(previous.source) !== referenceDigest(source)
      )
        throw new Error("Generated reference preimages conflict");
      if (previous) return previous;
      const item = {
        source,
        views: [] as ObservationReference["views"][number][],
      };
      references.set(source.id, item);
      return item;
    };
    const add = (
      segment: ObservationSegment,
      rendered: LlmMessage,
      messageIndex: number,
    ) => {
      const text = decodeObservationView(
        rendered.content.slice(segment.start, segment.end),
        segment.encoding,
      );
      const digest = hash(JSON.stringify([segment.source, text]));
      const previous = candidates.get(segment.source.id);
      if (
        previous &&
        (previous.digest !== digest ||
          JSON.stringify(previous.proposed ?? []) !==
            JSON.stringify(segment.context ?? []))
      )
        throw new Error("Observation source views conflict");
      const view = {
        message_index: messageIndex,
        start: scalar(rendered.content.slice(0, segment.start)),
        end: scalar(rendered.content.slice(0, segment.end)),
        ...(segment.encoding ? { encoding: segment.encoding } : {}),
      };
      if (previous) previous.views.push(view);
      else
        candidates.set(segment.source.id, {
          source: segment.source,
          digest,
          views: [view],
          context: [],
          proposed: segment.context,
          frozen: false,
        });
    };
    for (const [messageIndex, rendered] of messages.entries()) {
      if (rendered.role === "assistant") {
        const parents = new Set(
          (rendered.observationParents ?? []).map((source) => source.id),
        );
        visibleAssistants.push(
          ...[
            ...(rendered.observationReferences ?? []).map(
              ({ source, start }) => ({ id: source.id, start }),
            ),
            ...(rendered.observationSources ?? []).flatMap(
              ({ start, context }) =>
                (context ?? [])
                  .filter((id) => parents.has(id))
                  .map((id) => ({ id, start })),
            ),
          ]
            .sort((a, b) => a.start - b.start)
            .map(({ id }) => id),
        );
      }
      for (const parent of rendered.observationParents ?? []) reference(parent);
      for (const segment of rendered.observationReferences ?? [])
        reference(segment.source).views.push({
          message_index: messageIndex,
          start: scalar(rendered.content.slice(0, segment.start)),
          end: scalar(rendered.content.slice(0, segment.end)),
          source_start: segment.source_start,
          source_end: segment.source_end,
          ...(segment.encoding ? { encoding: segment.encoding } : {}),
        });
      for (const segment of rendered.observationSources ?? [])
        add(segment, rendered, messageIndex);
      const ranges = [
        ...(rendered.observationSources ?? []),
        ...(rendered.observationReferences ?? []),
        ...(rendered.observationUnknown ?? []),
      ].sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const range of [
        ...ranges,
        { start: rendered.content.length, end: rendered.content.length },
      ]) {
        const text = rendered.content.slice(cursor, range.start);
        if (text.trim()) {
          const origin =
            rendered.role === "system" ? "system_input" : "unattributed_input";
          add(
            {
              source: {
                id: `patch:frame:${hash(JSON.stringify([origin, text]))}`,
                revision: 0,
                origin,
              },
              start: cursor,
              end: range.start,
              context: [],
            },
            rendered,
            messageIndex,
          );
        }
        cursor = Math.max(cursor, range.end);
      }
    }
    for (const candidate of candidates.values()) {
      store.advanceObservationRevision(
        this.namespace,
        this.bank,
        candidate.source.id,
        candidate.source.revision,
      );
    }
    for (const [id, item] of references)
      if (
        !store.generation(this.namespace, this.bank, id, item.source.revision)
      )
        references.delete(id);
    for (const candidate of candidates.values()) {
      const context = store.observationContext(
        this.bank,
        candidate.source.id,
        candidate.source.revision,
        candidate.digest,
        this.namespace,
      );
      if (context) {
        candidate.context = context;
        candidate.frozen = true;
      }
      for (const parent of candidate.context)
        if (parent.reference && !references.has(parent.id)) {
          const source = store.generation(
            this.namespace,
            this.bank,
            parent.id,
            parent.revision,
          );
          if (source && referenceDigest(source) === parent.digest)
            reference(source);
        }
    }
    const descriptor = (id: string): ObservationContext | undefined => {
      const parent = candidates.get(id);
      if (parent)
        return { id, revision: parent.source.revision, digest: parent.digest };
      const generated = references.get(id)?.source;
      if (generated)
        return {
          id,
          revision: generated.revision,
          digest: referenceDigest(generated),
          reference: true,
        };
    };
    const prune = () => {
      let removed: boolean;
      do {
        removed = false;
        for (const [id, candidate] of candidates)
          if (
            candidate.context.some((context) => {
              const parent = descriptor(context.id);
              return (
                !parent ||
                parent.digest !== context.digest ||
                parent.revision !== context.revision
              );
            })
          ) {
            candidates.delete(id);
            removed = true;
          }
      } while (removed);
    };
    for (const [id, candidate] of candidates)
      if (candidate.proposed?.some((parent) => !descriptor(parent)))
        candidates.delete(id);
    prune();
    const currentId = `discord:message:${message.id}`;
    const lastAssistant = visibleAssistants
      .filter((id) => {
        const source = references.get(id)?.source;
        return source && scalar(source.text) <= 4096;
      })
      .at(-1);
    const lastHuman = [...candidates.values()]
      .filter(
        ({ source }) =>
          source.origin === "human_input" && source.id !== currentId,
      )
      .at(-1)?.source.id;
    for (const candidate of candidates.values()) {
      const ids =
        candidate.proposed ??
        (candidate.source.id === currentId
          ? [lastAssistant ?? lastHuman].filter(isString)
          : candidate.source.origin === "external_observation"
            ? [currentId].filter((id) => candidates.has(id))
            : []);
      const context = candidate.frozen
        ? candidate.context
        : ids.map((id) => {
            const parent = descriptor(id);
            if (!parent) throw new Error("Observation context is unavailable");
            return parent;
          });
      candidate.context = store.freezeObservation(
        this.bank,
        candidate.source.id,
        candidate.source.revision,
        candidate.digest,
        context,
        this.namespace,
      );
    }
    prune();
    const inputs = [...candidates.values()].map(
      ({ source, views, context }) => ({
        ...source,
        views,
        context: context.map(({ id }) => id),
      }),
    );
    const refs = [...references.values()]
      .filter(
        ({ source, views }) =>
          views.length ||
          inputs.some((input) => input.context.includes(source.id)),
      )
      .map(({ source, views }) => ({ ...source, views }));
    const observations: ObservationBatch = {
      bank: this.bank,
      id: `patch:batch:${hash(JSON.stringify([this.bank, [...candidates.values()].map(({ source, digest, context }) => [source.id, source.revision, digest, context]), refs.map(({ views: _, ...source }) => source), botUserId]))}`,
      revision: 0,
      inputs,
      ...(refs.length ? { references: refs } : {}),
      generated: {
        actor: {
          bank: this.bank,
          role: "assistant",
          id: `discord:user:${botUserId}`,
        },
      },
    };
    validateObservationBatch(observations, messages, limits);
    this.consumed = this.consumedSources(observations);
    this.assertCurrent();
    return {
      read_banks: remora.read_banks,
      speaker: { bank: this.bank, id: `discord:user:${message.author.id}` },
      ...(remora.recall ? { recall: remora.recall } : {}),
      observations,
    };
  }

  /** Check immediately before each async boundary that can decode, execute or send. */
  assertCurrent() {
    if (!this.isCurrent())
      throw new ObservationAttemptInvalidated(
        "Observation attempt invalidated by a memory fence or source revision",
      );
  }

  /** Failed HTTP has no response callback; its catch must also honor cancellation. */
  isCurrent() {
    return (
      this.options.store.privacyEpoch() === this.epoch &&
      this.options.store.sourcesCurrent(
        this.namespace,
        this.bank,
        this.consumed,
      )
    );
  }

  private consumedSources(batch: ObservationBatch): readonly ConsumedSource[] {
    return [
      ...batch.inputs.map(({ id, revision }) => ({ id, revision })),
      ...(batch.references ?? []).map(({ id, revision }) => ({
        id,
        revision,
        reference: true,
      })),
      ...[...this.sourceRevisions]
        .filter(([id]) => !batch.inputs.some((input) => input.id === id))
        .map(([id, revision]) => ({ id, revision })),
    ];
  }

  private observeRevision(id: string, revision: number) {
    const sourceId = `discord:message:${id}`;
    this.sourceRevisions.set(sourceId, revision);
    this.options.store.advanceObservationRevision(
      this.namespace,
      this.bank,
      sourceId,
      revision,
    );
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

export function observationNamespace(baseUrl: string, apiKey: string) {
  return hash(JSON.stringify([baseUrl, apiKey]));
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function scalar(value: string) {
  return Array.from(value).length;
}
function referenceDigest(source: CompletedGeneration) {
  return hash(JSON.stringify([source.id, source.revision, source.text]));
}
function isString(value: string | undefined): value is string {
  return value !== undefined;
}
