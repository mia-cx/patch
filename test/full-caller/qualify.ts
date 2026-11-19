/** PREPARED ONLY. Run solely after the coordinated isolated full-caller ready.json handback. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { Schema } from "effect";
import { observationNamespace } from "../../src/conversation/observations.js";
import { ObservationLimitsSchema } from "../../src/llm/evidence.js";
import type { EvidenceRecord } from "../../src/memory/evidence.js";
import { BANKS, BASE, FullCallerFixture, MODEL, WEB_URL } from "./fixture.js";
import { CallerHttpGuard } from "./guard.js";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Contract = Schema.Struct({
  schema: Schema.Literal("full-caller-contract-v1"),
  entrypoint: Schema.String,
  files: Schema.Record(Schema.String, Digest),
  persona: Schema.Struct({ path: Schema.String, sha256: Digest }),
  required_limits: Schema.Struct({
    max_observation_sources: Schema.Int,
    max_observation_views: Schema.Int,
  }),
});
const Ready = Schema.Struct({
  base_url: Schema.Literal(BASE),
  token_file: Schema.String,
  banks: Schema.Array(Schema.String),
  model: Schema.Literal(MODEL),
  caller_contract: Schema.Struct({ path: Schema.String, sha256: Digest }),
  freeze_sha256: Digest,
  deadline_monotonic: Schema.Number,
  release_file: Schema.String,
  qualification: Schema.Literal("unqualified"),
});
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  options.set(process.argv[i] ?? "", process.argv[i + 1] ?? "");
if (
  options.size !== 2 ||
  !options.has("--ready") ||
  !options.has("--token-file")
)
  throw new Error(
    "Requires explicit --ready <private ready.json> --token-file <private token>; no default target",
  );
const readyPath = resolve(options.get("--ready") ?? "");
const ready = Schema.decodeUnknownSync(Ready)(
  JSON.parse(readFileSync(readyPath, "utf8")),
);
assert.equal(resolve(options.get("--token-file") ?? ""), ready.token_file);
assert.deepEqual(ready.banks, BANKS);
assert(uptime() < ready.deadline_monotonic - 20, "Isolated window has expired");
const rawContract = readFileSync(ready.caller_contract.path);
assert.equal(digest(rawContract), ready.caller_contract.sha256);
const contract = Schema.decodeUnknownSync(Contract)(
  JSON.parse(rawContract.toString()),
);
assert.equal(contract.entrypoint, resolve(process.argv[1] ?? ""));
for (const [path, hash] of Object.entries(contract.files)) {
  assert(isAbsolute(path));
  assert.equal(
    digest(readFileSync(path)),
    hash,
    `Frozen caller changed: ${path}`,
  );
}
assert.equal(contract.files[contract.persona.path], contract.persona.sha256);
const persona = readFileSync(contract.persona.path, "utf8");
const sharedPersonaPath = resolve(
  dirname(contract.persona.path),
  "persona-shared.txt",
);
assert(sharedPersonaPath in contract.files);
const finalPersonaPaths = [
  "persona-final.txt",
  "persona-shared-final.txt",
  "persona-continuation.txt",
  "persona-shared-continuation.txt",
].map((name) => resolve(dirname(contract.persona.path), name));
for (const path of finalPersonaPaths) assert(path in contract.files);
const output = resolve(dirname(readyPath), "caller-results");
mkdirSync(output, { mode: 0o700 });
const record = (value: unknown) =>
  appendFileSync(resolve(output, "http.jsonl"), `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
const token = readFileSync(ready.token_file, "utf8").trim();
assert(token.length > 0);
const app = new FullCallerFixture(token);
const originalFetch = globalThis.fetch;
const guard = new CallerHttpGuard(
  async (url, init) => {
    assert(uptime() < ready.deadline_monotonic - 10, "Window deadline reached");
    return originalFetch(url, init);
  },
  token,
  Schema.decodeUnknownSync(ObservationLimitsSchema)({
    max_observation_sources: 128,
    max_observation_views: 512,
    max_observation_source_chars: 65536,
    max_observation_contexts: 16,
    max_observation_total_chars: 262144,
    max_observation_id_chars: 256,
  }),
  record,
  new Set([
    persona,
    readFileSync(sharedPersonaPath, "utf8"),
    ...finalPersonaPaths.map((path) => readFileSync(path, "utf8")),
  ]),
);
globalThis.fetch = guard.fetch;
const journey: unknown[] = [];
let outcome: "complete" | "failed" = "failed";

function anchor(records: readonly EvidenceRecord[], source: string) {
  for (const record of records) {
    if (record.source.id === source) return { id: record.id };
    const context_index = record.context.findIndex(
      (item) => item.source.id === source,
    );
    if (context_index >= 0) return { id: record.id, context_index };
  }
  throw new Error("Required source was not retained as evidence/context");
}

try {
  await app.initialize();
  for (const bank of BANKS)
    assert.equal(
      (await app.memory.listEvidence(bank)).data.length,
      0,
      "Qualification requires fresh empty banks",
    );
  const turn = async (
    bank: (typeof BANKS)[number],
    text: string,
    edit?: { id: string; revision: number },
  ) => {
    const before = guard.chats.length;
    const result = await app.turn(bank, text, edit);
    journey.push({
      ...result,
      first_request: before,
      end_request: guard.chats.length,
    });
    return result;
  };
  await turn(BANKS[3], "My private sentinel code is Saffron-726.");
  const sentinel = await app.memory.listEvidence(BANKS[3]);
  assert(
    sentinel.data.length,
    "Sentinel must be retained before isolation checks",
  );
  await turn(BANKS[2], "Our shared project is called Lumen Harbor.");
  const firstRequest = guard.chats.length;
  const plain = await turn(
    BANKS[0],
    "My preferred editor is Helix. I like oolong tea.",
  );
  await turn(BANKS[0], "Ask me which music genre I listen to most.");
  await turn(BANKS[0], "future garage");
  app.reset(BANKS[0]);
  await turn(
    BANKS[0],
    "What editor, tea and music genre did I tell you I prefer?",
  );
  await turn(BANKS[0], "Actually, my preferred editor is Zed now.");
  app.reset(BANKS[0]);
  await turn(BANKS[0], "Which editor do I prefer now?");
  const editStart = guard.chats.length;
  await turn(BANKS[0], "My preferred editor is Zed. I like oolong tea.", {
    id: plain.id,
    revision: 1792400000000,
  });
  const editedRequest = guard.chats[editStart];
  assert(
    editedRequest?.observations?.inputs.some(
      (input) =>
        input.id === plain.source_id && input.revision === 1792400000000,
    ),
  );
  app.reset(BANKS[0]);
  await turn(BANKS[0], "Which editor do I prefer now?");
  const webStart = guard.chats.length;
  const webTurn = await turn(
    BANKS[0],
    `Use web_fetch to read ${WEB_URL} and tell me what its badge colour means. Keep the reply short.`,
  );
  assert(
    guard.chats
      .slice(webStart)
      .some(({ observations }) =>
        observations?.inputs.some(
          (input) =>
            input.origin === "external_observation" && input.url === WEB_URL,
        ),
      ),
    "The real model must execute the actual web tool",
  );
  const reentryStart = guard.chats.length;
  await turn(BANKS[0], "What does that colour mean again?");
  for (const display of webTurn.sent) {
    const parent = app.store.displayParent(
      observationNamespace(BASE, token),
      BANKS[0],
      display.id,
      0,
      display.text,
    );
    assert(parent, "Actual formatted display lacks a qualified raw parent");
    assert(
      guard.chats
        .slice(reentryStart)
        .some(({ observations }) =>
          observations?.references?.some(
            (reference) =>
              reference.id === parent.id && reference.text === parent.text,
          ),
        ),
      "Actual displayed parent did not re-enter the full caller",
    );
  }
  assert(
    guard.chats
      .slice(webStart)
      .some(({ observations }) => observations?.references?.length),
    "Formatted display must re-enter through an authenticated raw parent",
  );
  app.reset(BANKS[0]);
  await turn(BANKS[0], "What did the page say its violet badges mean?");
  const beforeForget = await app.memory.listEvidence(BANKS[0]);
  const webRecord = beforeForget.data.find(
    (record) =>
      record.source.url === WEB_URL ||
      record.context.some((item) => item.source.url === WEB_URL),
  );
  assert(webRecord, "A useful web quotation/context must survive reset");
  const recordBody = {
    bank: BANKS[0],
    ids: [webRecord.id],
    request_id: "full-caller-record-forget",
    expected_revision: beforeForget.revision,
  };
  const forgotten = await app.mutation(() =>
    app.memory.forgetEvidence(recordBody),
  );
  assert(forgotten);
  assert.equal(forgotten.reset_required, true);
  const recordReplay = await app.mutation(() =>
    app.memory.forgetEvidence(recordBody),
  );
  assert(recordReplay);
  assert.equal(recordReplay.replayed, true);
  assert.deepEqual({ ...recordReplay, replayed: false }, forgotten);
  assert(
    !(await app.memory.listEvidence(BANKS[0])).data.some(
      (record) => record.id === webRecord.id,
    ),
  );
  const snapshot = await app.memory.listEvidence(BANKS[0]);
  const sourceAnchor = anchor(snapshot.data, plain.source_id);
  const sourceBody = {
    bank: BANKS[0],
    ...sourceAnchor,
    request_id: "full-caller-source-forget",
    expected_revision: snapshot.revision,
  };
  const sourceReceipt = await app.mutation(() =>
    app.memory.forgetEvidenceSource(sourceBody),
  );
  const sourceReplay = await app.mutation(() =>
    app.memory.forgetEvidenceSource(sourceBody),
  );
  assert(sourceReceipt && sourceReplay);
  assert.equal(sourceReplay.replayed, true);
  assert.deepEqual({ ...sourceReplay, replayed: false }, sourceReceipt);
  const afterErase = await app.memory.listEvidence(BANKS[0]);
  assert(
    !afterErase.data.some(
      (record) =>
        record.source.id === plain.source_id ||
        record.context.some((item) => item.source.id === plain.source_id),
    ),
    "Erased source and dependent contexts must be absent",
  );
  // The immutable completed edit has no erased raw references. No cache callback can recreate its old display.
  assert(
    editedRequest?.observations &&
      !editedRequest.observations.references?.length,
  );
  const retry = await app.llm.complete({
    messages: [...editedRequest.body.messages],
    remora: {
      read_banks: [...editedRequest.body.remora.read_banks],
      observations: editedRequest.observations,
      ...(editedRequest.body.remora.speaker
        ? { speaker: editedRequest.body.remora.speaker }
        : {}),
    },
    maxTokens: 128,
    temperature: 0,
    enableThinking: false,
  });
  journey.push({
    stage: "erased-completed-source-retry",
    metadata: retry.remora,
    text: retry.content,
  });
  assert(
    retry.remora?.observations?.input_replayed,
    "Completed input must replay its original receipt",
  );
  assert.deepEqual(
    (await app.memory.listEvidence(BANKS[0])).data,
    afterErase.data,
    "Completed retry must not resurrect evidence",
  );
  await turn(
    BANKS[0],
    "What editor do I prefer now, and what tea did I say I like?",
  );
  await turn(
    BANKS[1],
    "What is our shared project called? What private sentinel code do I have?",
  );
  app.reset(BANKS[0]);
  await turn(
    BANKS[0],
    "What is our shared project called? What private sentinel code do I have?",
  );
  assert.deepEqual(
    (await app.memory.listEvidence(BANKS[3])).data,
    sentinel.data,
    "Unrelated bank sentinel changed",
  );
  const forbidden = app.sent
    .filter(({ bank }) => bank !== BANKS[3])
    .filter(({ text }) => /saffron[ -]?726/i.test(text));
  assert.equal(
    forbidden.length,
    0,
    "Private bank leaked into another bank's reply",
  );
  assert(
    guard.chats[firstRequest]?.observations?.inputs.some(
      (input) => input.id === plain.source_id,
    ),
  );
  outcome = "complete";
} finally {
  globalThis.fetch = originalFetch;
  writeFileSync(
    resolve(output, "results.json"),
    JSON.stringify(
      {
        outcome,
        qualification: "unqualified",
        semantic_review: "required_before_release",
        hard_semantic_failures: [
          "wrong speaker",
          "erased source resurrection",
          "private/shared disclosure",
        ],
        physical_erasure_review: "backend full-table snapshots required",
        clean_context_boundary:
          "invented empty model histories; preserve all original records and banks at eventual cutover",
        http: guard.count,
        completions: guard.completions,
        max_sources: guard.sources,
        max_views: guard.views,
        journey,
        sent: app.sent,
        violations: app.violations,
        logs: app.logs,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await app.close();
  const releaseTemp = resolve(
    dirname(ready.release_file),
    `caller-release-${process.pid}.tmp`,
  );
  writeFileSync(
    releaseTemp,
    JSON.stringify({
      freeze_sha256: ready.freeze_sha256,
      caller_contract_sha256: ready.caller_contract.sha256,
      outcome,
    }),
    { mode: 0o600, flag: "wx" },
  );
  linkSync(releaseTemp, ready.release_file);
  unlinkSync(releaseTemp);
}
console.log(
  JSON.stringify({
    outcome,
    semantic_review: "pending",
    http: guard.count,
    completions: guard.completions,
    output,
  }),
);
