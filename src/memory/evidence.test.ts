import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evidenceCapabilities,
  makeEvidenceRecord,
} from "../../test/fixtures/evidence.js";
import { parseRemoraCapabilities } from "../llm/remora.js";
import { RemoraMemoryClient } from "./client.js";

const config = {
  llmBaseUrl: "http://remora.test/v1",
  llmApiKey: "fictional-token",
  llmTimeoutMs: 1000,
};
const revision = "a".repeat(64);
const page = (id = 1) => ({
  object: "remora.evidence.list",
  version: 1,
  bank: "room-a",
  revision,
  data: [makeEvidenceRecord("room-a", id)],
  next_cursor: null,
});
afterEach(() => vi.unstubAllGlobals());

describe("evidence memory management transport", () => {
  // Proves evidence listing and exact forgetting use their own namespace, retaining complete provenance and immutable request bodies.
  it("lists quoted evidence and replays exact evidence mutations", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let mutations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, body });
        if (!init.body) return Response.json(page());
        mutations++;
        return Response.json({
          object: "remora.evidence.mutation",
          version: 1,
          bank: "room-a",
          request_id: "forget-1",
          operation: "forget",
          replayed: mutations > 1,
          deleted_ids: [1],
          deleted_count: 1,
          dependent_suppression: { bank: "room-a", visible_active_count: 0 },
          revision: "b".repeat(64),
          cache_invalidated: true,
          reset_required: true,
        });
      }),
    );
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(evidenceCapabilities));
    const listed = await client.listAllEvidence("room-a", 10000);
    expect(listed.data).toEqual([makeEvidenceRecord()]);
    const request = {
      bank: "room-a",
      request_id: "forget-1",
      expected_revision: revision,
      ids: [1],
    };
    const first = await client.forgetEvidence(request);
    const replay = await client.forgetEvidence(request);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/remora/evidence",
      "/v1/remora/evidence/forget",
      "/v1/remora/evidence/forget",
    ]);
    expect(requests[1]?.body).toEqual(request);
    expect(requests[2]?.body).toEqual(request);
    expect(first.reset_required).toBe(true);
  });

  // Proves source erasure selects a listed context anchor without inventing principal or source identity.
  it("forgets a supporting source through its exact anchor and validates dependent IDs", async () => {
    const request = {
      bank: "room-a",
      request_id: "source-forget-1",
      expected_revision: revision,
      id: 1,
      context_index: 0,
    };
    const post = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual(request);
      return Response.json({
        object: "remora.evidence.mutation",
        version: 1,
        bank: "room-a",
        operation: "forget_source",
        request_id: "source-forget-1",
        deleted_ids: [1],
        deleted_count: 1,
        dependent_suppression: {
          bank: "room-a",
          visible_active_count: 1,
          ids: [2],
        },
        revision,
        replayed: false,
        cache_invalidated: true,
        reset_required: true,
      });
    });
    vi.stubGlobal("fetch", post);
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(evidenceCapabilities));
    expect(
      (await client.forgetEvidenceSource(request)).dependent_suppression.ids,
    ).toEqual([2]);
    expect(post.mock.calls[0]?.[0]).toBe(
      "http://remora.test/v1/remora/evidence/forget-source",
    );
  });

  // Proves an enabled fact-management endpoint is insufficient authority to call evidence routes.
  it("keeps unsupported evidence management offline", async () => {
    const post = vi.fn();
    vi.stubGlobal("fetch", post);
    const client = new RemoraMemoryClient(config);
    await client.initialize(
      parseRemoraCapabilities({
        ...evidenceCapabilities,
        source_binding: "final_user_message_exact",
        observation_binding: undefined,
        features: {
          ...evidenceCapabilities.features,
          all_stream_evidence: false,
        },
      }),
    );
    await expect(client.listEvidence("room-a")).rejects.toThrow(
      "unsupported_feature",
    );
    await expect(
      client.forgetEvidence({
        bank: "room-a",
        request_id: "r",
        expected_revision: revision,
        ids: [1],
      }),
    ).rejects.toThrow("unsupported_feature");
    expect(post).not.toHaveBeenCalled();
  });

  // Proves malformed server data cannot change a quotation's namespace, subject resolution, source voice, scope or exact scalar extent.
  it.each([
    "subjects",
    "voice",
    "span",
    "bank",
    "unsafe_id",
    "duplicate",
  ] as const)("rejects malformed evidence %s", async (failure) => {
    const original = makeEvidenceRecord();
    const changed = {
      ...original,
      ...(failure === "subjects" ? { subjects: {} } : {}),
      ...(failure === "voice"
        ? { source: { ...original.source, origin: "assistant_output" } }
        : {}),
      ...(failure === "span" ? { span: { start: 0, end: 5 } } : {}),
      ...(failure === "bank" ? { bank: "other-bank" } : {}),
      ...(failure === "unsafe_id" ? { id: Number.MAX_SAFE_INTEGER + 1 } : {}),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...page(),
          data: failure === "duplicate" ? [original, original] : [changed],
        }),
      ),
    );
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(evidenceCapabilities));
    await expect(client.listEvidence("room-a")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  // Proves a changing catalog cannot yield a partial or mixed-revision export.
  it("fails a paginated evidence export on revision change", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          ++calls === 1
            ? { ...page(), next_cursor: "opaque" }
            : { ...page(2), revision: "b".repeat(64) },
        ),
      ),
    );
    const client = new RemoraMemoryClient(config);
    await client.initialize(parseRemoraCapabilities(evidenceCapabilities));
    await expect(client.listAllEvidence("room-a", 10000)).rejects.toMatchObject(
      { code: "cursor_stale" },
    );
    expect(calls).toBe(2);
  });
});
