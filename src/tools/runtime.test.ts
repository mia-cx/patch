import { readFileSync } from "node:fs";
import { ChannelType, Client, ClientUser } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../actions/context.js";
import { registerDefaultActions } from "../actions/defaults.js";
import { createPatchActionRegistry } from "../actions/registry.js";
import { loadConfig } from "../config.js";
import { ConversationContextStore } from "../conversation/store.js";
import type { ConversationMessage } from "../conversation/types.js";
import {
  DiscordJsAdapter,
  toConversationMessage,
} from "../discord/discord-js-adapter.js";
import { LlmClient } from "../llm/client.js";
import { ModelCatalog } from "../llm/model-catalog.js";
import { parseRemoraCapabilities } from "../llm/remora.js";
import { createLogger } from "../logger.js";
import { RemoraMemoryClient } from "../memory/client.js";
import { GenerationQueue } from "../queue.js";
import { respond } from "../response/responder.js";
import { SettingsStore } from "../settings/store.js";
import { deliverFollowups } from "./followups.js";
import { HarnessStore } from "./store.js";
import { runToolTurn } from "./turn.js";
import { WebClient } from "./web.js";

const CHANNEL = "1000000000000000001";
const BOT = "1000000000000000002";
const HUMAN = "1000000000000000003";
const CURRENT = "1000000000000000004";
const PREVIOUS = "1000000000000000005";
const GUILD = "1000000000000000006";
const THREAD = "1000000000000000007";
const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

async function runtime(guild = false, remora = false) {
  const client = new Client<true>({ intents: [] });
  client.user = new Bot(client);
  const packet = (id = PREVIOUS, author = BOT, content = "old message") => ({
    id,
    channel_id: CHANNEL,
    ...(guild ? { guild_id: GUILD } : {}),
    type: 0,
    author: {
      id: author,
      username: author === BOT ? "Patch" : "Mia",
      discriminator: "0",
      avatar: null,
      bot: author === BOT,
    },
    content,
    timestamp: "2026-10-19T12:00:00Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    components: [],
  });
  const thread = {
    id: THREAD,
    guild_id: GUILD,
    parent_id: CHANNEL,
    type: ChannelType.PublicThread,
    name: "tangent",
    owner_id: BOT,
    thread_metadata: {
      archived: false,
      auto_archive_duration: 1440,
      archive_timestamp: "2026-10-19T12:00:00Z",
    },
  };
  const rest = {
    get: vi.spyOn(client.rest, "get").mockImplementation(async (route) => {
      if (route === `/guilds/${GUILD}`)
        return {
          id: GUILD,
          name: "test guild",
          owner_id: BOT,
          features: [],
          roles: [
            {
              id: GUILD,
              name: "@everyone",
              permissions: "8",
              position: 0,
              color: 0,
            },
          ],
          members: [
            {
              user: {
                id: BOT,
                username: "Patch",
                discriminator: "0",
                avatar: null,
                bot: true,
              },
              roles: [],
              joined_at: "2026-10-19T00:00:00Z",
              deaf: false,
              mute: false,
            },
          ],
          channels: [],
          emojis: [],
          stickers: [],
        };
      if (route === `/channels/${CHANNEL}`)
        return guild
          ? {
              id: CHANNEL,
              guild_id: GUILD,
              type: ChannelType.GuildText,
              name: "test",
              permission_overwrites: [],
            }
          : {
              id: CHANNEL,
              type: ChannelType.DM,
              recipients: [
                {
                  id: HUMAN,
                  username: "Mia",
                  discriminator: "0",
                  avatar: null,
                },
              ],
            };
      if (route === `/channels/${THREAD}`) return thread;
      if (route === `/channels/${CHANNEL}/messages/${CURRENT}`)
        return packet(CURRENT, HUMAN, "look that up");
      if (route === `/channels/${CHANNEL}/messages/${PREVIOUS}`)
        return packet();
      if (route === `/guilds/${GUILD}/emojis`)
        return [
          {
            id: "1000000000000000010",
            name: "happy",
            available: true,
            roles: [],
          },
        ];
      if (route === `/guilds/${GUILD}/stickers`)
        return [
          {
            id: "1000000000000000011",
            guild_id: GUILD,
            name: "wave",
            tags: "hi",
            type: 2,
            format_type: 1,
            available: true,
          },
        ];
      if (route === `/guilds/${GUILD}/stickers/1000000000000000011`)
        return {
          id: "1000000000000000011",
          guild_id: GUILD,
          name: "wave",
          tags: "hi",
          type: 2,
          format_type: 1,
          available: true,
        };
      if (route === `/guilds/${GUILD}/threads/active`)
        return { threads: [thread], members: [], has_more: false };
      throw new Error(`Unexpected SDK request: ${route}`);
    }),
    post: vi
      .spyOn(client.rest, "post")
      .mockImplementation(async (route) =>
        route.endsWith("/threads") ? thread : packet("1000000000000000020"),
      ),
    patch: vi.spyOn(client.rest, "patch").mockResolvedValue(packet()),
    put: vi.spyOn(client.rest, "put").mockResolvedValue(undefined),
    delete: vi.spyOn(client.rest, "delete").mockResolvedValue(undefined),
  };
  if (guild) await client.guilds.fetch(GUILD);
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased()) throw new Error("Fixture channel unavailable");
  const message = await channel.messages.fetch(CURRENT);
  const previous = await channel.messages.fetch(PREVIOUS);
  const config = loadConfig({
    DISCORD_TOKEN: "test",
    DISCORD_CLIENT_ID: BOT,
    LLM_TOOL_MODE: "tagged",
    LLM_BASE_URL: "http://remora.test/v1",
    REMORA_DM_ENABLED: String(remora),
  });
  const logger = createLogger(false);
  logger.level = "silent";
  const settings = new SettingsStore(":memory:", { llmModel: "test" });
  const contextStore = new ConversationContextStore(":memory:");
  const llm = new LlmClient(config);
  if (remora) llm.supportsTools = false;
  const store = new HarnessStore(":memory:");
  const web = new WebClient({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "A real fixture page.",
    }),
  });
  const context: ActionContext = {
    client,
    config,
    llm,
    logger,
    settings,
    contextStore,
    queue: new GenerationQueue(1),
    modelCatalog: new ModelCatalog(llm, logger),
    memory: new RemoraMemoryClient(config),
    harness: { store, web },
  };
  const registry = createPatchActionRegistry();
  registerDefaultActions(registry);
  resources.push(
    () => settings.close(),
    () => contextStore.close(),
    () => store.close(),
    () => {
      void client.destroy();
    },
  );
  const complete = vi.spyOn(llm, "complete");
  const run = (history?: ConversationMessage[]) =>
    respond({
      adapter: new DiscordJsAdapter(client, BOT),
      message,
      botUserId: BOT,
      config,
      llm,
      logger,
      contextStore,
      contextMessages: history ?? [
        toConversationMessage(previous, BOT),
        toConversationMessage(message, BOT),
      ],
      actionContext: context,
      actionRegistry: registry,
    });
  return { ...context, registry, message, complete, rest, run, store };
}

const call = (name: string, args: object) =>
  `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

describe("complete harness with the actual Discord SDK", () => {
  // Proves an opted-in shared conversation uses channel/server recall, never private extras, with source-bound roles and tools intact.
  it("uses shared banks and preserves speakers in the configured guild channel", async () => {
    const app = await runtime(true, true);
    app.config.discordTrialDmChannelId = "1000000000000000090";
    app.config.discordTrialGuild = { guildId: GUILD, channelId: CHANNEL };
    app.config.remoraReadBanks = ["discord:dm:private"];
    app.complete
      .mockResolvedValueOnce({
        content: call("web_fetch", { url: "https://example.com/" }),
      })
      .mockResolvedValueOnce({ content: "found that page" });
    const current = toConversationMessage(app.message, BOT);
    await app.run([
      {
        ...current,
        id: "1000000000000000008",
        authorId: "1000000000000000009",
        authorName: "Robin",
        content: "I play cello.",
      },
      {
        ...current,
        id: PREVIOUS,
        authorId: BOT,
        authorName: "Patch",
        authorIsBot: true,
        content: "that's cool",
      },
      current,
    ]);
    const first = app.complete.mock.calls[0]?.[0];
    expect(first?.remora).toEqual({
      read_banks: [`discord:channel:${CHANNEL}`, `discord:guild:${GUILD}`],
      write_bank: `discord:channel:${CHANNEL}`,
      turn: {
        id: `discord:message:${CURRENT}`,
        revision: 0,
        speaker_id: `discord:user:${HUMAN}`,
        text: "look that up",
      },
    });
    expect(first?.messages.at(-1)).toEqual({
      role: "user",
      content: "look that up",
    });
    expect(first?.messages).toContainEqual({
      role: "assistant",
      content: "that's cool",
    });
    expect(
      first?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes('author_id="1000000000000000009"') &&
          message.content.includes("I play cello."),
      ),
    ).toBe(true);
    const second = app.complete.mock.calls[1]?.[0];
    expect(second?.remora?.read_banks).toEqual(first?.remora?.read_banks);
    expect(second?.remora?.write_bank).toBeUndefined();
    expect(second?.remora?.turn).toBeUndefined();
    expect(
      second?.messages.some((message) =>
        message.content.includes("A real fixture page."),
      ),
    ).toBe(true);
    expect(
      app.rest.post.mock.calls.filter(([route]) => route.endsWith("/messages")),
    ).toHaveLength(1);
  });

  // Proves explicit recall returns qualified facts through the model loop without rewriting the human source or widening selected banks.
  it("searches caller-selected banks through Protocord and continues read-only", async () => {
    const app = await runtime(false, true);
    app.config.remoraReadBanks = ["place:extra"];
    const contract: {
      capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
    } = JSON.parse(
      readFileSync(
        new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
        "utf8",
      ),
    );
    await app.memory.initialize(
      parseRemoraCapabilities({
        ...contract.capabilities_example,
        features: {
          ...contract.capabilities_example.features,
          memory_search: true,
        },
        limits: {
          ...contract.capabilities_example.limits,
          max_search_results: 2,
          max_search_banks: 2,
          max_search_query_chars: 2048,
          max_search_query_tokens: 256,
        },
      }),
    );
    const bank = `discord:dm:${CHANNEL}`;
    const marker = `@{${"a".repeat(64)}}`;
    const hit = {
      bank,
      id: 2,
      text: `${marker} has a dog named Aster.`,
      kind: "fact",
      source: "user",
      subjects: { [marker]: { principal: "test", entity: "another-person" } },
      source_actor: {
        principal: "test",
        actor: { bank, role: "human", id: "original-speaker" },
      },
      score: 0.8,
    };
    const request = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        object: "remora.memory.search",
        version: 1,
        query: "dog ownership",
        read_banks: [bank, "place:extra"],
        data: [hit],
        revisions: { [bank]: "a".repeat(64), "place:extra": "b".repeat(64) },
      }),
    );
    vi.stubGlobal("fetch", request);
    app.complete
      .mockResolvedValueOnce({
        content: call("memory_search", { query: "dog ownership" }),
      })
      .mockResolvedValueOnce({ content: "found the ownership record" });
    await app.run();
    expect(request.mock.calls[0]).toEqual([
      "http://remora.test/v1/remora/memories/search",
      expect.objectContaining({ method: "POST" }),
    ]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1].body))).toEqual({
      query: "dog ownership",
      read_banks: [bank, "place:extra"],
      limit: 2,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const second = app.complete.mock.calls[1]?.[0];
    expect(app.complete.mock.calls[0]?.[0].remora?.turn?.text).toBe(
      "look that up",
    );
    expect(second?.remora?.turn).toBeUndefined();
    expect(second?.remora?.write_bank).toBeUndefined();
    expect(second?.messages.at(-1)).toEqual({
      role: "user",
      content: "look that up",
    });
    const results = second?.messages
      .find((message) => message.content.startsWith("Harness tool results"))
      ?.content.split("\n")
      .slice(1)
      .join("\n");
    expect(JSON.parse(results ?? "[]")[0]?.output.data).toEqual([hit]);
  });

  // Proves absent capability, absent scope and model-provided bank arguments cannot reach the recall endpoint.
  it.each(["disabled", "no_scope", "widen"] as const)(
    "blocks memory search for %s",
    async (failure) => {
      const app = await runtime(false, failure !== "no_scope");
      const contract: {
        capabilities_example: ReturnType<typeof parseRemoraCapabilities>;
      } = JSON.parse(
        readFileSync(
          new URL(
            "../../spec/fixtures/remora-contract-v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await app.memory.initialize(
        parseRemoraCapabilities({
          ...contract.capabilities_example,
          features: {
            ...contract.capabilities_example.features,
            memory_search: failure !== "disabled",
          },
          limits: {
            ...contract.capabilities_example.limits,
            max_search_results: 2,
            max_search_banks: 2,
            max_search_query_chars: 2048,
            max_search_query_tokens: 256,
          },
        }),
      );
      const request = vi.fn();
      vi.stubGlobal("fetch", request);
      app.complete.mockResolvedValue({
        content: call("memory_search", {
          query: "dog ownership",
          ...(failure === "widen"
            ? { read_banks: ["another-persons-bank"] }
            : {}),
        }),
      });
      await app.run();
      expect(request).not.toHaveBeenCalled();
    },
  );
  // Proves plain model output stays ordinary in guilds, while explicit replies target the selected message without pinging.
  it.each([false, true])(
    "opts into a reply only when requested: %s",
    async (reply) => {
      const app = await runtime(true);
      app.complete.mockResolvedValue({
        content: `${reply ? `<reply to="${PREVIOUS}" />\n` : ""}yeah, exactly`,
      });
      await app.run();
      const sent = app.rest.post.mock.calls.find(
        ([route]) => route === `/channels/${CHANNEL}/messages`,
      );
      expect(sent?.[1]?.body).toMatchObject({
        content: "yeah, exactly",
        allowed_mentions: { replied_user: false },
        enforce_nonce: true,
        nonce: expect.any(String),
      });
      if (reply)
        expect(sent?.[1]?.body).toHaveProperty(
          "message_reference.message_id",
          PREVIOUS,
        );
      else
        expect(JSON.parse(JSON.stringify(sent?.[1]?.body))).not.toHaveProperty(
          "message_reference",
        );
    },
  );

  // Proves reaction-only turns preserve emoji, send no extra text, and retry without a second Discord mutation.
  it("reacts silently and replays an already completed action", async () => {
    const app = await runtime();
    app.complete.mockResolvedValue({
      content: call("react", { message_id: CURRENT, emoji: "😂" }),
    });
    await app.run();
    await app.run();
    expect(app.rest.put).toHaveBeenCalledTimes(1);
    expect(app.rest.put.mock.calls[0]?.[0]).toContain("%F0%9F%98%82");
    expect(
      app.rest.post.mock.calls.filter(([route]) => route.endsWith("/messages")),
    ).toHaveLength(0);
  });

  // Proves authorship protection remains in force even when a model requests an edit.
  it("refuses editing a human message and can delete Patch's own visible message", async () => {
    const app = await runtime();
    app.complete
      .mockResolvedValueOnce({
        content: call("edit_message", {
          message_id: CURRENT,
          text: "rewritten",
        }),
      })
      .mockResolvedValueOnce({ content: "i can't edit your message" });
    await app.run();
    expect(app.rest.patch).not.toHaveBeenCalled();
    app.complete.mockResolvedValue({
      content: call("delete_message", { message_id: PREVIOUS }),
    });
    await app.run();
    expect(app.rest.delete).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/messages/${PREVIOUS}`,
    );
  });

  // Proves native tool selection receives properly paired native result messages.
  it("continues native read tools with their exact call IDs", async () => {
    const app = await runtime();
    app.config.llmToolMode = "native";
    app.complete
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "call-real-id",
            type: "function",
            name: "web_fetch",
            arguments: '{"url":"https://example.com/"}',
          },
        ],
      })
      .mockResolvedValueOnce({ content: "found it" });
    await app.run();
    const messages = app.complete.mock.calls[1]?.[0].messages;
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call-real-id" })],
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-real-id",
        content: expect.stringContaining("A real fixture page."),
      }),
    );
  });

  // Proves an uncertain mutation cannot repeat even when generation for the same turn is retried.
  it("reports uncertain reactions without repeating the Discord request", async () => {
    const app = await runtime();
    app.rest.put.mockRejectedValue(
      new Error("connection closed after acceptance"),
    );
    const reaction = call("react", { message_id: CURRENT, emoji: "😂" });
    app.complete
      .mockResolvedValueOnce({ content: reaction })
      .mockResolvedValueOnce({ content: "couldn't confirm that reaction" })
      .mockResolvedValueOnce({ content: reaction })
      .mockResolvedValueOnce({ content: "still can't confirm it" });
    await app.run();
    await app.run();
    expect(app.rest.put).toHaveBeenCalledTimes(1);
    expect(
      app.complete.mock.calls[3]?.[0].messages.some((message) =>
        message.content.includes("uncertain"),
      ),
    ).toBe(true);
  });

  // Proves a cancellation arriving during target lookup prevents the later Discord mutation.
  it("does not react after cancellation during channel lookup", async () => {
    const app = await runtime();
    const controller = new AbortController();
    const channel = await app.client.channels.fetch(CHANNEL);
    vi.spyOn(app.client.channels, "fetch").mockImplementation(async () => {
      controller.abort();
      return channel;
    });
    await expect(
      runToolTurn({
        messages: [{ role: "user", content: "react" }],
        generate: async () => ({
          content: call("react", { message_id: CURRENT, emoji: "😂" }),
        }),
        registry: app.registry,
        context: app,
        message: app.message,
        visibleMessageIds: new Set([CURRENT]),
        allowedTools: new Set(["react"]),
        maxCalls: 1,
        maxInputChars: 16_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(app.rest.put).not.toHaveBeenCalled();
  });

  // Proves long native tool arguments cannot accumulate beyond the advertised context budget.
  it("prunes completed native exchanges before their arguments overflow context", async () => {
    const app = await runtime();
    app.config.llmToolMode = "native";
    app.config.llmContextTokens = 16_384;
    app.config.llmMaxTokens = 2048;
    const sizes: number[] = [];
    const callIds: string[][] = [];
    let turn = 0;
    app.complete.mockImplementation(async (request) => {
      sizes.push(
        Math.ceil(
          (request.messages.reduce(
            (sum, message) =>
              sum +
              message.content.length +
              JSON.stringify(message.tool_calls ?? []).length,
            0,
          ) +
            JSON.stringify(request.tools).length) /
            4,
        ) +
          1024 +
          2048,
      );
      callIds.push(
        request.messages.flatMap(
          (message) => message.tool_calls?.map((call) => call.id) ?? [],
        ),
      );
      turn++;
      return turn > 3
        ? { content: "saved the notes" }
        : {
            content: "",
            toolCalls: [
              {
                id: `write-${turn}`,
                type: "function",
                name: "scratch_write",
                arguments: JSON.stringify({
                  path: `note-${turn}.md`,
                  text: "x".repeat(6000),
                  expected_revision: null,
                }),
              },
            ],
          };
    });
    await app.run();
    expect(app.complete).toHaveBeenCalledTimes(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(16_384);
    expect(callIds[3]?.length).toBeLessThan(3);
    expect(app.store.listNotes(CHANNEL)).toHaveLength(3);
  });

  // Proves successful edits preserve text but cannot ping users or roles through it.
  it("edits its own visible message without enabling mentions", async () => {
    const app = await runtime();
    app.complete.mockResolvedValue({
      content: call("edit_message", {
        message_id: PREVIOUS,
        text: "fixed @everyone",
      }),
    });
    await app.run();
    expect(app.rest.patch).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/messages/${PREVIOUS}`,
      expect.objectContaining({
        body: expect.objectContaining({
          content: "fixed @everyone",
          allowed_mentions: expect.objectContaining({ parse: [] }),
        }),
      }),
    );
  });

  // Proves a bad second action cannot cause the first action to execute from a partially accepted batch.
  it("rejects a forged tool batch before its first side effect", async () => {
    const app = await runtime();
    app.complete.mockResolvedValue({
      content:
        call("react", { message_id: CURRENT, emoji: "😂" }) +
        call("not_registered", {}),
    });
    await app.run();
    expect(app.rest.put).not.toHaveBeenCalled();
  });

  // Proves web/notes round trips preserve exactly one raw human source and every continuation is read-only.
  it("uses fetched data and persistent notes without re-writing the human source", async () => {
    const app = await runtime(false, true);
    app.complete
      .mockResolvedValueOnce({
        content: call("web_fetch", { url: "https://example.com/" }),
      })
      .mockResolvedValueOnce({
        content: call("scratch_write", {
          path: "research.md",
          text: "A real fixture page.",
          expected_revision: null,
        }),
      })
      .mockResolvedValueOnce({ content: "found it" });
    await app.run();
    expect(app.complete).toHaveBeenCalledTimes(3);
    const requests = app.complete.mock.calls.map(([request]) => request);
    expect(requests[0]?.remora?.turn?.text).toBe("look that up");
    for (const request of requests.slice(1)) {
      expect(request.remora?.write_bank).toBeUndefined();
      expect(request.remora?.turn).toBeUndefined();
      expect(request.remora?.speaker).toEqual({
        bank: `discord:dm:${CHANNEL}`,
        id: `discord:user:${HUMAN}`,
      });
      expect(request.messages.at(-1)).toEqual({
        role: "user",
        content: "look that up",
      });
      expect(
        request.messages.filter((m) => m.content === "look that up"),
      ).toHaveLength(1);
      expect(request.tools).toEqual([]);
    }
    expect(app.store.readNote(CHANNEL, "research.md").text).toBe(
      "A real fixture page.",
    );
    expect(
      app.rest.post.mock.calls.find(([route]) =>
        route.endsWith("/messages"),
      )?.[1]?.body,
    ).toMatchObject({
      content: expect.stringContaining("https://example.com/"),
    });
  });

  // Proves classifier-supplied history still reserves space for the actual tool catalogue and results.
  it("rolls supplied history forward when tool instructions fill its budget", async () => {
    const app = await runtime(false, true);
    app.config.llmContextTokens = 12_288;
    app.config.llmMaxTokens = 256;
    const current = toConversationMessage(app.message, BOT);
    app.complete.mockResolvedValue({ content: "hey" });
    await app.run([
      {
        ...current,
        id: "1000000000000000000",
        content: `OLD_HISTORY ${"x".repeat(6000)}`,
      },
      current,
    ]);
    expect(
      app.complete.mock.calls[0]?.[0].messages.some((message) =>
        message.content.includes("OLD_HISTORY"),
      ),
    ).toBe(false);
    expect(app.contextStore.getStart(CHANNEL)).toBe(CURRENT);
  });

  // Proves server threads, native polls, asset reads and stickers actually cross the SDK action seam.
  it("runs the approved group actions through Protocord", async () => {
    const app = await runtime(true);
    app.config.maxToolCalls = 5;
    app.complete.mockResolvedValueOnce({
      content: call("start_thread", { message_id: CURRENT, name: "tangent" }),
    });
    await app.run();
    expect(app.rest.post).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/messages/${CURRENT}/threads`,
      expect.objectContaining({
        body: expect.objectContaining({ name: "tangent" }),
      }),
    );
    app.complete.mockResolvedValueOnce({
      content: call("create_poll", {
        question: "Which one?",
        answers: ["A", "B"],
        duration_hours: 1,
      }),
    });
    await app.run();
    expect(
      app.rest.post.mock.calls.some(
        ([, options]) =>
          options?.body &&
          typeof options.body === "object" &&
          "poll" in options.body,
      ),
    ).toBe(true);
    app.complete
      .mockResolvedValueOnce({ content: call("channel_assets", {}) })
      .mockResolvedValueOnce({
        content: call("send_sticker", { sticker_id: "1000000000000000011" }),
      });
    await app.run();
    expect(
      app.rest.post.mock.calls.some(
        ([, options]) =>
          options?.body &&
          typeof options.body === "object" &&
          "sticker_ids" in options.body,
      ),
    ).toBe(true);
  });

  // Proves retries inside the Discord SDK can deduplicate every tool-created message using a stable enforced nonce.
  it.each([
    [
      "create_poll",
      { question: "Which one?", answers: ["A", "B"], duration_hours: 1 },
    ],
    [
      "start_thread",
      { message_id: CURRENT, name: "tangent", text: "over here" },
    ],
    ["send_sticker", { sticker_id: "1000000000000000011" }],
  ])("deduplicates SDK message retries for %s", async (name, args) => {
    const nonces: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const app = await runtime(true);
      app.complete.mockResolvedValue({ content: call(String(name), args) });
      await app.run();
      const sent = app.rest.post.mock.calls.find(([route]) =>
        route.endsWith("/messages"),
      );
      expect(sent?.[1]?.body).toMatchObject({
        enforce_nonce: true,
        nonce: expect.stringMatching(/^[a-f0-9]{25}$/),
      });
      const body = sent?.[1]?.body;
      nonces.push(
        body && typeof body === "object" && "nonce" in body ? body.nonce : null,
      );
    }
    expect(nonces[1]).toBe(nonces[0]);
  });

  // Proves escaping-heavy tool data stays within the serialized result budget, preserving the latest read in either protocol.
  it.each([false, true])(
    "bounds escaped tool results in native mode %s",
    async (native) => {
      const app = await runtime();
      app.config.llmToolMode = native ? "native" : "tagged";
      const text = '\\"'.repeat(2000);
      app.store.writeNote(CHANNEL, "large.md", text, null);
      const args = { path: "large.md" };
      const observed: Array<string | undefined> = [];
      let calls = 0;
      app.complete.mockImplementation(async (request) => {
        if (calls > 0)
          observed.push(
            native
              ? `[${request.messages
                  .filter((message) => message.role === "tool")
                  .map((message) => message.content)
                  .join(",")}]`
              : request.messages
                  .find((message) =>
                    message.content.startsWith("Harness tool results"),
                  )
                  ?.content.split("\n")
                  .slice(1)
                  .join("\n"),
          );
        calls++;
        if (calls === 4) return { content: "read it" };
        return native
          ? {
              content: "",
              toolCalls: [
                {
                  id: `call-escape-${calls}`,
                  type: "function",
                  name: "scratch_read",
                  arguments: JSON.stringify(args),
                },
              ],
            }
          : { content: call("scratch_read", args) };
      });
      await app.run();
      expect(app.complete).toHaveBeenCalledTimes(4);
      for (const serialized of observed) {
        expect(serialized).toBeDefined();
        expect(serialized?.length).toBeLessThanOrEqual(6000);
        const results = JSON.parse(serialized ?? "[]");
        expect(results.at(-1)?.output_excerpt).toContain("\\");
        if (results.length > 1)
          expect(results[0]).toEqual({
            name: "scratch_read",
            completed: true,
            truncated: true,
          });
      }
    },
  );

  // Proves pruning old result data cannot turn an uncertain action into a success receipt.
  it("keeps failures visible when older result data is pruned", async () => {
    const app = await runtime();
    app.store.writeNote(CHANNEL, "large.md", '\\"'.repeat(2000), null);
    app.rest.put.mockRejectedValue(
      new Error("connection closed after acceptance"),
    );
    app.complete
      .mockResolvedValueOnce({
        content: call("react", { message_id: CURRENT, emoji: "😂" }),
      })
      .mockResolvedValueOnce({
        content: call("scratch_read", { path: "large.md" }),
      })
      .mockResolvedValueOnce({ content: "read it; the reaction is uncertain" });
    await app.run();
    const data = app.complete.mock.calls[2]?.[0].messages
      .find((message) => message.content.startsWith("Harness tool results"))
      ?.content.split("\n")
      .slice(1)
      .join("\n");
    expect(JSON.parse(data ?? "[]")[0]).toEqual({
      name: "react",
      completed: false,
      truncated: true,
      error: "connection closed after acceptance",
    });
  });

  // Proves scheduled text delivers once without another model call.
  it.each([false, true])(
    "delivers a scoped durable follow-up once, guild=%s",
    async (guild) => {
      const app = await runtime(guild);
      app.config.discordTrialDmChannelId = guild
        ? "1000000000000000090"
        : CHANNEL;
      app.config.discordTrialGuild = {
        guildId: GUILD,
        channelId: guild ? CHANNEL : "1000000000000000091",
      };
      app.store.schedule(CHANNEL, 2000, "checking in", 1000);
      app.store.schedule("1000000000000000092", 2000, "out of scope", 1000);
      await deliverFollowups(app);
      await deliverFollowups(app);
      expect(
        app.rest.post.mock.calls.filter(([route]) =>
          route.endsWith("/messages"),
        ),
      ).toHaveLength(1);
      expect(app.complete).not.toHaveBeenCalled();
      expect(app.store.followups(CHANNEL)).toEqual([]);
    },
  );
});
