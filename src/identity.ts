import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Who Patch is. Taste and personality grow through Remora memory, not a fixed list. */
export type BotIdentity = {
  name: string;
  pronouns: string;
  aliases: string[];
  project: string;
  background: string;
};

export const DEFAULT_BOT_IDENTITY: BotIdentity = {
  name: "Patch",
  pronouns: "she/her",
  aliases: ["patch"],
  project: "Patch",
  background:
    "a cartoon bear plushie and the face of the Patch music/producer project",
};

let cachedIdentity: BotIdentity | undefined;

export function getBotIdentity(): BotIdentity {
  cachedIdentity ??= loadBotIdentity();
  return cachedIdentity;
}

export function reloadBotIdentity(): BotIdentity {
  cachedIdentity = loadBotIdentity();
  return cachedIdentity;
}

/** Reads `prompts/identity.json` (or BOT_IDENTITY_PATH), then BOT_* overrides. */
export function loadBotIdentity(
  env: NodeJS.ProcessEnv = process.env,
): BotIdentity {
  const file = loadIdentityFile(env);
  return normalizeIdentity({
    ...file,
    name: env.BOT_NAME ?? file.name,
    pronouns: env.BOT_PRONOUNS ?? file.pronouns,
    aliases: env.BOT_ALIASES ? splitCsv(env.BOT_ALIASES) : file.aliases,
    project: env.BOT_PROJECT ?? file.project,
    background: env.BOT_BACKGROUND ?? file.background,
  });
}

/** Replaces `{{identity.key}}` placeholders; lists render comma-separated. */
export function renderIdentityTemplate(
  template: string,
  identity: BotIdentity = getBotIdentity(),
): string {
  return template.replace(
    /{{\s*identity\.([a-zA-Z0-9_]+)\s*}}/g,
    (match, key) => {
      const value = identity[key as keyof BotIdentity];
      if (Array.isArray(value)) return value.join(", ");
      return typeof value === "string" ? value : match;
    },
  );
}

type IdentityInput = Partial<Record<keyof BotIdentity, unknown>>;

function loadIdentityFile(env: NodeJS.ProcessEnv): IdentityInput {
  const identityPath =
    env.BOT_IDENTITY_PATH ?? env.IDENTITY_PATH ?? "prompts/identity.json";
  const resolvedPath = resolve(process.cwd(), identityPath);
  if (!existsSync(resolvedPath)) return DEFAULT_BOT_IDENTITY;
  const parsed: unknown = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : DEFAULT_BOT_IDENTITY;
}

function normalizeIdentity(input: IdentityInput): BotIdentity {
  const name = stringOr(input.name, DEFAULT_BOT_IDENTITY.name);
  return {
    name,
    pronouns: stringOr(input.pronouns, DEFAULT_BOT_IDENTITY.pronouns),
    aliases: nonEmptyStrings(input.aliases, [name.toLowerCase()]),
    project: stringOr(input.project, name),
    background: stringOr(input.background, DEFAULT_BOT_IDENTITY.background),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item.trim()] : []))
    : typeof value === "string"
      ? splitCsv(value)
      : [];
  return items.length ? items : fallback;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
