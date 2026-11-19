# Patch v0 Prototype

Goal: prove the core Discord + local LLM loop works without tools, web search, preferences, compaction, planner/classifier, passive thread participation, or durable conversation storage.

Current implementation behavior is canonical for v0.

## Scope

Implemented:

- TypeScript + `discord.js` bot runtime.
- OpenAI-compatible LLM client for local llama.cpp or compatible backend via native `fetch`.
- Markdown prompt assets in `prompts/`:
  - `system.md`
  - `response-user.md`
  - `webslang/emoji.md`
  - `webslang/phrases.md`
- Mention-triggered responses in guild channels.
- Edit-triggered mentions: if a message did not mention Patch before edit and does mention Patch after edit, Patch responds.
- DM responses without requiring a mention.
- DM responses sent as normal messages, not Discord replies.
- Reply-to-Patch continuation.
- Mention-while-replying context reconstruction.
- DM rolling context from recent DM history.
- Focused guild neighbor context around the triggering user / referenced Patch burst.
- Basic transcript formatting with `<message>` and `<response>`.
- Patch messages distinguished as `<response author_id="patch">`.
- The bottom conversation `<message>` block is the trigger.
- Typing indicator while generating.
- Guild response first chunk posted as a reply to the triggering message.
- Later guild burst chunks posted as normal messages to avoid Patch replying to herself.
- Hard Discord message-length splitting.
- Model-provided `<split />` hints for semantic/burst splitting.
- Harness line-break splitting for unstructured responses.
- Burst cap with even grouping, maximum 6 Discord messages per model response.
- Restrictive mention policy.
- Unicode emoji output stripping; text smileys remain allowed.
- Admin `/delete count:N` command for owner-only deletion of Patch's latest messages in the current channel.
- `/leave` command to generate a farewell and leave the current thread/forum post.
- Admin `/model [name]` command for owner-only live LLM model switching backed by SQLite settings.
- Admin `/reload` command for owner-only prompt reload without restarting Patch.
- LLM prompt/response tracing behind `LLM_TRACE_LOGGING`.
- Optional passive-response classifier behind `RESPONSE_CLASSIFIER_ENABLED=false` by default.
- Optional generated Discord presence activity updates behind `ACTIVITY_UPDATES_ENABLED=false` by default.
- Basic tests for splitting and emoji stripping.

Do not implement in v0:

- Tool calling.
- Web search/fetch.
- User preferences.
- Thread/forum passive participation. This waits for v1.
- Planner/classifier. This waits for v1.
- Context menu commands.
- Components/modals.
- Compaction.
- Durable conversation storage.
- Streaming partial edits.

## Stack

Use:

- pnpm
- TypeScript
- Node 22
- `discord.js`
- `tsx` for local dev
- `tsup` for builds
- Effect v4 beta for config loading effect boundary
- Effect Schema for config validation
- Biome for linting/formatting
- Vitest for tests
- Pino for structured logging
- native `fetch` for LLM REST calls

Scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --target node22 --clean",
    "start": "node dist/index.js",
    "check": "biome check . && tsc --noEmit",
    "fix": "biome check --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

## LLM runner assumption

Patch targets a local llama.cpp OpenAI-compatible server. Current default local endpoint:

```env
LLM_BASE_URL=http://10.0.3.2:8080/v1
LLM_MODEL=gemma-4-e4b-it
LLM_API_KEY=local
```

Requests include llama.cpp-specific options:

```json
{
  "chat_template_kwargs": { "enable_thinking": false },
  "cache_prompt": true
}
```

`enable_thinking` is controlled by `LLM_ENABLE_THINKING` and defaults to `false`. When thinking is enabled, response generation uses `LLM_THINKING_MAX_TOKENS` and `LLM_THINKING_TIMEOUT_MS` for the first attempt, then falls back to a no-thinking request if that attempt times out or returns no visible content.

`cache_prompt: true` lets llama.cpp reuse the static prompt prefix when possible.

## Configuration

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
LLM_BASE_URL=http://10.0.3.2:8080/v1
LLM_MODEL=gemma-4-e4b-it
LLM_API_KEY=local
SETTINGS_DB_PATH=data/patch.sqlite
LLM_CONTEXT_TOKENS=32768
LLM_ENABLE_THINKING=false
LLM_THINKING_MAX_TOKENS=1024
LLM_THINKING_TIMEOUT_MS=20000
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=2048
LLM_TEMPERATURE=0.55
BOT_OWNER_USER_IDS=
DEBUG_LOGGING=false
LLM_TRACE_LOGGING=false
RESPONSE_CLASSIFIER_ENABLED=false
DM_CONTEXT_MESSAGE_LIMIT=30
THREAD_CONTEXT_MESSAGE_LIMIT=30
GUILD_RECENT_MESSAGE_LIMIT=10
CLASSIFIER_CONTEXT_MESSAGE_LIMIT=12
ACTIVITY_UPDATES_ENABLED=false
ACTIVITY_UPDATE_INTERVAL_MS=2700000
PASSIVE_RESPONSE_TTL_MS=30000
MAX_GLOBAL_CONCURRENCY=1
```

`LLM_CONTEXT_TOKENS` is the approximate total context budget. The harness reserves the assembled prompt instructions, a template/tool margin, and `LLM_MAX_TOKENS` for output (or the larger thinking allowance when enabled). The remainder is available for conversation history.

`SETTINGS_DB_PATH` points at Patch's local SQLite settings database. `LLM_MODEL` seeds the persistent `llm_model` setting on first startup only; after that, `/model` updates the database and live LLM requests use the stored model.

## Trigger rules

A v0 conversation starts when:

1. A user sends Patch a DM. Every non-bot DM message is a manual trigger and does not require mentioning Patch.
2. A user mentions Patch in a guild channel.
3. A user replies to a Patch message.
4. A user mentions Patch while replying to any message.
5. A user edits a message from no Patch mention to containing a Patch mention.

Edits are ignored if the message already mentioned Patch before editing and still mentions Patch after editing.

Patch does not auto-respond to other bots.

Thread/forum messages are not passively followed in v0. Direct mentions may still arrive through the normal message event path.

## Context reconstruction

Each DM, guild channel, and thread has a persistent starting message ID in the
SQLite database at `SETTINGS_DB_PATH`. The first request seeds history using
`DM_CONTEXT_MESSAGE_LIMIT`, `THREAD_CONTEXT_MESSAGE_LIMIT`, or
`GUILD_RECENT_MESSAGE_LIMIT`. Later requests fetch all messages from that fixed
boundary through the trigger, with pagination. The initial counts do not apply
to subsequent turns. Message edits and deletions are reflected by Discord's
current history; fetching failures leave the saved boundary intact.

Context grows until its approximate token budget is exceeded. Patch then keeps
a contiguous recent suffix containing roughly half the available conversation
tokens, persists its first message as the new starting boundary, and grows
again. Whole messages are retained. Reply chains cannot reintroduce messages
older than the active boundary. An edit-to-mention before the boundary gets a
separate historical view without rewinding the chat.

Thread context is marked `thread`; guild history is marked `neighbor` and
relevant reply-chain entries are marked `reply_chain`. When duplicates occur,
reply-chain context wins. Internal context labels are not included in the
formatted transcript.

Fixed response instructions precede the transcript. Participant and per-turn
classifier metadata follow its conversation blocks, preserving the history
prefix for llama.cpp prompt caching. Persisting a boundary preserves the chat
view across Patch restarts; server-side KV state may need to be rebuilt.
Compaction is deferred pending Remora recall experiments across resets.

## Prompting

The response prompt receives the reconstructed transcript.

An optional passive-response classifier is available behind `RESPONSE_CLASSIFIER_ENABLED=false`. It only classifies thread messages. Normal guild channel messages reach the LLM only through manual triggers: DMs, Patch mentions, replies to Patch, or edit-to-mention. It receives selected shared prompt components, classifier-specific instructions, runtime classification metadata, and the most recent `CLASSIFIER_CONTEXT_MESSAGE_LIMIT` messages from the reconstructed transcript. Manual triggers bypass the classifier and respond automatically. It is disabled by default and is not required for v0 acceptance.

Prompt assets are canonical Markdown files:

- `prompts/system/*.md`
- `prompts/webslang/emoji.md`
- `prompts/webslang/phrases.md`
- `prompts/classifier.md`
- `prompts/activity.md`
- `prompts/response-user.md`

Prompt components are assembled into one system message per call because llama.cpp chat templates require the system message at the beginning.

## Transcript formatting

Use XML-like transcript blocks:

- human/other-bot messages: `<message>`
- Patch messages: `<response>`
- Patch's real bot user ID is normalized to `author_id="patch"`
- `author_name`, `author_id`, and optional `pronouns` are speaker identity
- The bottom conversation `<message>` block is the trigger; the participant index and optional classifier decision follow conversation blocks
- user-controlled content is XML-escaped and control tags are neutralized
- when profile pronouns are unavailable or look nonsensical, transcript metadata uses `pronouns="missing"`; Patch may use they/them in passing but should report missing pronouns when asked

Adjacent Patch messages are merged into one logical `<response>` during transcript formatting.

## Split responses

Patch may emit `<split />` in model output.

Rules:

- Parse split hints only from model response text.
- Ignore split hints inside code fences.
- Strip split hints before posting.
- For guild channels, send the first chunk as a reply to the trigger.
- For guild channels, send later chunks as normal messages in the same channel.
- For DMs, send all chunks as normal messages.
- If no split hint exists, the harness may split unstructured line breaks into burst chunks.
- Structured Markdown responses with headings/lists/code fences preserve line breaks.
- Long responses hard-split safely.
- A single model response may produce at most 6 Discord messages; overflow is grouped evenly and then hard-size-limited.

## Mention policy

Use restrictive `allowedMentions`.

- Never allow `@everyone`, `@here`, or role mentions.
- Direct user mentions are allowed only for user IDs that appear as message authors in the transcript.
- Default to no ping unless the response text explicitly includes an allowed participant mention.
- Discord reply mentions stay disabled with `repliedUser: false`.

## Failure behavior

If generation fails after a manual trigger, reply in-character with:

> sorry, brain fog. couldn't get my thoughts into a usable shape. try that again?

Keep details in structured logs only.

## Queueing

- `MAX_GLOBAL_CONCURRENCY=1` by default.
- Manual triggers outrank passive classifier jobs.
- Jobs are bucketed by channel/thread and round-robin within a priority tier.
- Passive jobs older than `PASSIVE_RESPONSE_TTL_MS` are dropped before generation starts.
- No in-flight cancellation/rewrite.
- Generation timeout uses `LLM_TIMEOUT_MS`.

## Commands

`/delete count:N`

- owner-only, controlled by `BOT_OWNER_USER_IDS`
- deletes Patch's latest N messages in the current channel
- deletes messages individually so `Manage Messages` is not required

`/leave`

- works only in threads/forum posts
- generates a short farewell from `prompts/leave.md`
- sends the farewell, then leaves the thread/forum post

`/model [name]`

- owner-only, controlled by `BOT_OWNER_USER_IDS`
- without `name`, shows the current persisted LLM model
- with `name`, stores the model in SQLite and uses it for the next LLM request without restarting Patch

`/reload`

- owner-only, controlled by `BOT_OWNER_USER_IDS`
- clears the prompt file cache so live prompt edits take effect without restarting Patch

## Acceptance criteria

v0 is accepted when the verification checklist passes:

1. `pnpm run check` passes.
2. `pnpm test` passes.
3. `pnpm run build` passes.
4. llama.cpp smoke request succeeds with `enable_thinking: false` and `cache_prompt: true`.
5. Bot logs in and prints `patch online`.
6. DMing Patch produces a reply without requiring a mention.
7. Consecutive DM messages preserve recent context without Discord replies.
8. Mentioning Patch in a guild channel produces a reply.
9. Editing a non-mentioned guild message to add `@Patch` triggers exactly once.
10. Editing a message that already mentioned Patch does not retrigger.
11. Replying to Patch includes prior Patch response context as `<response>`.
12. Mentioning Patch while replying to another user includes the upward reply chain.
13. Multi-speaker context preserves speaker identity by `author_name` / `author_id`.
14. Guild neighbor context does not leak unrelated nearby conversations into the answer.
15. User XML/control-token injection is escaped.
16. `<split />` hints produce multiple chunks.
17. Unstructured line breaks split into burst chunks.
18. Later guild burst chunks are normal messages, not replies to Patch.
19. Long responses hard-split below Discord limits.
20. Burst output is capped at 6 Discord messages.
21. Unicode emoji emitted by the model is stripped before sending.
22. Failures produce the generic in-character failure reply.
23. `/delete count:N` deletes Patch's recent messages for an owner and rejects non-owners.
24. `/leave` generates a farewell and leaves the current thread/forum post.
25. `/model [name]` shows or switches the persisted LLM model for an owner and rejects non-owners.
26. `/reload` clears the prompt cache for an owner and rejects non-owners.
27. With `LLM_TRACE_LOGGING=true`, logs include reconstructed context, prompt messages, raw LLM response, and sanitized content.
