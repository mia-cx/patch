import { Schema } from "effect";
import {
  EvidenceDigest,
  EvidenceExactText,
  EvidenceId,
  EvidenceIdText,
  EvidenceIndex,
  EvidenceManagementString,
} from "../llm/evidence.js";

const StoredActor = Schema.Struct({
  bank: EvidenceIdText,
  role: Schema.Literals(["human", "assistant"]),
  id: EvidenceIdText,
});
const SourceActor = Schema.Struct({
  principal: EvidenceIdText,
  actor: Schema.NullOr(StoredActor),
  entity: Schema.NullOr(EvidenceIdText),
  unknown: Schema.Null,
  description: Schema.Null,
}).check(
  Schema.makeFilter(
    (value) => (value.actor !== null) !== (value.entity !== null),
  ),
);
const Source = Schema.Struct({
  id: EvidenceIdText,
  revision: EvidenceIndex,
  origin: Schema.Literals([
    "human_input",
    "external_observation",
    "assistant_reasoning",
    "assistant_output",
    "system_input",
    "unattributed_input",
  ]),
  actor: Schema.NullOr(SourceActor),
  tool: Schema.NullOr(EvidenceIdText),
  url: Schema.NullOr(
    EvidenceExactText.check(
      Schema.makeFilter((value) => Array.from(value).length <= 2048),
    ),
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      (value.origin !== "unattributed_input" || value.actor === null) &&
      (value.origin === "external_observation" ||
        (value.tool === null && value.url === null)) &&
      (value.origin !== "human_input" ||
        !value.actor?.actor ||
        value.actor.actor.role === "human") &&
      (!["assistant_output", "assistant_reasoning"].includes(value.origin) ||
        !value.actor?.actor ||
        value.actor.actor.role === "assistant"),
  ),
);
const Span = Schema.Struct({
  start: EvidenceIndex.check(Schema.isLessThanOrEqualTo(65535)),
  end: EvidenceId.check(Schema.isLessThanOrEqualTo(65536)),
});
const Quotation = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value) =>
      Buffer.from(value).toString("utf8") === value &&
      Array.from(value).length <= 4096,
  ),
);
const Context = Schema.Struct({
  source: Source,
  span: Span,
  source_digest: EvidenceDigest,
  text: Quotation,
}).check(
  Schema.makeFilter(
    (value) =>
      value.span.end - value.span.start === Array.from(value.text).length,
  ),
);
export const EvidenceRecordSchema = Schema.Struct({
  id: EvidenceId,
  bank: EvidenceIdText,
  kind: Schema.Literal("evidence"),
  subjects: Schema.Null,
  source: Source,
  span: Span,
  text: Quotation,
  context: Schema.Array(Context).check(Schema.isMaxLength(16)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.span.end - value.span.start === Array.from(value.text).length,
  ),
);
export const EvidenceSnapshotSchema = Schema.Struct({
  object: Schema.Literal("remora.evidence.list"),
  version: Schema.Literal(1),
  bank: EvidenceManagementString,
  revision: EvidenceDigest,
  data: Schema.Array(EvidenceRecordSchema).check(Schema.isMaxLength(100)),
  next_cursor: Schema.NullOr(
    Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
      Schema.isMaxLength(1024),
    ),
  ),
});
const Ids = Schema.Array(EvidenceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isUnique(),
);
export const EvidenceMutationSchema = Schema.Struct({
  object: Schema.Literal("remora.evidence.mutation"),
  version: Schema.Literal(1),
  bank: EvidenceManagementString,
  operation: Schema.Literals(["forget", "forget_source"]),
  request_id: EvidenceManagementString,
  deleted_ids: Ids,
  deleted_count: EvidenceId.check(Schema.isLessThanOrEqualTo(4096)),
  dependent_suppression: Schema.Struct({
    bank: EvidenceManagementString,
    visible_active_count: EvidenceIndex.check(Schema.isLessThanOrEqualTo(4096)),
    ids: Schema.optional(
      Schema.Array(EvidenceId).check(
        Schema.isMaxLength(4096),
        Schema.isUnique(),
      ),
    ),
  }),
  revision: EvidenceDigest,
  replayed: Schema.Boolean,
  cache_invalidated: Schema.Literal(true),
  reset_required: Schema.Literal(true),
}).check(
  Schema.makeFilter((value) => {
    const dependent = value.dependent_suppression;
    if (
      value.deleted_ids.length !== value.deleted_count ||
      dependent.bank !== value.bank ||
      value.deleted_count + dependent.visible_active_count > 4096
    )
      return false;
    if (value.operation === "forget")
      return value.deleted_count <= 100 && dependent.ids === undefined;
    return (
      dependent.ids !== undefined &&
      dependent.ids.length === dependent.visible_active_count &&
      dependent.ids.every(
        (id, index) =>
          !value.deleted_ids.includes(id) &&
          (index === 0 || id > (dependent.ids?.[index - 1] ?? 0)),
      )
    );
  }),
);
export type EvidenceRecord = typeof EvidenceRecordSchema.Type;
export type EvidenceSnapshot = typeof EvidenceSnapshotSchema.Type;
export type EvidenceMutation = typeof EvidenceMutationSchema.Type;
