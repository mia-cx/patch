import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
 * Show `pages` in the command's deferred reply, with ⏮ ◀ [n / N] ▶ ⏭ buttons while there is more than one.
 * The page-number button asks for a page to jump to. Clicks edit the same message; after `PAGING_MS`
 * the buttons go away. `files` stay on every page.
 */
export async function showPages(
  interaction: ChatInputCommandInteraction,
  pages: readonly string[],
  logger: Logger,
  files: readonly AttachmentBuilder[] = [],
) {
  let at = 0;
  const last = pages.length - 1;
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
  const jump = async (click: ButtonInteraction) => {
    const id = `page:jump:${click.id}`;
    await click.showModal(jumpModal(id, pages.length));
    const submit = await click.awaitModalSubmit({
      time: PAGING_MS,
      filter: (modal) => modal.customId === id,
    });
    const page = Number(submit.fields.getTextInputValue("page"));
    if (Number.isInteger(page)) at = Math.min(Math.max(page - 1, 0), last);
    if (submit.isFromMessage()) await submit.update(view());
  };
  collector.on("collect", (click) => {
    if (click.customId === "page:at") {
      jump(click).catch(failed);
      return;
    }
    at =
      {
        "page:first": 0,
        "page:previous": Math.max(at - 1, 0),
        "page:next": Math.min(at + 1, last),
        "page:last": last,
      }[click.customId] ?? at;
    click.update(view()).catch(failed);
  });
  collector.on("end", () => {
    interaction.editReply({ components: [] }).catch(failed);
  });
}

function buttons(at: number, count: number) {
  const button = (id: string, disabled: boolean) =>
    new ButtonBuilder()
      .setCustomId(`page:${id}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("first", at === 0).setEmoji("⏮️"),
    button("previous", at === 0).setEmoji("◀️"),
    button("at", false).setLabel(`${at + 1} / ${count}`),
    button("next", at === count - 1).setEmoji("▶️"),
    button("last", at === count - 1).setEmoji("⏭️"),
  );
}

function jumpModal(id: string, count: number) {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle("Go to page")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("page")
          .setLabel(`Page (1–${count})`)
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(String(count).length)
          .setRequired(true),
      ),
    );
}
