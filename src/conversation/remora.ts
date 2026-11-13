import { ChannelType, type Message } from "discord.js";
import type { Config } from "../config.js";
import { allowsConversation } from "../discord/scope.js";
import type { RemoraRequest } from "../llm/remora.js";

/** A person's own memory: their DMs write here, and every server message they send is copied here. */
export const userBank = (userId: string) => `discord:user:${userId}`;

/**
 * Layered memory: a server-channel message is written to its channel, its server
 * and its speaker's user bank, but reads only the channel and server, so nothing
 * said in a DM surfaces in public. A DM reads and writes the speaker's user bank;
 * the trial DM also reads its earlier per-channel bank, which receives nothing new.
 */
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
    config.discordTrialGuild.channelIds.includes(message.channelId);
  if (!personal && !shared) return;
  const user = userBank(message.author.id);
  const turn = {
    id: `discord:message:${message.id}`,
    revision: message.editedTimestamp ?? 0,
    speaker_id: user,
    text: message.content,
  };
  if (personal) {
    const legacy =
      message.channelId === config.discordTrialDmChannelId
        ? [`discord:dm:${message.channelId}`]
        : [];
    return {
      read_banks: [...new Set([user, ...legacy, ...config.remoraReadBanks])],
      write_bank: user,
      turn,
    };
  }
  const channel = `discord:channel:${message.channelId}`;
  const guild = `discord:guild:${message.guildId}`;
  return {
    read_banks: [channel, guild],
    write_bank: channel,
    also_banks: [
      guild,
      // The speaker's layer takes only their own words, never the channel's.
      { bank: user, actor: { bank: channel, role: "human", id: user } },
    ],
    turn,
  };
}
