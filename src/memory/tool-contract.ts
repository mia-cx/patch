import { Schema } from "effect";
import { MemoryMutationSchema } from "./client.js";
import { EvidenceMutationSchema } from "./evidence.js";
import { MemorySaveReceiptSchema } from "./save.js";

export const MemoryToolOutcomeSchema = Schema.Union([
  Schema.Struct({
    memory_control: Schema.Literal(true),
    content: Schema.String,
    status: Schema.Literals(["saved", "forgotten"]),
    receipt: Schema.Union([
      MemorySaveReceiptSchema,
      MemoryMutationSchema,
      EvidenceMutationSchema,
    ]),
  }),
  Schema.Struct({
    memory_control: Schema.Literal(true),
    content: Schema.String,
    status: Schema.Literal("clarification_required"),
    candidates: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          kind: Schema.Literals(["fact", "evidence"]),
          text: Schema.String,
        }),
      ),
    ),
  }),
]);
export type MemoryToolOutcome = typeof MemoryToolOutcomeSchema.Type;

/** The real Protocord dispatch wrapper, before the turn runner presents its confirmation. */
export const MemoryDispatchEnvelopeSchema = Schema.Struct({
  output: MemoryToolOutcomeSchema,
  continueAfter: Schema.Literal(false),
});
export const MemoryToolResultSchema = Schema.Union([
  Schema.Struct({
    name: Schema.Literals(["memory_save", "memory_forget"]),
    output: MemoryToolOutcomeSchema,
    completed: Schema.Literal(true),
  }),
  Schema.Struct({
    name: Schema.Literals(["memory_save", "memory_forget"]),
    output: Schema.Struct({ error: Schema.String }),
    completed: Schema.Literal(false),
    error: Schema.String,
  }),
]);
/** Memory turns terminate without decoding the old prompt after a privacy fence. */
export const MemoryTurnEnvelopeSchema = Schema.Struct({
  content: Schema.String,
  sources: Schema.Array(Schema.Never),
  memoryControl: Schema.Literal(true),
  memoryToolResult: MemoryToolResultSchema,
  memoryEpoch: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
