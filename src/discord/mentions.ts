import type { TranscriptParticipant } from "../conversation/types.js";

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;
const RAW_MENTION = /(\s?)<@([!&]?)([^<>\n]*)>(\s?)/g;
const PLAIN_MENTION = /(?<![\w<@/])@([\w.]+)/g;
const MASS_MENTIONS = new Set(["everyone", "here"]);

/**
 * Turn the model's mentions into what Discord should show: `@username` for a
 * participant becomes a real `<@id>` ping; unknown or ambiguous names stay plain
 * text. Raw `<@…>` forms keep only participant IDs: a name inside one is
 * resolved like `@name`, and unknown IDs and role mentions are dropped. Code is
 * left untouched. Mass mentions stay text; allowed mentions never ping them.
 */
export function repairMentions(
  text: string,
  participants: readonly TranscriptParticipant[],
): string {
  const ids = new Set(participants.map(({ id }) => id));
  const resolve = (name: string) => {
    const wanted = name.toLowerCase();
    for (const key of ["username", "name"] as const) {
      const matches = participants.filter(
        (participant) => participant[key].toLowerCase() === wanted,
      );
      if (matches.length) return matches.length === 1 ? matches[0] : undefined;
    }
  };
  const ping = (name: string) => {
    if (MASS_MENTIONS.has(name.toLowerCase())) return `@${name}`;
    const exact = resolve(name);
    if (exact) return `<@${exact.id}>`;
    // A sentence can end right after a username.
    const trimmed = name.replace(/\.+$/, "");
    const loose = trimmed === name ? undefined : resolve(trimmed);
    return loose ? `<@${loose.id}>${name.slice(trimmed.length)}` : `@${name}`;
  };
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(RAW_MENTION, (_, before, kind, inner, after) => {
              const value = inner.trim().replace(/^@/, "");
              if (kind !== "&" && ids.has(value))
                return `${before}<@${value}>${after}`;
              if (kind !== "&" && value && !/^\d+$/.test(value))
                return `${before}@${value}${after}`;
              return before && after ? before : "";
            })
            .replace(PLAIN_MENTION, (_, name: string) => ping(name)),
    )
    .join("");
}
