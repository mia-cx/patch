import { Schema } from "effect";

/** Optional Remora controls; bank selection never grants recall permission. */
export type RemoraRequest = {
  read_banks: string[];
  write_bank?: string;
  /** Current human attribution; inferred from write_bank + turn when writable. Never grants access. */
  speaker?: { bank: string; id: string };
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
const FactRef = Schema.Struct({ bank: Schema.String, id: PositiveInteger });

const RemoraResponseSchema = Schema.Struct({
  version: Schema.Literal(1),
  backend: Backend,
  read_banks: Schema.Array(Schema.String),
  selected: Schema.Array(FactRef),
  writes: Schema.NullOr(
    Schema.Struct({
      bank: Schema.String,
      source_id: Schema.String,
      revision: NonNegativeInteger,
      replayed: Schema.Boolean,
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
): RemoraResponse {
  const response = Schema.decodeUnknownSync(RemoraResponseSchema)(value);
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
  return response;
}

const RemoraCapabilitiesSchema = Schema.Struct({
  object: Schema.Literal("remora.capabilities"),
  version: Schema.Literal(1),
  model: Schema.String,
  backend: Backend,
  profile: Schema.String,
  source_binding: Schema.Literal("final_user_message_exact"),
  features: Schema.Struct({
    memory: Schema.Boolean,
    automatic_writes: Schema.Boolean,
    multi_bank: Schema.Boolean,
    fact_filter: Schema.Boolean,
    source_revisions: Schema.Boolean,
    prefix_cache: Schema.Boolean,
    speaker_binding: Schema.optional(Schema.Boolean),
    streaming: Schema.Boolean,
    tools: Schema.Boolean,
    thinking: Schema.Boolean,
  }),
  limits: Schema.Struct({
    context_tokens: PositiveInteger,
    max_output_tokens: PositiveInteger,
    max_read_banks: Schema.Literal(8),
  }),
});

/** Decodes runtime limits; the contract's example profile is not a default. */
export const parseRemoraCapabilities = Schema.decodeUnknownSync(
  RemoraCapabilitiesSchema,
);
