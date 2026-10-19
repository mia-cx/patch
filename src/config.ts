import { Effect, Schema } from "effect";

export type Config = {
  discordToken: string;
  discordClientId: string;
  discordTrialDmChannelId: string;
  discordTrialGuild: { guildId: string; channelId: string } | undefined;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  settingsDbPath: string;
  llmContextTokens: number;
  llmEnableThinking: boolean;
  llmThinkingMaxTokens: number;
  llmThinkingTimeoutMs: number;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  llmTemperature: number;
  llmToolMode: "auto" | "native" | "tagged" | "off";
  maxToolCalls: number;
  remoraDmEnabled: boolean;
  remoraReadBanks: readonly string[];
  botOwnerUserIds: ReadonlySet<string>;
  debugLogging: boolean;
  llmTraceLogging: boolean;
  responseClassifierEnabled: boolean;
  dmResponseClassifierEnabled: boolean;
  pronounOverrides: ReadonlyMap<string, string>;
  activityUpdatesEnabled: boolean;
  activityUpdateIntervalMs: number;
  passiveResponseTtlMs: number;
  maxGlobalConcurrency: number;
  dmContextMessageLimit: number;
  threadContextMessageLimit: number;
  guildRecentMessageLimit: number;
  classifierContextMessageLimit: number;
};

const PositiveInteger = Schema.Number.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const ConfigSchema = Schema.Struct({
  discordToken: Schema.String.check(Schema.isMinLength(1)),
  discordClientId: Schema.String.check(Schema.isMinLength(1)),
  discordTrialDmChannelId: Schema.String,
  discordTrialGuild: Schema.UndefinedOr(
    Schema.Struct({
      guildId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
      channelId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
    }),
  ),
  llmBaseUrl: Schema.String.check(Schema.isMinLength(1)),
  llmModel: Schema.String.check(Schema.isMinLength(1)),
  llmApiKey: Schema.String.check(Schema.isMinLength(1)),
  settingsDbPath: Schema.String.check(Schema.isMinLength(1)),
  llmContextTokens: PositiveInteger,
  llmEnableThinking: Schema.Boolean,
  llmThinkingMaxTokens: PositiveInteger,
  llmThinkingTimeoutMs: PositiveInteger,
  llmTimeoutMs: PositiveInteger,
  llmMaxTokens: PositiveInteger,
  llmTemperature: NonNegativeNumber,
  llmToolMode: Schema.Literals(["auto", "native", "tagged", "off"]),
  maxToolCalls: PositiveInteger,
  remoraDmEnabled: Schema.Boolean,
  remoraReadBanks: Schema.Array(Schema.String),
  botOwnerUserIds: Schema.ReadonlySet(Schema.String),
  debugLogging: Schema.Boolean,
  llmTraceLogging: Schema.Boolean,
  responseClassifierEnabled: Schema.Boolean,
  dmResponseClassifierEnabled: Schema.Boolean,
  pronounOverrides: Schema.ReadonlyMap(Schema.String, Schema.String),
  activityUpdatesEnabled: Schema.Boolean,
  activityUpdateIntervalMs: PositiveInteger,
  passiveResponseTtlMs: PositiveInteger,
  maxGlobalConcurrency: PositiveInteger,
  dmContextMessageLimit: PositiveInteger,
  threadContextMessageLimit: PositiveInteger,
  guildRecentMessageLimit: PositiveInteger,
  classifierContextMessageLimit: PositiveInteger,
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Effect.runSync(loadConfigEffect(env));
}

export function loadConfigEffect(env: NodeJS.ProcessEnv = process.env) {
  return Effect.sync(() =>
    Schema.decodeUnknownSync(ConfigSchema)({
      discordToken: required(env, "DISCORD_TOKEN"),
      discordClientId: required(env, "DISCORD_CLIENT_ID"),
      discordTrialDmChannelId: env.DISCORD_TRIAL_DM_CHANNEL_ID?.trim() ?? "",
      discordTrialGuild:
        env.DISCORD_TRIAL_GUILD_ID?.trim() ||
        env.DISCORD_TRIAL_GUILD_CHANNEL_ID?.trim()
          ? {
              guildId: env.DISCORD_TRIAL_GUILD_ID?.trim() ?? "",
              channelId: env.DISCORD_TRIAL_GUILD_CHANNEL_ID?.trim() ?? "",
            }
          : undefined,
      llmBaseUrl: trimTrailingSlash(
        env.LLM_BASE_URL ?? "http://10.0.3.2:8080/v1",
      ),
      llmModel: env.LLM_MODEL ?? "gemma-4-e4b-it",
      llmApiKey: env.LLM_API_KEY ?? "local",
      settingsDbPath: env.SETTINGS_DB_PATH ?? "data/patch.sqlite",
      llmContextTokens: integer(env.LLM_CONTEXT_TOKENS, 32_768),
      llmEnableThinking: boolean(env.LLM_ENABLE_THINKING, false),
      llmThinkingMaxTokens: integer(env.LLM_THINKING_MAX_TOKENS, 1024),
      llmThinkingTimeoutMs: integer(env.LLM_THINKING_TIMEOUT_MS, 20_000),
      llmTimeoutMs: integer(env.LLM_TIMEOUT_MS, 120_000),
      llmMaxTokens: integer(env.LLM_MAX_TOKENS, 512),
      llmTemperature: number(env.LLM_TEMPERATURE, 0.55),
      llmToolMode: env.LLM_TOOL_MODE ?? "auto",
      maxToolCalls: Math.min(integer(env.MAX_TOOL_CALLS, 3), 8),
      remoraDmEnabled: boolean(env.REMORA_DM_ENABLED, false),
      remoraReadBanks: splitCsv(env.REMORA_READ_BANKS),
      botOwnerUserIds: new Set(splitCsv(env.BOT_OWNER_USER_IDS)),
      debugLogging: boolean(env.DEBUG_LOGGING, false),
      llmTraceLogging: boolean(env.LLM_TRACE_LOGGING, false),
      responseClassifierEnabled: boolean(
        env.RESPONSE_CLASSIFIER_ENABLED,
        false,
      ),
      dmResponseClassifierEnabled: boolean(
        env.DM_RESPONSE_CLASSIFIER_ENABLED,
        false,
      ),
      pronounOverrides: parseKeyValueMap(env.DISCORD_PRONOUN_OVERRIDES),
      activityUpdatesEnabled: boolean(
        env.ACTIVITY_UPDATES_ENABLED ?? env.STATUS_UPDATES_ENABLED,
        false,
      ),
      activityUpdateIntervalMs: integer(
        env.ACTIVITY_UPDATE_INTERVAL_MS ?? env.STATUS_UPDATE_INTERVAL_MS,
        45 * 60 * 1000,
      ),
      passiveResponseTtlMs: integer(env.PASSIVE_RESPONSE_TTL_MS, 30_000),
      maxGlobalConcurrency: integer(env.MAX_GLOBAL_CONCURRENCY, 1),
      dmContextMessageLimit: integer(env.DM_CONTEXT_MESSAGE_LIMIT, 30),
      threadContextMessageLimit: integer(env.THREAD_CONTEXT_MESSAGE_LIMIT, 30),
      guildRecentMessageLimit: integer(env.GUILD_RECENT_MESSAGE_LIMIT, 10),
      classifierContextMessageLimit: integer(
        env.CLASSIFIER_CONTEXT_MESSAGE_LIMIT,
        12,
      ),
    }),
  );
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function number(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseKeyValueMap(value: string | undefined): Map<string, string> {
  const entries = splitCsv(value).flatMap((item): Array<[string, string]> => {
    const separator = item.includes("=") ? "=" : ":";
    const [rawKey, ...rawValueParts] = item.split(separator);
    const key = rawKey?.trim();
    const parsedValue = rawValueParts.join(separator).trim();
    return key && parsedValue ? [[key, parsedValue]] : [];
  });

  return new Map(entries);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
