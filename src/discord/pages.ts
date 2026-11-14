import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
} from "discord.js";
import type { Logger } from "../logger.js";

/** Room for one page, under Discord's 2,000-character message limit. */
const PAGE_CHARS = 1_900;
/** Buttons stop under the interaction token's 15-minute life, so the last edit can still remove them. */
const PAGING_MS = 14 * 60_000;
const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

/**
 * `blocks` packed into pages of at most `limit` characters, joined by `separator`.
 * A block that fits a page never splits across two; a longer one fills whole pages of its own.
 */
export function paginate(
  blocks: readonly string[],
  separator = "\n",
  limit = PAGE_CHARS,
): string[] {
  const pages: string[] = [];
  let page = "";
  for (const block of blocks) {
    if (page && page.length + separator.length + block.length > limit) {
      pages.push(page);
      page = "";
    }
    if (block.length > limit) {
      if (page) pages.push(page);
      for (let start = 0; start < block.length; start += limit)
        pages.push(block.slice(start, start + limit));
      page = "";
    } else page = page ? `${page}${separator}${block}` : block;
  }
  return page ? [...pages, page] : pages;
}

/**
 * Show `pages` in the command's deferred reply, with ◀ / ▶ buttons while there is more than one.
 * Clicks edit the same message; after `PAGING_MS` the buttons go away. `files` stay on every page.
 */
export async function showPages(
  interaction: ChatInputCommandInteraction,
  pages: readonly string[],
  logger: Logger,
  files: readonly AttachmentBuilder[] = [],
) {
  let at = 0;
  const view = () => ({
    content: pages[at] ?? "",
    components: pages.length > 1 ? [buttons(at, pages.length)] : [],
    allowedMentions: NO_MENTIONS,
  });
  const message = await interaction.editReply({ ...view(), files: [...files] });
  if (pages.length <= 1) return;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGING_MS,
  });
  const failed = (error: unknown) =>
    logger.warn(
      { error, interactionId: interaction.id },
      "memory page did not update",
    );
  collector.on("collect", (click) => {
    at = Math.min(
      Math.max(at + (click.customId === "page:next" ? 1 : -1), 0),
      pages.length - 1,
    );
    click.update(view()).catch(failed);
  });
  collector.on("end", () => {
    interaction.editReply({ components: [] }).catch(failed);
  });
}

function buttons(at: number, count: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("page:previous")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(at === 0),
    new ButtonBuilder()
      .setCustomId("page:at")
      .setLabel(`${at + 1} / ${count}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("page:next")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(at === count - 1),
  );
}
