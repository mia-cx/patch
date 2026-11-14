import { createHash } from "node:crypto";
import { Schema } from "effect";
import { EvidenceSourceMetadataSchema } from "./evidence.js";

const Text = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isMaxLength(256),
);
const Id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const MemorySaveRequestSchema = Schema.Struct({
  bank: Text,
  /** Further layers that receive the same save, e.g. the server and the speaker's own bank. */
  also_banks: Schema.optional(Schema.Array(Text).check(Schema.isMaxLength(4))),
  request_id: Text,
  source: Schema.Struct({
    id: Text,
    revision: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    actor_id: Text,
    text: Schema.String.check(
      Schema.isPattern(/\S/u),
      Schema.makeFilter(
        (text) =>
          Array.from(text).length <= 4096 &&
          Buffer.from(text).toString("utf8") === text,
      ),
    ),
    observed_at: Schema.String.check(
      Schema.isMaxLength(64),
      Schema.isPattern(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u,
      ),
    ),
  }),
});
export const MemorySaveReceiptSchema = Schema.Struct({
  object: Schema.Literal("remora.memory.save"),
  version: Schema.Literal(1),
  bank: Text,
  request_id: Text,
  kind: Schema.Literal("evidence"),
  source: EvidenceSourceMetadataSchema,
  subjects: Schema.Null,
  saved_ids: Schema.Array(Id).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
  active_ids: Schema.Array(Id).check(Schema.isMaxLength(1)),
  status: Schema.Literals(["saved", "forgotten"]),
  replayed: Schema.Boolean,
  /** One entry per requested layer, in order; present only when the request named layers. */
  copies: Schema.optional(
    Schema.Array(
      Schema.Struct({
        bank: Text,
        saved_ids: Schema.Array(Id).check(Schema.isMaxLength(1)),
        active_ids: Schema.Array(Id).check(Schema.isMaxLength(1)),
      }),
    ).check(Schema.isMaxLength(4)),
  ),
  admission_identity: Schema.Literal(
    createHash("sha256")
      .update(JSON.stringify("explicit-human-save-v1"))
      .digest("hex"),
  ),
});
export type MemorySaveRequest = typeof MemorySaveRequestSchema.Type;
export type MemorySaveReceipt = typeof MemorySaveReceiptSchema.Type;
