import { readFileSync } from "node:fs";
import type { ObservationBatch } from "../../src/llm/evidence.js";
import type { parseRemoraCapabilities } from "../../src/llm/remora.js";

const legacy: {
  capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

/** Fictional capability advertisement, independently pinned to the companion's limits. */
export const evidenceCapabilities = {
  ...legacy.capabilities_example,
  source_binding: "original_message_scalar_views_v1" as const,
  observation_binding: "original_message_scalar_views_v1" as const,
  source_reference_binding: "completed_generated_scalar_views_v1" as const,
  features: {
    ...legacy.capabilities_example.features,
    all_stream_evidence: true,
    source_references: true,
    entity_identity: false,
    memory_management: true,
  },
  limits: {
    ...legacy.capabilities_example.limits,
    max_memory_page_size: 100,
    max_memory_forget_ids: 100,
    max_memory_request_id_chars: 256,
    max_observation_sources: 128,
    max_observation_views: 512,
    max_observation_source_chars: 65536,
    max_observation_contexts: 16,
    max_observation_total_chars: 262144,
    max_observation_id_chars: 256,
  },
} as const;

/** Invented complete HTTP receipt; deliberately makes no useful-memory quality claim. */
export function observationReply(
  batch: ObservationBatch,
  content: string,
  attemptNumber = 1,
  outcome: "rejected" | "untracked_dependencies" = "rejected",
) {
  const attempt = `generation-${String(attemptNumber).padStart(32, "0")}`;
  const receipt = {
    saved: [],
    superseded: [],
    status: "not_admitted",
    replayed: false,
    admission_identity: "a".repeat(64),
  };
  return {
    choices: [{ message: { content } }],
    remora: {
      version: 1,
      backend: "transformers",
      read_banks: [batch.bank],
      selected: [],
      writes: null,
      cache: {
        requested: true,
        reused_tokens: 0,
        evaluated_tokens: 1,
        invalidated: null,
      },
      observations: {
        inputs: [
          ...batch.inputs.map((input) => ({
            source_id: input.id,
            revision: input.revision,
            outcome: "rejected",
            receipt,
          })),
          ...(batch.references ?? []).map((input) => ({
            source_id: input.id,
            revision: input.revision,
            outcome: "referenced",
            receipt: { ...receipt, replayed: true },
          })),
        ],
        generated: [
          { source_id: `${attempt}:output`, revision: 0, outcome, receipt },
        ],
        attempt_id: attempt,
        input_replayed: false,
      },
    },
  };
}

/** Invented quotation, with explicit source voice and deliberately unresolved subjects. */
export function makeEvidenceRecord(bank = "room-a", id = 1) {
  return {
    id,
    bank,
    kind: "evidence" as const,
    subjects: null,
    source: {
      id: `fictional:message:${id}`,
      revision: 0,
      origin: "human_input" as const,
      actor: {
        principal: "fictional-client",
        actor: { bank, role: "human" as const, id: "person-2" },
        entity: null,
        unknown: null,
        description: null,
      },
      tool: null,
      url: null,
    },
    span: { start: 0, end: 6 },
    text: "my dog",
    context: [],
  };
}
