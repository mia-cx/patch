import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { parseRemoraCapabilities } from "../llm/remora.js";
import {
  type MemoryMutation,
  type MemorySnapshot,
  RemoraMemoryClient,
} from "./client.js";

const contract: {
  memory_management: {
    examples: {
      capabilities_with_management: ReturnType<typeof parseRemoraCapabilities>;
      capabilities_without_management: ReturnType<
        typeof parseRemoraCapabilities
      >;
      list_first_page: { response: MemorySnapshot };
      list_next_page: { response: MemorySnapshot };
      forget: {
        request: {
          bank: string;
          ids: number[];
          request_id: string;
          expected_revision: string;
        };
        response: MemoryMutation;
      };
      clear: {
        request: {
          bank: string;
          request_id: string;
          expected_revision: string;
        };
        response: MemoryMutation;
      };
    };
  };
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
    "utf8",
  ),
);
const examples = contract.memory_management.examples;
const config = {
  llmBaseUrl: "http://remora.test/v1",
  llmApiKey: "fictional-token",
  llmTimeoutMs: 1000,
};
afterEach(() => vi.unstubAllGlobals());

describe("deterministic Remora management HTTP", () => {
  // Proves complete authorized data and exact durable mutation receipts travel without a model request.
  it("lists every canonical page and validates exact forget, replay and clear receipts", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    let forgetCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: string, init: RequestInit) => {
        const url = new URL(value);
        requests.push({ url, init });
        if (url.pathname.endsWith("/capabilities"))
          return Response.json(examples.capabilities_with_management);
        if (url.pathname.endsWith("/memories"))
          return Response.json(
            url.searchParams.has("cursor")
              ? examples.list_next_page.response
              : examples.list_first_page.response,
          );
        if (url.pathname.endsWith("/forget"))
          return Response.json({
            ...examples.forget.response,
            replayed: forgetCalls++ > 0,
          });
        if (url.pathname.endsWith("/clear"))
          return Response.json(examples.clear.response);
        throw new Error(`Unexpected route ${url.pathname}`);
      }),
    );
    const client = new RemoraMemoryClient(config);
    const snapshot = await client.listAll("place:a", 100_000);
    expect(snapshot.data).toEqual([
      ...examples.list_first_page.response.data,
      ...examples.list_next_page.response.data,
    ]);
    expect(snapshot.next_cursor).toBeNull();
    expect(await client.forget(examples.forget.request)).toEqual(
      examples.forget.response,
    );
    expect((await client.forget(examples.forget.request)).replayed).toBe(true);
    expect(await client.clear(examples.clear.request)).toEqual(
      examples.clear.response,
    );
    const mutations = requests.filter(({ init }) => init.method === "POST");
    expect(mutations.map(({ init }) => JSON.parse(String(init.body)))).toEqual([
      examples.forget.request,
      examples.forget.request,
      examples.clear.request,
    ]);
    expect(
      requests.every(
        ({ init }) =>
          new Headers(init.headers).get("Authorization") ===
          "Bearer fictional-token",
      ),
    ).toBe(true);
    expect(requests.some(({ url }) => url.pathname.includes("chat"))).toBe(
      false,
    );
  });

  // Proves ignored support, unsafe targets, changed snapshots and mismatched receipts cannot become deletion success.
  it.each([
    "disabled",
    "missing_limit",
    "excess_limit",
    "unsafe_id",
    "duplicate_id",
    "wrong_bank",
    "wrong_roots",
    "no_reset",
    "changed_revision",
    "repeated_cursor",
    "ambiguous_subject",
  ] as const)("rejects %s", async (failure) => {
    let pages = 0;
    let mutations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (value: string, init: RequestInit) => {
        if (value.endsWith("/capabilities")) {
          const caps = examples.capabilities_with_management;
          return Response.json({
            ...caps,
            features: {
              ...caps.features,
              memory_management: failure !== "disabled",
            },
            limits: {
              ...caps.limits,
              max_memory_forget_ids:
                failure === "missing_limit"
                  ? undefined
                  : caps.limits.max_memory_forget_ids,
              max_memory_page_size:
                failure === "excess_limit"
                  ? 101
                  : caps.limits.max_memory_page_size,
            },
          });
        }
        if (init.method === "POST") {
          mutations++;
          const receipt = examples.forget.response;
          return Response.json({
            ...receipt,
            bank: failure === "wrong_bank" ? "another-bank" : receipt.bank,
            deleted_ids: failure === "wrong_roots" ? [9] : receipt.deleted_ids,
            reset_required: failure !== "no_reset",
          });
        }
        const original =
          pages++ === 0
            ? examples.list_first_page.response
            : examples.list_next_page.response;
        const page = {
          ...original,
          revision:
            failure === "changed_revision" && pages > 1
              ? "a".repeat(64)
              : original.revision,
          next_cursor:
            failure === "repeated_cursor"
              ? examples.list_first_page.response.next_cursor
              : original.next_cursor,
        };
        if (failure === "ambiguous_subject") {
          const memory = page.data[1];
          if (!memory) throw new Error("Missing canonical reference");
          const marker = Object.keys(memory.subjects)[0];
          if (!marker) throw new Error("Missing canonical marker");
          return Response.json({
            ...page,
            data: [
              {
                ...memory,
                subjects: {
                  [marker]: {
                    ...memory.subjects[marker],
                    entity: "different-subject",
                  },
                },
              },
            ],
          });
        }
        return Response.json(page);
      }),
    );
    const client = new RemoraMemoryClient(config);
    if (
      ["changed_revision", "repeated_cursor", "ambiguous_subject"].includes(
        failure,
      )
    ) {
      await expect(client.listAll("place:a", 100_000)).rejects.toThrow();
    } else {
      await expect(
        client.forget({
          ...examples.forget.request,
          ids:
            failure === "unsafe_id"
              ? [Number.MAX_SAFE_INTEGER + 1]
              : failure === "duplicate_id"
                ? [2, 2]
                : [2],
        }),
      ).rejects.toThrow();
    }
    expect(mutations).toBe(
      ["wrong_bank", "wrong_roots", "no_reset"].includes(failure) ? 1 : 0,
    );
  });
});
