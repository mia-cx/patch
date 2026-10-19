import { ChannelType, type Message } from "discord.js";
import type { Config } from "../config.js";
import { allowsConversation } from "../discord/scope.js";
import type { RemoraRequest } from "../llm/remora.js";

/** Keep personal banks in DMs; opted-in guild turns read shared banks and write only their channel. */
export function buildRemoraRequest(
  config: Config,
  message: Message,
): RemoraRequest | undefined {
  if (!message.content.trim() || !allowsConversation(config, message)) return;

  const personal =
    message.channel.type === ChannelType.DM && config.remoraDmEnabled;
  const shared =
    message.guildId &&
    config.discordTrialGuild &&
    message.guildId === config.discordTrialGuild.guildId &&
    message.channelId === config.discordTrialGuild.channelId;
  if (!personal && !shared) return;
  const bank = `discord:${personal ? "dm" : "channel"}:${message.channelId}`;
  return {
    read_banks: personal
      ? [...new Set([bank, ...config.remoraReadBanks])]
      : [bank, `discord:guild:${message.guildId}`],
    write_bank: bank,
    turn: {
      id: `discord:message:${message.id}`,
      revision: message.editedTimestamp ?? 0,
      speaker_id: `discord:user:${message.author.id}`,
      text: message.content,
    },
  };
}
