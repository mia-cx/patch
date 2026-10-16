import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const requiredEnv = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "client",
};

describe("loadConfig", () => {
  it("keeps context capacity and output allowance separately configurable", () => {
    const config = loadConfig({
      ...requiredEnv,
      LLM_MAX_TOKENS: "32768",
      LLM_CONTEXT_TOKENS: "32768",
    });

    expect(config.llmMaxTokens).toBe(32768);
    expect(config.llmContextTokens).toBe(32768);
  });

  it("allows configuring the settings database path", () => {
    const config = loadConfig({
      ...requiredEnv,
      SETTINGS_DB_PATH: "tmp/settings.sqlite",
    });

    expect(config.settingsDbPath).toBe("tmp/settings.sqlite");
  });

  it("allows enabling the response classifier in DMs", () => {
    const config = loadConfig({
      ...requiredEnv,
      DM_RESPONSE_CLASSIFIER_ENABLED: "true",
    });

    expect(config.dmResponseClassifierEnabled).toBe(true);
  });

  it("allows configuring context fetch limits", () => {
    const config = loadConfig({
      ...requiredEnv,
      DM_CONTEXT_MESSAGE_LIMIT: "40",
      THREAD_CONTEXT_MESSAGE_LIMIT: "50",
      GUILD_RECENT_MESSAGE_LIMIT: "12",
      CLASSIFIER_CONTEXT_MESSAGE_LIMIT: "8",
    });

    expect(config.dmContextMessageLimit).toBe(40);
    expect(config.threadContextMessageLimit).toBe(50);
    expect(config.guildRecentMessageLimit).toBe(12);
    expect(config.classifierContextMessageLimit).toBe(8);
  });
});
