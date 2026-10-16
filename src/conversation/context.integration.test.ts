import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIMessage, ChannelType, Client, MessageType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { DiscordJsAdapter } from "../discord/discord-js-adapter.js";
import { LlmClient } from "../llm/client.js";
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
  vi.spyOn(client.rest, "post").mockImplementation(async (route) => {
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
