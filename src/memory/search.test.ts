import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRemoraCapabilities } from "../llm/remora.js";
import {
  type MemorySearch,
  type MemorySearchRequest,
  RemoraMemoryClient,
} from "./client.js";

const contract: {
  capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
    "utf8",
  ),
);
const fixture: {
  examples: { request: MemorySearchRequest; response: MemorySearch };
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/memory-search.json", import.meta.url),
    "utf8",
  ),
);
const caps = {
  ...contract.capabilities_example,
  features: {
    ...contract.capabilities_example.features,
    memory_management: false,
    memory_search: true,
  },
  limits: {
    ...contract.capabilities_example.limits,
    max_search_results: 2,
    max_search_banks: 2,
    max_search_query_chars: 2048,
    max_search_query_tokens: 256,
  },
};
const config = {
  llmBaseUrl: "http://remora.test/v1",
  llmApiKey: "fictional-token",
  llmTimeoutMs: 1000,
};
afterEach(() => vi.unstubAllGlobals());

describe("explicit Remora recall", () => {
  // Proves exact queries and full bank-qualified facts keep subjects separate from the source voice, without chat or management support.
  it("searches with actual limits and preserves source attribution", async () => {
    const marker = `@{${"a".repeat(64)}}`;
    const hit = fixture.examples.response.data[0];
    if (!hit) throw new Error("Missing canonical hit");
    const response = {
      ...fixture.examples.response,
      query: "  whose dog is Aster?  ",
      read_banks: ["place:b", "place:example"],
      data: [
        {
          ...hit,
          subjects: {
            [marker]: { principal: "example", entity: "someone-else" },
          },
        },
        { ...hit, bank: "place:b", source_actor: null, score: 0.5 },
      ],
      revisions: {
        "place:b": "b".repeat(64),
        ...fixture.examples.response.revisions,
      },
    };
    const request = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", request);
    const client = new RemoraMemoryClient(config);
    expect(client.supportsSearch).toBe(false);
    await client.initialize(parseRemoraCapabilities(caps));
    expect(client.supportsSearch).toBe(true);
    const controller = new AbortController();
    const result = await client.search(
      { read_banks: ["place:example", "place:b"], query: response.query },
      controller.signal,
    );
    expect(result).toEqual(response);
    expect(result.data[0]?.source_actor).toEqual(hit.source_actor);
    expect(result.data[0]?.subjects[marker]).toEqual({
      principal: "example",
      entity: "someone-else",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([
      "http://remora.test/v1/remora/memories/search",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer fictional-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          read_banks: ["place:example", "place:b"],
          query: response.query,
          limit: 2,
        }),
      }),
    ]);
    request.mockResolvedValueOnce(Response.json({ ...response, data: [] }));
    expect(
      (
        await client.search({
          read_banks: response.read_banks,
          query: response.query,
        })
      ).data,
    ).toEqual([]);
  });

  // Proves older endpoints stay compatible while enabled search requires every valid advertised bound.
  it.each([
    "disabled",
    "absent",
    "results",
    "banks",
    "query_chars",
    "query_tokens",
    "excess",
  ] as const)("fails closed for %s", async (failure) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const limits = {
      ...Object.fromEntries(
        Object.entries(caps.limits).filter(
          ([key]) => key !== `max_search_${failure}`,
        ),
      ),
      ...(failure === "excess" ? { max_search_results: 51 } : {}),
    };
    const value = {
      ...caps,
      limits,
      features: {
        ...caps.features,
        memory_search:
          failure === "absent" ? undefined : failure !== "disabled",
      },
    };
    const client = new RemoraMemoryClient(config);
    if (failure === "disabled" || failure === "absent") {
      await client.initialize(parseRemoraCapabilities(value));
      expect(client.supportsSearch).toBe(false);
      await expect(client.search(fixture.examples.request)).rejects.toThrow(
        "unsupported_feature",
      );
    } else expect(() => parseRemoraCapabilities(value)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  // Proves requests honor smaller server limits and code-point counts without silently changing the query or bank scope.
  it("validates input locally and leaves token enforcement to the server", async () => {
    const request = vi.fn(async () =>
      Response.json({ ...fixture.examples.response, query: "🚀🚀🚀" }),
    );
    vi.stubGlobal("fetch", request);
    const client = new RemoraMemoryClient(config);
    await client.initialize(
      parseRemoraCapabilities({
        ...caps,
        limits: { ...caps.limits, max_search_query_chars: 4 },
      }),
    );
    for (const invalid of [
      { read_banks: ["place:example"], query: "     " },
      { read_banks: ["place:example"], query: "longer" },
      { read_banks: ["place:example", "place:example"], query: "dog" },
      { read_banks: ["a", "b", "c"], query: "dog" },
      { read_banks: ["place:example"], query: "dog", limit: 3 },
      { read_banks: ["place:example"], query: "dog", min_score: 2 },
      {
        read_banks: ["place:example"],
        query: "dog",
        write_bank: "place:example",
      },
    ])
      await expect(client.search(invalid)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(
      (await client.search({ read_banks: ["place:example"], query: "🚀🚀🚀" }))
        .query,
    ).toBe("🚀🚀🚀");
  });

  // Proves untrusted responses cannot widen scope, round IDs, alter queries, confuse identities or violate ranking.
  it.each([
    "query",
    "bank",
    "revision",
    "unsafe_id",
    "duplicate",
    "order",
    "subject",
    "floor",
  ] as const)("rejects response %s", async (failure) => {
    const original = fixture.examples.response;
    const hit = original.data[0];
    if (!hit) throw new Error("Missing canonical hit");
    const changed = {
      ...hit,
      ...(failure === "bank" ? { bank: "unrequested" } : {}),
      ...(failure === "unsafe_id" ? { id: Number.MAX_SAFE_INTEGER + 1 } : {}),
      ...(failure === "subject"
        ? { source_actor: { ...hit.source_actor, entity: "different-person" } }
        : {}),
    };
    const response = {
      ...original,
      ...(failure === "query" ? { query: "another query" } : {}),
      ...(failure === "revision"
        ? { revisions: { unrequested: "a".repeat(64) } }
        : {}),
      data:
        failure === "duplicate"
          ? [hit, hit]
          : failure === "order"
            ? [hit, { ...hit, id: 3, score: 0.99 }]
            : [changed],
    };
    const request = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", request);
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(caps));
    await expect(
      client.search({
        read_banks: response.read_banks,
        query: fixture.examples.response.query,
        limit: 2,
        ...(failure === "floor" ? { min_score: 0.9 } : {}),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  // Proves changed-snapshot errors remain failures and do not trigger a fallback model or write request.
  it.each([
    ["memory_search_changed", 409],
    ["search_query_too_long", 400],
  ] as const)("propagates %s without retrying", async (code, status) => {
    const request = vi.fn(async () =>
      Response.json({ error: { code } }, { status }),
    );
    vi.stubGlobal("fetch", request);
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(caps));
    await expect(
      client.search({ ...fixture.examples.request, limit: 2 }),
    ).rejects.toMatchObject({ code, status });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
