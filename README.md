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
