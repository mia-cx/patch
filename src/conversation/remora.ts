import { ChannelType, type Message, PermissionsBitField } from "discord.js";
import type { Config } from "../config.js";
import { allowsConversation } from "../discord/scope.js";
import type { RemoraRequest } from "../llm/remora.js";

/** A person's own memory: their DMs write here, and every server message they send is copied here. */
export const userBank = (userId: string) => `discord:user:${userId}`;

/**
 * Patch's own self: facts about her alone, set by the app's team through `/self`.
 * Read everywhere (it holds nothing about users) and never written by a conversation.
 */
export const SELF_BANK = "patch:self";

/**
 * Layered memory: a server-channel message is written to its channel, its server
 * and its speaker's user bank, but reads only the channel and server, so nothing
 * said in a DM surfaces in public. A DM reads and writes the speaker's user bank;
 * the trial DM also reads its earlier per-channel bank, which receives nothing new.
 */
export function buildRemoraRequest(
  config: Config,
  message: Message,
  memberRoleId?: string,
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
  const self = config.remoraSelfApiKey ? [SELF_BANK] : [];
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
      read_banks: [
        ...new Set([user, ...legacy, ...config.remoraReadBanks, ...self]),
      ],
      write_bank: user,
      turn,
    };
  }
  const channel = `discord:channel:${message.channelId}`;
  const guild = `discord:guild:${message.guildId}`;
  return {
    read_banks: [channel, guild, ...self],
    write_bank: channel,
    also_banks: [
      // Only what the whole server can see reaches the server bank.
      ...(isPublic(message, memberRoleId) ? [guild] : []),
      // The speaker's layer takes only their own words, never the channel's.
      { bank: user, actor: { bank: channel, role: "human", id: user } },
    ],
    turn,
  };
}

/**
 * A channel is public when the server's member role (default @everyone) can view it.
 * Private threads never are; other threads follow their parent channel.
 */
function isPublic(message: Message, memberRoleId: string | undefined) {
  const { channel, guild } = message;
  if (!guild || channel.type === ChannelType.PrivateThread) return false;
  const place = channel.isThread() ? channel.parent : channel;
  if (!place || !("permissionsFor" in place)) return false;
  const role =
    guild.roles.cache.get(memberRoleId ?? guild.id) ?? guild.roles.everyone;
  return place.permissionsFor(role).has(PermissionsBitField.Flags.ViewChannel);
}
