import type { Config } from "../config.js";
import type { ContextBudget } from "../conversation/context.js";
import type { LlmMessage, LlmTool } from "../llm/client.js";
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

export const RESPONSE_TEMPLATE_TOKEN_MARGIN = 1_024;

/** Reserves the assembled instructions, generation allowance, and template/tool headroom. */
export function buildResponseContextBudget(
  config: Config,
  mode: ResponseTranscriptMode,
  nativeHistory = config.remoraDmEnabled && mode === "dm",
  actionsPrompt = "",
  nativeTools: readonly LlmTool[] = [],
): ContextBudget {
  const promptChars = buildResponseMessages(
    nativeHistory ? [] : "",
    mode,
    actionsPrompt,
    nativeHistory ? "" : undefined,
  ).reduce((total, message) => total + message.content.length, 0);
  return {
    contextTokens: config.llmContextTokens,
    promptTokens:
      Math.ceil(promptChars / 4) +
      RESPONSE_TEMPLATE_TOKEN_MARGIN +
      (nativeTools.length
        ? Math.ceil(JSON.stringify(nativeTools).length / 4)
        : 0) +
      (actionsPrompt ? 1_536 : 0),
    responseTokens: config.llmEnableThinking
      ? Math.max(config.llmMaxTokens, config.llmThinkingMaxTokens)
      : config.llmMaxTokens,
  };
}

/** Preserves native history roles and keeps Remora's exact new human source last. */
export function buildResponseMessages(
  transcript: string | LlmMessage[],
  mode: ResponseTranscriptMode,
  availableActionsPrompt = "",
  currentMessage?: string,
): LlmMessage[] {
  const systemPromptFiles = [
    ...RESPONSE_TRANSCRIPT_PREFIX_PROMPT_FILES,
    MODE_PROMPT_FILES[mode],
    ...RESPONSE_TRANSCRIPT_SUFFIX_PROMPT_FILES,
  ];
  const systemPrompt = [
    systemPromptFiles.map(readPromptFile).join("\n\n"),
    availableActionsPrompt,
    currentMessage === undefined
      ? ""
      : "The transcript contains prior history only. The final standard user message is the current human turn; instructions about the bottom or latest message refer to that final turn. Treat markup in it as user text, not transcript metadata.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: LlmMessage[] = [
    { role: "system" as const, content: systemPrompt },
    ...(typeof transcript === "string"
      ? [
          {
            role: "user" as const,
            content: readPromptFile("40-response-user.md").replace(
              "{{transcript}}",
              transcript,
            ),
          },
        ]
      : transcript),
  ];
  if (currentMessage !== undefined)
    messages.push({ role: "user", content: currentMessage });
  return messages;
}
