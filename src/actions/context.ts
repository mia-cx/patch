import type { Client, Message } from "discord.js";
import { Schema } from "effect";
import type {
  ActionInput,
  ActionInvocation,
  Action as ProtocordAction,
  ActionRegistry as ProtocordRegistry,
} from "protocord";
import type { Config } from "../config.js";
import type { ConversationContextStore } from "../conversation/store.js";
import type { LlmClient } from "../llm/client.js";
import type { ModelCatalog } from "../llm/model-catalog.js";
import type { Logger } from "../logger.js";
import type { RemoraMemoryClient } from "../memory/client.js";
import type { MemoryScope } from "../memory/scope.js";
import type { GenerationQueue } from "../queue.js";
import type { SettingsStore } from "../settings/store.js";
import type { HarnessStore } from "../tools/store.js";
import type { WebClient } from "../tools/web.js";

export type ActionPermission =
  | "owner"
  | "delete_messages"
  | {
      kind: "memory";
      scope: MemoryScope;
      operation: "read" | "forget";
    };
export type Action<Input, Output = void> = ProtocordAction<
  Input,
  Output,
  ActionContext,
  ActionPermission
>;
export type ActionRegistry = ProtocordRegistry<ActionContext, ActionPermission>;
export type { ActionInvocation };

export type ActionContext = {
  client: Pick<Client, "channels"> & { user: { id: string } | null };
  config: Config;
  llm: LlmClient;
  memory: RemoraMemoryClient;
  logger: Logger;
  queue: GenerationQueue;
  modelCatalog: ModelCatalog;
  settings: SettingsStore;
  contextStore: ConversationContextStore;
  harness?: { store: HarnessStore; web: WebClient };
  toolScope?: {
    messageIds: ReadonlySet<string>;
    signal: AbortSignal;
    nonce: string;
  };
  channel?: Pick<Message["channel"], "isThread"> | null | undefined;
};

/** Adapt Effect input validation and JSON Schema to Protocord's action contract. */
export function actionInput<Input extends Schema.Decoder<unknown>>(
  schema: Input,
): ActionInput<Input["Type"]> {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    parse: Schema.decodeUnknownSync(schema, { onExcessProperty: "error" }),
    jsonSchema: { ...document.schema, $defs: document.definitions },
  };
}
