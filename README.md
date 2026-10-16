# Patch

A Discord conversation harness for a locally hosted model.
Product behavior is described in [SPEC.md](SPEC.md); current project decisions
are in [DIRECTION.md](DIRECTION.md).

## Setup

Use Node.js 24 and pnpm 11. Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/mia-cx/patch.git
cd patch
pnpm install --frozen-lockfile
```

For an existing checkout, run `git submodule update --init --recursive` before
installing. Installation builds the local Protocord packages. Copy
`.env.example` to `.env`, configure the development bot and model endpoint, then
run `pnpm dev`.

## Conversation context

Each DM, guild channel, and thread has a fixed starting message, persisted in
the SQLite database at `SETTINGS_DB_PATH`. Discord remains the message store,
so history reconstruction reflects edits and deletions. Patch keeps everything
from that starting boundary through the trigger, including her own replies and
messages sent while she was offline.

`DM_CONTEXT_MESSAGE_LIMIT`, `THREAD_CONTEXT_MESSAGE_LIMIT`, and
`GUILD_RECENT_MESSAGE_LIMIT` seed new contexts only. After that, context grows
until the approximate `LLM_CONTEXT_TOKENS` budget is full. The budget reserves
the assembled instructions, output tokens, and template/tool headroom. On
overflow, Patch moves the boundary forward to retain roughly half the available
conversation tokens, then grows from there again.

Fixed instructions precede history; participant and classifier metadata follow
it so new turns preserve the prompt prefix for llama.cpp's `cache_prompt`.
Boundaries survive Patch restarts; KV cache retention belongs to the model
server. The optional classifier's short decision input does not trim response
history. Summarization is deferred while we evaluate Remora across resets.

## Remora DM integration

`REMORA_DM_ENABLED=true` enables memory for text turns in one-to-one DMs. Point
the existing `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` at an isolated Remora
service. The first HF profile requires `LLM_TEMPERATURE=0`, thinking disabled,
and activity updates disabled. Memory remains off by default.

Each DM reads and writes `discord:dm:<channelId>`. `REMORA_READ_BANKS` adds up to
seven comma-separated read banks; it never adds write destinations. Remora's
authenticated server policy grants banks, facts, and cross-bank information
flows. Selecting a bank grants no access.

Patch sends earlier rendered history followed by the exact raw new human message
once, with a stable Discord message ID and edit revision. Generation retries keep
the same source identity. Remora owns durable write deduplication. Classifier,
activity, and output-formatting requests carry no memory extension. An edit used
as a new trigger advances its source revision; changing older supplied history
alone does not request deletion of its saved facts.

Before connecting to Discord, Patch checks `/v1/remora/capabilities`, caps context
and output allowances to the reported limits, and rejects unsupported settings
or a context too small for the persona. Responses must include valid Remora
metadata and a matching write receipt. Receipts and observed cache reuse are
logged; a writer failure preserves the generated reply and logs the failure.

The shared contract snapshot is [remora-contract-v1.json](spec/fixtures/remora-contract-v1.json).
It matches Remora commit `59886116b4053b7abca2913e13fc3eac3cdf61db` semantically;
only JSON formatting differs.
[remora-patch-request.json](spec/fixtures/remora-patch-request.json) is a sanitized
request with Patch's actual persona and fictional history for backend context
measurements. These fixtures and the HTTP integration tests establish client
compatibility; a real Gemma context/cache validation remains required before
calling the integration ready for a bot trial.

The Gemma tokenizer renders this sample at 8,770 tokens before Remora framing and
128 output tokens. An 8,192-token profile cannot fit it; the larger backend profile
still needs GPU validation.

Once the isolated service grants the fixture's synthetic bank, run
`LLM_BASE_URL=<service>/v1 LLM_API_KEY=<test-policy-token> pnpm remora:smoke`.
This sends the full persona through the real TypeScript client twice and checks
that changing generation limits replays the same write receipt. It connects to
no Discord bot and prints answers, receipts, and cache metrics.

## Protocord

[`mia-cx/protocord`](https://github.com/mia-cx/protocord) is pinned at
`vendor/protocord`. Its packages are part of this pnpm workspace, and the core
is available as the `protocord` dependency without registry publication.
Patch's slash commands, autocomplete, and model tool calls all use its action
lifecycle. Patch supplies its own actions and model tool-call trigger provider.

Patch's checks, tests, and build stay separate from the submodule's checks.
Run `pnpm protocord:check` to validate all Protocord packages. Commit and push
changes inside the submodule first, then commit its updated pointer in Patch.

```sh
pnpm check
pnpm test
pnpm build
```
