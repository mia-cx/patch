import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { allowsConversation, isScopedTrial } from "./scope.js";

const env = {
  DISCORD_TOKEN: "test",
  DISCORD_CLIENT_ID: "1000000000000000001",
  DISCORD_TRIAL_DM_CHANNEL_ID: "1000000000000000002",
  DISCORD_TRIAL_GUILD_ID: "1000000000000000003",
  DISCORD_TRIAL_GUILD_CHANNEL_ID: "1000000000000000004",
};

describe("scoped Discord conversations", () => {
  // Proves adding a guild channel keeps both places available and every other guild, channel and DM closed.
  it("opens only the configured DM and exact guild/channel pair", () => {
    const config = loadConfig(env);
    expect(isScopedTrial(config)).toBe(true);
    for (const [channelId, guildId, allowed] of [
      [env.DISCORD_TRIAL_DM_CHANNEL_ID, null, true],
      [env.DISCORD_TRIAL_GUILD_CHANNEL_ID, env.DISCORD_TRIAL_GUILD_ID, true],
      ["1000000000000000005", env.DISCORD_TRIAL_GUILD_ID, false],
      [env.DISCORD_TRIAL_GUILD_CHANNEL_ID, "1000000000000000006", false],
      [env.DISCORD_TRIAL_GUILD_CHANNEL_ID, null, false],
      [env.DISCORD_TRIAL_DM_CHANNEL_ID, env.DISCORD_TRIAL_GUILD_ID, false],
      ["1000000000000000007", null, false],
    ] as const)
      expect(allowsConversation(config, { channelId, guildId })).toBe(allowed);
  });

  // Proves a partial or malformed opt-in fails startup instead of accidentally enabling unrestricted Discord handling.
  it.each([
    { DISCORD_TRIAL_GUILD_ID: "", DISCORD_TRIAL_GUILD_CHANNEL_ID: "123" },
    { DISCORD_TRIAL_GUILD_ID: "123", DISCORD_TRIAL_GUILD_CHANNEL_ID: "" },
    {
      DISCORD_TRIAL_GUILD_ID: "not-an-id",
      DISCORD_TRIAL_GUILD_CHANNEL_ID: "123",
    },
  ])("rejects incomplete guild scope %j", (scope) => {
    expect(() => loadConfig({ ...env, ...scope })).toThrow();
  });
});
