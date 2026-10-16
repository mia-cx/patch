import {
  type APIApplicationCommandAutocompleteInteraction,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  InteractionResponseType,
  InteractionType,
  Locale,
  MessageFlags,
  MessageType,
  PermissionsBitField,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { ConversationContextStore } from "../conversation/store.js";
import { dispatchInteraction } from "../discord/actions/dispatch.js";
import { LlmClient } from "../llm/client.js";
import { ModelCatalog } from "../llm/model-catalog.js";
import { createLogger } from "../logger.js";
import { GenerationQueue } from "../queue.js";
import { SettingsStore } from "../settings/store.js";
import { buildModelVisibleActions, toLlmTools } from "./action-context.js";
import type { ActionContext } from "./context.js";
import { registerDefaultActions } from "./defaults.js";
import { createPatchActionRegistry } from "./registry.js";
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
});

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

async function runtime(thread = true) {
  const client = new Client<true>({ intents: [] });
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
