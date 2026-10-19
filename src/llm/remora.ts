import { Schema } from "effect";
import {
  type ObservationBatch,
  ObservationLimitsSchema,
  ObservationResponseSchema,
  validateObservationResponse,
} from "./evidence.js";

type IdentityActor = {
  bank: string;
  role: "human" | "assistant";
  id: string;
};

/** Caller-owned identity data; declarations never grant bank or fact access. */
export type RemoraIdentity = {
  assistant?: { bank: string; id: string };
  bindings?: Array<{ actor: IdentityActor; entity: string }>;
  labels?: Array<
    | { actor: IdentityActor; entity?: never; label: string }
    | { entity: string; actor?: never; label: string }
  >;
  /** Durable harness observations, separately negotiated and bound to a writable source. */
  names?: Array<{ actor: IdentityActor; name: string }>;
};

/** Optional Remora controls; bank selection never grants recall permission. */
export type RemoraRequest = {
  read_banks: string[];
  write_bank?: string;
  /** Current human attribution; inferred from write_bank + turn when writable. Never grants access. */
  speaker?: { bank: string; id: string };
  identity?: RemoraIdentity;
  /** Separate source-view persistence, negotiated independently from legacy turn writes. */
  observations?: ObservationBatch;
  turn?: {
    id: string;
    revision: number;
    speaker_id: string;
    text: string;
  };
  recall?: {
    allow?: Array<typeof FactRef.Type>;
    deny?: Array<typeof FactRef.Type>;
  };
};

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const Backend = Schema.Literals(["transformers", "llama.cpp"]);
const FactRef = Schema.Struct({
  bank: Schema.String,
  id: PositiveInteger.check(
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  kind: Schema.optional(Schema.Literals(["statement", "evidence"])),
});

const RemoraResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  backend: Backend,
  read_banks: Schema.Array(Schema.String),
  selected: Schema.Array(FactRef),
  observations: Schema.optional(Schema.NullOr(ObservationResponseSchema)),
  writes: Schema.NullOr(
    Schema.Struct({
      bank: Schema.String,
      source_id: Schema.String,
      revision: NonNegativeInteger,
      replayed: Schema.Boolean,
      harness_names: Schema.optional(
        Schema.Struct({
          saved: Schema.Array(PositiveInteger),
          unchanged: Schema.Array(PositiveInteger),
          superseded: Schema.Array(PositiveInteger),
          suppressed: Schema.Array(
            Schema.Struct({
              bank: Schema.String,
              role: Schema.Literals(["human", "assistant"]),
              id: Schema.String,
            }),
          ),
        }),
      ),
      result: Schema.Struct({
        saved: Schema.Array(PositiveInteger),
        reinforced: Schema.Array(PositiveInteger),
        superseded: Schema.Array(PositiveInteger),
        forgotten: Schema.Array(PositiveInteger),
        error: Schema.NullOr(Schema.String),
        unmatched_forget: Schema.Boolean,
      }),
    }),
  ),
  cache: Schema.Struct({
    requested: Schema.Boolean,
    reused_tokens: NonNegativeInteger,
    evaluated_tokens: NonNegativeInteger,
    invalidated: Schema.NullOr(Schema.String),
  }),
});

/** Validated receipts and observed reuse, separate from normal model choices. */
export type RemoraResponse = typeof RemoraResponseSchema.Type;

/** Rejects ignored extensions and receipts belonging to another source. */
export function parseRemoraResponse(
  value: unknown,
  request: RemoraRequest,
  evidenceEnabled = false,
): RemoraResponse {
  const response = Schema.decodeUnknownSync(RemoraResponseSchema)(value);
  if (
    (!evidenceEnabled &&
      response.selected.some((ref) => ref.kind !== undefined)) ||
    response.selected.some((ref) => ref.kind === "statement") ||
    (evidenceEnabled &&
      (response.read_banks.length !== request.read_banks.length ||
        new Set(response.read_banks).size !== response.read_banks.length ||
        response.read_banks.some(
          (bank) => !request.read_banks.includes(bank),
        ) ||
        response.selected.some(
          (ref) => !request.read_banks.includes(ref.bank),
        )))
  )
    throw new Error("Remora selected an unsupported memory reference");
  if (request.observations) {
    if (
      !evidenceEnabled ||
      request.turn ||
      request.write_bank ||
      request.identity ||
      !response.observations
    )
      throw new Error("Remora response has no negotiated observation receipt");
    validateObservationResponse(response.observations, request.observations);
  } else if (response.observations != null) {
    throw new Error("Remora returned unsolicited observation receipts");
  }
  if (
    request.turn &&
    (!response.writes ||
      response.writes.bank !== request.write_bank ||
      response.writes.source_id !== request.turn.id ||
      response.writes.revision !== request.turn.revision)
  )
    throw new Error("Remora response has no matching source write receipt");
  if (!request.turn && response.writes !== null)
    throw new Error("Remora returned a write receipt for a read-only request");
  if (request.identity?.names !== undefined && !response.writes?.harness_names)
    throw new Error("Remora response has no harness name acknowledgement");
  return response;
}

const RemoraCapabilitiesSchema = Schema.Struct({
  object: Schema.Literal("remora.capabilities"),
  version: Schema.Literal(1),
  model: Schema.String,
  backend: Backend,
  profile: Schema.String,
  memory_delivery: Schema.optional(
    Schema.Literals(["detached", "native-cache"]),
  ),
  source_binding: Schema.Literals([
    "final_user_message_exact",
    "original_message_scalar_views_v1",
  ]),
  observation_binding: Schema.optional(
    Schema.Literal("original_message_scalar_views_v1"),
  ),
  features: Schema.Struct({
    memory: Schema.Boolean,
    automatic_writes: Schema.Boolean,
    multi_bank: Schema.Boolean,
    fact_filter: Schema.Boolean,
    source_revisions: Schema.Boolean,
    prefix_cache: Schema.Boolean,
    speaker_binding: Schema.optional(Schema.Boolean),
    entity_identity: Schema.optional(Schema.Boolean),
    harness_names: Schema.optional(Schema.Boolean),
    memory_management: Schema.optional(Schema.Boolean),
    memory_search: Schema.optional(Schema.Boolean),
    all_stream_evidence: Schema.optional(Schema.Boolean),
    streaming: Schema.Boolean,
    tools: Schema.Boolean,
    thinking: Schema.Boolean,
  }),
  limits: Schema.Struct({
    context_tokens: PositiveInteger,
    max_output_tokens: PositiveInteger,
    max_read_banks: Schema.Literal(8),
    max_identity_bindings: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(16)),
    ),
    max_identity_labels: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(64)),
    ),
    max_identity_id_chars: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(256)),
    ),
    max_identity_label_chars: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(128)),
    ),
    max_harness_names: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(2)),
    ),
    max_harness_name_chars: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(128)),
    ),
    max_memory_page_size: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(100)),
    ),
    max_memory_forget_ids: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(100)),
    ),
    max_memory_request_id_chars: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(256)),
    ),
    max_search_results: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(50)),
    ),
    max_search_banks: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(8)),
    ),
    max_search_query_chars: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(2048)),
    ),
    max_search_query_tokens: Schema.optional(
      PositiveInteger.check(Schema.isLessThanOrEqualTo(256)),
    ),
    max_observation_sources: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_sources,
    ),
    max_observation_views: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_views,
    ),
    max_observation_source_chars: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_source_chars,
    ),
    max_observation_contexts: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_contexts,
    ),
    max_observation_total_chars: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_total_chars,
    ),
    max_observation_id_chars: Schema.optional(
      ObservationLimitsSchema.fields.max_observation_id_chars,
    ),
  }),
});

/** Decodes runtime limits; the contract's example profile is not a default. */
export function parseRemoraCapabilities(value: unknown) {
  const capabilities = Schema.decodeUnknownSync(RemoraCapabilitiesSchema)(
    value,
  );
  if (capabilities.features.all_stream_evidence) {
    if (
      capabilities.source_binding !== "original_message_scalar_views_v1" ||
      capabilities.observation_binding !== "original_message_scalar_views_v1" ||
      capabilities.features.entity_identity !== false ||
      !capabilities.features.memory_management ||
      capabilities.limits.max_memory_page_size !== 100 ||
      capabilities.limits.max_memory_forget_ids !== 100 ||
      capabilities.limits.max_memory_request_id_chars !== 256
    )
      throw new Error(
        "Remora evidence requires source-view bindings and compatible management",
      );
    Schema.decodeUnknownSync(ObservationLimitsSchema)(capabilities.limits);
  } else if (
    capabilities.source_binding !== "final_user_message_exact" ||
    capabilities.observation_binding !== undefined
  ) {
    throw new Error("Remora source-view binding requires evidence support");
  }
  if (
    capabilities.features.memory_management &&
    (capabilities.limits.max_memory_page_size === undefined ||
      capabilities.limits.max_memory_forget_ids === undefined ||
      capabilities.limits.max_memory_request_id_chars === undefined)
  )
    throw new Error("Remora memory management requires all three limits");
  if (
    capabilities.features.memory_search &&
    (capabilities.limits.max_search_results === undefined ||
      capabilities.limits.max_search_banks === undefined ||
      capabilities.limits.max_search_query_chars === undefined ||
      capabilities.limits.max_search_query_tokens === undefined)
  )
    throw new Error("Remora memory search requires all four limits");
  return capabilities;
}
