import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { LlmClient, type LlmMessage } from "./client.js";
import type { RemoraRequest, RemoraResponse } from "./remora.js";

// Golden examples are copied from Remora's canonical contract, not re-created by Patch.
const contract: {
  request_example: { messages: LlmMessage[]; remora: RemoraRequest };
  readonly_speaker_request_example: {
    messages: LlmMessage[];
    remora: RemoraRequest;
  };
  response_example: {
    choices: { message: { content: string } }[];
    remora: RemoraResponse;
  };
  capabilities_example: {
    features: Record<string, boolean>;
    limits: {
      context_tokens: number;
      max_output_tokens: number;
      max_read_banks: number;
    };
  };
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

afterEach(() => vi.unstubAllGlobals());

describe("Remora contract over the LLM HTTP interface", () => {
  // Proves runtime limits govern both chat history and explicit auxiliary generation allowances.
  it("negotiates runtime limits and consumes the canonical request/receipt", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    const requests: {
      remora?: RemoraRequest;
      max_tokens: number;
      cache_prompt: boolean;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/remora/capabilities"))
          return Response.json({
            ...contract.capabilities_example,
            features: {
              ...contract.capabilities_example.features,
              speaker_binding: undefined,
            },
            limits: {
              context_tokens: 16_384,
              max_output_tokens: 128,
              max_read_banks: 8,
            },
          });
        const body = JSON.parse(String(init.body));
        requests.push(body);
        return Response.json(
          body.remora
            ? contract.response_example
            : { choices: contract.response_example.choices },
        );
      }),
    );
    const llm = new LlmClient(config);
    await llm.initializeRemora();
    const result = await llm.complete({
      ...contract.request_example,
      maxTokens: 768,
    });
    await llm.complete({
      messages: contract.request_example.messages,
      maxTokens: 768,
    });
    expect(config.llmContextTokens).toBe(16_384);
    expect(config.llmMaxTokens).toBe(128);
    expect(result.content).toBe("Got it.");
    expect(result.remora).toEqual(contract.response_example.remora);
    expect(requests).toEqual([
      expect.objectContaining({
        remora: contract.request_example.remora,
        max_tokens: 128,
        cache_prompt: true,
      }),
      expect.objectContaining({ max_tokens: 128 }),
    ]);
    expect(requests[1]?.remora).toBeUndefined();
  });

  // Proves a read-only caller can bind the current human without creating a write source.
  it("transports the canonical read-only speaker and accepts no write receipt", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    const requests: { remora?: RemoraRequest }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/remora/capabilities"))
          return Response.json(contract.capabilities_example);
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          ...contract.response_example,
          remora: { ...contract.response_example.remora, writes: null },
        });
      }),
    );
    const llm = new LlmClient(config);
    const capabilities = await llm.initializeRemora();
    const result = await llm.complete(
      contract.readonly_speaker_request_example,
    );

    expect(capabilities.features.speaker_binding).toBe(true);
    expect(requests.map((request) => request.remora)).toEqual([
      contract.readonly_speaker_request_example.remora,
    ]);
    expect(result.content).toBe("Got it.");
    expect(result.remora?.writes).toBeNull();
  });

  // Proves durable failed-write receipts remain visible without discarding the generated answer.
  it("preserves an answer alongside a replayed failed-write receipt", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
    });
    const writes = contract.response_example.remora.writes;
    if (!writes) throw new Error("Canonical fixture must have a write receipt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...contract.response_example,
          remora: {
            ...contract.response_example.remora,
            writes: {
              ...writes,
              replayed: true,
              result: {
                ...writes.result,
                saved: [],
                error: "writer unavailable",
              },
            },
          },
        }),
      ),
    );
    const result = await new LlmClient(config).complete(
      contract.request_example,
    );
    expect(result.content).toBe("Got it.");
    expect(result.remora?.writes).toEqual(
      expect.objectContaining({
        replayed: true,
        result: expect.objectContaining({
          saved: [],
          error: "writer unavailable",
        }),
      }),
    );
  });

  // Proves unsupported profiles fail before the bot starts accepting writable DM turns.
  it.each([
    "missing_cache",
    "missing_revisions",
    "thinking",
    "sampling",
    "activity",
    "too_many_banks",
  ] as const)("rejects %s configuration", async (failure) => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: failure === "sampling" ? "0.55" : "0",
      LLM_ENABLE_THINKING: String(failure === "thinking"),
      ACTIVITY_UPDATES_ENABLED: String(failure === "activity"),
      REMORA_READ_BANKS: failure === "too_many_banks" ? "a,b,c,d,e,f,g,h" : "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...contract.capabilities_example,
          features: {
            ...contract.capabilities_example.features,
            ...(failure === "missing_cache" ? { prefix_cache: false } : {}),
            ...(failure === "missing_revisions"
              ? { source_revisions: false }
              : {}),
          },
        }),
      ),
    );
    await expect(new LlmClient(config).initializeRemora()).rejects.toThrow();
  });
});
