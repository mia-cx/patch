import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { LlmClient, type LlmMessage } from "./client.js";
import type {
  RemoraIdentity,
  RemoraRequest,
  RemoraResponse,
  parseRemoraCapabilities,
} from "./remora.js";

// Golden examples are copied from Remora's canonical contract, not re-created by Patch.
const contract: {
  request_example: { messages: LlmMessage[]; remora: RemoraRequest };
  readonly_speaker_request_example: {
    messages: LlmMessage[];
    remora: RemoraRequest;
  };
  identity_request_example: { messages: LlmMessage[]; remora: RemoraRequest };
  harness_names_request_example: {
    messages: LlmMessage[];
    remora: RemoraRequest;
  };
  response_example: {
    choices: { message: { content: string } }[];
    remora: RemoraResponse;
  };
  capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
  identity_capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
  harness_names_capabilities_example: ReturnType<
    typeof parseRemoraCapabilities
  >;
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
            memory_delivery: undefined,
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
          return Response.json({
            ...contract.capabilities_example,
            memory_delivery: "native-cache",
            profile: "gemma-reference-12288-native-cache",
          });
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
    expect(capabilities.memory_delivery).toBe("native-cache");
    expect(capabilities.backend).toBe("transformers");
    expect(capabilities.profile).toBe("gemma-reference-12288-native-cache");
    expect(requests.map((request) => request.remora)).toEqual([
      contract.readonly_speaker_request_example.remora,
    ]);
    expect(result.content).toBe("Got it.");
    expect(result.remora?.writes).toBeNull();
  });

  // Proves negotiated identity survives transport, honors actual limits and never expands read-only writes.
  it("transports identity within advertised limits and stops when support is withdrawn", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    let capabilities = {
      ...contract.identity_capabilities_example,
      limits: {
        ...contract.identity_capabilities_example.limits,
        max_identity_bindings: 1,
        max_identity_labels: 1,
        max_identity_id_chars: 32,
        max_identity_label_chars: 4,
      },
    };
    const requests: RemoraRequest[] = [];
    const writes = contract.response_example.remora.writes;
    const request = contract.identity_request_example;
    const identity = request.remora.identity;
    if (!writes || !identity)
      throw new Error("Canonical identity fixture missing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/remora/capabilities"))
          return Response.json(capabilities);
        const body = JSON.parse(String(init.body));
        requests.push(body.remora);
        return Response.json({
          ...contract.response_example,
          remora: {
            ...contract.response_example.remora,
            read_banks: ["place:a"],
            writes: body.remora.turn
              ? { ...writes, bank: "place:a", source_id: "event:1" }
              : null,
          },
        });
      }),
    );
    const llm = new LlmClient(config);
    await llm.initializeRemora();
    const saved = await llm.complete(request);
    const readonly: RemoraRequest = {
      read_banks: ["place:a"],
      speaker: { bank: "place:a", id: "local:7" },
      identity: {
        assistant: { bank: "place:a", id: " account:helper " },
        labels: [
          {
            actor: {
              bank: "place:a",
              role: "assistant",
              id: " account:helper ",
            },
            label: "😀😀😀😀",
          },
        ],
      },
    };
    const recalled = await llm.complete({
      messages: request.messages,
      remora: readonly,
    });
    expect(requests).toEqual([request.remora, readonly]);
    expect(saved.remora?.writes?.source_id).toBe("event:1");
    expect(recalled.remora?.writes).toBeNull();

    const tooLarge: RemoraIdentity[] = [
      {
        ...identity,
        bindings: [
          ...(identity.bindings ?? []),
          {
            actor: { bank: "place:a", role: "assistant", id: "account:helper" },
            entity: "agent:helper",
          },
        ],
      },
      {
        ...identity,
        labels: [
          ...(identity.labels ?? []),
          {
            actor: { bank: "place:a", role: "assistant", id: "account:helper" },
            label: "Help",
          },
        ],
      },
      { ...identity, assistant: { bank: "place:a", id: "x".repeat(33) } },
      { ...identity, labels: [{ entity: "person:alpha", label: "Alex!" }] },
    ];
    for (const identity of tooLarge)
      await expect(
        llm.complete({ ...request, remora: { ...request.remora, identity } }),
      ).rejects.toThrow("advertised");
    capabilities = {
      ...capabilities,
      features: { ...capabilities.features, entity_identity: false },
    };
    await llm.initializeRemora();
    await expect(llm.complete(request)).rejects.toThrow("not been negotiated");
    expect(requests).toHaveLength(2);
  });

  // Proves unsupported services never receive an identity object, including an empty one.
  it.each([undefined, false])(
    "blocks identity when support is %s",
    async (support) => {
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        DISCORD_CLIENT_ID: "test",
        LLM_TEMPERATURE: "0",
      });
      const fetch = vi.fn(async () =>
        Response.json({
          ...contract.capabilities_example,
          features: {
            ...contract.capabilities_example.features,
            entity_identity: support,
          },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const llm = new LlmClient(config);
      const request = {
        ...contract.readonly_speaker_request_example,
        remora: { read_banks: ["place:a"], identity: {} },
      };
      await expect(llm.complete(request)).rejects.toThrow(
        "not been negotiated",
      );
      await llm.initializeRemora();
      await expect(llm.complete(request)).rejects.toThrow(
        "not been negotiated",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  // Proves an enabled endpoint cannot make clients guess a missing or invalid identity limit.
  it.each([
    ["max_identity_bindings", undefined],
    ["max_identity_labels", undefined],
    ["max_identity_id_chars", undefined],
    ["max_identity_label_chars", undefined],
    ["max_identity_bindings", 17],
    ["max_identity_label_chars", 0],
  ] as const)("rejects enabled identity limit %s=%s", async (field, value) => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...contract.identity_capabilities_example,
          limits: {
            ...contract.identity_capabilities_example.limits,
            [field]: value,
          },
        }),
      ),
    );
    await expect(new LlmClient(config).initializeRemora()).rejects.toThrow();
  });

  // Proves source-bound names survive retries and their receipt remains independent of model writes.
  it("preserves canonical names and acknowledgements across generation retries", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    const request = contract.harness_names_request_example;
    const turn = request.remora.turn;
    const writes = contract.response_example.remora.writes;
    if (!turn || !writes) throw new Error("Canonical writable fixture missing");
    const acknowledgement = {
      saved: [2],
      unchanged: [],
      superseded: [],
      suppressed: [],
    };
    const requests: RemoraRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/remora/capabilities"))
          return Response.json(contract.harness_names_capabilities_example);
        const body: { remora: RemoraRequest } = JSON.parse(String(init.body));
        requests.push(body.remora);
        return Response.json({
          ...contract.response_example,
          remora: {
            ...contract.response_example.remora,
            writes: body.remora.turn
              ? {
                  ...writes,
                  bank: request.remora.write_bank,
                  source_id: turn.id,
                  revision: turn.revision,
                  replayed: requests.length > 1,
                  result: {
                    ...writes.result,
                    saved: [],
                    error: "writer unavailable",
                  },
                  harness_names: acknowledgement,
                }
              : null,
          },
        });
      }),
    );
    const llm = new LlmClient(config);
    await llm.initializeRemora();
    const first = await llm.complete(request);
    const retry = await llm.complete({
      ...request,
      maxTokens: 32,
      enableThinking: false,
    });
    const omitted = await llm.complete({
      ...request,
      remora: { ...request.remora, identity: {} },
    });
    const readonly = await llm.complete({
      messages: request.messages,
      remora: {
        read_banks: request.remora.read_banks,
        speaker: { bank: "place:demo", id: "actor:7" },
      },
    });
    expect(requests.slice(0, 2)).toEqual([request.remora, request.remora]);
    for (const response of [first, retry, omitted]) {
      expect(response.content).toBe("Got it.");
      expect(response.remora?.writes?.harness_names).toEqual(acknowledgement);
      expect(response.remora?.writes?.result.error).toBe("writer unavailable");
    }
    expect(retry.remora?.writes?.replayed).toBe(true);
    expect(omitted.remora?.writes?.replayed).toBe(true);
    expect(requests[2]?.identity?.names).toBeUndefined();
    expect(readonly.remora?.writes).toBeNull();
  });

  // Proves name writes are gated independently of identity support, even with advertised limits.
  it.each([undefined, false])(
    "blocks name declarations when name support is %s",
    async (support) => {
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        DISCORD_CLIENT_ID: "test",
        LLM_TEMPERATURE: "0",
      });
      const fetch = vi.fn(async () =>
        Response.json({
          ...contract.harness_names_capabilities_example,
          features: {
            ...contract.harness_names_capabilities_example.features,
            harness_names: support,
          },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const llm = new LlmClient(config);
      const request = contract.harness_names_request_example;
      await expect(llm.complete(request)).rejects.toThrow("negotiated");
      await llm.initializeRemora();
      await expect(llm.complete(request)).rejects.toThrow("negotiated");
      await expect(
        llm.complete({
          ...request,
          remora: { ...request.remora, identity: { names: [] } },
        }),
      ).rejects.toThrow("negotiated");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  // Proves clients cannot enable name writes without identity and all six valid limits.
  it.each([
    ["max_identity_bindings", undefined],
    ["max_identity_labels", undefined],
    ["max_identity_id_chars", undefined],
    ["max_identity_label_chars", undefined],
    ["max_harness_names", undefined],
    ["max_harness_name_chars", undefined],
    ["max_harness_names", 0],
    ["max_harness_names", 3],
    ["max_harness_name_chars", 129],
    ["max_harness_name_chars", 1.5],
  ] as const)("rejects enabled name limit %s=%s", async (field, value) => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...contract.harness_names_capabilities_example,
          limits: {
            ...contract.harness_names_capabilities_example.limits,
            [field]: value,
          },
        }),
      ),
    );
    await expect(new LlmClient(config).initializeRemora()).rejects.toThrow();
  });

  it.each([undefined, false])(
    "rejects enabled names when identity support is %s",
    async (support) => {
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        DISCORD_CLIENT_ID: "test",
        LLM_TEMPERATURE: "0",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            ...contract.harness_names_capabilities_example,
            features: {
              ...contract.harness_names_capabilities_example.features,
              entity_identity: support,
            },
          }),
        ),
      );
      await expect(new LlmClient(config).initializeRemora()).rejects.toThrow(
        "require entity identity",
      );
    },
  );

  // Proves exact Unicode names cross HTTP while actual smaller limits and renegotiation stop writes.
  it("honors actual name limits and clears them when negotiation changes", async () => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    let capabilities: ReturnType<typeof parseRemoraCapabilities> = {
      ...contract.harness_names_capabilities_example,
      limits: {
        ...contract.harness_names_capabilities_example.limits,
        max_harness_names: 1,
        max_harness_name_chars: 4,
        max_identity_id_chars: 16,
      },
    };
    const example = contract.harness_names_request_example;
    const original = example.remora.identity?.names?.[0];
    const turn = example.remora.turn;
    const writes = contract.response_example.remora.writes;
    if (!original || !turn || !writes)
      throw new Error("Canonical name fixture missing");
    const name = { ...original, name: " 🦊🦊 " };
    const request = {
      ...example,
      remora: { ...example.remora, identity: { names: [name] } },
    };
    const requests: RemoraRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/remora/capabilities"))
          return Response.json(capabilities);
        const body: { remora: RemoraRequest } = JSON.parse(String(init.body));
        requests.push(body.remora);
        return Response.json({
          ...contract.response_example,
          remora: {
            ...contract.response_example.remora,
            writes: {
              ...writes,
              bank: example.remora.write_bank,
              source_id: turn.id,
              harness_names: {
                saved: [],
                unchanged: [],
                superseded: [],
                suppressed: [original.actor],
              },
            },
          },
        });
      }),
    );
    const llm = new LlmClient(config);
    await llm.initializeRemora();
    const result = await llm.complete(request);
    expect(requests[0]).toEqual(request.remora);
    expect(result.remora?.writes?.harness_names?.suppressed).toEqual([
      original.actor,
    ]);
    for (const names of [
      [],
      [name, { ...name, actor: { ...name.actor, id: "actor:8" } }],
      [{ ...name, name: "🦊".repeat(5) }],
      [{ ...name, name: "\u00a0 \n" }],
      [{ ...name, actor: { ...name.actor, id: "x".repeat(17) } }],
    ])
      await expect(
        llm.complete({
          ...request,
          remora: { ...request.remora, identity: { names } },
        }),
      ).rejects.toThrow("advertised");

    capabilities = {
      ...capabilities,
      features: { ...capabilities.features, harness_names: false },
    };
    await llm.initializeRemora();
    await expect(llm.complete(request)).rejects.toThrow("not been negotiated");
    await llm.complete({
      ...request,
      remora: { ...request.remora, identity: { labels: [] } },
    });
    capabilities = {
      ...capabilities,
      features: { ...capabilities.features, harness_names: true },
      limits: { ...capabilities.limits, max_harness_name_chars: undefined },
    };
    await expect(llm.initializeRemora()).rejects.toThrow();
    await expect(llm.complete(request)).rejects.toThrow("not been negotiated");
    expect(requests).toHaveLength(2);
  });

  // Proves a server cannot silently ignore names or return an unusable acknowledgement.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["incomplete", { saved: [2] }],
    [
      "invalid ID",
      { saved: [0], unchanged: [], superseded: [], suppressed: [] },
    ],
    [
      "invalid actor",
      {
        saved: [],
        unchanged: [],
        superseded: [],
        suppressed: [{ bank: "place:demo", role: "bot", id: "actor:7" }],
      },
    ],
  ])("rejects a %s name acknowledgement", async (_label, acknowledgement) => {
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: "test",
      LLM_TEMPERATURE: "0",
    });
    const request = contract.harness_names_request_example;
    const turn = request.remora.turn;
    const writes = contract.response_example.remora.writes;
    if (!turn || !writes) throw new Error("Canonical writable fixture missing");
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/remora/capabilities")
          ? contract.harness_names_capabilities_example
          : {
              ...contract.response_example,
              remora: {
                ...contract.response_example.remora,
                writes: {
                  ...writes,
                  bank: request.remora.write_bank,
                  source_id: turn.id,
                  harness_names: acknowledgement,
                },
              },
            },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const llm = new LlmClient(config);
    await llm.initializeRemora();
    await expect(llm.complete(request)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
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
