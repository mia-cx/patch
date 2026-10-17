import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type APIChatInputApplicationCommandInteraction,
  type APIMessage,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  InteractionType,
  Locale,
  MessageType,
  SnowflakeUtil,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../actions/context.js";
import { registerDefaultActions } from "../actions/defaults.js";
import { createPatchActionRegistry } from "../actions/registry.js";
import { loadConfig } from "../config.js";
import { dispatchInteraction } from "../discord/actions/dispatch.js";
import { DiscordJsAdapter } from "../discord/discord-js-adapter.js";
import { LlmClient, type LlmMessage } from "../llm/client.js";
import { ModelCatalog } from "../llm/model-catalog.js";
import type { RemoraRequest, RemoraResponse } from "../llm/remora.js";
import { createLogger } from "../logger.js";
import { GenerationQueue } from "../queue.js";
import { respond } from "../response/responder.js";
import { SettingsStore } from "../settings/store.js";
import {
  type ConversationContextOptions,
  reconstructConversationContext,
} from "./context.js";
import { ConversationContextStore } from "./store.js";

const CHANNEL = "1000000000000000001";
const GUILD = "1000000000000000002";
const BOT = "1000000000000000003";
const HUMAN = "1000000000000000004";
const resources: (() => void)[] = [];

afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function packet(
  index: number,
  overrides: Partial<APIMessage> = {},
): APIMessage {
  const timestamp = Date.UTC(2026, 9, 16, 10, 0, index);
  return {
    id: SnowflakeUtil.generate({ timestamp, increment: 1n }).toString(),
    channel_id: CHANNEL,
    author: {
      id: HUMAN,
      username: "Mia",
      global_name: null,
      discriminator: "0",
      avatar: null,
      bot: false,
    },
    type: MessageType.Default,
    content: `message ${index}`,
    timestamp: new Date(timestamp).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    components: [],
    ...overrides,
  };
}

class Command extends ChatInputCommandInteraction {
  // biome-ignore lint/complexity/noUselessConstructor: expose the SDK's protected gateway constructor
  constructor(
    client: Client<true>,
    data: APIChatInputApplicationCommandInteraction,
  ) {
    super(client, data);
  }
}

async function runtime(
  type:
    | ChannelType.DM
    | ChannelType.GuildText
    | ChannelType.PublicThread = ChannelType.DM,
  path = ":memory:",
  channelId = CHANNEL,
) {
  const client = new Client<true>({ intents: [] });
  let packets: APIMessage[] = [];
  let confirmationIndex = 0;
  let store = new ConversationContextStore(path);
  resources.push(
    () => {
      void client.destroy();
    },
    () => store.close(),
  );
  const rest = vi
    .spyOn(client.rest, "get")
    .mockImplementation(async (route, options) => {
      if (route === `/guilds/${GUILD}`)
        return {
          id: GUILD,
          name: "trial guild",
          owner_id: HUMAN,
          features: [],
          roles: [],
          channels: [],
          members: [],
          emojis: [],
          stickers: [],
        };
      if (route === `/channels/${channelId}`)
        return {
          id: channelId,
          type,
          guild_id: type === ChannelType.DM ? undefined : GUILD,
          name: "trial",
          recipients: [],
          owner_id: HUMAN,
          parent_id: "1000000000000000005",
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-10-16T10:00:00Z",
          },
        };
      if (route === `/channels/${channelId}/messages`) {
        const before = BigInt(
          options?.query?.get("before") ?? "9223372036854775807",
        );
        const limit = Number(options?.query?.get("limit") ?? 50);
        return packets
          .filter((item) => BigInt(item.id) < before)
          .toReversed()
          .slice(0, limit);
      }
      const message = packets.find(
        (item) => route === `/channels/${channelId}/messages/${item.id}`,
      );
      if (message) return message;
      throw new Error(`Unexpected Discord request: ${route}`);
    });
  const post = vi
    .spyOn(client.rest, "post")
    .mockImplementation(async (route) => {
      if (route.startsWith("/interactions/")) return undefined;
      if (route === `/webhooks/${BOT}/test-token`)
        return packet(confirmationIndex);
      if (route === `/channels/${channelId}/typing`) return undefined;
      if (route === `/channels/${channelId}/messages`) {
        const sent = packet(900, {
          author: {
            id: BOT,
            username: "Patch",
            global_name: null,
            discriminator: "0",
            avatar: null,
            bot: true,
          },
          content: "hello",
        });
        return sent;
      }
      throw new Error(`Unexpected Discord request: ${route}`);
    });
  const patch = vi.spyOn(client.rest, "patch").mockResolvedValue(packet(900));
  const restDelete = vi
    .spyOn(client.rest, "delete")
    .mockResolvedValue(undefined);
  if (type !== ChannelType.DM) await client.guilds.fetch(GUILD);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Fixture must support messages");
  const adapter = new DiscordJsAdapter(client, BOT);
  const logger = createLogger(false);
  logger.level = "silent";
  const config = loadConfig({
    DISCORD_TOKEN: "test",
    DISCORD_CLIENT_ID: BOT,
    BOT_OWNER_USER_IDS: HUMAN,
  });
  const settings = new SettingsStore(":memory:", { llmModel: "test-model" });
  resources.push(() => settings.close());
  const llm = new LlmClient(config, settings);
  const actionContext: ActionContext = {
    client: { channels: client.channels, user: { id: BOT } },
    config,
    llm,
    logger,
    settings,
    queue: new GenerationQueue(2),
    modelCatalog: new ModelCatalog(llm, logger),
    get contextStore() {
      return store;
    },
  };
  const registry = createPatchActionRegistry();
  registerDefaultActions(registry);

  const message = async (index: number) => {
    return channel.messages.fetch({ message: packet(index).id, force: true });
  };
  return {
    adapter,
    logger,
    rest,
    post,
    patch,
    restDelete,
    message,
    actionContext,
    get store() {
      return store;
    },
    add(index: number, overrides: Partial<APIMessage> = {}) {
      packets.push(packet(index, { channel_id: channelId, ...overrides }));
    },
    remove(index: number) {
      packets = packets.filter((item) => item.id !== packet(index).id);
    },
    edit(index: number, content: string) {
      packets = packets.map((item) =>
        item.id === packet(index).id ? { ...item, content } : item,
      );
    },
    reopen() {
      store.close();
      store = new ConversationContextStore(path);
    },
    async receive(index: number) {
      const incoming = await message(index);
      return (
        !incoming.author.bot &&
        store.observeHumanMessage(incoming.channelId, incoming.id)
      );
    },
    async reset(index: number, userId = HUMAN) {
      confirmationIndex = index;
      const interaction = new Command(client, {
        id: packet(index).id,
        application_id: BOT,
        token: "test-token",
        version: 1,
        type: InteractionType.ApplicationCommand,
        channel: { id: channelId, type },
        channel_id: channelId,
        user: { ...packet(index).author, id: userId },
        locale: Locale.EnglishUS,
        app_permissions: "0",
        entitlements: [],
        authorizing_integration_owners: {},
        attachment_size_limit: 1000000,
        data: {
          id: packet(0).id,
          name: "context",
          type: ApplicationCommandType.ChatInput,
          options: [
            { name: "reset", type: ApplicationCommandOptionType.Subcommand },
          ],
        },
      });
      await dispatchInteraction({
        interaction,
        context: actionContext,
        registry,
      });
    },
    confirmAt(index: number) {
      confirmationIndex = index;
    },
    async context(
      index: number,
      options: Partial<ConversationContextOptions> = {},
    ) {
      return reconstructConversationContext(
        adapter,
        await message(index),
        BOT,
        logger,
        undefined,
        {
          store,
          budget: { contextTokens: 100_000, promptTokens: 3_000 },
          dmContextMessageLimit: 3,
          threadContextMessageLimit: 3,
          guildRecentMessageLimit: 3,
          ...options,
        },
      );
    },
  };
}

describe("persistent chat context", () => {
  // Proves explicit forgetting fences all memory-backed chats, including other banks, across restarts.
  it("fences memory-backed chats before deletion without resetting plain conversations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-memory-reset-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "patch.sqlite");
    const app = await runtime(ChannelType.DM, path);
    const otherChannel = "1000000000000000009";
    const unrelatedChannel = "1000000000000000010";
    const other = await runtime(ChannelType.DM, path, otherChannel);
    const unrelated = await runtime(ChannelType.DM, path, unrelatedChannel);
    for (const chat of [app, other, unrelated]) {
      chat.add(1, { content: "old fact must not return" });
      chat.add(2);
      await chat.context(2);
    }
    app.store.recordMemoryContext(CHANNEL);
    app.store.recordMemoryContext(otherChannel);
    expect(app.store.resetMemoryContexts([CHANNEL], packet(4).id)).toBe(2);
    app.reopen();
    expect(await app.context(2)).toEqual([]);
    expect(await other.context(2)).toEqual([]);
    expect(unrelated.store.getStart(unrelatedChannel)).toBe(packet(1).id);
    app.add(5, {
      content: "new conversation",
      message_reference: { channel_id: CHANNEL, message_id: packet(1).id },
    });
    expect(await app.receive(5)).toBe(true);
    expect((await app.context(5)).map((item) => item.content)).toEqual([
      "new conversation",
    ]);
    // A duplicate old command cannot rewind a newer successful reset.
    expect(app.store.resetMemoryContexts([CHANNEL], packet(3).id)).toBe(1);
    expect(app.store.getStart(CHANNEL)).toBe(packet(5).id);
    expect(app.store.resetMemoryContexts([], packet(6).id)).toBe(0);
  });

  // Proves a confirmed native reset survives restarts and only a new human arrival starts history.
  it("starts afresh on the first human arrival after confirmation, despite stale events and replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-reset-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "patch.sqlite");
    const app = await runtime(ChannelType.DM, path);
    const other = await runtime(ChannelType.DM, path, "1000000000000000009");
    const bot = { ...packet(1).author, id: BOT, username: "Patch", bot: true };
    app.add(1, { content: "old human history" });
    app.add(2, { author: bot, content: "old reply-chain ancestor" });
    app.add(3);
    await app.context(3);
    other.add(1, { content: "other channel history" });
    await other.context(1);
    let confirm!: () => void;
    let confirming!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const started = new Promise<void>((resolve) => {
      confirming = resolve;
    });
    app.patch.mockImplementationOnce(async () => {
      confirming();
      await confirmation;
      return packet(4);
    });
    const reset = app.reset(4);
    await Promise.race([started, reset]);
    expect(app.patch).toHaveBeenCalledTimes(1);
    // This arrives after invocation but before successful confirmation; it must not become the start.
    app.add(5, { content: "human while reset is still running" });
    await app.receive(5);
    other.add(5, { content: "unaffected while another channel resets" });
    expect(await other.receive(5)).toBe(true);
    expect((await other.context(5)).map((item) => item.content)).toEqual([
      "other channel history",
      "unaffected while another channel resets",
    ]);
    app.confirmAt(7);
    confirm();
    await reset;
    expect(
      app.post.mock.calls.find(
        ([route]) => route === `/webhooks/${BOT}/test-token`,
      )?.[1]?.body,
    ).toMatchObject({
      content: "context reset. your next message starts a new conversation.",
    });
    expect(app.store.getStart(CHANNEL)).toBeUndefined();
    app.add(4, {
      type: MessageType.ChatInputCommand,
      content: "/context reset",
    });
    app.add(6, { author: bot, content: "reset confirmation" });
    await app.reset(8);
    app.reopen();
    app.edit(1, "old edit now mentioning Patch");
    expect(await app.context(1)).toEqual([]);
    expect(await app.receive(5)).toBe(false);
    app.add(9, { author: bot, content: "a bot cannot establish the boundary" });
    expect(await app.receive(9)).toBe(false);
    expect(app.store.getStart(CHANNEL)).toBeUndefined();
    app.add(10, {
      content: "first new human, with no generated reply",
      message_reference: { channel_id: CHANNEL, message_id: packet(2).id },
    });
    expect(await app.receive(10)).toBe(true);
    app.reopen();
    app.add(11, {
      content: "second new human",
      message_reference: { channel_id: CHANNEL, message_id: packet(2).id },
    });
    expect(await app.receive(11)).toBe(true);
    // A late event even newer than the cutoff cannot rewind the first observed human arrival.
    app.remove(9);
    app.add(9, { content: "late human event" });
    expect(await app.receive(9)).toBe(false);
    expect(await app.context(9)).toEqual([]);
    expect(await app.context(5)).toEqual([]);
    app.rest.mockClear();
    expect((await app.context(11)).map((item) => item.content)).toEqual([
      "first new human, with no generated reply",
      "second new human",
    ]);
    expect(
      app.rest.mock.calls.some(([route]) =>
        route.endsWith(`/messages/${packet(2).id}`),
      ),
    ).toBe(false);
    app.add(12, { author: bot, content: "new assistant reply" });
    app.add(13, {
      message_reference: { channel_id: CHANNEL, message_id: packet(12).id },
    });
    expect(await app.receive(13)).toBe(true);
    expect((await app.context(13)).map((item) => item.content)).toEqual([
      "first new human, with no generated reply",
      "second new human",
      "new assistant reply",
      "message 13",
    ]);
    expect(other.store.getStart("1000000000000000009")).toBe(packet(1).id);
  });

  // Proves rejected or failed native resets leave the active conversation usable and report no success.
  it.each(["unauthorized", "confirmation", "storage", "late_storage"] as const)(
    "keeps history when reset fails at %s",
    async (failure) => {
      const dir = mkdtempSync(join(tmpdir(), "patch-reset-failure-"));
      resources.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, "patch.sqlite");
      const app = await runtime(ChannelType.DM, path);
      app.add(1, { content: "keep this conversation" });
      await app.context(1);
      if (failure === "confirmation") {
        // Acknowledge the command, then fail the fresh success send after the original was deleted.
        app.post
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("Discord unavailable"));
      }
      if (failure === "storage") {
        const db = new DatabaseSync(path);
        db.exec(`CREATE TRIGGER fail_reset BEFORE INSERT ON conversation_resets
          BEGIN SELECT RAISE(ABORT, 'read-only trial database'); END;`);
        db.close();
      }
      if (failure === "late_storage") {
        app.post
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(async () => {
            const db = new DatabaseSync(path);
            db.exec(`CREATE TRIGGER fail_reset BEFORE INSERT ON conversation_resets
            BEGIN SELECT RAISE(ABORT, 'database filled during confirmation'); END;`);
            db.close();
            return packet(2);
          });
      }
      await app.reset(
        2,
        failure === "unauthorized" ? "1000000000000000008" : HUMAN,
      );
      expect(app.patch).toHaveBeenCalledTimes(1);
      const response =
        failure === "confirmation" || failure === "late_storage"
          ? app.post
          : app.patch;
      expect(response).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            content:
              failure === "unauthorized"
                ? "nope, owner-only."
                : "couldn't reset context. try again.",
          }),
        }),
      );
      if (failure === "late_storage") {
        expect(app.restDelete).toHaveBeenCalledWith(
          `/webhooks/${BOT}/test-token/messages/${packet(2).id}`,
          expect.anything(),
        );
      }
      app.reopen();
      app.add(3);
      expect(await app.receive(3)).toBe(true);
      expect((await app.context(3)).map((item) => item.content)).toEqual([
        "keep this conversation",
        "message 3",
      ]);
    },
  );

  // Proves same-millisecond human arrivals survive a delayed success acknowledgement without using the host clock.
  it("keeps the first human reply received while Discord's successful confirmation is in transit", async () => {
    const app = await runtime();
    app.add(1, { content: "old history" });
    await app.context(1);
    let acknowledge!: () => void;
    let sent!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const success = new Promise<void>((resolve) => {
      sent = resolve;
    });
    app.post
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        sent();
        await acknowledgement;
        return {
          ...packet(3),
          id: SnowflakeUtil.generate({
            timestamp: Date.parse(packet(3).timestamp),
            increment: 0n,
          }).toString(),
        };
      });
    const reset = app.reset(2);
    await success;
    app.add(3, {
      content: "first human after success in the same millisecond",
    });
    await app.receive(3);
    app.add(4, { content: "second human after success" });
    await app.receive(4);
    app.add(2, { content: "late event from before success" });
    await app.receive(2);
    acknowledge();
    await reset;
    expect((await app.context(4)).map((item) => item.content)).toEqual([
      "first human after success in the same millisecond",
      "second human after success",
    ]);
    expect(app.store.getStart(CHANNEL)).toBe(packet(3).id);
    expect(await app.receive(2)).toBe(false);
  });

  // Proves reset success waits for active sends and stale queued work cannot generate or restore history.
  it("serializes reset confirmation after an in-flight reply and suppresses queued old turns", async () => {
    const app = await runtime();
    app.add(1);
    app.add(2);
    await app.context(1);
    await app.receive(2);
    let finish!: () => void;
    let requested!: () => void;
    const generation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const network = vi.fn(async () => {
      requested();
      await generation;
      return Response.json({
        choices: [{ message: { content: "old-context reply" } }],
      });
    });
    vi.stubGlobal("fetch", network);
    const run = async (index: number) =>
      respond({
        adapter: app.adapter,
        message: await app.message(index),
        botUserId: BOT,
        ...app.actionContext,
      });
    const active = app.actionContext.queue.add(() => run(1), {
      bucketKey: CHANNEL,
    });
    await started;
    const queued = app.actionContext.queue.add(() => run(2), {
      bucketKey: CHANNEL,
      priority: "passive",
    });
    const reset = app.reset(3);
    await vi.waitFor(() =>
      expect(app.post).toHaveBeenCalledWith(
        expect.stringMatching(/^\/interactions\//),
        expect.anything(),
      ),
    );
    expect(app.patch).not.toHaveBeenCalled();
    expect(app.store.getStart(CHANNEL)).toBe(packet(1).id);
    finish();
    await Promise.all([active, reset, queued]);
    expect(network).toHaveBeenCalledTimes(1);
    const replies = app.post.mock.calls.filter(
      ([route]) => route === `/channels/${CHANNEL}/messages`,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[1]?.body).toMatchObject({
      content: "old-context reply",
    });
    const replyIndex = app.post.mock.calls.findIndex(
      ([route]) => route === `/channels/${CHANNEL}/messages`,
    );
    const confirmationIndex = app.post.mock.calls.findIndex(
      ([route]) => route === `/webhooks/${BOT}/test-token`,
    );
    expect(
      app.post.mock.invocationCallOrder[confirmationIndex],
    ).toBeGreaterThan(app.post.mock.invocationCallOrder[replyIndex] ?? 0);
    expect(app.store.getStart(CHANNEL)).toBeUndefined();
    expect(await app.context(2)).toEqual([]);
  });

  it.each([
    ChannelType.DM,
    ChannelType.PublicThread,
    ChannelType.GuildText,
  ] as const)(
    "keeps growing past the initial message count in channel type %s",
    async (type) => {
      const app = await runtime(type);
      for (let index = 1; index <= 4; index++) app.add(index);
      expect((await app.context(4)).map((item) => item.content)).toEqual([
        "message 2",
        "message 3",
        "message 4",
      ]);
      app.add(5, {
        author: {
          id: BOT,
          username: "Patch",
          global_name: null,
          discriminator: "0",
          avatar: null,
          bot: true,
        },
      });
      app.add(6);
      expect((await app.context(6)).map((item) => item.content)).toEqual([
        "message 2",
        "message 3",
        "message 4",
        "message 5",
        "message 6",
      ]);
    },
  );

  it("recovers the same starting boundary after reopening the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-context-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "patch.sqlite");
    const app = await runtime(ChannelType.DM, path);
    for (let index = 1; index <= 4; index++) app.add(index);
    await app.context(3);
    app.store.setStart("another-chat", packet(90).id);
    app.reopen();
    expect((await app.context(4)).map((item) => item.content)).toEqual([
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
    expect(app.store.getStart("another-chat")).toBe(packet(90).id);
  });

  it("jumps forward on overflow and then grows from the new boundary", async () => {
    const app = await runtime();
    // These messages each cost about 115 estimated tokens. 500 input tokens
    // fit four; after overflow, the 250-token target fits the latest two.
    const options = {
      budget: {
        contextTokens: 4_000,
        promptTokens: 3_000,
        responseTokens: 500,
      },
    };
    for (let index = 1; index <= 5; index++) {
      app.add(
        index,
        index === 2
          ? {
              author: {
                ...packet(index).author,
                id: BOT,
                username: "Patch",
                bot: true,
              },
            }
          : {},
      );
    }
    app.add(6, {
      message_reference: { channel_id: CHANNEL, message_id: packet(2).id },
    });
    expect((await app.context(3, options)).map((item) => item.content)).toEqual(
      ["message 1", "message 2", "message 3"],
    );
    expect((await app.context(4, options)).map((item) => item.content)).toEqual(
      ["message 1", "message 2", "message 3", "message 4"],
    );
    expect((await app.context(5, options)).map((item) => item.content)).toEqual(
      ["message 4", "message 5"],
    );
    expect((await app.context(6, options)).map((item) => item.content)).toEqual(
      ["message 4", "message 5", "message 6"],
    );
  });

  it("paginates beyond 100 messages without including messages after the trigger", async () => {
    const app = await runtime();
    for (let index = 1; index <= 106; index++) app.add(index);
    await app.context(3);
    const context = await app.context(105);
    expect(context).toHaveLength(105);
    expect(context[0]?.content).toBe("message 1");
    expect(context.at(-1)?.content).toBe("message 105");
  });

  it("resets after a long offline gap without fetching the entire channel", async () => {
    const app = await runtime();
    for (let index = 1; index <= 1_000; index++) app.add(index);
    await app.context(3);
    app.rest.mockClear();
    const context = await app.context(1_000, {
      budget: {
        contextTokens: 4_000,
        promptTokens: 3_000,
        responseTokens: 500,
      },
    });
    expect(context.map((item) => item.content)).toEqual([
      "message 999",
      "message 1000",
    ]);
    expect(
      app.rest.mock.calls.filter(
        ([route]) => route === `/channels/${CHANNEL}/messages`,
      ),
    ).toHaveLength(1);
  });

  it("reflects edits and deletions instead of retaining stale message copies", async () => {
    const app = await runtime(ChannelType.GuildText);
    for (let index = 1; index <= 5; index++) {
      app.add(
        index,
        index >= 4
          ? {
              message_reference: {
                channel_id: CHANNEL,
                message_id: packet(2).id,
              },
            }
          : {},
      );
    }
    await app.context(3);
    await app.message(2);
    app.edit(2, "corrected fact");
    app.remove(1);
    expect((await app.context(4)).map((item) => item.content)).toEqual([
      "corrected fact",
      "message 3",
      "message 4",
    ]);
    expect(app.store.getStart(CHANNEL)).toBe(packet(2).id);
    app.remove(2);
    expect((await app.context(5)).map((item) => item.content)).toEqual([
      "message 3",
      "message 4",
      "message 5",
    ]);
  });

  it("does not rewind the active context when an older message is edited to mention Patch", async () => {
    const app = await runtime();
    for (let index = 1; index <= 6; index++) app.add(index);
    await app.context(5);
    app.edit(1, "@Patch a question about this older message");
    expect((await app.context(1)).at(-1)?.content).toContain(
      "a question about this older message",
    );
    expect((await app.context(6)).map((item) => item.content)).toEqual([
      "message 3",
      "message 4",
      "message 5",
      "message 6",
    ]);
  });

  it("keeps the saved boundary when a history fetch fails", async () => {
    const app = await runtime();
    for (let index = 1; index <= 5; index++) app.add(index);
    await app.context(3);
    const trigger = await app.message(4);
    app.rest.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(
      reconstructConversationContext(
        app.adapter,
        trigger,
        BOT,
        app.logger,
        undefined,
        {
          store: app.store,
          budget: { contextTokens: 100_000, promptTokens: 3_000 },
        },
      ),
    ).rejects.toThrow("Discord unavailable");
    expect((await app.context(5)).map((item) => item.content)).toEqual([
      "message 1",
      "message 2",
      "message 3",
      "message 4",
      "message 5",
    ]);
  });

  it("rejects an oversized trigger without changing the saved boundary", async () => {
    const app = await runtime();
    app.add(1);
    await app.context(1);
    app.add(2, { content: "x".repeat(2_001) });
    await expect(
      app.context(2, { budget: { contextTokens: 3_500, promptTokens: 3_000 } }),
    ).rejects.toThrow("Latest message exceeds");
    expect(app.store.getStart(CHANNEL)).toBe(packet(1).id);
  });

  it("keeps the response history prefix stable when participants and classifier guidance change", async () => {
    const app = await runtime();
    app.add(1);
    app.add(2, {
      author: {
        id: "1000000000000000009",
        username: "Other",
        global_name: null,
        discriminator: "0",
        avatar: null,
        bot: false,
      },
    });
    const prompts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        // Inspect the serialized HTTP request from the real LLM client.
        const body: { messages: { role: string; content: string }[] } =
          JSON.parse(String(init.body));
        prompts.push(body.messages.map((item) => item.content).join("\n\n"));
        return Response.json({
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        });
      }),
    );
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: BOT,
    });
    const llm = new LlmClient(config);
    for (const index of [1, 2]) {
      await respond({
        adapter: app.adapter,
        message: await app.message(index),
        botUserId: BOT,
        config,
        llm,
        logger: app.logger,
        contextStore: app.store,
        classifierDecision: {
          shouldRespond: true,
          confidence: index / 2,
          reason: `decision ${index}`,
        },
      });
    }
    expect(prompts).toHaveLength(2);
    const first = prompts[0];
    const second = prompts[1];
    if (!first || !second) throw new Error("Expected two generated prompts");
    const historyEnd = first.lastIndexOf("</message>") + "</message>".length;
    expect(second.startsWith(first.slice(0, historyEnd))).toBe(true);
    expect(second).toContain("message 2");
    expect(
      second.indexOf("<classifier_decision should_respond="),
    ).toBeGreaterThan(second.lastIndexOf("</message>"));
  });
});

type CapturedRequest = {
  messages: LlmMessage[];
  remora?: RemoraRequest;
  chat_template_kwargs: { enable_thinking: boolean };
};

function memoryReceipt(
  request: RemoraRequest,
  replayed = false,
): RemoraResponse {
  if (!request.turn || !request.write_bank)
    throw new Error("Expected writable turn");
  return {
    version: 1,
    backend: "transformers",
    read_banks: request.read_banks,
    selected: [{ bank: request.write_bank, id: 1 }],
    writes: {
      bank: request.write_bank,
      source_id: request.turn.id,
      revision: request.turn.revision,
      replayed,
      result: {
        saved: [1],
        reinforced: [],
        superseded: [],
        forgotten: [],
        error: null,
        unmatched_forget: false,
      },
    },
    cache: {
      requested: true,
      reused_tokens: 800,
      evaluated_tokens: 40,
      invalidated: null,
    },
  };
}

describe("opt-in Remora DM conversations", () => {
  // Proves chat roles preserve distinct speakers, reply targets, and the exact new write source.
  it("keeps attributed history in real chat roles before the raw new source", async () => {
    const app = await runtime();
    const bot = { ...packet(1).author, id: BOT, username: "Patch", bot: true };
    app.add(1, { content: "I adopted a puppy." });
    const other = {
      ...packet(1).author,
      id: "1000000000000000009",
      username: "Sam",
    };
    app.add(2, { author: other, content: "My puppy is called Pip." });
    app.add(3, { author: bot, content: "That's lovely." });
    app.add(4, { author: bot, content: "Tell me more." });
    app.add(5, {
      content: "Want to hear his name?",
      message_reference: {
        channel_id: CHANNEL,
        message_id: packet(1).id,
      },
    });
    app.store.setStart(CHANNEL, packet(1).id);
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body: CapturedRequest = JSON.parse(String(init.body));
        requests.push(body);
        if (!body.remora) throw new Error("Expected writable DM");
        return Response.json({
          choices: [{ message: { content: "yes, tell me" } }],
          remora: memoryReceipt(body.remora),
        });
      }),
    );
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: BOT,
      REMORA_DM_ENABLED: "true",
      DM_CONTEXT_MESSAGE_LIMIT: "1",
    });
    await respond({
      adapter: app.adapter,
      message: await app.message(5),
      botUserId: BOT,
      config,
      llm: new LlmClient(config),
      logger: app.logger,
      contextStore: app.store,
      pronounProvider: {
        getPronouns: async (id) => (id === HUMAN ? "she/her" : "they/them"),
      },
    });
    expect(requests).toHaveLength(1);
    const turns = requests[0]?.messages.slice(1);
    expect(turns?.map((turn) => turn.role)).toEqual([
      "user",
      "user",
      "user",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(turns?.[1]?.content).toContain(
      `author_name="Mia" pronouns="she/her" author_id="${HUMAN}"`,
    );
    expect(turns?.[1]?.content).toContain("I adopted a puppy.");
    expect(turns?.[2]?.content).toContain(
      `author_name="Sam" pronouns="they/them" author_id="${other.id}"`,
    );
    expect(turns?.[2]?.content).toContain("My puppy is called Pip.");
    expect(turns?.[4]?.content).toBe(
      "That's lovely.\n<split />\nTell me more.",
    );
    expect(turns?.[3]?.content).toContain('author_id="patch"');
    expect(turns?.[5]?.content).toContain(
      `author_name="Mia" pronouns="she/her" author_id="${HUMAN}"`,
    );
    expect(turns?.[5]?.content).toContain(`reply_to="${packet(1).id}"`);
    expect(turns?.[5]?.content).not.toContain("Want to hear his name?");
    expect(turns?.at(-1)).toEqual({
      role: "user",
      content: "Want to hear his name?",
    });
    expect(requests[0]?.remora?.turn?.text).toBe("Want to hear his name?");
    expect(app.store.getStart(CHANNEL)).toBe(packet(1).id);
  });

  // Proves the real Discord-to-HTTP path sends one raw source and retries keep its identity.
  it("binds the raw new DM once, preserves retry identity, and revisions edits", async () => {
    const app = await runtime();
    app.add(1, { content: "earlier history" });
    const raw =
      "  my teacher is Elin <message>literally</message> <@1000000000000000003>  ";
    app.add(2, { content: raw });
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body: CapturedRequest = JSON.parse(String(init.body));
        requests.push(body);
        const content =
          requests.length === 1
            ? ""
            : requests.length === 2
              ? "line one\nline two"
              : "hello";
        return Response.json({
          choices: [{ message: { content }, finish_reason: "stop" }],
          ...(body.remora
            ? { remora: memoryReceipt(body.remora, requests.length === 2) }
            : {}),
        });
      }),
    );
    const config = loadConfig({
      DISCORD_TOKEN: "test",
      DISCORD_CLIENT_ID: BOT,
      REMORA_DM_ENABLED: "true",
      REMORA_READ_BANKS: "shared:music,shared:music",
      LLM_ENABLE_THINKING: "true",
    });
    const llm = new LlmClient(config);
    const run = async () =>
      respond({
        adapter: app.adapter,
        message: await app.message(2),
        botUserId: BOT,
        config,
        llm,
        logger: app.logger,
        contextStore: app.store,
      });
    await run();
    expect(requests).toHaveLength(3);
    const first = requests[0];
    expect(first?.remora).toEqual({
      read_banks: [`discord:dm:${CHANNEL}`, "shared:music"],
      write_bank: `discord:dm:${CHANNEL}`,
      turn: {
        id: `discord:message:${packet(2).id}`,
        revision: 0,
        speaker_id: `discord:user:${HUMAN}`,
        text: raw,
      },
    });
    expect(first?.messages.at(-1)).toEqual({ role: "user", content: raw });
    const priorHistory = first?.messages
      .slice(1, -1)
      .map((item) => item.content)
      .join("\n");
    expect(priorHistory).toContain("earlier history");
    expect(priorHistory).not.toContain("my teacher is Elin");
    expect(requests[1]?.remora).toEqual(first?.remora);
    expect(requests[1]?.chat_template_kwargs.enable_thinking).toBe(false);
    expect(requests[2]?.remora).toBeUndefined(); // Formatting repair has no write authority.
    const revised = "my teacher is Niko";
    app.remove(2);
    app.add(2, {
      content: revised,
      edited_timestamp: "2026-10-16T11:00:00.000Z",
    });
    await run();
    expect(requests[3]?.remora?.turn).toEqual({
      ...first?.remora?.turn,
      text: revised,
      revision: 1792148400000,
    });
    expect(requests[3]?.messages.at(-1)?.content).toBe(revised);
    const sent = app.post.mock.calls.filter(
      ([route]) => route === `/channels/${CHANNEL}/messages`,
    );
    expect(sent).toHaveLength(2);
    for (const [, options] of sent)
      expect(options?.body).toEqual(
        expect.objectContaining({ content: "hello" }),
      );
  });

  // Proves ordinary endpoints, shared channels, and attachment-only turns receive no memory controls.
  it.each([
    { enabled: false, type: ChannelType.DM, content: "plain endpoint" },
    { enabled: true, type: ChannelType.GuildText, content: "shared channel" },
    { enabled: true, type: ChannelType.DM, content: "" },
  ] as const)(
    "omits memory for $content",
    async ({ enabled, type, content }) => {
      const app = await runtime(type);
      app.add(1, { content });
      const requests: CapturedRequest[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          requests.push(JSON.parse(String(init.body)));
          return Response.json({
            choices: [{ message: { content: "hello" } }],
          });
        }),
      );
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        DISCORD_CLIENT_ID: BOT,
        REMORA_DM_ENABLED: String(enabled),
      });
      await respond({
        adapter: app.adapter,
        message: await app.message(1),
        botUserId: BOT,
        config,
        llm: new LlmClient(config),
        logger: app.logger,
        contextStore: app.store,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.remora).toBeUndefined();
      expect(requests[0]?.messages).toHaveLength(2);
    },
  );

  // Proves ignored extensions and misbound write receipts cannot masquerade as memory success.
  it.each(["missing", "wrong_source", "malformed_cache"] as const)(
    "rejects %s Remora metadata",
    async (failure) => {
      const app = await runtime();
      app.add(1);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const body: CapturedRequest = JSON.parse(String(init.body));
          if (!body.remora) throw new Error("Expected memory request");
          const metadata = memoryReceipt(body.remora);
          return Response.json({
            choices: [{ message: { content: "unverified response" } }],
            ...(failure === "missing"
              ? {}
              : {
                  remora: {
                    ...metadata,
                    ...(failure === "wrong_source"
                      ? {
                          writes: {
                            ...metadata.writes,
                            source_id: "another-source",
                          },
                        }
                      : {}),
                    ...(failure === "malformed_cache" ? { cache: null } : {}),
                  },
                }),
          });
        }),
      );
      const config = loadConfig({
        DISCORD_TOKEN: "test",
        DISCORD_CLIENT_ID: BOT,
        REMORA_DM_ENABLED: "true",
      });
      await respond({
        adapter: app.adapter,
        message: await app.message(1),
        botUserId: BOT,
        config,
        llm: new LlmClient(config),
        logger: app.logger,
        contextStore: app.store,
      });
      const sent = app.post.mock.calls.filter(
        ([route]) => route === `/channels/${CHANNEL}/messages`,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.[1]?.body).toEqual(
        expect.objectContaining({
          content: expect.stringContaining("brain fog"),
        }),
      );
    },
  );
});
