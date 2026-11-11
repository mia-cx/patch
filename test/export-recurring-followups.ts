import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deliverFollowups } from "../src/tools/followups.js";
import { FOLLOWUP_CHANNEL, followupHarness } from "./fixtures/followups.js";

/** Describe observed runtime JSON structure; argument validation remains the registered Effect schema. */
function responseShape(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const variants = [
      ...new Map(
        value.map((item: unknown) => {
          const schema = responseShape(item);
          return [JSON.stringify(schema), schema] as const;
        }),
      ).values(),
    ];
    return {
      type: "array",
      ...(variants.length
        ? { items: variants.length === 1 ? variants[0] : { anyOf: variants } }
        : {}),
    };
  }
  if (typeof value === "object")
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, responseShape(item)]),
      ),
      required: Object.keys(value),
      additionalProperties: false,
    };
  return {
    type:
      typeof value === "number" && Number.isInteger(value)
        ? "integer"
        : typeof value,
  };
}

const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: tsx test/export-recurring-followups.ts OUTPUT.json");
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(
  git("status", "--porcelain"),
  "",
  "Commit the implementation before exporting its revision",
);
const actualNow = Date.now;
let now = Date.parse("2026-11-11T12:00:00Z");
Date.now = () => now;
const app = await followupHarness();
try {
  const steps: Array<{
    call?: { name: string; arguments: Record<string, unknown> };
    request?: { role: "user"; content: string };
    outcome: unknown;
    response_shape?: Record<string, unknown>;
    wire_message?: unknown;
  }> = [];
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    replay = false,
  ) => {
    if (!replay)
      app.nextRequest(
        name === "list_followups"
          ? "Which reminders are active in this conversation?"
          : name === "cancel_followup"
            ? "Please cancel the synthetic reminder."
            : "Please schedule the synthetic reminder.",
      );
    const request = { role: "user" as const, content: app.message.content };
    const call = { name, arguments: args };
    let outcome: unknown;
    try {
      outcome = await app.invoke(name, args);
    } catch (error) {
      const outcome = {
        phase: "input_validation",
        tool_result_emitted: false,
        error: error instanceof Error ? error.message : String(error),
      };
      steps.push({ request, call, outcome });
      return outcome;
    }
    const wire_message = app.wireResults.at(-1);
    assert.ok(wire_message);
    assert.equal(wire_message.role, "tool");
    assert.deepEqual(JSON.parse(wire_message.content), outcome);
    steps.push({
      request,
      call,
      outcome,
      response_shape: responseShape(outcome),
      wire_message,
    });
    return outcome;
  };
  const args = {
    cron: "*/5 * * * *",
    timezone: "Europe/Amsterdam",
    text: "Synthetic reminder: check the fictional build. 😀",
  };
  const scheduled = await invoke("schedule_followup", args);
  assert.partialDeepStrictEqual(scheduled, {
    completed: true,
    output: { replayed: false, result: { at: "2026-11-11T12:05:00.000Z" } },
  });
  const [job] = app.store.followups(FOLLOWUP_CHANNEL);
  assert.ok(job);
  assert.partialDeepStrictEqual(await invoke("schedule_followup", args, true), {
    completed: true,
    output: { replayed: true },
  });
  assert.partialDeepStrictEqual(await invoke("list_followups", {}), {
    name: "list_followups",
    completed: true,
    output: [
      {
        id: job.id,
        recurring: true,
        cron: args.cron,
        timezone: args.timezone,
        next_at: "2026-11-11T12:05:00.000Z",
        status: "pending",
      },
    ],
  });
  now = Date.parse("2026-11-11T12:05:00Z");
  await deliverFollowups(app.context);
  await deliverFollowups(app.context);
  assert.equal(app.deliveries.length, 1);
  assert.partialDeepStrictEqual(app.deliveries[0], {
    content: args.text,
    enforce_nonce: true,
    allowed_mentions: { parse: [], replied_user: false },
  });
  assert.equal(
    app.store.followups(FOLLOWUP_CHANNEL)[0]?.at,
    Date.parse("2026-11-11T12:10:00Z"),
  );
  steps.push({
    outcome: {
      phase: "synthetic_worker_delivery",
      at: new Date(now).toISOString(),
      discord_request: app.deliveries[0],
      persisted: app.store.followups(FOLLOWUP_CHANNEL),
    },
  });
  await invoke("list_followups", {});
  assert.partialDeepStrictEqual(
    await invoke("cancel_followup", { id: job.id }),
    { completed: true, output: { result: { cancelled: true } } },
  );
  await invoke("list_followups", {});
  const oneOff = {
    at: "2026-11-11T12:06:00Z",
    text: "Synthetic one-off reminder.",
  };
  assert.partialDeepStrictEqual(await invoke("schedule_followup", oneOff), {
    completed: true,
    output: { result: { at: "2026-11-11T12:06:00.000Z" } },
  });
  now = Date.parse(oneOff.at);
  await deliverFollowups(app.context);
  assert.equal(app.deliveries.length, 2);
  assert.partialDeepStrictEqual(app.deliveries[1], { content: oneOff.text });
  assert.deepEqual(app.store.followups(FOLLOWUP_CHANNEL), []);
  steps.push({
    outcome: {
      phase: "synthetic_one_off_delivery",
      discord_request: app.deliveries[1],
      active_followups: [],
    },
  });

  const success = [...steps];
  steps.length = 0;
  const errors = [
    { ...args, at: "2026-11-11T12:10:00Z" },
    { cron: args.cron, text: args.text },
    { ...args, channel_id: "1000000000000000099" },
    { ...args, cron: "61 * * * *" },
    { ...args, timezone: "Mars/Olympus" },
    { at: "2026-11-11T13:00:00", text: args.text },
    { at: "2027-02-30T12:00:00Z", text: args.text },
  ];
  for (const input of errors) {
    const outcome = await invoke("schedule_followup", input);
    assert.ok(outcome && typeof outcome === "object");
    assert.ok(
      ("phase" in outcome && outcome.phase === "input_validation") ||
        ("completed" in outcome && outcome.completed === false),
    );
  }
  assert.partialDeepStrictEqual(
    await invoke("cancel_followup", { id: "nonexistent-synthetic-id" }),
    { completed: false },
  );
  assert.deepEqual(app.store.followups(FOLLOWUP_CHANNEL), []);
  const artifact = {
    format_version: 1,
    status: "implemented_and_synthetically_tested_not_deployed",
    proposed: [],
    revision: {
      repository: "https://github.com/mia-cx/patch",
      commit: git("rev-parse", "HEAD"),
      base: git("rev-parse", "origin/t3/audit-protocord-before-gemma"),
      protocord: git("-C", "vendor/protocord", "rev-parse", "HEAD"),
      cron_parser: "5.10.4",
    },
    generated_at: new Date(actualNow()).toISOString(),
    schemas: app.tools,
    response_contract: {
      status: "observed_from_implemented_runtime",
      shapes:
        "Each successful or failed dispatched call includes a response_shape derived from its actual outcome and the exact native wire_message. Shapes describe JSON types and required keys; dynamic IDs and text are not enums. Empty arrays leave items unconstrained.",
      envelope: {
        native:
          "wire_message is the actual {role:'tool', content:JSON.stringify(outcome), tool_call_id} message. outcome is the outer {name, output, completed, error?} runtime receipt.",
        mutations:
          "Successful schedule/cancel output is {result:<action output>, replayed:boolean}. Replay returns the original stored result.",
        reads:
          "Successful list output is the action's array directly, with no result/replayed wrapper.",
        errors:
          "Dispatched failures have completed:false, output:{error:string}, and an outer error truncated to 80 characters. Structural validation fails before dispatch and emits no tool result; these are marked tool_result_emitted:false.",
        tagged:
          "The same parsed outcome appears in Harness tool results JSON for tagged calls. Native and tagged lifecycle behavior is covered by regression tests.",
      },
      outer_tool_result_schema: {
        anyOf: [
          ...new Map(
            [...success, ...steps]
              .filter((step) => step.response_shape)
              .map((step) => [
                JSON.stringify(step.response_shape),
                step.response_shape,
              ]),
          ).values(),
        ],
      },
      native_wire_message_schema: responseShape(app.wireResults[0]),
      validation_error_is_tool_receipt: false,
    },
    validation: {
      structural:
        "Exact registered Protocord schemas; excess properties rejected. Runtime also validates cron, IANA zone, valid ISO calendar/offset, text and quota.",
      schema_format:
        "OpenAI function tool definitions, parameters are JSON Schema generated from the actual Effect validators.",
    },
    semantics: {
      destination:
        "Current invocation conversation only; no model-selected destination.",
      delivery:
        "Exact stored text; no new model generation. Discord mentions disabled.",
      bounds: {
        active_per_conversation: 20,
        text_utf16_code_units: 2000,
        minimum_interval_seconds: 60,
        initial_horizon_days: 366,
        cron_characters: 128,
        timezone_characters: 100,
        due_batch: 20,
      },
      cron: "Five fields: minute hour day-of-month month day-of-week. cron-parser syntax except randomized H and macros. Explicit IANA zone required; UTC accepted. Day-of-month/day-of-week use cron-parser OR semantics.",
      dst: "cron-parser 5.10.4 forward traversal shifts nonexistent hours forward and skips a repeated hour when traversing across the fold. Advance from the persisted occurrence first, then from completion time if that next tick is overdue. A fresh search begun inside the second fold hour can select that hour.",
      missed_ticks:
        "Deliver at most one overdue occurrence per schedule per pass, then next strictly after completion; no catch-up loop.",
      uncertain:
        "A claimed occurrence at restart or any ambiguous send pauses the whole schedule. No automatic retry or resume tool. List exposes uncertain; cancel removes the schedule.",
      cancellation:
        "Stops future occurrences and any claimed work before send; an in-flight Discord request may complete. Cancellation cannot rearm the schedule.",
      list: "at is next occurrence epoch milliseconds; next_at is its ISO equivalent. cron/timezone are null for one-offs. For uncertain jobs, the stored occurrence is held, not scheduled for delivery.",
      sparse:
        "Initial occurrence must be within 366 days. Subsequent sparse occurrences can be later; each cron search is bounded to eight years.",
    },
    synthetic_only: true,
    provenance: {
      requester: {
        role: "user",
        content: app.message.content,
        author: "Synthetic user",
      },
      tool_receipts:
        "Captured from the actual caller, never inferred from human acknowledgements or delivery prose.",
      private_source_messages_used: false,
    },
    examples: { native_tool_lifecycle: success, errors: steps },
    qualification: {
      automated:
        "src/tools/followups.test.ts exercises native and tagged calls, SQLite migration, restart, DST, quotas, duplicate/stale claims, cancellation and ambiguous sends with synthetic Discord I/O.",
      live_discord_or_model: "not performed",
      deployment: "not performed",
      scheduled_real_messages: false,
    },
  };
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    `Exported implemented schemas and synthetic outcomes at ${artifact.revision.commit} to ${resolve(destination)}`,
  );
} finally {
  app.close();
  Date.now = actualNow;
}
