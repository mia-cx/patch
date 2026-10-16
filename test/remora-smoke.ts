import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { LlmClient, type LlmMessage } from "../src/llm/client.js";
import type { RemoraRequest } from "../src/llm/remora.js";
import { buildResponseContextBudget } from "../src/prompts/response.js";

// Exercise the real client without connecting a Discord bot or using real messages.
assert(
  process.env.LLM_BASE_URL,
  "Set LLM_BASE_URL to the isolated Remora service",
);
assert(
  process.env.LLM_API_KEY,
  "Set LLM_API_KEY for its synthetic test-bank policy",
);
const fixture: {
  model: string;
  messages: LlmMessage[];
  max_tokens: number;
  remora: RemoraRequest;
} = JSON.parse(
  readFileSync(
    new URL("../spec/fixtures/remora-patch-request.json", import.meta.url),
    "utf8",
  ),
);
const config = loadConfig({
  ...process.env,
  DISCORD_TOKEN: "unused-http-probe",
  DISCORD_CLIENT_ID: "unused-http-probe",
  LLM_MODEL: process.env.LLM_MODEL ?? fixture.model,
  LLM_TEMPERATURE: "0",
  LLM_ENABLE_THINKING: "false",
  ACTIVITY_UPDATES_ENABLED: "false",
  REMORA_DM_ENABLED: "true",
  REMORA_READ_BANKS: "",
});
const llm = new LlmClient(config);
const capabilities = await llm.initializeRemora();
const budget = buildResponseContextBudget(config, "dm");
assert(
  budget.promptTokens + (budget.responseTokens ?? 0) < budget.contextTokens,
  "The service context cannot fit Patch's persona and output allowance",
);
const request = {
  messages: fixture.messages,
  remora: fixture.remora,
  maxTokens: fixture.max_tokens,
  signal: AbortSignal.timeout(config.llmTimeoutMs),
};
const first = await llm.complete(request);
assert(
  first.content.trim(),
  "Expected a nonempty response through the full Patch persona",
);
assert.equal(
  first.remora?.writes?.result.error,
  null,
  "The synthetic source write must succeed",
);
const replay = await llm.complete({
  ...request,
  maxTokens: Math.max(1, fixture.max_tokens / 2),
  signal: AbortSignal.timeout(config.llmTimeoutMs),
});
assert(replay.content.trim(), "Expected a nonempty fallback generation");
assert.equal(
  replay.remora?.writes?.replayed,
  true,
  "Retry must replay the durable write receipt",
);
assert.deepEqual(
  replay.remora?.writes?.result,
  first.remora?.writes?.result,
  "Changing generation limits must not run the writer again",
);
console.log(
  JSON.stringify(
    {
      capabilities,
      contextTokens: config.llmContextTokens,
      first: { content: first.content, remora: first.remora },
      replay: { content: replay.content, remora: replay.remora },
    },
    null,
    2,
  ),
);
