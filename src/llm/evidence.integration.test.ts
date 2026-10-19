import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceCapabilities as evidenceCaps } from "../../test/fixtures/evidence.js";
import { loadConfig } from "../config.js";
import { LlmClient, type LlmMessage } from "./client.js";
import { type ObservationBatch, validateObservationBatch } from "./evidence.js";
import { type RemoraRequest, parseRemoraCapabilities } from "./remora.js";

const config = () =>
  loadConfig({
    DISCORD_TOKEN: "fictional",
    DISCORD_CLIENT_ID: "test",
    LLM_BASE_URL: "http://remora.test/v1",
    LLM_TEMPERATURE: "0",
  });
const raw = "A😀 & B\r\n";
const xml = "A😀 &amp; B&#13;\n";
const messages: LlmMessage[] = [
  { role: "user", content: raw },
  { role: "user", content: JSON.stringify(raw) },
  { role: "user", content: xml },
];
const batch: ObservationBatch = {
  bank: "room-a",
  id: "batch-17",
  revision: 0,
  inputs: [
    {
      id: "message-12",
      revision: 0,
      origin: "human_input",
      actor: { bank: "room-a", role: "human", id: "person-2" },
      views: [
        { message_index: 0, start: 0, end: 8 },
        {
          message_index: 1,
          start: 0,
          end: Array.from(JSON.stringify(raw)).length,
          encoding: "json_string",
        },
        {
          message_index: 2,
          start: 0,
          end: Array.from(xml).length,
          encoding: "xml_text",
        },
      ],
    },
  ],
  generated: { actor: { bank: "room-a", role: "assistant", id: "patch" } },
};
function reply(attempt = "1", replayed = false) {
  const attemptId = `generation-${attempt.repeat(32)}`;
  return {
    choices: [{ message: { content: "a real reply" } }],
    remora: {
      version: 1,
      backend: "transformers",
      read_banks: ["room-a"],
      selected: [{ bank: "room-a", id: 1, kind: "evidence" }],
      writes: null,
      observations: {
        inputs: [
          {
            source_id: "message-12",
            revision: 0,
            outcome: "admitted",
            receipt: {
              saved: [1],
              superseded: [],
              status: "admitted",
              replayed,
              admission_identity: "a".repeat(64),
            },
          },
        ],
        generated: [
          {
            source_id: `${attemptId}:output`,
            revision: 0,
            outcome: "admitted",
            receipt: {
              saved: [2],
              superseded: [],
              status: "admitted",
              replayed: false,
              admission_identity: "a".repeat(64),
            },
          },
        ],
        attempt_id: attemptId,
        input_replayed: replayed,
      },
      cache: {
        requested: true,
        reused_tokens: 0,
        evaluated_tokens: 12,
        invalidated: null,
      },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("negotiated all-stream observation transport", () => {
  // Proves exact scalar subviews preserve original generated voice in any native role, while a transformation requires a real parent.
  it.each([
    "valid",
    "context_only",
    "mismatch",
    "orphan",
    "overlap",
    "source_budget",
    "view_budget",
  ] as const)("validates completed generated reference %s", (mode) => {
    const raw = "raw 😀 reply";
    const id = "generation-original:output";
    const observed: LlmMessage[] = [
      {
        role: "user",
        content:
          mode === "context_only"
            ? "formatted reply"
            : JSON.stringify("😀 reply"),
      },
    ];
    const reference = {
      id,
      revision: 0,
      text: raw,
      views:
        mode === "context_only" || mode === "orphan"
          ? []
          : [
              {
                message_index: 0,
                start: 0,
                end: Array.from(observed[0]?.content ?? "").length,
                encoding: "json_string" as const,
                source_start: mode === "mismatch" ? 0 : 4,
                source_end: 11,
              },
            ],
    };
    let references = [reference];
    if (mode === "overlap")
      references = [
        reference,
        { ...reference, id: "generation-another:output" },
      ];
    if (mode === "source_budget")
      references = Array.from({ length: 129 }, (_, i) => ({
        ...reference,
        id: `g-${i}`,
      }));
    if (mode === "view_budget")
      references = [
        {
          ...reference,
          views: Array.from({ length: 513 }, () => reference.views[0]).filter(
            (view) => view !== undefined,
          ),
        },
      ];
    const value: ObservationBatch = {
      bank: "room-a",
      id: "batch",
      revision: 0,
      inputs:
        mode === "context_only"
          ? [
              {
                id: "discord:message:30",
                revision: 0,
                origin: "unattributed_input",
                views: [{ message_index: 0, start: 0, end: 15 }],
                context: [id],
              },
            ]
          : [],
      references,
    };
    const check = () =>
      validateObservationBatch(value, observed, evidenceCaps.limits);
    if (mode === "valid" || mode === "context_only")
      expect(check).not.toThrow();
    else expect(check).toThrow();
  });
  // Proves raw/JSON/XML views share one immutable source, while parameter retries retain input receipts and accept independent decoder attempts.
  it("binds exact scalar views and separates input replay from generated attempts", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/capabilities")) return Response.json(evidenceCaps);
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(reply(String(++calls), calls > 1));
      }),
    );
    const client = new LlmClient(config());
    await client.initializeRemora();
    expect(client.observationLimits?.max_observation_views).toBe(512);
    const remora: RemoraRequest = {
      read_banks: ["room-a"],
      observations: batch,
      speaker: { bank: "room-a", id: "person-2" },
    };
    const first = await client.complete({ messages, remora, maxTokens: 256 });
    const retry = await client.complete({ messages, remora, maxTokens: 128 });
    expect(first.remora?.observations?.inputs[0]?.source_id).toBe("message-12");
    expect(retry.remora?.observations?.input_replayed).toBe(true);
    expect(first.remora?.observations?.attempt_id).not.toBe(
      retry.remora?.observations?.attempt_id,
    );
    for (const body of bodies) expect(body).toMatchObject({ messages, remora });
    expect(bodies).toHaveLength(2);
  });

  // Proves a partial or incompatible feature advertisement cannot activate this new source-binding mode.
  it.each([
    "sources",
    "views",
    "source_chars",
    "contexts",
    "total_chars",
    "id_chars",
    "binding",
    "identity",
    "management",
    "old_binding",
  ] as const)("rejects incomplete capability %s", (failure) => {
    const value = {
      ...evidenceCaps,
      source_binding:
        failure === "old_binding"
          ? "final_user_message_exact"
          : evidenceCaps.source_binding,
      observation_binding:
        failure === "binding" ? undefined : evidenceCaps.observation_binding,
      features: {
        ...evidenceCaps.features,
        entity_identity: failure === "identity",
        memory_management: failure !== "management",
      },
      limits: Object.fromEntries(
        Object.entries(evidenceCaps.limits).filter(
          ([key]) => key !== `max_observation_${failure}`,
        ),
      ),
    };
    expect(() => parseRemoraCapabilities(value)).toThrow();
  });

  // Proves legacy endpoints receive no new observations, kind-qualified recall or mixed source declarations.
  it("fails locally before sending unnegotiated or legacy observation writes", async () => {
    const request = vi.fn(async () => Response.json(evidenceCaps));
    vi.stubGlobal("fetch", request);
    const client = new LlmClient(config());
    await expect(
      client.complete({
        messages,
        remora: { read_banks: ["room-a"], observations: batch },
      }),
    ).rejects.toThrow("not been negotiated");
    expect(request).not.toHaveBeenCalled();
    await client.initializeRemora();
    await expect(
      client.complete({
        messages,
        remora: {
          read_banks: ["room-a"],
          write_bank: "room-a",
          turn: {
            id: "message-12",
            revision: 0,
            speaker_id: "person-2",
            text: raw,
          },
        },
      }),
    ).rejects.toThrow("rejects legacy writes");
    await expect(
      client.complete({
        messages,
        remora: { read_banks: ["room-a"], identity: {} },
      }),
    ).rejects.toThrow("identity declarations");
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Proves a malformed range, changed rendering, forged actor or unbound context cannot be posted to the backend.
  it.each([
    "range",
    "overlap",
    "rendering",
    "principal",
    "actor_bank",
    "context",
    "origin",
    "unicode",
  ] as const)("rejects observation %s before HTTP", async (failure) => {
    const request = vi.fn(async () => Response.json(evidenceCaps));
    vi.stubGlobal("fetch", request);
    const client = new LlmClient(config());
    await client.initializeRemora();
    const input = batch.inputs[0];
    if (!input) throw new Error("Missing fictional source");
    const firstView = input.views[0];
    if (!firstView) throw new Error("Missing fictional view");
    const observations = {
      ...batch,
      inputs: [
        {
          ...input,
          ...(failure === "principal"
            ? {
                actor: {
                  bank: "room-a",
                  role: "human" as const,
                  id: "person-2",
                  principal: "forged",
                },
              }
            : {}),
          ...(failure === "actor_bank"
            ? {
                actor: {
                  bank: "another-bank",
                  role: "human" as const,
                  id: "person-2",
                },
              }
            : {}),
          ...(failure === "context" ? { context: ["not-declared"] } : {}),
          ...(failure === "origin"
            ? {
                origin: "assistant_output" as const,
                actor: {
                  bank: "room-a",
                  role: "assistant" as const,
                  id: "patch",
                },
              }
            : {}),
          ...(failure === "range"
            ? { views: [{ ...firstView, end: 999 }] }
            : {}),
          ...(failure === "overlap" ? { views: [firstView, firstView] } : {}),
        },
      ],
    };
    const altered = messages.map((message, index) =>
      index === 1 && failure === "rendering"
        ? { ...message, content: '"another source"' }
        : failure === "unicode" && index === 0
          ? { ...message, content: "\ud800" }
          : message,
    );
    await expect(
      client.complete({
        messages: altered,
        remora: { read_banks: ["room-a"], observations },
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Proves input source receipt mismatches and forged decoder-attempt receipts cannot masquerade as successful retention.
  it.each([
    "source",
    "revision",
    "outcome",
    "saved",
    "attempt",
    "duplicate",
    "output",
    "replay",
  ] as const)("rejects response %s", async (failure) => {
    const value = reply();
    const input = value.remora.observations.inputs[0];
    const generated = value.remora.observations.generated[0];
    if (!input || !generated) throw new Error("Missing fixture receipt");
    const response = {
      ...value,
      remora: {
        ...value.remora,
        observations: {
          ...value.remora.observations,
          ...(failure === "attempt"
            ? { attempt_id: `generation-${"2".repeat(32)}` }
            : {}),
          ...(failure === "replay" ? { input_replayed: true } : {}),
          inputs: [
            {
              ...input,
              ...(failure === "source" ? { source_id: "wrong-source" } : {}),
              ...(failure === "revision" ? { revision: 1 } : {}),
              ...(failure === "outcome" ? { outcome: "rejected" } : {}),
              ...(failure === "saved"
                ? { receipt: { ...input.receipt, saved: [] } }
                : {}),
            },
          ],
          ...(failure === "duplicate"
            ? { generated: [generated, generated] }
            : {}),
          ...(failure === "output"
            ? {
                generated: [
                  {
                    ...generated,
                    source_id: `${value.remora.observations.attempt_id}:reasoning`,
                  },
                ],
              }
            : {}),
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url.endsWith("/capabilities") ? evidenceCaps : response),
      ),
    );
    const client = new LlmClient(config());
    await client.initializeRemora();
    await expect(
      client.complete({
        messages,
        remora: { read_banks: ["room-a"], observations: batch },
      }),
    ).rejects.toThrow();
  });
});
