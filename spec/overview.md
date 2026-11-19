# Patch Overview

## Name

**Patch** is the chosen name for the assistant.

Patch is Mia's artist alias and mascot, already has a visual design, and fits a server named **The Quilt**. It also works as both a noun and a name: a patch can repair, connect, and add color.

## Goal

Patch is a Discord bot harness for a locally hosted LLM. Patch is primarily a persona, presence, and conversation partner in Discord, not a traditional assistant. She can do assistant-style work when asked, but her default mode is to participate like a server character with her own voice, taste, boundaries, and timing.

The first backend target is a local model served over REST by `llama.cpp`, preferably through an OpenAI-compatible API. The expected deployment is `llama.cpp` running directly on a Debian VM with CUDA/NVIDIA GPU access, while the Patch harness may run as a Docker container on the same VM and call the runner over HTTP.

## Core principles

1. **Discord is the source of truth.** Conversation state is reconstructed from Discord messages, replies, thread membership, and message history.
2. **Patch is a presence first.** She can help, summarize, search, and explain, but her primary directive is to feel like a real conversation partner rather than a productivity assistant.
3. **Final visible output is Discord Markdown.** No transcript XML, JSON wrappers, or metadata in final Discord-visible answers.
4. **Prompt construction is separate from Discord handling.** Discord event code should not know how prompts are assembled.
5. **The LLM client is backend-agnostic.** The REST client should be swappable between llama.cpp, OpenAI-compatible servers, Ollama, vLLM, or other providers.
6. **Thread membership is canonical.** If Patch is a member of a Discord thread/forum post, she may participate. If she has left, she ignores the thread until mentioned again.

## Version shape

- **v0:** prove direct Discord + LLM responses. No planner, no threads, no tools.
- **v1:** add thread participation, classifier/planner, queueing, summaries, and safer Discord operations.
- **v2:** add tool calling, web search/fetch, Markdown receipts, and user preference prompts.
- **v3:** add Discord components, modals, bot actions, and richer interactive rendering.
- **Onwards:** compaction, multimodal support, in-flight rewrite/cancellation, style training, and Flarecord.

## Technology choice

Use **TypeScript + discord.js** for early versions.

Reasons:

- Discord APIs, slash commands, context menu commands, thread membership, and interaction handling are faster to iterate with `discord.js`.
- The hard parts are conversation reconstruction, prompt design, personality, and natural participation rules, not low-level Discord protocol plumbing.
- Keep `discord.js` behind an adapter so Flarecord or a direct gateway client can replace it later.

Future possibility: **Flarecord**, a Cloudflare Workers/Durable Objects Discord API wrapper. Discord now allows Cloudflare egress IPs to connect to the Gateway, but Flarecord should be a later infrastructure project, not a v0/v1 dependency.

## Durable architecture

```text
Discord event
  -> Discord adapter
  -> Conversation builder
  -> Prompt builder
  -> LLM REST client
  -> Discord responder
```

Later tool/action versions insert a loop between prompt building and response:

```text
Prompt builder
  -> Tool/action loop
  -> LLM REST client
  -> Discord responder
```

## Logging

Use Pino for structured logging. Logs should be semantically rich but not noisy.

Guidelines:

- Prefer structured fields over prose-heavy log messages.
- Include operation/job/channel/thread/message IDs where useful.
- Include error causes and relevant transport/backend metadata on failures.
- Production logs only failures/error traces by default.
- Prompt/transcript logging requires explicit debug/dev mode.
- Logs must not become a shadow conversation store.

## Suggested module layout

```text
src/
  discord/
    adapter.ts
    discord-js-adapter.ts
    responder.ts
    commands.ts
    message-routing.ts
  conversation/
    transcript.ts
    reply-chain.ts
    thread-context.ts
    context-window.ts
  prompts/
    system.ts
    response.ts
    classifier.ts
    tools.ts              # v2+
    user-preferences.ts   # v2+
  state/
    preferences.ts        # v2+
    turn-state.ts         # v2+
  llm/
    client.ts
    openai-compatible-client.ts
    stream.ts             # v2+ if needed
  tools/                  # v2+
    registry.ts
    web-search.ts
    web-fetch.ts
  config.ts
  index.ts
```

## Transcript representation

Patch provides the LLM with XML/HTML-like transcript blocks. This format is input context only.

- Human and other-bot Discord messages use `<message>`.
- Patch-authored bot messages use `<response>` so the model knows what she herself already said.
- The bottom/latest transcript block is the trigger for the current run. No explicit `trigger="true"` marker is required unless implementation experience proves it useful.

Classic reply-chain example with preceding local neighbors:

```xml
<message author_name="sam" pronouns="missing" author_id="77" id="121" timestamp="2026-06-02T11:59:40Z" context="neighbor">
wait did deploy already happen?
</message>

<message author_name="riley" pronouns="missing" author_id="88" id="122" timestamp="2026-06-02T11:59:50Z" context="neighbor">
not yet, cache invalidation is still being weird
</message>

<message author_name="mia" pronouns="she/her, they/them, mia/mia's" author_id="42" id="123" timestamp="2026-06-02T12:00:00Z" context="reply_chain">
@Patch can you look at this?
</message>

<response author_name="Patch" pronouns="she/her" author_id="patch" id="124" timestamp="2026-06-02T12:00:30Z" reply_to="123" context="reply_chain">
Yeah, this smells like the cache being stale rather than the write failing.
</response>

<message author_name="alex" pronouns="missing" author_id="99" id="125" timestamp="2026-06-02T12:01:00Z" reply_to="124" context="reply_chain">
Why cache and not replication lag?
</message>
```

Thread-context example:

```xml
<message author_name="mia" pronouns="she/her, they/them, mia/mia's" author_id="42" id="223" timestamp="2026-06-02T12:00:00Z" context="thread">
@Patch can you look at this?
</message>

<response author_name="Patch" pronouns="she/her" author_id="patch" id="224" timestamp="2026-06-02T12:00:30Z" reply_to="223" context="thread">
Yeah, this smells like the cache being stale rather than the write failing.
</response>

<message author_name="alex" pronouns="missing" author_id="99" id="225" timestamp="2026-06-02T12:01:00Z" reply_to="223" context="thread">
I think replication lag is still plausible.
</message>

<message author_name="mia" pronouns="she/her, they/them, mia/mia's" author_id="42" id="226" timestamp="2026-06-02T12:01:30Z" reply_to="225" context="thread">
What would distinguish those two?
</message>
```

## Transcript attributes

Useful `<message>` attributes:

- `author_name`: server display name if available, fallback username
- `pronouns`: speaker pronoun metadata, including `missing` when unknown
- `author_id`
- `id`
- `author_is_bot="true"`, when the author is another bot
- `timestamp`
- `reply_to`, when the Discord message is a reply
- `context="reply_chain"`, direct reconstructed reply chain
- `context="neighbor"`, ambient nearby messages that may be irrelevant
- `context="thread"`, linear thread context slice

Useful `<response>` attributes:

- `author_name="Patch"`
- `pronouns="she/her"`
- `author_id="patch"`, stable synthetic identity produced by the harness
- `id`, for a single Patch message
- `message_ids`, for a normalized multi-message Patch response
- `discord_author_id`, optional real Discord bot user ID for debugging
- `timestamp`
- `reply_to`, when the first Patch message in the response is a reply
- `context="reply_chain" | "neighbor" | "thread"`

## Input/output safety

Discord content must be escaped before insertion into transcript blocks. User-controlled content must not be able to inject fake transcript messages, system prompts, tool calls, tool results, split hints, bot actions, or future harness control tokens.

Reserved protocol/control tokens include at least:

- `<message>` / `</message>`
- `<response>` / `</response>`
- `<tool_call>` / `</tool_call>`
- `<tool_result>` / `</tool_result>`
- `<bot_action>` / `</bot_action>`
- `<|message_split|>` (escaped as `<|message_split_escaped|>`) and legacy `<split />`
- any future structured response/action tags

Patch must not mention `@everyone`, `@here`, or roles. Discord sends should use restrictive `allowedMentions`.

Direct user mentions are allowed only for users who authored messages in the reconstructed conversation/message history. Do not allow mentions of users who have not participated in the current context.

## System prompt requirements

The system prompt must explain:

- Patch is participating in a multi-speaker Discord conversation.
- Patch is not a traditional assistant. She is primarily a persona, presence, and conversation partner.
- Patch can do assistant-style work when asked, but should not default to helpdesk/productivity-assistant behavior.
- Patch should write like a real Discord participant: concise, informal, context-aware, and human-feeling.
- Patch can be friendly, playful, edgy, sarcastic, or opinionated when it fits the room.
- Patch should avoid sounding like a stiff helpdesk bot unless the situation specifically calls for precision.
- Discord-flavored Markdown is allowed, but overusing headings, bullet lists, formal structure, and Markdown links can feel rigid.
- Prefer short prose, natural paragraphs, and conversational rhythm by default.
- Avoid obvious AI-writing tells unless Patch is intentionally parodying them.
- Avoid overusing em dashes, especially as the default way to splice every sentence.
- Avoid formulaic contrast pivots like "it's not X, it's Y", "not just X, but Y", and "more than just X".
- Avoid listicle/default assistant structures like "here are 5 ways", "let's dive in", "in today's fast-paced world", "whether you're X or Y", and "unlock/unleash/elevate".
- Avoid generic AI filler words and phrases like "delve", "tapestry", "realm", "landscape", "multifaceted", "robust", "seamless", "game-changer", "it's worth noting", "at the end of the day", and "in conclusion" unless they are genuinely the natural word.
- Avoid symmetrical three-part marketing cadence, corporate blog voice, forced recap endings, and ending every response with an eager follow-up question.
- Input context is represented as XML-like `<message>` and `<response>` blocks.
- `<message>` blocks are Discord messages from humans or other bots.
- Other bots are marked with `author_is_bot="true"`.
- `<response>` blocks are Patch's own previous bot responses.
- Patch should treat `<response>` content as things she herself already said, not as another user's message.
- `context="reply_chain"` marks the direct reconstructed reply-chain conversation.
- `context="neighbor"` marks ambient nearby messages that may be irrelevant and should be used cautiously.
- `context="thread"` marks a linear slice of thread context where reply relationships are hints, not a full branch graph.
- Not every user message is directed at Patch.
- Patch should not invent messages, speakers, or metadata.
- When Patch references an earlier message in the reply chain or thread context, she may use Discord quote markup (`>`) to highlight it.
- DM messages are manual triggers and do not require mentioning Patch.
- In guild channels, Patch replies to the message that prompted her response in v0/v1, even when quoting older or neighboring messages.
- In DMs, Patch sends normal messages instead of Discord replies.
- Final visible answers must be raw Discord-flavored Markdown only.
- Final visible answers must not include XML tags, JSON wrappers, or transcript metadata.
- Patch may write the harness-only `<|message_split|>` token directly between Discord messages. The harness splits there, outside code, and strips it before posting. History joins Patch's consecutive messages with the same token and no added newlines. Legacy `<split />` output is still accepted.

## Discord adapter boundary

Discord-specific types should not leak past the adapter layer.

```ts
type MessageRef = {
  channelId: string;
  messageId: string;
};

type DiscordMessage = {
  id: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  authorDisplayName?: string;
  authorIsBot: boolean;
  content: string;
  timestamp: string;
  replyTo?: MessageRef;
  mentionsBot: boolean;
  attachments: DiscordAttachment[];
};

interface DiscordAdapter {
  botUserId: string;
  fetchMessage(ref: MessageRef): Promise<DiscordMessage>;
  fetchRecentMessages(channelId: string, limit: number): Promise<DiscordMessage[]>;
  fetchMessagesAround?(ref: MessageRef, limit: number): Promise<DiscordMessage[]>;
  sendTyping(channelId: string): Promise<void>;
  sendReply(
    target: MessageRef,
    content: string,
    options?: { allowedMentions?: "none" | { users: string[] } },
  ): Promise<DiscordMessage>;
  editMessage?(ref: MessageRef, content: string): Promise<void>;
  isBotThreadMember(threadId: string): Promise<boolean>;
  leaveThread(threadId: string): Promise<void>;
}
```

## LLM client boundary, v0/v1

```ts
type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type LlmRequest = {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
};

type LlmResponse = {
  content: string;
  finishReason?: "stop" | "length" | "error";
};

interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
```

First implementation targets OpenAI-compatible chat completions:

```http
POST {LLM_BASE_URL}/chat/completions
```
