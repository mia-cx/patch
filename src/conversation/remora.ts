import { ChannelType, type Message } from "discord.js";
import type { Config } from "../config.js";
import type { RemoraRequest } from "../llm/remora.js";

/** Maps a new one-to-one DM to its bank and stable, revisioned source identity. */
export function buildRemoraRequest(
  config: Config,
  message: Message,
): RemoraRequest | undefined {
  if (!config.remoraDmEnabled || message.channel.type !== ChannelType.DM)
    return;
  if (!message.content.trim()) return;

  const bank = `discord:dm:${message.channelId}`;
  return {
    read_banks: [...new Set([bank, ...config.remoraReadBanks])],
    write_bank: bank,
    turn: {
      id: `discord:message:${message.id}`,
      revision: message.editedTimestamp ?? 0,
      speaker_id: `discord:user:${message.author.id}`,
      text: message.content,
    },
  };
}
