import { readFileSync } from "node:fs";
import {
  type APIApplicationCommandAutocompleteInteraction,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  ClientApplication,
  ClientUser,
  InteractionContextType,
  InteractionResponseType,
  InteractionType,
  Locale,
  MessageFlags,
  MessageType,
  PermissionsBitField,
} from "discord.js";
import { getDiscordCommandRegistration } from "protocord";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evidenceCapabilities,
  makeEvidenceRecord,
} from "../../test/fixtures/evidence.js";
import { loadConfig } from "../config.js";
import { ConversationContextStore } from "../conversation/store.js";
import { dispatchInteraction } from "../discord/actions/dispatch.js";
import { LlmClient } from "../llm/client.js";
import { ModelCatalog } from "../llm/model-catalog.js";
import { parseRemoraCapabilities } from "../llm/remora.js";
import { createLogger } from "../logger.js";
import { RemoraMemoryClient } from "../memory/client.js";
import { GenerationQueue } from "../queue.js";
import { SettingsStore } from "../settings/store.js";
import { buildModelVisibleActions, toLlmTools } from "./action-context.js";
import type { ActionContext } from "./context.js";
import { registerDefaultActions } from "./defaults.js";
import { createPatchActionRegistry } from "./registry.js";
import { selfAction } from "./self.js";
import { dispatchToolCall } from "./tool-calls.js";

const CHANNEL = "1000000000000000001";
const GUILD = "1000000000000000002";
const BOT = "1000000000000000003";
const OWNER = "1000000000000000004";
const MEMBER = "1000000000000000005";
const MESSAGE = "1000000000000000006";
const resources: (() => void)[] = [];
afterEach(() => {
  for (const close of resources.splice(0)) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const managementFixture: {
  memory_management: { examples: { capabilities_with_management: unknown } };
} = JSON.parse(
  readFileSync(
    new URL("../../spec/fixtures/remora-contract-v1.json", import.meta.url),
    "utf8",
  ),
);
const managementCaps = parseRemoraCapabilities(
  managementFixture.memory_management.examples.capabilities_with_management,
);
const READ_ACCESS =
  PermissionsBitField.Flags.ViewChannel |
  PermissionsBitField.Flags.ReadMessageHistory;
const REVISION = "a".repeat(64);

function memoryOptions(
  operation: "list" | "forget" | "clear",
  scope: "personal" | "channel" | "server",
  ids = "5, 2",
  confirm = true,
): APIApplicationCommandInteractionDataOption[] {
  return [
    {
      name: operation,
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        ...(operation === "forget"
          ? [
              {
                type: ApplicationCommandOptionType.String as const,
                name: "ids",
                value: ids,
              },
            ]
          : []),
        ...(operation === "clear"
          ? [
              {
                type: ApplicationCommandOptionType.Boolean as const,
                name: "confirm",
                value: confirm,
              },
            ]
          : []),
        {
          type: ApplicationCommandOptionType.String,
          name: "scope",
          value: scope,
        },
      ],
    },
  ];
}

// Discord constructs these from gateway packets. Subclasses expose the SDK's
// protected constructor so the tests exercise its real parsing and responses.
class Command extends ChatInputCommandInteraction {
  // biome-ignore lint/complexity/noUselessConstructor: expose the SDK's protected gateway constructor
  constructor(
    client: Client<true>,
    data: APIChatInputApplicationCommandInteraction,
  ) {
    super(client, data);
  }
}
class Autocomplete extends AutocompleteInteraction {
  // biome-ignore lint/complexity/noUselessConstructor: expose the SDK's protected gateway constructor
  constructor(
    client: Client<true>,
    data: APIApplicationCommandAutocompleteInteraction,
  ) {
    super(client, data);
  }
}

class BotUser extends ClientUser {
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

async function runtime(thread = true) {
  const client = new Client<true>({ intents: [] });
  client.user = new BotUser(client);
  const botMessage = {
    id: "1000000000000000007",
    channel_id: CHANNEL,
    author: { id: BOT, username: "Patch", discriminator: "0", avatar: null },
    type: MessageType.Default,
    content: "previous bot message",
    timestamp: "2026-10-16T10:00:00Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    components: [],
  };
  const rest = {
    get: vi.spyOn(client.rest, "get").mockImplementation(async (route) => {
      if (route === `/guilds/${GUILD}`)
        return {
          id: GUILD,
          name: "test guild",
          owner_id: OWNER,
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
          guild_id: GUILD,
          type: thread ? ChannelType.PublicThread : ChannelType.GuildText,
          name: "trial",
          owner_id: OWNER,
          parent_id: "1000000000000000008",
          thread_metadata: {
            archived: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-10-16T10:00:00Z",
          },
        };
      if (route === `/channels/${CHANNEL}/messages/${MESSAGE}`)
        return {
          ...botMessage,
          id: MESSAGE,
          content: "please leave",
          author: {
            id: OWNER,
            username: "Mia",
            discriminator: "0",
            avatar: null,
          },
        };
      if (route === `/channels/${CHANNEL}/messages`) return [botMessage];
      throw new Error(`Unexpected Discord request: ${route}`);
    }),
    post: vi.spyOn(client.rest, "post").mockResolvedValue(botMessage),
    patch: vi.spyOn(client.rest, "patch").mockResolvedValue(botMessage),
    delete: vi.spyOn(client.rest, "delete").mockResolvedValue(undefined),
  };
  await client.guilds.fetch(GUILD);
  const channel = await client.channels.fetch(CHANNEL);
  if (!channel?.isTextBased())
    throw new Error("Fixture channel must support messages");
  const message = await channel.messages.fetch(MESSAGE);
  const channelType = channel.type;
  const config = loadConfig({
    DISCORD_TOKEN: "test",
    DISCORD_CLIENT_ID: BOT,
    BOT_OWNER_USER_IDS: OWNER,
  });
  const logger = createLogger(false);
  logger.level = "silent";
  const settings = new SettingsStore(":memory:", { llmModel: "old-model" });
  const contextStore = new ConversationContextStore(":memory:");
  resources.push(
    () => settings.close(),
    () => contextStore.close(),
    () => {
      void client.destroy();
    },
  );
  const llm = new LlmClient(config, settings);
  const context: ActionContext = {
    client: { channels: client.channels, user: { id: BOT } },
    config,
    logger,
    settings,
    contextStore,
    llm,
    memory: new RemoraMemoryClient(config),
    queue: new GenerationQueue(1),
    modelCatalog: new ModelCatalog(llm, logger),
  };
  const registry = createPatchActionRegistry();
  registerDefaultActions(registry);
  function packet(userId = OWNER, permission = 0n) {
    const user = {
      id: userId,
      username: "human",
      global_name: null,
      discriminator: "0",
      avatar: null,
    };
    return {
      id: "1000000000000000009",
      application_id: BOT,
      token: "test-token",
      version: 1 as const,
      channel: { id: CHANNEL, type: channelType },
      channel_id: CHANNEL,
      guild_id: GUILD,
      user,
      member: {
        user,
        roles: [],
        joined_at: "2026-10-16T10:00:00Z",
        deaf: false,
        mute: false,
        flags: 0,
        permissions: `${permission}`,
      },
      locale: Locale.EnglishUS,
      app_permissions: "0",
      entitlements: [],
      authorizing_integration_owners: {},
      attachment_size_limit: 1000000,
    };
  }
  function command(
    name: string,
    options: APIApplicationCommandInteractionDataOption[] = [],
    user = OWNER,
    permissions = 0n,
  ) {
    return new Command(client, {
      ...packet(user, permissions),
      type: InteractionType.ApplicationCommand,
      data: {
        id: "1000000000000000010",
        name,
        type: ApplicationCommandType.ChatInput,
        options,
      },
    });
  }
  const dispatch = (
    interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  ) => dispatchInteraction({ registry, context, interaction });
  return {
    client,
    context,
    registry,
    message,
    rest,
    command,
    packet,
    dispatch,
  };
}

describe("Patch's Protocord integration", () => {
  // Proves the same numeric ID is displayed as two distinct storage kinds, privately and with source voice preserved.
  it("lists facts and evidence through their separate routes", async () => {
    const app = await runtime(false);
    const bank = `discord:guild:${GUILD}`;
    await app.context.memory.initialize(
      parseRemoraCapabilities(evidenceCapabilities),
    );
    const request = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get("bank")).toBe(bank);
      return Response.json(
        url.includes("/evidence?")
          ? {
              object: "remora.evidence.list",
              version: 1,
              bank,
              revision: REVISION,
              data: [makeEvidenceRecord(bank)],
              next_cursor: null,
            }
          : {
              object: "remora.memory.list",
              version: 1,
              bank,
              revision: REVISION,
              data: [
                {
                  id: 1,
                  text: "A canonical statement.",
                  kind: "fact",
                  source: "user",
                  subjects: {},
                },
              ],
              next_cursor: null,
            },
      );
    });
    vi.stubGlobal("fetch", request);
    await app.dispatch(
      app.command(
        "memory",
        memoryOptions("list", "server"),
        MEMBER,
        READ_ACCESS,
      ),
    );
    const body = app.rest.patch.mock.calls.at(-1)?.[1]?.body;
    expect(body).toMatchObject({
      content: expect.stringContaining("fact #1"),
      allowed_mentions: { parse: [], replied_user: false },
    });
    expect(body).toMatchObject({
      content: expect.stringContaining('#1 "my dog"'),
    });
    expect(app.rest.post.mock.calls[0]?.[1]?.body).toMatchObject({
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  // Proves a web memory shows its page URL inline while the attached file keeps every source and context.
  it("lists a web memory with its URL and exports its full provenance", async () => {
    const app = await runtime(false);
    const bank = `discord:guild:${GUILD}`;
    await app.context.memory.initialize(
      parseRemoraCapabilities(evidenceCapabilities),
    );
    const seed = makeEvidenceRecord(bank);
    const record = {
      ...seed,
      source: {
        ...seed.source,
        origin: "external_observation",
        actor: null,
        tool: "web_fetch",
        url: "https://page.test/release",
      },
      context: [
        {
          text: "context",
          span: { start: 0, end: 7 },
          source_digest: "b".repeat(64),
          source: {
            ...seed.source,
            id: "search:1",
            origin: "external_observation",
            actor: null,
            tool: "web_search",
            url: "https://search.test/source",
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "remora.evidence.list",
          version: 1,
          bank,
          revision: REVISION,
          data: [record],
          next_cursor: null,
        }),
      ),
    );
    await app.dispatch(
      app.command(
        "memory",
        [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "list",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "scope",
                value: "server",
              },
              {
                type: ApplicationCommandOptionType.String,
                name: "kind",
                value: "evidence",
              },
            ],
          },
        ],
        MEMBER,
        READ_ACCESS,
      ),
    );
    const response = app.rest.patch.mock.calls.at(-1)?.[1];
    expect(response?.body).toMatchObject({
      content: expect.stringContaining("https://page.test/release"),
      allowed_mentions: { parse: [], replied_user: false },
    });
    expect(response?.files).toHaveLength(1);
    const file = response?.files?.[0];
    expect(file?.name).toBe("memories.json");
    if (!file || !Buffer.isBuffer(file.data))
      throw new Error("Missing complete evidence export");
    expect(JSON.parse(file.data.toString("utf8"))).toEqual({
      statements: [],
      evidence: [record],
    });
  });

  // Proves evidence deletion and source deletion retain Discord management gates and the principal-wide generation fence.
  it.each(["record", "source", "unauthorized_source"] as const)(
    "handles evidence %s with scoped erasure",
    async (scenario) => {
      const app = await runtime(false);
      const bank = `discord:channel:${CHANNEL}`;
      app.context.contextStore.setStart(CHANNEL, "1");
      app.context.contextStore.recordMemoryContext(CHANNEL);
      await app.context.memory.initialize(
        parseRemoraCapabilities(evidenceCapabilities),
      );
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push(url);
          if (init.method !== "POST")
            return Response.json({
              object: "remora.evidence.list",
              version: 1,
              bank,
              revision: REVISION,
              data: [makeEvidenceRecord(bank)],
              next_cursor: null,
            });
          expect(app.context.contextStore.allowsMessage(CHANNEL, "1")).toBe(
            false,
          );
          const source = scenario !== "record";
          expect(JSON.parse(String(init.body))).toEqual({
            bank,
            request_id: "1000000000000000009",
            expected_revision: REVISION,
            ...(source ? { id: 1 } : { ids: [1] }),
          });
          return Response.json({
            object: "remora.evidence.mutation",
            version: 1,
            bank,
            request_id: "1000000000000000009",
            operation: source ? "forget_source" : "forget",
            replayed: false,
            deleted_ids: [1],
            deleted_count: 1,
            dependent_suppression: {
              bank,
              visible_active_count: 0,
              ...(source ? { ids: [] } : {}),
            },
            revision: REVISION,
            cache_invalidated: true,
            reset_required: true,
          });
        }),
      );
      const options: APIApplicationCommandInteractionDataOption[] = [
        {
          name: scenario === "record" ? "forget" : "forget-source",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "scope",
              type: ApplicationCommandOptionType.String,
              value: "channel",
            },
            ...(scenario === "record"
              ? [
                  {
                    name: "ids",
                    type: ApplicationCommandOptionType.String as const,
                    value: "1",
                  },
                  {
                    name: "kind",
                    type: ApplicationCommandOptionType.String as const,
                    value: "evidence",
                  },
                ]
              : [
                  {
                    name: "id",
                    type: ApplicationCommandOptionType.Integer as const,
                    value: 1,
                  },
                ]),
          ],
        },
      ];
      await app.dispatch(
        app.command(
          "memory",
          options,
          MEMBER,
          READ_ACCESS |
            (scenario === "unauthorized_source"
              ? 0n
              : PermissionsBitField.Flags.ManageMessages),
        ),
      );
      if (scenario === "unauthorized_source") {
        expect(calls).toEqual([]);
        expect(app.context.contextStore.getStart(CHANNEL)).toBe("1");
      } else {
        expect(calls).toHaveLength(2);
        expect(calls.every((url) => url.includes("/remora/evidence"))).toBe(
          true,
        );
        expect(calls[1]).toMatch(
          scenario === "record"
            ? /\/evidence\/forget$/
            : /\/evidence\/forget-source$/,
        );
        expect(app.context.contextStore.getStart(CHANNEL)).toBeUndefined();
        expect(app.rest.patch.mock.calls.at(-1)?.[1]?.body).toMatchObject({
          content: expect.stringContaining("forgot 1 memory"),
        });
      }
    },
  );

  // Proves invalid user-supplied targets stop before management requests or context resets.
  it.each(["0", "1.5", "1e2", "9007199254740992", "2,2"])(
    "refuses malformed memory IDs %s",
    async (ids) => {
      const app = await runtime(false);
      app.context.contextStore.setStart(CHANNEL, MESSAGE);
      const fetch = vi.fn(async () => Response.json(managementCaps));
      vi.stubGlobal("fetch", fetch);
      await app.dispatch(
        app.command(
          "memory",
          memoryOptions("forget", "channel", ids),
          MEMBER,
          READ_ACCESS | PermissionsBitField.Flags.ManageMessages,
        ),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/remora/capabilities"),
        expect.anything(),
      );
      expect(app.context.contextStore.getStart(CHANNEL)).toBe(MESSAGE);
      expect(app.rest.patch).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            content: expect.stringContaining("whole-number IDs"),
          }),
        }),
      );
    },
  );

  // Proves an ordinary member can inspect a readable server bank without clipping long facts.
  it("exports complete server memories privately when the list exceeds a Discord message", async () => {
    const app = await runtime(false);
    const data = [
      {
        id: 2,
        text: "Long fictional evidence. ".repeat(200),
        kind: "fact",
        source: "user",
        subjects: {},
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/capabilities")) return Response.json(managementCaps);
        expect(new URL(url).searchParams.get("bank")).toBe(
          `discord:guild:${GUILD}`,
        );
        return Response.json({
          object: "remora.memory.list",
          version: 1,
          bank: `discord:guild:${GUILD}`,
          revision: REVISION,
          data,
          next_cursor: null,
        });
      }),
    );
    await app.dispatch(
      app.command(
        "memory",
        memoryOptions("list", "server"),
        MEMBER,
        READ_ACCESS,
      ),
    );
    const file = app.rest.patch.mock.calls.at(-1)?.[1]?.files?.[0];
    expect(file?.name).toBe("memories.json");
    expect(file?.data.toString()).toBe(JSON.stringify(data, null, 2));
    expect(app.rest.post).toHaveBeenCalledTimes(1);
    expect(app.rest.post.mock.calls[0]?.[1]?.body).toMatchObject({
      data: { flags: MessageFlags.Ephemeral },
    });
  });

  // Proves a private guild invocation resolves only the caller's own bank and never posts memory content publicly.
  it("inspects personal memories from a guild through the actual SDK's own-DM lookup", async () => {
    const app = await runtime(false);
    const dm = "1000000000000000020";
    app.rest.post.mockImplementation(async (route) => {
      if (route === "/users/@me/channels")
        return {
          id: dm,
          type: ChannelType.DM,
          recipients: [
            {
              id: MEMBER,
              username: "member",
              discriminator: "0",
              avatar: null,
            },
          ],
        };
      return undefined;
    });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/capabilities")) return Response.json(managementCaps);
      expect(new URL(url).searchParams.get("bank")).toBe(
        `discord:user:${MEMBER}`,
      );
      return Response.json({
        object: "remora.memory.list",
        version: 1,
        bank: `discord:user:${MEMBER}`,
        revision: REVISION,
        data: [
          {
            id: 2,
            text: "A fictional personal fact.",
            kind: "fact",
            source: "user",
            subjects: {},
          },
        ],
        next_cursor: null,
      });
    });
    vi.stubGlobal("fetch", fetch);
    await app.dispatch(
      app.command("memory", memoryOptions("list", "personal"), MEMBER),
    );
    expect(app.rest.post).toHaveBeenCalledWith(
      "/users/@me/channels",
      expect.objectContaining({ body: { recipient_id: MEMBER } }),
    );
    expect(app.rest.patch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content: "your personal memories\n\n#2 A fictional personal fact.",
          allowed_mentions: expect.objectContaining({ parse: [] }),
        }),
      }),
    );
    expect(
      app.rest.post.mock.calls.some(
        ([route]) => route === `/channels/${CHANNEL}/messages`,
      ),
    ).toBe(false);
    expect(app.rest.post.mock.calls[0]?.[1]?.body).toMatchObject({
      data: { flags: MessageFlags.Ephemeral },
    });
  });

  // Proves Discord permission rejection precedes Remora access, including for the bot owner.
  it.each(["channel", "server"] as const)(
    "rejects unprivileged %s forgetting before any backend request",
    async (scope) => {
      const app = await runtime(false);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const permissions =
        scope === "server"
          ? READ_ACCESS | PermissionsBitField.Flags.ManageMessages
          : READ_ACCESS;
      await app.dispatch(
        app.command(
          "memory",
          memoryOptions("forget", scope),
          OWNER,
          permissions,
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(app.rest.patch).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            content: expect.stringContaining(
              scope === "server" ? "Manage Server" : "Manage Messages",
            ),
          }),
        }),
      );
    },
  );

  // Proves explicit clear confirmation is required before inspecting or changing storage/history.
  it("leaves memories and conversation history intact without clear confirmation", async () => {
    const app = await runtime(false);
    app.context.contextStore.setStart(CHANNEL, MESSAGE);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await app.dispatch(
      app.command(
        "memory",
        memoryOptions("clear", "server", "", false),
        MEMBER,
        READ_ACCESS | PermissionsBitField.Flags.ManageGuild,
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(app.context.contextStore.getStart(CHANNEL)).toBe(MESSAGE);
    expect(app.rest.patch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("nothing deleted"),
        }),
      }),
    );
  });

  // Proves commands acknowledge actual receipts, preserve failed deletions, and fence all supplied memory history first.
  it.each(["forget", "clear", "conflict", "lost_response"] as const)(
    "reports the actual %s result with durable caller-history fencing",
    async (scenario) => {
      const app = await runtime(false);
      const otherMemoryChat = "1000000000000000030";
      const plainChat = "1000000000000000040";
      for (const channel of [CHANNEL, otherMemoryChat, plainChat])
        app.context.contextStore.setStart(channel, "1");
      app.context.contextStore.recordMemoryContext(otherMemoryChat);
      let mutations = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith("/capabilities"))
            return Response.json(managementCaps);
          const bank = `discord:guild:${GUILD}`;
          if (init.method !== "POST")
            return Response.json({
              object: "remora.memory.list",
              version: 1,
              bank,
              revision: REVISION,
              data: [],
              next_cursor: null,
            });
          mutations++;
          expect(app.context.contextStore.allowsMessage(CHANNEL, "1")).toBe(
            false,
          );
          expect(
            app.context.contextStore.allowsMessage(otherMemoryChat, "1"),
          ).toBe(false);
          expect(app.context.contextStore.getStart(plainChat)).toBe("1");
          const operation = scenario === "clear" ? "clear" : "forget";
          const expected = {
            bank,
            expected_revision: REVISION,
            request_id: "1000000000000000009",
            ...(operation === "forget" ? { ids: [2, 5] } : {}),
          };
          expect(JSON.parse(String(init.body))).toEqual(expected);
          if (scenario === "conflict")
            return Response.json(
              { error: { code: "shared_evidence_conflict" } },
              { status: 409 },
            );
          if (scenario === "lost_response") throw new Error("socket closed");
          return Response.json({
            object: "remora.memory.mutation",
            version: 1,
            bank,
            request_id: expected.request_id,
            operation,
            replayed: false,
            deleted_ids: operation === "forget" ? [2, 5] : null,
            deleted_count: operation === "forget" ? 2 : 3,
            dependent_suppression: { bank, visible_active_count: 0 },
            revision: "b".repeat(64),
            cache_invalidated: true,
            reset_required: true,
          });
        }),
      );
      await app.dispatch(
        app.command(
          "memory",
          memoryOptions(scenario === "clear" ? "clear" : "forget", "server"),
          MEMBER,
          READ_ACCESS | PermissionsBitField.Flags.ManageGuild,
        ),
      );
      expect(mutations).toBe(1);
      const content =
        scenario === "conflict"
          ? "share evidence"
          : scenario === "lost_response"
            ? "couldn't confirm"
            : `forgot ${scenario === "clear" ? 3 : 2} memories from this server.`;
      expect(app.rest.patch).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            content: expect.stringContaining(content),
          }),
        }),
      );
      expect(app.context.contextStore.getStart(CHANNEL)).toBeUndefined();
    },
  );

  it("persists an owner's model switch and presents one private response", async () => {
    const app = await runtime();
    await app.dispatch(
      app.command("model", [
        {
          type: ApplicationCommandOptionType.String,
          name: "name",
          value: "new-model",
        },
      ]),
    );
    expect(app.context.settings.getLlmModel()).toBe("new-model");
    expect(app.rest.patch).toHaveBeenCalledTimes(1);
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({ content: "model set to new-model" }),
      }),
    );
    expect(app.rest.post).toHaveBeenCalledTimes(1);
    expect(app.rest.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          data: { flags: MessageFlags.Ephemeral },
          type: InteractionResponseType.DeferredChannelMessageWithSource,
        }),
      }),
    );
  });

  it.each(["model", "reload"])(
    "rejects non-owner /%s before executing it",
    async (name) => {
      const app = await runtime();
      await app.dispatch(app.command(name, [], MEMBER));
      expect(app.context.settings.getLlmModel()).toBe("old-model");
      expect(app.rest.patch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({ content: "nope, owner-only." }),
        }),
      );
    },
  );

  it("keeps model autocomplete private and lets owners choose catalog models", async () => {
    const app = await runtime();
    const catalog = vi
      .spyOn(app.context.modelCatalog, "getModels")
      .mockResolvedValue(["gemma-local"]);
    const autocomplete = (user: string) =>
      new Autocomplete(app.client, {
        ...app.packet(user),
        type: InteractionType.ApplicationCommandAutocomplete,
        data: {
          id: "1000000000000000010",
          name: "model",
          type: ApplicationCommandType.ChatInput,
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "name",
              value: "gemma",
              focused: true,
            },
          ],
        },
      });
    await app.dispatch(autocomplete(MEMBER));
    expect(catalog).not.toHaveBeenCalled();
    expect(app.rest.post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: {
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: { choices: [] },
        },
      }),
    );
    await app.dispatch(autocomplete(OWNER));
    expect(app.rest.post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: {
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: { choices: [{ name: "gemma-local", value: "gemma-local" }] },
        },
      }),
    );
  });

  it("requires Manage Messages for guild deletion and deletes only bot messages", async () => {
    const app = await runtime();
    const options = [
      {
        type: ApplicationCommandOptionType.Integer as const,
        name: "count",
        value: 1,
      },
    ];
    await app.dispatch(app.command("delete", options, MEMBER));
    expect(app.rest.delete).not.toHaveBeenCalled();
    await app.dispatch(
      app.command(
        "delete",
        options,
        MEMBER,
        PermissionsBitField.Flags.ManageMessages,
      ),
    );
    expect(app.rest.delete).toHaveBeenCalledTimes(1);
    expect(app.rest.delete).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/messages/1000000000000000007`,
    );
  });

  it.each([0, 101, 1.5])(
    "rejects invalid delete count %s without deleting messages",
    async (value) => {
      const app = await runtime();
      await app.dispatch(
        app.command("delete", [
          { type: ApplicationCommandOptionType.Integer, name: "count", value },
        ]),
      );
      expect(app.rest.delete).not.toHaveBeenCalled();
      expect(app.rest.patch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            content: "Something went wrong while running this action.",
          }),
        }),
      );
    },
  );

  it("sends model-provided farewell chunks before leaving, without pinging anyone", async () => {
    const app = await runtime();
    const tools = toLlmTools(
      await buildModelVisibleActions({
        registry: app.registry,
        context: app.context,
        message: app.message,
      }),
    );
    expect(tools.map((tool) => tool.function.name)).toEqual(["leave_thread"]);
    await dispatchToolCall({
      ...app,
      toolCall: {
        type: "function",
        name: "leave_thread",
        arguments: JSON.stringify({ farewell: "bye <split /> see you" }),
      },
    });
    expect(app.rest.post).toHaveBeenCalledTimes(2);
    expect(app.rest.post).toHaveBeenNthCalledWith(
      1,
      `/channels/${CHANNEL}/messages`,
      expect.objectContaining({
        body: expect.objectContaining({
          content: "bye",
          allowed_mentions: {
            parse: [],
            users: [],
            roles: [],
            replied_user: false,
          },
        }),
      }),
    );
    expect(app.rest.post).toHaveBeenNthCalledWith(
      2,
      `/channels/${CHANNEL}/messages`,
      expect.objectContaining({
        body: expect.objectContaining({ content: "see you" }),
      }),
    );
    expect(app.rest.delete).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/thread-members/%40me`,
      expect.anything(),
    );
    expect(app.rest.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      app.rest.post.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it.each(["{", "{}", '{"farewell":9}', '{"farewell":"bye","extra":true}'])(
    "rejects malformed model arguments %s before Discord side effects",
    async (args) => {
      const app = await runtime();
      await expect(
        dispatchToolCall({
          ...app,
          toolCall: { type: "function", name: "leave_thread", arguments: args },
        }),
      ).rejects.toThrow();
      expect(app.rest.post).not.toHaveBeenCalled();
      expect(app.rest.delete).not.toHaveBeenCalled();
    },
  );

  it("hides thread tools elsewhere and rejects stale or forged calls at execution", async () => {
    const app = await runtime(false);
    const actions = await buildModelVisibleActions({
      registry: app.registry,
      context: app.context,
      message: app.message,
    });
    expect(toLlmTools(actions)).toEqual([]);
    await expect(
      dispatchToolCall({
        ...app,
        toolCall: {
          type: "function",
          name: "leave_thread",
          arguments: '{"farewell":"bye"}',
        },
      }),
    ).rejects.toThrow("only available in threads");
    await expect(
      dispatchToolCall({
        ...app,
        toolCall: {
          type: "function",
          name: "model",
          arguments: '{"name":"new-model"}',
        },
      }),
    ).rejects.toThrow("Unknown tool call");
    expect(app.context.settings.getLlmModel()).toBe("old-model");
    expect(app.rest.post).not.toHaveBeenCalled();
    expect(app.rest.delete).not.toHaveBeenCalled();
  });

  it("generates one public slash farewell and leaves through the existing queue", async () => {
    const app = await runtime();
    vi.spyOn(app.context.llm, "complete").mockResolvedValue({
      content: "bye for now",
    });
    await app.dispatch(app.command("leave"));
    expect(app.rest.patch).toHaveBeenCalledTimes(1);
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({ content: "bye for now" }),
      }),
    );
    expect(app.rest.post).toHaveBeenCalledTimes(1);
    expect(app.rest.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          data: { flags: 0 },
          type: InteractionResponseType.DeferredChannelMessageWithSource,
        }),
      }),
    );
    expect(app.rest.delete).toHaveBeenCalledWith(
      `/channels/${CHANNEL}/thread-members/%40me`,
      expect.anything(),
    );
  });

  it("propagates a failed farewell and stays in the thread", async () => {
    const app = await runtime();
    app.rest.post.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(
      dispatchToolCall({
        ...app,
        toolCall: {
          type: "function",
          name: "leave_thread",
          arguments: '{"farewell":"bye"}',
        },
      }),
    ).rejects.toThrow("Discord unavailable");
    expect(app.rest.delete).not.toHaveBeenCalled();
  });
});

describe("Patch's self memory", () => {
  const TEAM = { id: "1000000000000000099", name: "patch team" };
  const selfCaps = {
    ...evidenceCapabilities,
    features: { ...evidenceCapabilities.features, assistant_statements: true },
    limits: {
      ...evidenceCapabilities.limits,
      max_assistant_statement_chars: 4096,
      max_assistant_aliases: 8,
    },
  };

  /** The runtime with a team-owned application (OWNER on the team) and a self client. */
  async function selfRuntime(receipt: Record<string, unknown> = {}) {
    const app = await runtime();
    const original = app.rest.get.getMockImplementation();
    app.rest.get.mockImplementation(async (route, options) => {
      if (route === "/applications/@me")
        return {
          id: BOT,
          name: "Patch",
          icon: null,
          description: "",
          bot_public: false,
          bot_require_code_grant: false,
          verify_key: "",
          flags: 0,
          team: {
            id: TEAM.id,
            icon: null,
            name: TEAM.name,
            owner_user_id: OWNER,
            members: [
              {
                membership_state: 2,
                permissions: ["*"],
                team_id: TEAM.id,
                role: "admin",
                user: {
                  id: OWNER,
                  username: "mia",
                  discriminator: "0",
                  avatar: null,
                },
              },
            ],
          },
        };
      return original?.(route, options);
    });
    // discord.js builds this on READY; its constructor is private to the library.
    const application: ClientApplication = Reflect.construct(
      ClientApplication,
      [app.client, { id: BOT, name: "Patch" }],
    );
    Object.assign(app.client, { application });
    const selfMemory = new RemoraMemoryClient({
      ...app.context.config,
      llmApiKey: "self-token",
    });
    await selfMemory.initialize(parseRemoraCapabilities(selfCaps));
    app.context.selfMemory = selfMemory;
    const requests: Array<{ url: string; body: unknown; auth: string | null }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({
          url,
          body,
          auth: new Headers(init.headers).get("authorization"),
        });
        return Response.json({
          object: "remora.memory.assistant",
          version: 1,
          bank: "patch:self",
          request_id: body.request_id,
          kind: "evidence",
          source: {
            id: body.source.id,
            revision: 0,
            origin: "assistant_output",
            actor: {
              principal: "patch-trial",
              actor: null,
              entity: body.source.entity_id,
              unknown: null,
              description: null,
            },
            tool: null,
            url: null,
          },
          saved_ids: [7],
          active_ids: [7],
          status: "saved",
          atoms: ["Patch likes teal."],
          context: ["Teal is a blue-green colour."],
          attached: [],
          subject: "c".repeat(64),
          linked: [],
          replayed: false,
          admission_identity:
            "a56bb32e55d908ce8b66725051ecef1c7d23226b5bf5a924ee32c8e749a96bf8",
          ...receipt,
        });
      }),
    );
    const add = (user: string, permissions = 0n) =>
      app.command(
        "self",
        [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "add",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "statement",
                value: "patch likes teal",
              },
            ],
          },
        ],
        user,
        permissions,
      );
    return { ...app, requests, add };
  }

  // Proves /self is a user-install command: server admins never see it, and it works in DMs and servers.
  it("registers /self as a user-installed command everywhere", async () => {
    const app = await runtime();
    const command = getDiscordCommandRegistration(app.registry).find(
      (item) => item.name === "self",
    );
    expect(command).toMatchObject({
      integrationTypes: [ApplicationIntegrationType.UserInstall],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
    });
    expect(command).not.toHaveProperty("defaultMemberPermissions");
  });

  // Proves a server administrator who is not on the app's team is refused before anything reaches Remora.
  it("refuses /self to anyone outside the application's team", async () => {
    const app = await selfRuntime();
    await app.dispatch(
      app.add(MEMBER, PermissionsBitField.Flags.Administrator),
    );
    expect(app.requests).toEqual([]);
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content: "nope, that's for Patch's team only.",
        }),
      }),
    );
  });

  // Proves the handler checks the team itself, even if authorization were bypassed.
  it("refuses a non-team caller inside the handler too", async () => {
    const app = await selfRuntime();
    const interaction = app.add(MEMBER);
    const reply = await selfAction.execute(
      {
        input: { operation: "add", statement: "patch likes teal" },
        rawEvent: interaction,
        requester: { id: MEMBER },
      } as never,
      app.context,
    );
    expect(reply).toBe("nope, that's for Patch's team only.");
    expect(app.requests).toEqual([]);
  });

  // Proves a team member's statement goes to the self bank with the self token, bound to Patch's stable ID.
  it("saves a team statement in Patch's voice and shows its atoms", async () => {
    const app = await selfRuntime();
    await app.dispatch(app.add(OWNER));
    expect(app.requests).toHaveLength(1);
    const [request] = app.requests;
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/v1/remora/memories/assistant",
    );
    expect(request?.auth).toBe("Bearer self-token");
    expect(request?.body).toMatchObject({
      bank: "patch:self",
      source: {
        entity_id: `discord:user:${BOT}`,
        label: "Patch",
        text: "patch likes teal",
      },
    });
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content:
            "saved #7:\n- Patch likes teal.\ncontext:\n- Teal is a blue-green colour.",
        }),
      }),
    );
  });

  // Proves a statement with nothing about Patch is still saved, and says which of her facts it belongs with.
  it("saves context-only statements and names the fact they attach to", async () => {
    const app = await selfRuntime({
      atoms: [],
      context: ["underscores uses she/her pronouns."],
      attached: [2],
    });
    await app.dispatch(app.add(OWNER));
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content:
            "saved #7:\ncontext:\n- underscores uses she/her pronouns.\nattached to #2",
        }),
      }),
    );
  });

  // Proves /self list shows a context record under the fact it attaches to, not as a fact of its own.
  it("lists attached context beneath its fact", async () => {
    const app = await selfRuntime();
    const record = (id: number, text: string, extra: object) => ({
      ...makeEvidenceRecord("patch:self", id),
      span: { start: 0, end: text.length },
      text,
      ...extra,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "remora.evidence.list",
          version: 1,
          bank: "patch:self",
          revision: REVISION,
          data: [
            record(2, "Patch loves underscores.", {
              atoms: ["Patch loves underscores."],
              atom_subjects: ["c".repeat(64)],
            }),
            record(4, "underscores uses she/her pronouns.", {
              atoms: ["underscores uses she/her pronouns."],
              attached_to: [2],
            }),
          ],
          next_cursor: null,
        }),
      ),
    );
    await app.dispatch(
      app.command(
        "self",
        [{ type: ApplicationCommandOptionType.Subcommand, name: "list" }],
        OWNER,
      ),
    );
    expect(app.rest.patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content:
            "#2: Patch loves underscores.\n  - Patch loves underscores.\n  - #4: underscores uses she/her pronouns.",
        }),
      }),
    );
  });
});
