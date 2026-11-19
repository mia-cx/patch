import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { Schema } from "effect";
import {
  MemoryManagementError,
  RemoraMemoryClient,
} from "../src/memory/client.js";

// This probe deletes invented rows. Require an explicit isolated fixture instead
// of accepting the ordinary LLM environment or inheriting the live trial bank.
const manifestPath = process.env.REMORA_MEMORY_SMOKE_MANIFEST;
const tokenPath = process.env.REMORA_MEMORY_SMOKE_TOKEN_FILE;
const outputPath = process.env.REMORA_MEMORY_SMOKE_OUTPUT;
assert(
  manifestPath && tokenPath && outputPath,
  "Set REMORA_MEMORY_SMOKE_MANIFEST, REMORA_MEMORY_SMOKE_TOKEN_FILE and REMORA_MEMORY_SMOKE_OUTPUT for a disposable HTTP fixture",
);
const ExpectedMemory = Schema.Struct({ id: Schema.Int, text: Schema.String });
const manifest = Schema.decodeUnknownSync(
  Schema.Struct({
    disposable: Schema.Literal(true),
    base_url: Schema.String,
    bank_a: Schema.String,
    bank_b: Schema.String,
    forget_id: Schema.Int,
    expected_a: Schema.Array(ExpectedMemory),
    expected_b: Schema.Array(ExpectedMemory),
  }),
)(JSON.parse(readFileSync(manifestPath, "utf8")));
const base = new URL(manifest.base_url);
assert.equal(base.hostname, "127.0.0.1");
assert.equal(base.pathname, "/v1");
assert(
  base.port && base.port !== "18787",
  "The live trial endpoint is forbidden",
);
assert.notEqual(manifest.bank_a, manifest.bank_b);
assert(
  !manifest.bank_a.startsWith("discord:") &&
    !manifest.bank_b.startsWith("discord:"),
  "Real platform banks are forbidden",
);
assert(manifest.expected_a.length >= 2 && manifest.expected_b.length >= 1);
assert(manifest.expected_a.some((memory) => memory.id === manifest.forget_id));
const output = openSync(outputPath, "wx", 0o600);
const readonlyTokenPath = process.env.REMORA_MEMORY_SMOKE_READONLY_TOKEN_FILE;
const readonlyToken = readonlyTokenPath
  ? readFileSync(readonlyTokenPath, "utf8").trim()
  : undefined;

const requestPaths: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, base.origin);
  assert(
    [
      "/v1/remora/capabilities",
      "/v1/remora/memories",
      "/v1/remora/memories/forget",
      "/v1/remora/memories/clear",
    ].includes(url.pathname),
    "Only management routes are allowed",
  );
  requestPaths.push(`${init?.method ?? "GET"} ${url.pathname}`);
  return originalFetch(input, init);
};
const client = new RemoraMemoryClient({
  llmBaseUrl: manifest.base_url,
  llmApiKey: readFileSync(tokenPath, "utf8").trim(),
  llmTimeoutMs: 15_000,
});
const capabilities = await client.initialize();
assert.equal(capabilities.features.memory_management, true);
const initialA = await client.listAll(manifest.bank_a, 1_000_000);
const initialB = await client.listAll(manifest.bank_b, 1_000_000);
assert.deepEqual(
  initialA.data.map(({ id, text }) => ({ id, text })),
  manifest.expected_a,
);
assert.deepEqual(
  initialB.data.map(({ id, text }) => ({ id, text })),
  manifest.expected_b,
);
const run = randomUUID();
const forgetRequest = {
  bank: manifest.bank_a,
  ids: [manifest.forget_id],
  request_id: `patch-smoke:${run}:forget`,
  expected_revision: initialA.revision,
};
const forgotten = await client.forget(forgetRequest);
assert.equal(forgotten.replayed, false);
const forgottenReplay = await client.forget(forgetRequest);
assert.deepEqual(forgottenReplay, { ...forgotten, replayed: true });
const afterForget = await client.listAll(manifest.bank_a, 1_000_000);
assert.deepEqual(
  afterForget.data,
  initialA.data.filter(({ id }) => id !== manifest.forget_id),
);
const clearRequest = {
  bank: manifest.bank_a,
  request_id: `patch-smoke:${run}:clear`,
  expected_revision: afterForget.revision,
};
const cleared = await client.clear(clearRequest);
assert.equal(cleared.replayed, false);
assert.equal(cleared.deleted_count, afterForget.data.length);
const clearedReplay = await client.clear(clearRequest);
assert.deepEqual(clearedReplay, { ...cleared, replayed: true });
const finalA = await client.listAll(manifest.bank_a, 1_000_000);
const finalB = await client.listAll(manifest.bank_b, 1_000_000);
assert.deepEqual(finalA.data, []);
assert.deepEqual(finalB, initialB);
let readonlyDenied = false;
if (readonlyToken) {
  const readonly = new RemoraMemoryClient({
    llmBaseUrl: manifest.base_url,
    llmApiKey: readonlyToken,
    llmTimeoutMs: 15_000,
  });
  await readonly.initialize();
  const snapshot = await readonly.listAll(manifest.bank_b, 1_000_000);
  assert.deepEqual(snapshot.data, finalB.data);
  const id = manifest.expected_b[0]?.id;
  assert(id);
  await assert.rejects(
    readonly.forget({
      bank: manifest.bank_b,
      ids: [id],
      request_id: `patch-smoke:${run}:forbidden`,
      expected_revision: snapshot.revision,
    }),
    (error: unknown) =>
      error instanceof MemoryManagementError &&
      error.status === 403 &&
      error.code === "memory_forbidden",
  );
  assert.deepEqual(await client.listAll(manifest.bank_b, 1_000_000), initialB);
  readonlyDenied = true;
}
writeFileSync(
  output,
  `${JSON.stringify({ capabilities, initialA, initialB, forgotten, forgottenReplay, afterForget, cleared, clearedReplay, finalA, finalB, readonlyDenied, requestPaths }, null, 2)}\n`,
);
closeSync(output);
console.log(
  JSON.stringify({
    passed: true,
    managementRequests: requestPaths.length,
    bankAEmpty: true,
    bankBUnchanged: true,
    readonlyDenied,
    outputPath,
  }),
);
