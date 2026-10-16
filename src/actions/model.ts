import {
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
} from "discord.js";
import { Schema } from "effect";
import { slashCommand } from "protocord";
import { getBotIdentity } from "../identity.js";
import { type Action, type ActionContext, actionInput } from "./context.js";

const MODEL_COMMAND_NAME = "model";

const ModelArgs = Schema.Struct({ name: Schema.optional(Schema.String) });

export const modelAction: Action<typeof ModelArgs.Type, string> = {
  name: "model",
  description: "Show or switch the current LLM model.",
  input: actionInput(ModelArgs),
  triggers: [
    slashCommand({
      name: MODEL_COMMAND_NAME,
      description: `Show or switch ${getBotIdentity().name}'s current LLM model`,
      usage: "/model [name:<model alias>]",
      registration: { dmPermission: true },
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "name",
          description: "Model alias/name to use, e.g. gemma-4-e4b-it",
          required: false,
          autocomplete: true,
        },
      ],
      parse: (interaction) => ({
        name: interaction.options.getString("name")?.trim() || undefined,
      }),
      autocomplete: {
        availability: () => ({ available: true }),
        access: { kind: "authorized", authorization: () => "owner" },
        complete: handleModelAutocomplete,
      },
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => "owner",
  async execute(invocation, context) {
    const { name } = invocation.input;
    if (!name) {
      return `current model: ${context.settings.getLlmModel()}`;
    }

    context.settings.setLlmModel(name);
    context.logger.info(
      { userId: invocation.requester?.id, model: name },
      "switched llm model",
    );

    return `model set to ${name}`;
  },
};

async function handleModelAutocomplete(
  interaction: AutocompleteInteraction,
  context: ActionContext,
) {
  const focused = interaction.options.getFocused().trim();
  try {
    const models = await context.modelCatalog.getModels();
    return rankModelChoices(models, focused, context.settings.getLlmModel())
      .slice(0, 25)
      .map((model) => ({ name: model, value: model }));
  } catch (error) {
    context.logger.warn({ error }, "failed to autocomplete model choices");
    const currentModel = context.settings.getLlmModel();
    return [{ name: currentModel, value: currentModel }];
  }
}

function rankModelChoices(
  models: string[],
  query: string,
  currentModel: string,
): string[] {
  return [...new Set([currentModel, ...models])]
    .map((model) => ({ model, score: scoreModelChoice(model, query) }))
    .filter((item) => item.score > Number.NEGATIVE_INFINITY)
    .sort(
      (left, right) =>
        right.score - left.score || left.model.localeCompare(right.model),
    )
    .map((item) => item.model);
}

function scoreModelChoice(model: string, query: string): number {
  if (!query) return 0;
  const normalizedModel = model.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedModel === normalizedQuery) return 1000;
  if (normalizedModel.startsWith(normalizedQuery)) return 900 - model.length;
  if (normalizedModel.includes(normalizedQuery)) return 700 - model.length;

  const subsequenceScore = scoreSubsequence(normalizedModel, normalizedQuery);
  return subsequenceScore ?? Number.NEGATIVE_INFINITY;
}

function scoreSubsequence(model: string, query: string): number | undefined {
  let queryIndex = 0;
  let gapCount = 0;

  for (const character of model) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === query.length) return 400 - gapCount;
      continue;
    }

    gapCount += 1;
  }

  return undefined;
}
