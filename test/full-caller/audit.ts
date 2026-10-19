import assert from "node:assert/strict";
import { Schema } from "effect";
import { validateObservationBatch } from "../../src/llm/evidence.js";
import { TAGGED_TOOL_INSTRUCTIONS } from "../../src/tools/output.js";
import { evidenceCapabilities } from "../fixtures/evidence.js";
import { BANKS, BASE, FullCallerFixture, WEB_URL } from "./fixture.js";

/** Offline preparation only. Every HTTP response is invented; it never calls a network transport. */
export async function auditFullCaller() {
  const previousFetch = globalThis.fetch;
  const app = new FullCallerFixture("invented-offline-only");
  const bodies: Array<{
    bank: string;
    messages: { role: string; content: string }[];
    sources: number;
    views: number;
  }> = [];
  let toolRounds = 0;
  let continued = false;
  let serial = 0;
  globalThis.fetch = async (input, init) => {
    assert(
      typeof input === "string" && input.startsWith(`${BASE}/`),
      "Offline audit rejected unexpected HTTP",
    );
    if (input.endsWith("/capabilities"))
      return Response.json(evidenceCapabilities);
    assert.equal(input, `${BASE}/chat/completions`);
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        messages: Schema.Array(
          Schema.Struct({ role: Schema.String, content: Schema.String }),
        ),
        remora: Schema.Struct({
          observations: Schema.Unknown,
          read_banks: Schema.Array(Schema.String),
        }),
      }),
    )(JSON.parse(String(init?.body)));
    const observations = validateObservationBatch(
      value.remora.observations,
      value.messages,
      evidenceCapabilities.limits,
    );
    const declarations = [
      ...observations.inputs,
      ...(observations.references ?? []),
    ];
    const views = declarations.flatMap((source) => source.views);
    for (const [index, message] of value.messages.entries())
      assert(
        Array.from(message.content).every(
          (character, offset) =>
            !character.trim() ||
            views.some(
              (view) =>
                view.message_index === index &&
                offset >= view.start &&
                offset < view.end,
            ),
        ),
        "Clean invented dialogue has uncovered prompt text",
      );
    bodies.push({
      bank: observations.bank,
      messages: [...value.messages],
      sources: declarations.length,
      views: views.length,
    });
    const attempt = `generation-${String(++serial).padStart(32, "0")}`;
    let content = "so, what's next?";
    if (
      value.messages[0]?.content.startsWith(
        "Repair Discord output formatting only.",
      )
    )
      content = "first<split />second";
    else if (toolRounds) {
      content =
        toolRounds === 3
          ? `<tool_call>web_fetch{url:${WEB_URL}}</tool_call>`
          : `<tool_call>{"name":"web_fetch","arguments":{"url":"${WEB_URL}","offset":${3 - toolRounds}}}</tool_call>`;
      toolRounds--;
      continued = true;
    } else if (continued) {
      content = "😀 first\nsecond";
      continued = false;
    }
    const receipt = {
      saved: [],
      superseded: [],
      status: "not_admitted",
      replayed: false,
      admission_identity: "a".repeat(64),
    };
    return Response.json({
      choices: [{ message: { content } }],
      remora: {
        version: 1,
        backend: "transformers",
        read_banks: value.remora.read_banks,
        selected: [],
        writes: null,
        cache: {
          requested: true,
          reused_tokens: 0,
          evaluated_tokens: 100,
          invalidated: null,
        },
        observations: {
          inputs: [
            ...observations.inputs.map((source) => ({
              source_id: source.id,
              revision: source.revision,
              outcome: "rejected",
              receipt,
            })),
            ...(observations.references ?? []).map((source) => ({
              source_id: source.id,
              revision: source.revision,
              outcome: "referenced",
              receipt: { ...receipt, replayed: true },
            })),
          ],
          generated: [
            {
              source_id: `${attempt}:output`,
              revision: 0,
              outcome: "rejected",
              receipt,
            },
          ],
          attempt_id: attempt,
          input_replayed: false,
        },
      },
    });
  };
  try {
    await app.initialize();
    // Include 41 offered real SDK history pairs. The actual 12K budget decides which remain in each prompt.
    for (let i = 0; i < 41; i++)
      await app.turn(BANKS[0], `Invented independent detail number ${i}.`);
    toolRounds = 3;
    await app.turn(BANKS[0], `Read ${WEB_URL}`);
    await app.turn(BANKS[0], "What did it mean?");
    toolRounds = 3;
    await app.turn(BANKS[1], `Read ${WEB_URL}`);
    assert(
      app.sent.some((message) => message.text.includes("Sources:")),
      "Actual citation transformation was not exercised",
    );
    assert.equal(app.violations.length, 0);
    const persona = bodies.find((body) => body.bank === BANKS[0])?.messages[0]
      ?.content;
    const sharedPersona = bodies.find((body) => body.bank === BANKS[1])
      ?.messages[0]?.content;
    assert(persona && sharedPersona);
    const continuationPersona = bodies.find(
      (body) =>
        body.bank === BANKS[0] &&
        body.messages[0]?.content.includes(
          "Continue the original human request",
        ) &&
        body.messages[0].content.includes(TAGGED_TOOL_INSTRUCTIONS),
    )?.messages[0]?.content;
    const sharedContinuationPersona = bodies.find(
      (body) =>
        body.bank === BANKS[1] &&
        body.messages[0]?.content.includes(
          "Continue the original human request",
        ) &&
        body.messages[0].content.includes(TAGGED_TOOL_INSTRUCTIONS),
    )?.messages[0]?.content;
    const finalPersona = bodies.find(
      (body) =>
        body.bank === BANKS[0] &&
        body.messages[0]?.content.startsWith("# Role") &&
        !body.messages[0].content.includes(TAGGED_TOOL_INSTRUCTIONS),
    )?.messages[0]?.content;
    const sharedFinalPersona = bodies.find(
      (body) =>
        body.bank === BANKS[1] &&
        body.messages[0]?.content.startsWith("# Role") &&
        !body.messages[0].content.includes(TAGGED_TOOL_INSTRUCTIONS),
    )?.messages[0]?.content;
    assert(
      continuationPersona &&
        sharedContinuationPersona &&
        finalPersona &&
        sharedFinalPersona,
    );
    assert(
      bodies.some((body) =>
        body.messages[0]?.content.startsWith(
          "Repair Discord output formatting only.",
        ),
      ),
      "Actual formatting fallback was not exercised",
    );
    return {
      persona,
      sharedPersona,
      continuationPersona,
      sharedContinuationPersona,
      finalPersona,
      sharedFinalPersona,
      required_limits: {
        max_observation_sources: Math.max(
          ...bodies.map((body) => body.sources),
        ),
        max_observation_views: Math.max(...bodies.map((body) => body.views)),
      },
      report: {
        network: "invented responses only; zero network/model/Discord calls",
        semantics: "not measured",
        context_tokens: 12288,
        offered_history_pairs: 41,
        tool_rounds: 3,
        captured_tagged_shorthand: true,
        actual_formatting_fallback: true,
        requests: bodies.map(({ messages, ...body }) => ({
          ...body,
          message_count: messages.length,
          system_scalars: Array.from(messages[0]?.content ?? "").length,
        })),
      },
    };
  } finally {
    globalThis.fetch = previousFetch;
    await app.close();
  }
}
