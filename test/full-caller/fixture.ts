import { ChannelType, Client, ClientUser } from "discord.js";
import pino from "pino";
import type { ActionContext } from "../../src/actions/context.js";
import { registerDefaultActions } from "../../src/actions/defaults.js";
import { createPatchActionRegistry } from "../../src/actions/registry.js";
import { loadConfig } from "../../src/config.js";
import { ConversationContextStore } from "../../src/conversation/store.js";
import type { ConversationMessage } from "../../src/conversation/types.js";
import {
  DiscordJsAdapter,
  toConversationMessage,
} from "../../src/discord/discord-js-adapter.js";
import { LlmClient } from "../../src/llm/client.js";
import { ModelCatalog } from "../../src/llm/model-catalog.js";
import { RemoraMemoryClient } from "../../src/memory/client.js";
import { GenerationQueue } from "../../src/queue.js";
import { respond } from "../../src/response/responder.js";
import { SettingsStore } from "../../src/settings/store.js";
import { HarnessStore } from "../../src/tools/store.js";
import { WebClient } from "../../src/tools/web.js";

export const BANKS = [
  "full-caller-v1-dm",
  "full-caller-v1-channel",
  "full-caller-v1-shared",
  "full-caller-v1-other",
] as const;
export const BASE = "http://127.0.0.1:18789/v1";
export const MODEL = "private-gemma-full-caller-v1";
export const BOT = "1000000000000000002";
const HUMAN = "1000000000000000003";
const GUILD = "1000000000000000006";
const CHANNELS = [
  "1000000000000000011",
  "1000000000000000012",
  "1000000000000000013",
  "1000000000000000014",
] as const;
export const WEB_URL = "https://fictional-release.example/aurora";
export const WEB_TEXT =
  "Aurora's fictional release uses violet badges for offline devices. The badges stay violet until synchronization completes.";

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

/** Real SDK objects and Protocord actions with every Discord/web transport replaced by invented local data. */
export class FullCallerFixture {
  readonly config;
  readonly llm;
  readonly memory;
  readonly contextStore = new ConversationContextStore(":memory:");
  readonly store = new HarnessStore(":memory:");
  readonly client = new Client<true>({ intents: [] });
  readonly registry = createPatchActionRegistry();
  readonly settings = new SettingsStore(":memory:", { llmModel: MODEL });
  readonly logger = pino({
    level: "warn",
    hooks: {
      logMethod: (args) => {
        this.logs.push(
          args
            .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
            .join(" "),
        );
      },
    },
  });
  readonly web = new WebClient({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (url) => {
      if (url.href === WEB_URL)
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<html><title>Aurora fictional release</title><main>${WEB_TEXT}</main></html>`,
        };
      if (url.hostname === "html.duckduckgo.com")
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<div class="result"><a class="result__a" href="${WEB_URL}">Aurora fictional release</a><p class="result__snippet">${WEB_TEXT}</p></div>`,
        };
      throw new Error("Qualification web fixture has no such page");
    },
  });
  readonly histories = new Map<string, ConversationMessage[]>();
  readonly sent: Array<{ bank: string; id: string; text: string }> = [];
  readonly violations: string[] = [];
  readonly logs: string[] = [];
  private serial = 1000000000000000100n;
  private readonly packets = new Map<
    string,
    ReturnType<FullCallerFixture["packet"]>
  >();
  readonly context: ActionContext;

  constructor(token: string) {
    this.client.user = new Bot(this.client);
    this.config = loadConfig({
      DISCORD_TOKEN: "invented-never-used",
      DISCORD_CLIENT_ID: BOT,
      DISCORD_TRIAL_DM_CHANNEL_ID: CHANNELS[0],
      LLM_BASE_URL: BASE,
      LLM_MODEL: MODEL,
      LLM_API_KEY: token,
      LLM_CONTEXT_TOKENS: "12288",
      LLM_MAX_TOKENS: "256",
      LLM_TEMPERATURE: "0",
      LLM_ENABLE_THINKING: "false",
      LLM_TOOL_MODE: "tagged",
      LLM_TIMEOUT_MS: "90000",
      REMORA_DM_ENABLED: "true",
      REMORA_OBSERVATION_START_ID: "1000000000000000000",
      DISCORD_TRIAL_GUILD_ID: GUILD,
      DISCORD_TRIAL_GUILD_CHANNEL_ID: CHANNELS[1],
    });
    this.llm = new LlmClient(this.config);
    this.memory = new RemoraMemoryClient(this.config);
    this.context = {
      client: this.client,
      config: this.config,
      llm: this.llm,
      memory: this.memory,
      logger: this.logger,
      settings: this.settings,
      contextStore: this.contextStore,
      queue: new GenerationQueue(1),
      modelCatalog: new ModelCatalog(this.llm, this.logger),
      harness: { store: this.store, web: this.web },
    };
    registerDefaultActions(this.registry);
    // Replace all SDK transports before any SDK fetch. No login or Gateway is started.
    Object.defineProperty(this.client.rest, "get", {
      value: async (route: string) => this.sdkGet(route),
    });
    Object.defineProperty(this.client.rest, "post", {
      value: async (route: string, options?: { body?: unknown }) => {
        const match = /^\/channels\/(\d+)\/messages$/.exec(route);
        if (
          match?.[1] &&
          options?.body &&
          typeof options.body === "object" &&
          "content" in options.body
        ) {
          const bank = this.bank(match[1]);
          const packet = this.packet(
            match[1],
            BOT,
            String(options.body.content),
          );
          this.packets.set(packet.id, packet);
          this.sent.push({ bank, id: packet.id, text: packet.content });
          return packet;
        }
        if (/^\/channels\/\d+\/typing$/.test(route)) return;
        return this.deny(route);
      },
    });
    for (const method of ["put", "patch", "delete"] as const)
      Object.defineProperty(this.client.rest, method, {
        value: async (route: string) => this.deny(route),
      });
  }

  private deny(route: string): never {
    this.violations.push(route);
    throw new Error(`Qualification blocked Discord action: ${route}`);
  }

  private bank(channel: string) {
    const index = CHANNELS.indexOf(channel as (typeof CHANNELS)[number]);
    const bank = BANKS[index];
    if (!bank) throw new Error("Unknown invented channel");
    return bank;
  }

  private packet(
    channel: string,
    author: string,
    text: string,
    id = String(++this.serial),
    revision = 0,
  ) {
    return {
      id,
      channel_id: channel,
      ...(channel === CHANNELS[1] ? { guild_id: GUILD } : {}),
      type: 0,
      author: {
        id: author,
        username: author === BOT ? "Patch" : "Alex",
        discriminator: "0",
        avatar: null,
        bot: author === BOT,
      },
      content: text,
      timestamp: "2026-10-19T12:00:00Z",
      edited_timestamp: revision ? new Date(revision).toISOString() : null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      components: [],
    };
  }

  private sdkGet(route: string) {
    if (route === `/guilds/${GUILD}`)
      return {
        id: GUILD,
        name: "Invented qualification guild",
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
    const channel = /^\/channels\/(\d+)$/.exec(route)?.[1];
    if (channel && CHANNELS.some((value) => value === channel))
      return channel === CHANNELS[1]
        ? {
            id: channel,
            guild_id: GUILD,
            type: ChannelType.GuildText,
            name: "invented-qualification",
            permission_overwrites: [],
          }
        : {
            id: channel,
            type: ChannelType.DM,
            recipients: [
              { id: HUMAN, username: "Alex", discriminator: "0", avatar: null },
            ],
          };
    const match = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route);
    const packet = match?.[2] ? this.packets.get(match[2]) : undefined;
    if (packet && packet.channel_id === match?.[1]) return packet;
    return this.deny(route);
  }

  async initialize() {
    await this.client.guilds.fetch(GUILD);
    const caps = await this.llm.initializeRemora();
    if (
      !this.llm.supportsSourceReferences ||
      !caps.features.all_stream_evidence ||
      caps.features.tools ||
      caps.features.thinking ||
      caps.features.streaming ||
      caps.features.memory_search ||
      caps.features.entity_identity ||
      caps.limits.context_tokens !== 12288 ||
      caps.limits.max_output_tokens !== 256
    )
      throw new Error("Qualification capabilities differ");
    await this.memory.initialize(caps);
    return caps;
  }

  /** Feed real SDK messages through the installed responder, formatting and returned-display re-entry. */
  async turn(
    bank: (typeof BANKS)[number],
    text: string,
    edit?: { id: string; revision: number },
  ) {
    const channelId = CHANNELS[BANKS.indexOf(bank)];
    if (!channelId) throw new Error("Unknown invented bank");
    const packet = this.packet(
      channelId,
      HUMAN,
      text,
      edit?.id,
      edit?.revision,
    );
    this.packets.set(packet.id, packet);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("Invented channel missing");
    const message = await channel.messages.fetch({
      message: packet.id,
      force: true,
      cache: false,
    });
    const prior = this.histories.get(bank) ?? [];
    // Editing reconstructs only through that original trigger; it does not rename a source.
    const history = [
      ...prior.filter((item) => BigInt(item.id) < BigInt(message.id)),
      toConversationMessage(message, BOT),
    ];
    const sentBefore = this.sent.length;
    this.contextStore.observeHumanMessage(channelId, message.id);
    const logBefore = this.logs.length;
    await respond({
      adapter: new DiscordJsAdapter(this.client, BOT),
      message,
      botUserId: BOT,
      config: this.config,
      llm: this.llm,
      logger: this.logger,
      contextStore: this.contextStore,
      contextMessages: history,
      actionContext: this.context,
      actionRegistry: this.registry,
      remoraScope: (current) => ({
        read_banks: bank === BANKS[1] ? [bank, BANKS[2]] : [bank],
        write_bank: bank,
        turn: {
          id: `discord:message:${current.id}`,
          revision: current.editedTimestamp ?? 0,
          speaker_id: `discord:user:${current.author.id}`,
          text: current.content,
        },
      }),
      toolExecutionAllowlist: new Set(["web_fetch", "web_search"]),
    });
    if (this.logs.length !== logBefore || this.violations.length)
      throw new Error(
        `Caller qualification failed: ${this.logs.slice(logBefore).join("; ")}`,
      );
    const sent = this.sent.slice(sentBefore);
    if (!sent.length) throw new Error("No actual formatted display returned");
    const adapter = new DiscordJsAdapter(this.client, BOT);
    for (const item of sent)
      history.push(
        await adapter.fetchMessage({ channelId, messageId: item.id }),
      );
    this.histories.set(bank, history);
    return {
      source_id: `discord:message:${message.id}`,
      id: message.id,
      revision: message.editedTimestamp ?? 0,
      text,
      sent,
    };
  }

  /** Fictional context reset only. Original Discord records and memory storage remain untouched. */
  reset(bank: string) {
    this.histories.delete(bank);
  }

  /** Mirror the principal-wide caller fence before a deterministic test-bank erasure. */
  mutation<T>(execute: () => Promise<T>) {
    return this.context.queue.add(
      async () => {
        this.store.invalidateConversationData();
        this.web.invalidate();
        this.contextStore.resetMemoryContexts(CHANNELS, String(this.serial));
        this.histories.clear();
        return execute();
      },
      { exclusive: true },
    );
  }

  async close() {
    this.store.close();
    this.settings.close();
    this.contextStore.close();
    await this.client.destroy();
  }
}
