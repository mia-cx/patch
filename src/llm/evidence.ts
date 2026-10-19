import { Schema } from "effect";

const ScalarString = Schema.String.check(
  Schema.makeFilter((value) => Buffer.from(value).toString("utf8") === value),
);
export const EvidenceExactText = ScalarString.check(
  Schema.isPattern(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Frozen source IDs use Python's exact whitespace set.
    /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u,
  ),
);
export const EvidenceIdText = EvidenceExactText.check(
  Schema.makeFilter((value) => Array.from(value).length <= 256),
);
export const EvidenceManagementString = ScalarString.check(
  Schema.isPattern(/\S/u),
  Schema.makeFilter((value) => Array.from(value).length <= 256),
);
export const EvidenceIndex = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const EvidenceId = EvidenceIndex.check(Schema.isGreaterThan(0));
export const EvidenceDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
);
const Actor = Schema.Struct({
  bank: EvidenceIdText.check(Schema.isPattern(/\S/u)),
  role: Schema.Literals(["human", "assistant"]),
  id: EvidenceIdText.check(Schema.isPattern(/\S/u)),
});
const Origin = Schema.Literals([
  "human_input",
  "external_observation",
  "assistant_reasoning",
  "assistant_output",
  "system_input",
  "unattributed_input",
]);
const View = Schema.Struct({
  message_index: EvidenceIndex,
  start: EvidenceIndex,
  end: EvidenceIndex,
  encoding: Schema.optional(
    Schema.Literals(["literal", "json_string", "xml_text"]),
  ),
});
const Input = Schema.Struct({
  id: EvidenceIdText,
  revision: EvidenceIndex,
  origin: Origin,
  views: Schema.Array(View).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  actor: Schema.optional(Actor),
  tool: Schema.optional(Schema.NullOr(EvidenceIdText)),
  url: Schema.optional(
    Schema.NullOr(
      EvidenceExactText.check(
        Schema.makeFilter((value) => Array.from(value).length <= 2048),
      ),
    ),
  ),
  context: Schema.optional(
    Schema.Array(EvidenceIdText).check(Schema.isMaxLength(16)),
  ),
});
const Batch = Schema.Struct({
  bank: EvidenceIdText,
  id: EvidenceIdText,
  revision: EvidenceIndex,
  inputs: Schema.Array(Input).check(Schema.isMaxLength(128)),
  references: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: EvidenceIdText,
        revision: EvidenceIndex,
        text: ScalarString.check(
          Schema.makeFilter((value) => Array.from(value).length <= 65536),
        ),
        views: Schema.Array(
          Schema.Struct({
            ...View.fields,
            source_start: EvidenceIndex.check(
              Schema.isLessThanOrEqualTo(65535),
            ),
            source_end: EvidenceId.check(Schema.isLessThanOrEqualTo(65536)),
          }),
        ).check(Schema.isMaxLength(512)),
      }),
    ).check(Schema.isMaxLength(128)),
  ),
  generated: Schema.optional(Schema.Struct({ actor: Actor })),
});

/** Exact advertised values from the independent frozen companion, not legacy defaults. */
export const ObservationLimitsSchema = Schema.Struct({
  max_observation_sources: Schema.Literal(128),
  max_observation_views: Schema.Literal(512),
  max_observation_source_chars: Schema.Literal(65536),
  max_observation_contexts: Schema.Literal(16),
  max_observation_total_chars: Schema.Literal(262144),
  max_observation_id_chars: Schema.Literal(256),
});
export type ObservationLimits = typeof ObservationLimitsSchema.Type;
export type ObservationBatch = typeof Batch.Type;
export type ObservationInput = typeof Input.Type;
export type ObservationView = typeof View.Type;
export type ObservationReference = NonNullable<
  ObservationBatch["references"]
>[number];
export type CompletedGeneration = Omit<ObservationReference, "views">;
export type ReferenceSegment = {
  source: CompletedGeneration;
  start: number;
  end: number;
  source_start: number;
  source_end: number;
  encoding?: ObservationView["encoding"];
};

/** Caller-only provenance for an exact rendered segment. Offsets use JavaScript string indices. */
export type ObservationSegment = {
  source: Omit<ObservationInput, "views" | "context">;
  start: number;
  end: number;
  encoding?: ObservationView["encoding"];
  context?: readonly string[];
};

const Receipt = Schema.Struct({
  saved: Schema.Array(EvidenceId).check(
    Schema.isMaxLength(64),
    Schema.isUnique(),
  ),
  superseded: Schema.Array(EvidenceId).check(
    Schema.isMaxLength(4096),
    Schema.isUnique(),
  ),
  status: Schema.Literals(["admitted", "not_admitted"]),
  replayed: Schema.Boolean,
  admission_identity: Schema.NullOr(EvidenceDigest),
}).check(
  Schema.makeFilter(
    (value) => (value.status === "admitted") === value.saved.length > 0,
  ),
);
const SourceResult = Schema.Struct({
  source_id: EvidenceIdText,
  revision: EvidenceIndex,
  receipt: Receipt,
  outcome: Schema.Literals([
    "admitted",
    "empty",
    "source_limit",
    "incomplete_evidence",
    "rejected",
    "replayed",
    "recalled_dependencies",
    "untracked_dependencies",
    "generated_context_limit",
    "erased_dependencies",
    "referenced",
  ]),
}).check(
  Schema.makeFilter(
    (value) =>
      (!["replayed", "referenced"].includes(value.outcome) ||
        value.receipt.replayed) &&
      (["replayed", "referenced"].includes(value.outcome) ||
        (value.outcome === "admitted") ===
          (value.receipt.status === "admitted")),
  ),
);
export const ObservationResponseSchema = Schema.Struct({
  inputs: Schema.Array(SourceResult).check(Schema.isMaxLength(128)),
  generated: Schema.Array(SourceResult).check(Schema.isMaxLength(2)),
  attempt_id: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^generation-[0-9a-f]{32}$/u)),
  ),
  input_replayed: Schema.Boolean,
});
export type ObservationResponse = typeof ObservationResponseSchema.Type;

/** Match immutable input receipts independently of the current backend-generated attempt. */
export function validateObservationResponse(
  response: ObservationResponse,
  request: ObservationBatch,
) {
  const expected = [...request.inputs, ...(request.references ?? [])];
  if (
    response.inputs.length !== expected.length ||
    response.inputs.some(
      (result, index) =>
        result.source_id !== expected[index]?.id ||
        result.revision !== expected[index]?.revision ||
        (index >= request.inputs.length &&
          (result.outcome !== "referenced" || !result.receipt.replayed)) ||
        (response.input_replayed && !result.receipt.replayed),
    )
  )
    throw new Error(
      "Remora observation input receipts do not match the request",
    );
  if (!request.generated) {
    if (response.attempt_id !== null || response.generated.length)
      throw new Error("Unexpected generated observation receipts");
    return;
  }
  const ids = response.generated.map((item) => item.source_id);
  if (
    !response.attempt_id ||
    !ids.includes(`${response.attempt_id}:output`) ||
    new Set(ids).size !== ids.length ||
    response.generated.some(
      (item) =>
        item.revision !== 0 ||
        ![
          `${response.attempt_id}:output`,
          `${response.attempt_id}:reasoning`,
        ].includes(item.source_id),
    )
  )
    throw new Error(
      "Remora generated observation receipts do not match their attempt",
    );
}

function xmlCharacter(value: number) {
  return (
    [9, 10, 13].includes(value) ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

/** Decode exactly the three source-view encodings without XML newline normalization. */
export function decodeObservationView(
  rendered: string,
  encoding: ObservationView["encoding"] = "literal",
): string {
  if (encoding === "literal") return rendered;
  if (encoding === "json_string") {
    if (!rendered.startsWith('"') || !rendered.endsWith('"'))
      throw new Error("Invalid JSON source view");
    const value: unknown = JSON.parse(rendered);
    if (
      typeof value !== "string" ||
      Buffer.from(value).toString("utf8") !== value
    )
      throw new Error("Invalid JSON source view");
    return value;
  }
  if (rendered.includes("<") || rendered.includes("]]>"))
    throw new Error("Invalid XML source view");
  const names: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  let text = "";
  const entities = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/y;
  for (let index = 0; index < rendered.length; ) {
    let char = String.fromCodePoint(rendered.codePointAt(index) ?? 0);
    let end = index + char.length;
    if (char === "&") {
      entities.lastIndex = index;
      const entity = entities.exec(rendered);
      if (!entity?.[1]) throw new Error("Invalid XML source view");
      const name = entity[1];
      const value = name.startsWith("#")
        ? Number.parseInt(
            name.slice(name.startsWith("#x") ? 2 : 1),
            name.startsWith("#x") ? 16 : 10,
          )
        : undefined;
      if (value !== undefined && !xmlCharacter(value))
        throw new Error("Invalid XML character");
      char =
        value === undefined ? (names[name] ?? "") : String.fromCodePoint(value);
      end = entities.lastIndex;
    }
    if (!xmlCharacter(char.codePointAt(0) ?? 0))
      throw new Error("Invalid XML character");
    text += char;
    index = end;
  }
  return text;
}

/** Validate source identity, exact scalar ranges and origin before any HTTP request. */
export function validateObservationBatch(
  value: unknown,
  messages: readonly { role: string; content: string }[],
  limits: ObservationLimits,
): ObservationBatch {
  const batch = Schema.decodeUnknownSync(Batch, { onExcessProperty: "error" })(
    value,
  );
  if (
    messages.some(
      (message) =>
        Buffer.from(message.content).toString("utf8") !== message.content,
    )
  )
    throw new Error("Observation messages contain invalid Unicode");
  const declarations = [...batch.inputs, ...(batch.references ?? [])];
  const ids = new Set(declarations.map((input) => input.id));
  if (
    ids.size !== declarations.length ||
    declarations.length > limits.max_observation_sources
  )
    throw new Error("Duplicate or excessive observation sources");
  if (
    batch.generated &&
    (batch.generated.actor.bank !== batch.bank ||
      batch.generated.actor.role !== "assistant")
  )
    throw new Error("Invalid generated observation actor");
  const occupied = new Map<number, Array<{ start: number; end: number }>>();
  let views = 0;
  let total = 0;
  const readView = (view: ObservationView) => {
    views++;
    const message = messages[view.message_index];
    if (
      !message ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    )
      throw new Error("Observation view has no supported message");
    const scalars = Array.from(message.content);
    if (
      view.start > view.end ||
      view.end > scalars.length ||
      view.end - view.start > 786434
    )
      throw new Error("Observation range is outside the message");
    const ranges = occupied.get(view.message_index) ?? [];
    if (
      ranges.some(
        (range) =>
          (view.start < range.end && range.start < view.end) ||
          (range.start === view.start && range.end === view.end),
      )
    )
      throw new Error("Observation views overlap");
    ranges.push(view);
    occupied.set(view.message_index, ranges);
    return decodeObservationView(
      scalars.slice(view.start, view.end).join(""),
      view.encoding,
    );
  };
  for (const input of batch.inputs) {
    if (input.actor?.bank !== undefined && input.actor.bank !== batch.bank)
      throw new Error("Observation actor is outside the destination bank");
    if (
      (input.origin === "human_input" &&
        input.actor &&
        input.actor.role !== "human") ||
      (["assistant_output", "assistant_reasoning"].includes(input.origin) &&
        input.actor &&
        input.actor.role !== "assistant") ||
      (input.origin === "unattributed_input" && input.actor)
    )
      throw new Error("Observation origin and actor disagree");
    if (
      input.origin !== "external_observation" &&
      (input.tool != null || input.url != null)
    )
      throw new Error("External provenance requires an external source");
    if (
      (input.context?.length ?? 0) > limits.max_observation_contexts ||
      input.context?.some((id) => !ids.has(id))
    )
      throw new Error("Observation context is undeclared");
    let content: string | undefined;
    for (const view of input.views) {
      const message = messages[view.message_index];
      if (!message || !["system", "user", "assistant"].includes(message.role))
        throw new Error("Observation view has no supported message");
      const requiredRole =
        input.origin === "human_input"
          ? "user"
          : input.origin === "system_input"
            ? "system"
            : ["assistant_output", "assistant_reasoning"].includes(input.origin)
              ? "assistant"
              : undefined;
      if (requiredRole && message.role !== requiredRole)
        throw new Error("Observation origin disagrees with the native role");
      const decoded = readView(view);
      if (
        Buffer.from(decoded).toString("utf8") !== decoded ||
        Array.from(decoded).length > limits.max_observation_source_chars ||
        (content !== undefined && content !== decoded)
      )
        throw new Error(
          "Observation source views disagree or exceed the source limit",
        );
      content = decoded;
    }
    total += Array.from(content ?? "").length;
  }
  for (const reference of batch.references ?? []) {
    const original = Array.from(reference.text);
    total += original.length;
    if (
      !reference.views.length &&
      !batch.inputs.some((input) => input.context?.includes(reference.id))
    )
      throw new Error("Context-only reference is unused");
    for (const view of reference.views) {
      if (
        view.source_start >= view.source_end ||
        view.source_end > original.length ||
        readView(view) !==
          original.slice(view.source_start, view.source_end).join("")
      )
        throw new Error(
          "Generated reference preimage does not match its displayed span",
        );
    }
  }
  if (
    views > limits.max_observation_views ||
    total > limits.max_observation_total_chars
  )
    throw new Error("Observation batch exceeds advertised limits");
  return batch;
}
