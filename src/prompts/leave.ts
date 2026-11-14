import type { LlmMessage } from "../llm/client.js";
import { RESPONSE_PROMPT_FILES } from "./common.js";
import { readPromptFile } from "./files.js";

type LeaveRequester = {
  id: string;
  name: string;
};

/** Persona and farewell brief, the recent thread in chat format, then the farewell request. */
export function buildLeaveMessages(
  requester: LeaveRequester,
  history: LlmMessage[],
): LlmMessage[] {
  const leavePrompt = readPromptFile("30-leave.md").replace(
    "{{requested_by}}",
    `${requester.name} (${requester.id})`,
  );

  return [
    {
      role: "system",
      content: [...RESPONSE_PROMPT_FILES.map(readPromptFile), leavePrompt].join(
        "\n\n",
      ),
    },
    ...history,
    { role: "user", content: readPromptFile("31-leave-user.md") },
  ];
}
