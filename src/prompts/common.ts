export const RESPONSE_TRANSCRIPT_PREFIX_PROMPT_FILES = [
  "system/01-role.md",
  "system/02-identity.md",
  "system/03-participant-relations.md",
  "system/04-transcript.md",
];

export const RESPONSE_TRANSCRIPT_SUFFIX_PROMPT_FILES = [
  "system/06-output.md",
  "system/07-safety.md",
  "system/12-helpfulness.md",
  "system/13-splitting.md",
  "system/14-mentions.md",
];

export const RESPONSE_TRANSCRIPT_PROMPT_FILES = [
  ...RESPONSE_TRANSCRIPT_PREFIX_PROMPT_FILES,
  ...RESPONSE_TRANSCRIPT_SUFFIX_PROMPT_FILES,
];
