import { Schema } from "effect";
import { slashCommand } from "protocord";
import { getBotIdentity } from "../identity.js";
import { reloadPromptFiles } from "../prompts/files.js";
import { type Action, actionInput } from "./context.js";

const RELOAD_COMMAND_NAME = "reload";
const ReloadArgs = Schema.Struct({});

export const reloadRuntimeAction: Action<typeof ReloadArgs.Type, string> = {
  name: "reload_runtime",
  description: "Reload prompt and identity files.",
  input: actionInput(ReloadArgs),
  triggers: [
    slashCommand({
      name: RELOAD_COMMAND_NAME,
      description: `Reload ${getBotIdentity().name}'s prompt and identity files`,
      usage: "/reload",
      registration: { dmPermission: true },
      parse: () => ({}),
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => "owner",
  async execute(invocation, context) {
    const cleared = reloadPromptFiles();
    context.logger.info(
      { userId: invocation.requester?.id, clearedPrompts: cleared },
      "reloaded prompt and identity files",
    );

    return `reloaded prompts and identity. cleared ${cleared} cached files.`;
  },
};
