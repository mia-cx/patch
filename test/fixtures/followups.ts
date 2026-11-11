import { ChannelType, Client } from "discord.js";
import {
  buildModelVisibleActions,
  formatCompactActionsPrompt,
  toLlmTools,
} from "../../src/actions/action-context.js";
import type { ActionContext } from "../../src/actions/context.js";
import { registerHarnessActions } from "../../src/actions/harness.js";
import { createPatchActionRegistry } from "../../src/actions/registry.js";
import { loadConfig } from "../../src/config.js";
import { ConversationContextStore } from "../../src/conversation/store.js";
import { LlmClient, type LlmMessage } from "../../src/llm/client.js";
import { ModelCatalog } from "../../src/llm/model-catalog.js";
import { createLogger } from "../../src/logger.js";
import { RemoraMemoryClient } from "../../src/memory/client.js";
import { GenerationQueue } from "../../src/queue.js";
import { SettingsStore } from "../../src/settings/store.js";
import { HarnessStore } from "../../src/tools/store.js";
import { runToolTurn } from "../../src/tools/turn.js";
import { WebClient } from "../../src/tools/web.js";

export const FOLLOWUP_CHANNEL = "1000000000000000001";
const BOT = "1000000000000000002";
const HUMAN = "1000000000000000003";
const TOOLS = ["schedule_followup", "list_followups", "cancel_followup"];

/** Real Protocord, SQLite and Discord SDK with synthetic Discord transport and no model connection. */
export async function followupHarness(path = ":memory:") {
  const client = new Client({ intents: [] });
  const deliveries: unknown[] = [];
  const packet = (id: string, content: string) => ({
    id,
    channel_id: FOLLOWUP_CHANNEL,
    type: 0,
    author: {
      id: HUMAN,
      username: "Synthetic user",
      discriminator: "0",
      avatar: null,
    },
    content,
    timestamp: "2026-11-11T12:00:00Z",
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
  client.rest.get = async (route) => {
    if (route === `/channels/${FOLLOWUP_CHANNEL}`)
      return { id: FOLLOWUP_CHANNEL, type: ChannelType.DM, recipients: [] };
    if (route === `/channels/${FOLLOWUP_CHANNEL}/messages/1000000000000000004`)
      return packet("1000000000000000004", "Schedule the synthetic reminder.");
    throw new Error(`Unexpected synthetic Discord GET: ${route}`);
  };
  client.rest.post = async (route, options) => {
    if (route !== `/channels/${FOLLOWUP_CHANNEL}/messages`)
      throw new Error(`Unexpected synthetic Discord POST: ${route}`);
    deliveries.push(options?.body);
    return packet(
      String(1000000000000000020n + BigInt(deliveries.length)),
      "Synthetic reminder.",
    );
  };
  const channel = await client.channels.fetch(FOLLOWUP_CHANNEL);
  if (!channel?.isTextBased()) throw new Error("Missing synthetic DM");
  const message = await channel.messages.fetch("1000000000000000004");
  const config = loadConfig({
    DISCORD_TOKEN: "synthetic",
    DISCORD_CLIENT_ID: BOT,
  });
  const llm = new LlmClient(config);
  const logger = createLogger(false);
  logger.level = "silent";
  const store = new HarnessStore(path);
  const settings = new SettingsStore(":memory:", { llmModel: "synthetic" });
  const contextStore = new ConversationContextStore(":memory:");
  const context: ActionContext = {
    client,
    config,
    llm,
    logger,
    settings,
    contextStore,
    memory: new RemoraMemoryClient(config),
    queue: new GenerationQueue(1),
    modelCatalog: new ModelCatalog(llm, logger),
    harness: { store, web: new WebClient() },
  };
  const registry = createPatchActionRegistry();
  registerHarnessActions(registry);
  const actions = await buildModelVisibleActions({
    message,
    context,
    registry,
  });
  const tools = toLlmTools(actions, { include: TOOLS });
  const compactPrompt = formatCompactActionsPrompt(actions);
  const wireResults: LlmMessage[] = [];

  /** Execute native or tagged synthetic calls through the caller's validation and mutation receipts. */
  async function invoke(
    name: string,
    args: Record<string, unknown>,
    native = true,
  ) {
    let receipt: unknown;
    await runToolTurn({
      messages: [{ role: "user", content: message.content }],
      generate: async (messages, continuation) => {
        if (!continuation)
          return native
            ? {
                content: "",
                toolCalls: [
                  {
                    id: "synthetic-call",
                    type: "function",
                    name,
                    arguments: JSON.stringify(args),
                  },
                ],
              }
            : {
                content: `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`,
              };
        const wireResult = messages.at(-1);
        if (!wireResult) throw new Error("Missing synthetic tool result");
        wireResults.push(wireResult);
        const result = wireResult.content;
        receipt = native
          ? JSON.parse(result)
          : JSON.parse(result.split("\n").slice(1).join("\n"))[0];
        return { content: "Synthetic action processed." };
      },
      registry,
      context,
      message,
      visibleMessageIds: new Set([message.id]),
      allowedTools: new Set(TOOLS),
      maxCalls: 3,
      maxInputChars: 100_000,
      nativeTools: tools,
      native,
      signal: new AbortController().signal,
    });
    return receipt;
  }
  return {
    context,
    client,
    message,
    store,
    tools,
    compactPrompt,
    wireResults,
    deliveries,
    invoke,
    nextRequest(content: string) {
      message.id = String(BigInt(message.id) + 1n);
      message.content = content;
    },
    close() {
      store.close();
      settings.close();
      contextStore.close();
      void client.destroy();
    },
  };
}
