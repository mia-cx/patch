import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  ChannelType,
  Client,
  ClientUser,
  MessageType,
  PermissionsBitField,
} from "discord.js";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { evidenceCapabilities } from "../../test/fixtures/evidence.js";
import {
  buildMemoryContract,
  memoryContractSchemas,
} from "../../test/memory-contract.js";
import {
  buildModelVisibleActions,
  toLlmTools,
} from "../actions/action-context.js";
import type { ActionContext } from "../actions/context.js";
import { registerDefaultActions } from "../actions/defaults.js";
import { createPatchActionRegistry } from "../actions/registry.js";
import { dispatchToolCall } from "../actions/tool-calls.js";
import { loadConfig } from "../config.js";
import { ConversationContextStore } from "../conversation/store.js";
import { LlmClient } from "../llm/client.js";
import { ModelCatalog } from "../llm/model-catalog.js";
import { parseRemoraCapabilities } from "../llm/remora.js";
import { createLogger } from "../logger.js";
import { GenerationQueue } from "../queue.js";
import { SettingsStore } from "../settings/store.js";
import { HarnessStore } from "../tools/store.js";
import { runToolTurn } from "../tools/turn.js";
import { WebClient } from "../tools/web.js";
import { RemoraMemoryClient } from "./client.js";
import { MemorySaveReceiptSchema, MemorySaveRequestSchema } from "./save.js";
import { MemoryToolOutcomeSchema } from "./tool-contract.js";

const CHANNEL = "1000000000000000001";
const HUMAN = "1000000000000000002";
const BOT = "1000000000000000003";
const CURRENT = "1000000000000000004";
const BANK = `discord:dm:${CHANNEL}`;
const cleanup: (() => void)[] = [];
class Bot extends ClientUser {
  constructor(client: Client<true>) {
    super(client, {
      id: BOT,
      username: "Patch",
      discriminator: "0",
      avatar: null,
      bot: true,
    });
  }
}
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(base = "http://synthetic.test/v1") {
  const dir = mkdtempSync(join(tmpdir(), "memory-tools-"));
  cleanup.push(() => rmSync(dir, { recursive: true }));
  const client = new Client<true>({ intents: [] });
  client.user = new Bot(client);
  cleanup.push(() => {
    void client.destroy();
  });
  vi.spyOn(client.rest, "get").mockImplementation(async (route) => {
    if (route === `/channels/${CHANNEL}`)
      return {
        id: CHANNEL,
        type: ChannelType.DM,
        recipients: [
          { id: HUMAN, username: "Alex", discriminator: "0", avatar: null },
        ],
      };
    if (route === `/channels/${CHANNEL}/messages/${CURRENT}`)
      return {
        id: CURRENT,
        channel_id: CHANNEL,
        author: {
          id: HUMAN,
          username: "Alex",
          discriminator: "0",
          avatar: null,
        },
        content: "remember that Sam's cat is Pepper 😀",
        timestamp: "2026-11-01T12:00:00Z",
        edited_timestamp: null,
        type: MessageType.Default,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_roles: [],
        components: [],
        flags: 0,
        pinned: false,
        tts: false,
        mention_everyone: false,
      };
    throw new Error(`Unexpected Discord request: ${route}`);
  });
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error("Missing synthetic channel");
  const message = await channel.messages.fetch(CURRENT);
  const config = loadConfig({
    DISCORD_TOKEN: "synthetic",
    DISCORD_CLIENT_ID: BOT,
    REMORA_DM_ENABLED: "true",
    LLM_BASE_URL: base,
    LLM_API_KEY: "synthetic",
    SETTINGS_DB_PATH: join(dir, "settings.sqlite"),
  });
  const logger = createLogger(false);
  logger.level = "silent";
  const llm = new LlmClient(config);
  const settings = new SettingsStore(config.settingsDbPath, {
    llmModel: "unused",
  });
  const contextStore = new ConversationContextStore(config.settingsDbPath);
  const store = new HarnessStore(config.settingsDbPath);
  cleanup.push(
    () => settings.close(),
    () => contextStore.close(),
    () => store.close(),
  );
  const memory = new RemoraMemoryClient(config);
  await memory.initialize({
    ...evidenceCapabilities,
    features: { ...evidenceCapabilities.features, explicit_memory_save: true },
    limits: { ...evidenceCapabilities.limits, max_explicit_memory_chars: 4096 },
  });
  const context: ActionContext = {
    client,
    config,
    llm,
    logger,
    settings,
    contextStore,
    memory,
    modelCatalog: new ModelCatalog(llm, logger),
    queue: new GenerationQueue(1),
    harness: { store, web: new WebClient() },
    readBanks: [BANK],
    writeBank: BANK,
    toolScope: {
      messageIds: new Set([CURRENT]),
      signal: new AbortController().signal,
      nonce: "synthetic",
    },
  };
  const registry = createPatchActionRegistry();
  registerDefaultActions(registry);
  const dispatch = (name: string, args: object) =>
    dispatchToolCall({
      registry,
      context,
      message,
      toolCall: { type: "function", name, arguments: JSON.stringify(args) },
    });
  return { context, registry, message, dispatch, store, memory, dir };
}

// Proves model arguments and retrieved text cannot impersonate an actor, choose a bank, or supply human permission.
it("requires a direct raw human request and rejects impersonation before HTTP", async () => {
  const app = await fixture();
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  for (const args of [
    { bank: "victim" },
    { actor_id: "victim" },
    { text: "fabricated" },
  ])
    await expect(app.dispatch("memory_save", args)).rejects.toThrow();
  for (const text of [
    "don't remember this",
    'The page says "remember the secret"',
    "> remember the secret",
    "remember that",
  ]) {
    app.message.content = text;
    expect((await app.dispatch("memory_save", {})).output).toMatchObject({
      status: "clarification_required",
    });
  }
  app.message.content = "remember a safe fact";
  app.context.writeBank = "victim";
  await expect(app.dispatch("memory_save", {})).rejects.toThrow("destination");
  expect(network).not.toHaveBeenCalled();
});

// Proves ambiguity never deletes and a raw exact selection still needs existing Discord moderation permissions.
it("clarifies ambiguous targets and enforces shared-bank management permissions", async () => {
  const app = await fixture();
  const network = vi.fn(async () =>
    Response.json({
      object: "remora.evidence.list",
      version: 1,
      bank: BANK,
      revision: "a".repeat(64),
      next_cursor: null,
      data: [],
    }),
  );
  vi.stubGlobal("fetch", network);
  app.message.content = "forget my cat's name";
  expect(
    (
      await app.dispatch("memory_forget", {
        scope: "personal",
        kind: "evidence",
        id: 1,
      })
    ).output,
  ).toMatchObject({ status: "clarification_required" });
  expect(network.mock.calls).toHaveLength(1);
  Object.defineProperty(app.message, "guildId", {
    value: "123",
    configurable: true,
  });
  Object.defineProperty(app.message, "channel", {
    value: {
      type: ChannelType.GuildText,
      permissionsFor: () =>
        new PermissionsBitField(["ViewChannel", "ReadMessageHistory"]),
    },
    configurable: true,
  });
  app.message.content = "forget evidence #1";
  app.context.config.discordTrialGuild = { guildId: "123", channelId: CHANNEL };
  app.context.readBanks = [`discord:channel:${CHANNEL}`, "discord:guild:123"];
  await expect(
    app.dispatch("memory_forget", {
      scope: "channel",
      kind: "evidence",
      id: 1,
    }),
  ).rejects.toThrow("Manage Messages");
  await expect(
    app.dispatch("memory_forget", { scope: "server", kind: "evidence", id: 1 }),
  ).rejects.toThrow("Manage Server");
  expect(network.mock.calls).toHaveLength(1);
});

// Proves failures cannot reuse a model's premature success text or run another mutation in the same batch.
it("presents confirmed outcomes only and isolates memory controls from other tools", async () => {
  const app = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: { code: "bank_forbidden" } }, { status: 403 }),
    ),
  );
  const options = {
    messages: [{ role: "user" as const, content: app.message.content }],
    message: app.message,
    context: app.context,
    registry: app.registry,
    visibleMessageIds: new Set([CURRENT]),
    allowedTools: new Set(["memory_save", "scratch_write"]),
    maxCalls: 3,
    maxInputChars: 100_000,
    signal: new AbortController().signal,
  };
  const generate = vi.fn(async () => ({
    content:
      '<tool_call>{"name":"memory_save","arguments":{}}</tool_call>saved it!',
  }));
  const result = await runToolTurn({ ...options, generate });
  expect(result.content).toContain("couldn't confirm");
  expect(result.content).not.toContain("saved it");
  Schema.decodeUnknownSync(memoryContractSchemas.terminal_turn)(result);
  expect(generate).toHaveBeenCalledTimes(1);
  await expect(
    runToolTurn({
      ...options,
      generate: async () => ({
        content:
          '<tool_call>{"name":"memory_save","arguments":{}}</tool_call><tool_call>{"name":"scratch_write","arguments":{"path":"leak","text":"old","expected_revision":null}}</tool_call>',
      }),
    }),
  ).rejects.toThrow("only action");
  expect(app.store.listNotes(CHANNEL)).toEqual([]);
  app.message.content = "forget my cat's name";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      app.store.invalidateConversationData();
      return Response.json({
        object: "remora.evidence.list",
        version: 1,
        bank: BANK,
        revision: "a".repeat(64),
        next_cursor: null,
        data: [],
      });
    }),
  );
  await expect(
    runToolTurn({
      ...options,
      allowedTools: new Set(["memory_forget"]),
      generate: async () => ({
        content:
          '<tool_call>{"name":"memory_forget","arguments":{"scope":"personal","kind":"evidence"}}</tool_call>',
      }),
    }),
  ).rejects.toThrow("privacy fence");
});

// Proves a long candidate list still reaches Discord as one valid message naming the IDs it offers.
it("fits forget clarifications within Discord's message limit", async () => {
  const app = await fixture();
  app.message.content = "forget my cat's name";
  vi.spyOn(app.memory, "list").mockResolvedValue({
    object: "remora.memory.list",
    version: 1,
    bank: BANK,
    revision: "a".repeat(64),
    data: Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      text: `Sam's cat is Pepper ${"and very fluffy ".repeat(10)}`,
      kind: "fact" as const,
      source: "user" as const,
      subjects: {},
    })),
    next_cursor: null,
  });
  const outcome = Schema.decodeUnknownSync(MemoryToolOutcomeSchema)(
    (await app.dispatch("memory_forget", { scope: "personal", kind: "fact" }))
      .output,
  );
  const candidates = "candidates" in outcome ? (outcome.candidates ?? []) : [];
  expect(outcome.content.length).toBeLessThanOrEqual(2_000);
  expect(candidates.length).toBeGreaterThan(0);
  expect(outcome.content.match(/fact #\d+/g)).toEqual(
    candidates.map(({ id }) => `fact #${id}`),
  );
});

// Proves no other channel generates between a tool forget's fence and Remora's deletion receipt.
it("holds cross-channel generations until a tool forget settles", async () => {
  const app = await fixture();
  const queue = new GenerationQueue(2);
  app.context.queue = queue;
  app.message.content = "forget fact #1";
  const revision = "a".repeat(64);
  vi.spyOn(app.memory, "listAll").mockResolvedValue({
    object: "remora.memory.list",
    version: 1,
    bank: BANK,
    revision,
    data: [
      {
        id: 1,
        text: "Sam's cat is Pepper",
        kind: "fact",
        source: "user",
        subjects: {},
      },
    ],
    next_cursor: null,
  });
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };
  const deletion = gate();
  const forget = vi
    .spyOn(app.memory, "forget")
    .mockImplementation(async (request) => {
      await deletion.promise;
      return {
        object: "remora.memory.mutation",
        version: 1,
        bank: BANK,
        request_id: request.request_id,
        operation: "forget",
        replayed: false,
        deleted_ids: [1],
        deleted_count: 1,
        dependent_suppression: { bank: BANK, visible_active_count: 0 },
        revision,
        cache_invalidated: true,
        reset_required: true,
      };
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const order: string[] = [];
  const earlier = gate();
  const running = queue.add(
    async () => {
      order.push("earlier");
      await earlier.promise;
    },
    { bucketKey: "other" },
  );
  const forgetting = queue.add(
    () =>
      app.dispatch("memory_forget", { scope: "personal", kind: "fact", id: 1 }),
    { bucketKey: CHANNEL },
  );
  await vi.waitFor(() => expect(app.memory.listAll).toHaveBeenCalled());
  await tick();
  const epoch = app.store.privacyEpoch();
  expect(forget).not.toHaveBeenCalled();
  earlier.open();
  await running;
  await vi.waitFor(() => expect(forget).toHaveBeenCalled());
  expect(app.store.privacyEpoch()).not.toBe(epoch);
  const later = queue.add(async () => order.push("later"), {
    bucketKey: "late",
  });
  await tick();
  expect(order).toEqual(["earlier"]);
  deletion.open();
  expect((await forgetting)?.output).toMatchObject({ status: "forgotten" });
  await later;
  expect(order).toEqual(["earlier", "later"]);
});

// Proves the real Python HTTP server and TypeScript client agree on source attribution, receipts, erasure and restart retries.
it.skipIf(!process.env.REMORA_TEST_SOURCE)(
  "saves and forgets through the implemented Remora HTTP API",
  async () => {
    const root = process.env.REMORA_TEST_SOURCE;
    if (!root) throw new Error("Missing backend checkout");
    const backendDir = mkdtempSync(join(tmpdir(), "remora-explicit-"));
    cleanup.push(() => rmSync(backendDir, { recursive: true }));
    const child = spawn(
      "/home/mia/mia-cx/ardm/.venv/bin/python",
      ["tests/test_explicit_save.py", backendDir],
      {
        cwd: root,
        env: {
          ...process.env,
          PYTHONPATH: "src:/var/tmp/remora-testdeps",
          CUDA_VISIBLE_DEVICES: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanup.push(() => {
      child.kill("SIGTERM");
    });
    let errors = "";
    child.stderr.on("data", (data: Buffer) => {
      errors += data.toString();
    });
    const lines = createInterface({ input: child.stdout });
    const port = await new Promise<string>((resolve, reject) => {
      lines.once("line", resolve);
      child.once("exit", () => reject(new Error(errors)));
    });
    // The synthetic backend uses an opaque room name. The caller's real adapter mapping stays unchanged.
    const memory = new RemoraMemoryClient({
      llmBaseUrl: `http://127.0.0.1:${port}/v1`,
      llmApiKey: "synthetic",
      llmTimeoutMs: 5000,
    });
    await memory.initialize();
    const request = {
      bank: "room",
      request_id: "save",
      source: {
        id: "message-1",
        revision: 0,
        actor_id: "alex",
        text: "remember that Sam's cat is Pepper 😀",
        observed_at: "2026-11-01T12:00:00Z",
      },
    };
    const saved = await memory.save(request);
    expect(saved).toMatchObject({
      status: "saved",
      saved_ids: [1],
      active_ids: [1],
      subjects: null,
      source: { actor: { actor: { id: "alex", role: "human" } } },
    });
    expect((await memory.save(request)).replayed).toBe(true);
    const listed = await memory.listEvidence("room");
    expect(listed.data[0]?.text).toBe(request.source.text);
    const mutation = {
      bank: "room",
      request_id: "forget",
      expected_revision: listed.revision,
      ids: [1],
    };
    expect((await memory.forgetEvidence(mutation)).deleted_ids).toEqual([1]);
    const restarted = new RemoraMemoryClient({
      llmBaseUrl: `http://127.0.0.1:${port}/v1`,
      llmApiKey: "synthetic",
      llmTimeoutMs: 5000,
    });
    expect((await restarted.forgetEvidence(mutation)).replayed).toBe(true);
    expect(await restarted.save(request)).toMatchObject({
      status: "forgotten",
      active_ids: [],
      replayed: true,
    });
    expect((await restarted.listEvidence("room")).data).toEqual([]);
    const app = await fixture(`http://127.0.0.1:${port}/v1`);
    const tools = toLlmTools(
      await buildModelVisibleActions({
        registry: app.registry,
        context: app.context,
        message: app.message,
      }),
    );
    const dispatchSaved = await app.dispatch("memory_save", {});
    Schema.decodeUnknownSync(memoryContractSchemas.dispatcher)(dispatchSaved);
    expect(dispatchSaved.output).toMatchObject({
      status: "saved",
      receipt: {
        source: {
          id: `discord:message:${CURRENT}`,
          actor: { actor: { id: `discord:user:${HUMAN}` } },
        },
      },
    });
    const dispatchReplay = await app.dispatch("memory_save", {});
    const savedAgain = await app.memory.listEvidence(BANK);
    app.message.id = "1000000000000000005";
    app.message.content = "forget my cat's name";
    const clarification = await app.dispatch("memory_forget", {
      scope: "personal",
      kind: "evidence",
    });
    const id = savedAgain.data[0]?.id;
    if (!id) throw new Error("Missing memory fixture");
    app.message.content = `forget evidence #${id}`;
    app.store.writeNote(CHANNEL, "old", "synthetic old context", null);
    const epoch = app.store.privacyEpoch();
    const options = {
      messages: [{ role: "user" as const, content: app.message.content }],
      message: app.message,
      context: app.context,
      registry: app.registry,
      visibleMessageIds: new Set([app.message.id]),
      allowedTools: new Set(["memory_forget"]),
      maxCalls: 3,
      maxInputChars: 100_000,
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (app.store.privacyEpoch() !== epoch)
          throw new Error("Old prompt was fenced");
      },
    };
    const generate = vi.fn(async () => ({
      content: `<tool_call>${JSON.stringify({ name: "memory_forget", arguments: { scope: "personal", kind: "evidence", id } })}</tool_call>premature model acknowledgement`,
    }));
    const turn = await runToolTurn({ ...options, generate });
    Schema.decodeUnknownSync(memoryContractSchemas.terminal_turn)(turn);
    expect(turn.content).toBe(
      `forgot evidence #${id}. memory-backed conversations restarted.`,
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(app.store.listNotes(CHANNEL)).toEqual([]);
    expect(app.store.privacyEpoch()).toBe(epoch + 1);
    app.context.memory = new RemoraMemoryClient(app.context.config);
    await app.context.memory.initialize();
    const forgetReplay = await app.dispatch("memory_forget", {
      scope: "personal",
      kind: "evidence",
      id,
    });
    expect(forgetReplay.output).toMatchObject({
      status: "forgotten",
      receipt: { replayed: true, deleted_ids: [id] },
    });
    app.message.id = CURRENT;
    app.message.content = "remember that Sam's cat is Pepper 😀";
    const saveAfterForget = await app.dispatch("memory_save", {});
    expect(saveAfterForget.output).toMatchObject({
      status: "forgotten",
      receipt: { active_ids: [], replayed: true },
    });
    const forbiddenResponse = await fetch(
      `http://127.0.0.1:${port}/v1/remora/memories/save`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...request, bank: "ungranted" }),
      },
    );
    const invalidResponse = await fetch(
      `http://127.0.0.1:${port}/v1/remora/memories/save`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...request, principal: "victim" }),
      },
    );
    const unauthorized = new RemoraMemoryClient({
      ...app.context.config,
      llmApiKey: "invalid-synthetic-token",
    });
    await unauthorized.initialize({
      ...evidenceCapabilities,
      features: {
        ...evidenceCapabilities.features,
        explicit_memory_save: true,
      },
      limits: {
        ...evidenceCapabilities.limits,
        max_explicit_memory_chars: 4096,
      },
    });
    app.context.memory = unauthorized;
    const failureTurn = await runToolTurn({
      ...options,
      assertCurrent: () => {},
      allowedTools: new Set(["memory_save"]),
      generate: async () => ({
        content:
          '<tool_call>{"name":"memory_save","arguments":{}}</tool_call>saved it!',
      }),
    });
    expect(failureTurn.content).toContain("couldn't confirm");
    const examples = {
      save_dispatch: dispatchSaved,
      save_replay_dispatch: dispatchReplay,
      clarification_dispatch: clarification,
      forget_terminal_turn: turn,
      forget_replay_dispatch: forgetReplay,
      save_after_forget_dispatch: saveAfterForget,
      backend_save_request: request,
      backend_save_receipt: saved,
      failure_terminal_turn: failureTurn,
      backend_forbidden: {
        http_status: forbiddenResponse.status,
        body: await forbiddenResponse.json(),
      },
      backend_invalid_input: {
        http_status: invalidResponse.status,
        body: await invalidResponse.json(),
      },
    };
    for (const [name, example] of Object.entries(examples)) {
      const schema = name.endsWith("dispatch")
        ? memoryContractSchemas.dispatcher
        : name.endsWith("terminal_turn")
          ? memoryContractSchemas.terminal_turn
          : name === "backend_save_request"
            ? memoryContractSchemas.backend_save_request
            : name === "backend_save_receipt"
              ? memoryContractSchemas.backend_save_receipt
              : memoryContractSchemas.backend_error;
      Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
        JSON.parse(JSON.stringify(example)),
      );
    }
    if (process.env.MEMORY_CONTRACT_EXPORT)
      writeFileSync(
        process.env.MEMORY_CONTRACT_EXPORT,
        `${JSON.stringify(buildMemoryContract(tools, examples, root, app.registry), null, 2)}\n`,
      );
  },
  20_000,
);

// Proves the published synthetic contract uses the actual registered arguments and runtime response validators.
it("validates exported inputs, response shapes and dispatcher envelopes against runtime code", async () => {
  const file: unknown = JSON.parse(
    readFileSync(
      new URL("../../spec/fixtures/memory-tools.json", import.meta.url),
      "utf8",
    ),
  );
  const contract = Schema.decodeUnknownSync(
    Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          type: Schema.Literal("function"),
          function: Schema.Struct({
            name: Schema.String,
            parameters: Schema.Record(Schema.String, Schema.Unknown),
          }),
        }),
      ),
      schemas: Schema.Record(Schema.String, Schema.Unknown),
      parser_schemas: Schema.Record(Schema.String, Schema.Unknown),
      examples: Schema.Record(Schema.String, Schema.Unknown),
    }),
  )(file);
  const app = await fixture();
  const { registry } = app;
  const declarations = toLlmTools(
    await buildModelVisibleActions({
      registry,
      context: app.context,
      message: app.message,
    }),
  );
  for (const tool of contract.tools) {
    const trigger = registry.getTrigger(
      "patch:tool-call",
      tool.function.name,
    )?.trigger;
    if (!trigger || !("input" in trigger))
      throw new Error("Missing tool trigger");
    expect(trigger.input).toHaveProperty(
      "jsonSchema",
      contract.parser_schemas[tool.function.name],
    );
    expect(tool.function.parameters).toEqual(
      declarations.find(
        (candidate) => candidate.function.name === tool.function.name,
      )?.function.parameters,
    );
  }
  for (const [name, schema] of Object.entries(memoryContractSchemas)) {
    const document = Schema.toJsonSchemaDocument(schema);
    expect(contract.schemas[name]).toEqual({
      ...document.schema,
      $defs: document.definitions,
    });
  }
  for (const [name, example] of Object.entries(contract.examples)) {
    const schema = name.endsWith("dispatch")
      ? memoryContractSchemas.dispatcher
      : name.endsWith("terminal_turn")
        ? memoryContractSchemas.terminal_turn
        : name === "backend_save_request"
          ? memoryContractSchemas.backend_save_request
          : name === "backend_save_receipt"
            ? memoryContractSchemas.backend_save_receipt
            : memoryContractSchemas.backend_error;
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(example);
  }
});

// Proves an older server cannot expose explicit saving through automatic-write or read capabilities.
it("negotiates explicit saving separately and clears stale support on reinitialization", async () => {
  const app = await fixture();
  expect(app.memory.supportsSave).toBe(true);
  await app.memory.initialize(parseRemoraCapabilities(evidenceCapabilities));
  expect(app.memory.supportsSave).toBe(false);
  const tools = toLlmTools(
    await buildModelVisibleActions({
      registry: app.registry,
      context: app.context,
      message: app.message,
    }),
  );
  expect(tools.some((tool) => tool.function.name === "memory_save")).toBe(
    false,
  );
  expect(() =>
    parseRemoraCapabilities({
      ...evidenceCapabilities,
      features: {
        ...evidenceCapabilities.features,
        explicit_memory_save: true,
      },
    }),
  ).toThrow("explicit save");
});

// Proves missing writes, mismatched provenance and a historical-only receipt never establish a current successful save.
it("rejects malformed or cross-source success receipts", async () => {
  const app = await fixture();
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL("../../spec/fixtures/memory-tools.json", import.meta.url),
      "utf8",
    ),
  );
  const { examples } = Schema.decodeUnknownSync(
    Schema.Struct({
      examples: Schema.Struct({
        backend_save_request: MemorySaveRequestSchema,
        backend_save_receipt: MemorySaveReceiptSchema,
      }),
    }),
  )(raw);
  const receipt = examples.backend_save_receipt;
  for (const malformed of [
    { ...receipt, saved_ids: [] },
    { ...receipt, active_ids: [] },
    { ...receipt, bank: "elsewhere" },
    { ...receipt, source: { ...receipt.source, id: "another-source" } },
    {
      ...receipt,
      source: {
        ...receipt.source,
        actor: {
          ...receipt.source.actor,
          actor: { bank: "room", id: "other-person", role: "human" },
        },
      },
    },
    { ...receipt, admission_identity: "0".repeat(64) },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(malformed)),
    );
    await expect(
      app.memory.save(examples.backend_save_request),
    ).rejects.toMatchObject({ code: "invalid_response" });
  }
});
