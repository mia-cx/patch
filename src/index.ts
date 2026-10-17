import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type PartialMessage,
  type ThreadChannel,
} from "discord.js";
import { registerDiscordCommands } from "protocord";
import { registerDefaultActions } from "./actions/defaults.js";
import { actionRegistry } from "./actions/registry.js";
import { classifyShouldRespond } from "./classifier/response-classifier.js";
import { loadConfig } from "./config.js";
import {
  limitContextMessages,
  reconstructConversationContext,
} from "./conversation/context.js";
import { ConversationContextStore } from "./conversation/store.js";
import type { ConversationMessage } from "./conversation/types.js";
import { dispatchInteraction } from "./discord/actions/dispatch.js";
import { startActivityLoop } from "./discord/activity.js";
import {
  DiscordJsAdapter,
  discordClientOptions,
} from "./discord/discord-js-adapter.js";
import { DiscordPronounProvider } from "./discord/pronouns.js";
import { getBotIdentity } from "./identity.js";
import { LlmClient } from "./llm/client.js";
import { ModelCatalog } from "./llm/model-catalog.js";
import { createLogger } from "./logger.js";
import { RemoraMemoryClient } from "./memory/client.js";
import { buildResponseContextBudget } from "./prompts/response.js";
import { GenerationQueue } from "./queue.js";
import { respond } from "./response/responder.js";
import { SettingsStore } from "./settings/store.js";

const MENTION_CACHE_LIMIT = 5_000;

const mentionStateByMessageId = new Map<string, boolean>();
const config = loadConfig();
const identity = getBotIdentity();
const logger = createLogger(config.debugLogging || config.llmTraceLogging);
const client = new Client(
  config.discordTrialDmChannelId
    ? {
        ...discordClientOptions,
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
      }
    : discordClientOptions,
);
const settings = new SettingsStore(config.settingsDbPath, {
  llmModel: config.llmModel,
});
const contextStore = new ConversationContextStore(config.settingsDbPath);
const llm = new LlmClient(config, settings);
const memory = new RemoraMemoryClient(config);
if (config.remoraDmEnabled) {
  const capabilities = await llm.initializeRemora();
  await memory.initialize(capabilities);
  if (config.discordTrialDmChannelId)
    contextStore.recordMemoryContext(config.discordTrialDmChannelId);
  const budget = buildResponseContextBudget(config, "dm");
  if (
    budget.promptTokens + (budget.responseTokens ?? 0) >=
    budget.contextTokens
  )
    throw new Error(
      "Remora context cannot fit Patch's persona and output allowance",
    );
  logger.info(
    {
      capabilities,
      contextTokens: config.llmContextTokens,
      maxTokens: config.llmMaxTokens,
    },
    "Remora DM memory enabled",
  );
}
const modelCatalog = new ModelCatalog(llm, logger);
const pronounProvider = new DiscordPronounProvider(
  config.discordToken,
  logger,
  config.pronounOverrides,
);
const queue = new GenerationQueue(config.maxGlobalConcurrency);
const actionContext = {
  client,
  config,
  llm,
  memory,
  logger,
  queue,
  modelCatalog,
  settings,
  contextStore,
};

registerDefaultActions(actionRegistry);

client.once(Events.ClientReady, (readyClient) => {
  startActivityLoop({ client: readyClient, config, llm, logger, queue });

  void modelCatalog.refresh().catch((error) => {
    logger.warn({ error }, "failed to prewarm model catalog");
  });

  // A one-DM trial must not change the application's global Discord commands.
  if (!config.discordTrialDmChannelId) {
    void registerDiscordCommands(readyClient, actionRegistry).catch((error) => {
      logger.error({ error }, "failed to register action triggers");
    });
  }

  logger.info(
    {
      botUserId: readyClient.user.id,
      username: readyClient.user.username,
      identityName: identity.name,
      llmModel: settings.getLlmModel(),
      settingsDbPath: config.settingsDbPath,
      trialDmChannelId: config.discordTrialDmChannelId || undefined,
    },
    `${identity.name.toLowerCase()} online`,
  );
});

client.on(Events.MessageCreate, (message) => {
  if (
    config.discordTrialDmChannelId &&
    message.channelId !== config.discordTrialDmChannelId
  )
    return;
  void handleMessage(message).catch((error) => {
    logger.error(
      { error, messageId: message.id, channelId: message.channelId },
      "unhandled message handler failure",
    );
  });
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (
    config.discordTrialDmChannelId &&
    newMessage.channelId !== config.discordTrialDmChannelId
  )
    return;
  void handleMessageUpdate(oldMessage, newMessage).catch((error) => {
    logger.error(
      { error, messageId: newMessage.id, channelId: newMessage.channelId },
      "unhandled message update handler failure",
    );
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (
    config.discordTrialDmChannelId &&
    interaction.channelId !== config.discordTrialDmChannelId &&
    !(interaction.isChatInputCommand() && interaction.commandName === "memory")
  )
    return;
  void dispatchInteraction({
    interaction,
    context: actionContext,
    registry: actionRegistry,
  }).catch((error) => {
    logger.error(
      {
        error,
        interactionId: interaction.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
      },
      "unhandled interaction dispatch failure",
    );
  });
});

await client.login(config.discordToken);

async function handleMessage(message: Message): Promise<void> {
  const botUserId = client.user?.id;
  if (!botUserId) return;
  if (message.author.bot) return;
  if (!contextStore.observeHumanMessage(message.channelId, message.id)) return;

  const mentionsBotUser = message.mentions.users.has(botUserId);
  rememberMentionState(message.id, mentionsBotUser);

  const adapter = new DiscordJsAdapter(client, botUserId);
  const isDm = !message.inGuild();
  const classifyDm = isDm && config.dmResponseClassifierEnabled;
  const repliesToBot = await isReplyToBot(adapter, message, botUserId);
  const manualTrigger =
    mentionsBotUser || (!classifyDm && (isDm || repliesToBot));

  if (manualTrigger) {
    const enqueuedAt = Date.now();
    logger.debug(
      { messageId: message.id, channelId: message.channelId },
      "queueing manual response job",
    );
    await queue.add(
      () => {
        logger.debug(
          {
            messageId: message.id,
            channelId: message.channelId,
            queuedMs: Date.now() - enqueuedAt,
          },
          "manual response job started",
        );
        return respond({
          adapter,
          message,
          botUserId,
          config,
          llm,
          logger,
          pronounProvider,
          contextStore,
          actionContext,
          actionRegistry,
        });
      },
      { priority: "manual", bucketKey: message.channelId },
    );
    return;
  }

  if (!(await shouldRunResponseClassifier(message, botUserId))) return;

  const enqueuedAt = Date.now();
  logger.debug(
    { messageId: message.id, channelId: message.channelId },
    "queueing response classifier job",
  );
  await queue.add(
    async () => {
      if (!contextStore.allowsMessage(message.channelId, message.id)) return;
      logger.debug(
        {
          messageId: message.id,
          channelId: message.channelId,
          queuedMs: Date.now() - enqueuedAt,
        },
        "response classifier job started",
      );
      const contextMessages = await buildSharedContext(
        adapter,
        message,
        botUserId,
      );
      const classifierContextMessages = limitContextMessages(
        contextMessages,
        config.classifierContextMessageLimit,
      );
      if (contextMessages.length === 0) return;
      if (classifierContextMessages.length !== contextMessages.length) {
        logger.debug(
          {
            messageId: message.id,
            channelId: message.channelId,
            contextMessageCount: contextMessages.length,
            classifierContextMessageCount: classifierContextMessages.length,
          },
          "limited response classifier context",
        );
      }
      const decision = await classifyShouldRespond({
        message,
        botUserId,
        llm,
        logger,
        llmTraceLogging: config.llmTraceLogging,
        contextMessages: classifierContextMessages,
      });
      if (!decision.shouldRespond) {
        logger.debug(
          { messageId: message.id, channelId: message.channelId, decision },
          "response classifier declined response",
        );
        return;
      }
      logger.debug(
        { messageId: message.id, channelId: message.channelId, decision },
        "response classifier accepted response",
      );
      await respond({
        adapter,
        message,
        botUserId,
        config,
        llm,
        logger,
        pronounProvider,
        contextStore,
        contextMessages,
        classifierDecision: decision,
        silentFailure: true,
        actionContext,
        actionRegistry,
      });
    },
    {
      priority: "passive",
      bucketKey: message.channelId,
      ttlMs: config.passiveResponseTtlMs,
    },
  );
}

async function buildSharedContext(
  adapter: DiscordJsAdapter,
  message: Message,
  botUserId: string,
): Promise<ConversationMessage[]> {
  return reconstructConversationContext(
    adapter,
    message,
    botUserId,
    logger,
    pronounProvider,
    {
      store: contextStore,
      budget: buildResponseContextBudget(
        config,
        !message.inGuild()
          ? "dm"
          : message.channel.isThread()
            ? "thread"
            : "global",
      ),
      dmContextMessageLimit: config.dmContextMessageLimit,
      threadContextMessageLimit: config.threadContextMessageLimit,
      guildRecentMessageLimit: config.guildRecentMessageLimit,
    },
  );
}

async function shouldRunResponseClassifier(
  message: Message,
  botUserId: string,
): Promise<boolean> {
  if (!config.responseClassifierEnabled) return false;
  if (!message.inGuild()) return config.dmResponseClassifierEnabled;
  if (!message.channel.isThread()) return false;
  return isThreadMember(message.channel as ThreadChannel, botUserId);
}

async function isThreadMember(
  thread: ThreadChannel,
  botUserId: string,
): Promise<boolean> {
  try {
    await thread.members.fetch({ member: botUserId, force: true, cache: true });
    return true;
  } catch (error) {
    if (discordErrorCode(error) === 10007) {
      logger.debug(
        { threadId: thread.id },
        `skipping passive classifier because ${getBotIdentity().name} is not in thread`,
      );
      return false;
    }

    logger.warn(
      { error, threadId: thread.id },
      "failed to check thread membership; skipping passive classifier",
    );
    return false;
  }
}

function discordErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "number" ? code : undefined;
}

async function handleMessageUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  const botUserId = client.user?.id;
  if (!botUserId) return;

  if (!contextStore.allowsMessage(newMessage.channelId, newMessage.id)) return;
  const beforeMentionedBot =
    mentionStateByMessageId.get(oldMessage.id) ??
    mentionsBot(oldMessage, botUserId);
  const afterMentionedBot = mentionsBot(newMessage, botUserId);

  if (afterMentionedBot !== undefined) {
    rememberMentionState(newMessage.id, afterMentionedBot);
  }

  if (beforeMentionedBot !== false || afterMentionedBot !== true) return;

  const message = await fetchUpdatedMessage(newMessage);
  if (!message || message.author.bot) return;

  const adapter = new DiscordJsAdapter(client, botUserId);
  await queue.add(
    () =>
      respond({
        adapter,
        message,
        botUserId,
        config,
        llm,
        logger,
        pronounProvider,
        contextStore,
        actionContext,
        actionRegistry,
      }),
    { priority: "manual", bucketKey: message.channelId },
  );
}

function rememberMentionState(
  messageId: string,
  mentionsBotUser: boolean,
): void {
  mentionStateByMessageId.set(messageId, mentionsBotUser);
  if (mentionStateByMessageId.size <= MENTION_CACHE_LIMIT) return;

  const oldest = mentionStateByMessageId.keys().next().value;
  if (oldest) mentionStateByMessageId.delete(oldest);
}

function mentionsBot(
  message: Message | PartialMessage,
  botUserId: string,
): boolean | undefined {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`);
  if (typeof message.content === "string") {
    return (
      mentionPattern.test(message.content) ||
      message.mentions.users.has(botUserId)
    );
  }

  return undefined;
}

async function fetchUpdatedMessage(
  message: Message | PartialMessage,
): Promise<Message | undefined> {
  if (!message.partial) return message;

  try {
    return await message.fetch();
  } catch (error) {
    logger.warn(
      { error, messageId: message.id },
      "failed to fetch edited message",
    );
    return undefined;
  }
}

async function isReplyToBot(
  adapter: DiscordJsAdapter,
  message: Message,
  botUserId: string,
): Promise<boolean> {
  const reference = message.reference;
  if (!reference?.messageId || !reference.channelId) return false;

  try {
    const parent = await adapter.fetchMessage({
      channelId: reference.channelId,
      messageId: reference.messageId,
    });
    return parent.authorId === botUserId;
  } catch (error) {
    logger.warn(
      { error, messageId: message.id, parentMessageId: reference.messageId },
      "failed to inspect reply target",
    );
    return false;
  }
}
