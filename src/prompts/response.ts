import type { Config } from "../config.js";
import type { ContextBudget } from "../conversation/context.js";
import {
  RESPONSE_TRANSCRIPT_PREFIX_PROMPT_FILES,
  RESPONSE_TRANSCRIPT_SUFFIX_PROMPT_FILES,
} from "./common.js";
import { readPromptFile } from "./files.js";

export type ResponseTranscriptMode = "dm" | "global" | "thread";

const MODE_PROMPT_FILES: Record<ResponseTranscriptMode, string> = {
  dm: "system/05-transcript-dm.md",
  global: "system/05-transcript-global.md",
  thread: "system/05-transcript-thread.md",
};

const PROMPT_TOKEN_MARGIN = 1_024;

/** Reserves the assembled instructions, generation allowance, and template/tool headroom. */
export function buildResponseContextBudget(
  config: Config,
  mode: ResponseTranscriptMode,
): ContextBudget {
  const promptChars = buildResponseMessages("", mode).reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return {
    contextTokens: config.llmContextTokens,
    promptTokens: Math.ceil(promptChars / 4) + PROMPT_TOKEN_MARGIN,
    responseTokens: config.llmEnableThinking
      ? Math.max(config.llmMaxTokens, config.llmThinkingMaxTokens)
      : config.llmMaxTokens,
  };
}

export function buildResponseMessages(
  transcript: string,
  mode: ResponseTranscriptMode,
  availableActionsPrompt = "",
) {
  const systemPromptFiles = [
    ...RESPONSE_TRANSCRIPT_PREFIX_PROMPT_FILES,
    MODE_PROMPT_FILES[mode],
    ...RESPONSE_TRANSCRIPT_SUFFIX_PROMPT_FILES,
  ];
  const systemPrompt = [
    systemPromptFiles.map(readPromptFile).join("\n\n"),
    availableActionsPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system" as const, content: systemPrompt },
    {
      role: "user" as const,
      content: readPromptFile("40-response-user.md").replace(
        "{{transcript}}",
        transcript,
      ),
    },
  ];
}
