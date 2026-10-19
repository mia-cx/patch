import { readFileSync } from "node:fs";
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
  features: {
    ...legacy.capabilities_example.features,
    all_stream_evidence: true,
    entity_identity: false,
    memory_management: true,
  },
  limits: {
    ...legacy.capabilities_example.limits,
    max_memory_page_size: 100,
    max_memory_forget_ids: 100,
    max_memory_request_id_chars: 256,
    max_observation_sources: 62,
    max_observation_views: 64,
    max_observation_source_chars: 65536,
    max_observation_contexts: 16,
    max_observation_total_chars: 262144,
    max_observation_id_chars: 256,
  },
};

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
