import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIMessage, ChannelType, Client, MessageType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { DiscordJsAdapter } from "../discord/discord-js-adapter.js";
import { LlmClient, type LlmMessage } from "../llm/client.js";
import type { RemoraRequest, RemoraResponse } from "../llm/remora.js";
import { createLogger } from "../logger.js";
import { respond } from "../response/responder.js";
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
  return {
    id: String(1000000000000000100n + BigInt(index)),
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
    timestamp: new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString(),
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

async function runtime(
  type:
    | ChannelType.DM
    | ChannelType.GuildText
    | ChannelType.PublicThread = ChannelType.DM,
  path = ":memory:",
) {
  const client = new Client<true>({ intents: [] });
  let packets: APIMessage[] = [];
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
      if (route === `/channels/${CHANNEL}`)
        return {
          id: CHANNEL,
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
      if (route === `/channels/${CHANNEL}/messages`) {
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
        (item) => route === `/channels/${CHANNEL}/messages/${item.id}`,
      );
      if (message) return message;
      throw new Error(`Unexpected Discord request: ${route}`);
    });
  const post = vi
    .spyOn(client.rest, "post")
    .mockImplementation(async (route) => {
      if (route === `/channels/${CHANNEL}/typing`) return undefined;
      if (route === `/channels/${CHANNEL}/messages`) {
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
  if (type !== ChannelType.DM) await client.guilds.fetch(GUILD);
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error("Fixture must support messages");
  const adapter = new DiscordJsAdapter(client, BOT);
  const logger = createLogger(false);
  logger.level = "silent";

  const message = async (index: number) => {
    return channel.messages.fetch({ message: packet(index).id, force: true });
  };
  return {
    adapter,
    logger,
    rest,
    post,
    message,
    get store() {
      return store;
    },
    add(index: number, overrides: Partial<APIMessage> = {}) {
      packets.push(packet(index, overrides));
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
