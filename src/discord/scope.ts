import type { Config } from "../config.js";

type ScopeConfig = Pick<
  Config,
  "discordTrialDmChannelId" | "discordTrialGuild"
>;
type Location = { channelId: string; guildId?: string | null | undefined };

/** Scoped trials keep command registration disabled and restrict gateway handling. */
export function isScopedTrial(config: ScopeConfig): boolean {
  return Boolean(config.discordTrialDmChannelId || config.discordTrialGuild);
}

/** Both guild and channel must match; shared-channel opt-in never opens other places. */
export function allowsConversation(
  config: ScopeConfig,
  location: Location,
): boolean {
  if (!isScopedTrial(config)) return true;
  if (!location.guildId)
    return location.channelId === config.discordTrialDmChannelId;
  return (
    location.guildId === config.discordTrialGuild?.guildId &&
    location.channelId === config.discordTrialGuild.channelId
  );
}
