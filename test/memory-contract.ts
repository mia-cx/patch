import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import type { LlmTool } from "../src/llm/client.js";
import {
  MemorySaveReceiptSchema,
  MemorySaveRequestSchema,
} from "../src/memory/save.js";
import {
  MemoryDispatchEnvelopeSchema,
  MemoryToolOutcomeSchema,
  MemoryToolResultSchema,
  MemoryTurnEnvelopeSchema,
} from "../src/memory/tool-contract.js";

export const memoryContractSchemas = {
  backend_save_request: MemorySaveRequestSchema,
  backend_save_receipt: MemorySaveReceiptSchema,
  backend_error: Schema.Struct({
    http_status: Schema.Int,
    body: Schema.Struct({
      error: Schema.Struct({
        message: Schema.String,
        type: Schema.String,
        param: Schema.NullOr(Schema.String),
        code: Schema.String,
      }),
    }),
  }),
  action_output: MemoryToolOutcomeSchema,
  dispatcher: MemoryDispatchEnvelopeSchema,
  tool_result: MemoryToolResultSchema,
  terminal_turn: MemoryTurnEnvelopeSchema,
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Export only implemented runtime validators and observed synthetic results. */
export function buildMemoryContract(
  tools: readonly LlmTool[],
  examples: Record<string, unknown>,
  backendRoot: string,
) {
  const revisions = (root: string, files: string[]) => ({
    commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    files: Object.fromEntries(
      files.map((file) => [
        file,
        hash(readFileSync(`${root}/${file}`, "utf8")),
      ]),
    ),
  });
  return {
    object: "protocord.memory_tool_contract",
    version: 1,
    status: "implemented_and_synthetic_http_tested",
    deployed: false,
    proposed: false,
    schema_scope:
      "Runtime-derived structural JSON Schemas plus the listed permission, Unicode-scalar, source binding, timestamp validity, receipt-ID equality and policy invariants. JSON Schema alone does not grant permission or prove these cross-field invariants.",
    provenance: {
      patch: revisions(process.cwd(), [
        "src/actions/memory-tools.ts",
        "src/actions/tool-calls.ts",
        "src/memory/client.ts",
        "src/memory/save.ts",
        "src/memory/tool-contract.ts",
        "src/memory/journal.ts",
        "src/tools/turn.ts",
        "src/response/responder.ts",
        "src/memory/tools.integration.test.ts",
      ]),
      remora: revisions(backendRoot, [
        "src/ardm/explicit_save.py",
        "src/ardm/evidence_memory.py",
        "src/ardm/evidence_parents.py",
        "src/ardm/api.py",
        "tests/test_explicit_save.py",
      ]),
      fixture_test: "src/memory/tools.integration.test.ts",
      verification:
        "REMORA_TEST_SOURCE=<backend checkout> pnpm exec vitest run src/memory/tools.integration.test.ts",
      synthetic_only: true,
    },
    tools: tools.filter((tool) =>
      ["memory_save", "memory_forget"].includes(tool.function.name),
    ),
    schemas: Object.fromEntries(
      Object.entries(memoryContractSchemas).map(([name, schema]) => {
        const document = Schema.toJsonSchemaDocument(schema);
        return [name, { ...document.schema, $defs: document.definitions }];
      }),
    ),
    gating: {
      memory_save: {
        capabilities: [
          "features.explicit_memory_save=true",
          "features.all_stream_evidence=true",
          "features.memory_management=true",
          "limits.max_explicit_memory_chars in 1..4096",
          "all six valid observation limits and three management limits",
        ],
        caller: [
          "harness present",
          "selected read banks",
          "caller-selected writeBank equals buildRemoraRequest destination",
          "raw non-bot, non-webhook human in approved Discord scope",
          "direct current remember request with literal content",
        ],
        backend: [
          "authenticated bearer principal",
          "full-bank read grant",
          "existing bank write grant",
          "unchanged policy at commit",
        ],
        arguments:
          "Empty object only. Model cannot supply actor, bank, source, text, time, provenance or subjects.",
      },
      memory_forget: {
        capabilities: [
          "features.memory_management=true with all three valid limits",
          "features.all_stream_evidence=true additionally required for kind=evidence",
        ],
        caller: [
          "harness and selected read banks",
          "personal only in the requesting human's DM",
          "channel requires ViewChannel, ReadMessageHistory, ManageMessages",
          "server requires ViewChannel, ReadMessageHistory, ManageGuild",
          "bank derived from signed Discord event and included in caller read banks",
          "raw current request selects exact namespace and ID: forget evidence #ID or forget fact #ID; optional in/from my/this/the personal/channel/server",
          "other requests return clarification candidates and delete nothing",
        ],
        backend: [
          "authenticated bearer principal",
          "independent read and forget grants",
          "evidence requires full-bank read and forget authority",
          "exact ID and frozen revision",
          "policy checked again at commit",
        ],
      },
    },
    semantics: {
      evidence:
        "Saves entire literal current request as human_input. Source author remains distinct from semantic subjects; subjects=null means unresolved. No assistant paraphrase, atomisation or surprise admission.",
      idempotence:
        "Independent explicit source-revision receipt and fingerprinted request ID survive retries. Forgotten saves return status=forgotten and active_ids=[]; replay cannot restore plaintext. Caller freezes forget revision in a durable digest-only journal.",
      outcomes:
        "Memory controls execute alone. runToolTurn returns terminal_turn with memoryToolResult. The responder presents its deterministic content and performs no further model call. No native role=tool or tagged continuation message is emitted for these terminal controls.",
      failure:
        "dispatchToolCall throws on failed authorization, validation or HTTP. runToolTurn converts that failure to completed=false and an unconfirmed terminal message. completed=true with clarification_required is a completed read, not proof of a save or deletion.",
      transport:
        "dispatcher is the actual dispatchToolCall return. tool_result is memoryToolResult within the terminal turn, not a serialized model tool message.",
      scope:
        "No clear, source-wide erasure, arbitrary actor or arbitrary bank model argument exists. Existing slash and search behavior is retained.",
    },
    examples,
  };
}
