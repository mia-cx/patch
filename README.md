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

Fixed instructions precede history to preserve the prompt prefix for
llama.cpp's `cache_prompt`.
Boundaries survive Patch restarts; KV cache retention belongs to the model
server. The optional classifier's short decision input does not trim response
history. Summarization is deferred while we evaluate Remora across resets.

Owners configured in `BOT_OWNER_USER_IDS` can run **`/context reset`** in the
current DM, channel, or thread. After its private confirmation succeeds, the next
incoming human message starts a new persistent context, even if Patch does not
reply. The new confirmation's Discord message ID defines the cutoff; a human
reply received while its HTTP acknowledgement is in transit is retained too.
Earlier history, reply ancestors, the command, and its confirmation stay
outside that context. Repeating reset before another human message keeps the
context empty. Old events and edits cannot restore earlier history; other
channels keep their context. An active reply finishes before reset confirms, and
queued old turns are skipped. Remora's saved memories, grants, source identities,
and write receipts are preserved; this command resets conversation context only.

## Remora DM integration

`REMORA_DM_ENABLED=true` enables memory for text turns in one-to-one DMs. Point
the existing `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` at an isolated Remora
service. The validated profiles require `LLM_TEMPERATURE=0`, thinking disabled,
and activity updates disabled. Memory remains off by default.

Set `DISCORD_TRIAL_DM_CHANNEL_ID` for a trial confined to one DM. Patch then
subscribes only to DM events, ignores other channels, and skips global command
registration. Use a separate `SETTINGS_DB_PATH` to keep trial settings and context
boundaries apart from other runs.

Each DM reads and writes `discord:dm:<channelId>`. `REMORA_READ_BANKS` adds up to
seven comma-separated read banks; it never adds write destinations. Remora's
authenticated server policy grants banks, facts, and cross-bank information
flows. Selecting a bank grants no access.

Patch sends earlier turns with their real user/assistant roles. Incoming turns
keep author IDs, names, pronouns, message IDs, and reply references in readable
labels; other bots remain attributed user turns. Patch's prior replies stay plain
assistant text, with their message references in separate metadata that identifies
the current speaker before the exact raw new human message, included once with
a stable Discord message ID and edit revision. Generation retries keep
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
It matches Remora commit `6b5e18c` semantically;
only JSON formatting differs.
Read-only callers may supply `remora.speaker: { bank, id }` to identify the current
human's attribution scope. The ID is opaque and grants no access; writable turns
infer that scope from `write_bank` and `turn.speaker_id`. The optional
`features.speaker_binding` capability is decoded when present.
The low-level LLM client also supports optional `remora.identity` assistant,
binding and label data. It sends that object only after capability negotiation
advertises `features.entity_identity: true` with all four valid identity limits.
It checks requests against those advertised counts and character limits while
preserving exact IDs and labels. Missing or false support rejects even an empty
identity object locally. Patch's DM request builder still sends its existing
source tuple, without automatic assistant identities or shared bindings.
Optional `identity.names` transport additionally requires
`features.harness_names: true` and both name limits, alongside the four identity
limits. It preserves exact names and source identities across retries, rejects
missing name-write acknowledgements, and accepts their original optional receipt
on retries that omit names. The DM builder does not yet supply name observations.
Remora's name backend `2f64afd` has passed CPU review; separate model validation
is pending before enabling the mapping.
Capabilities also retain optional `memory_delivery: "detached" | "native-cache"`.
Delivery is selected by the service, with detached as its default. HF native-cache
feeds recalled source blocks through ordinary token/KV input and remains
`backend: "transformers"`; its profile is `gemma-reference-12288-native-cache`.
The reviewed identity baseline is
[Remora `ba87a90`](https://github.com/mia-cx/remora/commit/ba87a90d179ca3d82abf9503aaa4a45ef266744c).
Its [entity identity guide](https://github.com/mia-cx/remora/blob/242fae2c141a7d0c5ebf8ec8dcebaec6ffc1351c/docs/api/entity-identity.md)
covers the validated opt-in selection:
`--memory-delivery native-cache --entity-identity --legacy-source-projection`.
That profile is `gemma-reference-12288-native-cache-source-projected`, with
12,288 context tokens, 256 output tokens and eight read banks. Legacy projection
is a source-verified read-only view that preserves stored facts and receipts.
The actual TypeScript diagnostic now recalls the captured name and human owner
and denies assistant ownership. All eight read-only calls reuse 7,310 already-warm
SYSTEM tokens and preserve original/copy bank rows and policies. A later captured
intrusion is causally tied to irrelevant Remora recall: cold and warm recall
produce an off-topic dog reply, an empty fact allowlist and bare Gemma produce the
same relevant follow-up, and restoring recall restores the failure. The
reconstructed persona/history contains no dog name; bank rows and policy bytes
remain unchanged.

The authorized fix is live on reviewed runtime `d0b8b52`, released with
[Remora `70ba7c9`](https://github.com/mia-cx/remora/commit/70ba7c9c8a4a9c0cf7bef12b6dde97ebe271c000).
Its optional turn-start relevance gate uses frozen Gemma with head C100/-5;
partial-reply refresh retains the original retriever. The active profile is
`gemma-reference-12288-native-cache-source-projected-turn-relevance`, with the
same 12,288/256/eight-bank limits. The 27 behavioral checks, one-shot fresh64
gates, public HTTP checks and eight actual TypeScript calls pass. Those TS pairs
produce a relevant music follow-up, recall the correct name and human owner, and
deny assistant ownership. Every call returns `writes:null` and reuses 7,310 SYSTEM
tokens; bank rows, cache files and policies remain unchanged. The
[turn relevance guide](https://github.com/mia-cx/remora/blob/70ba7c9c8a4a9c0cf7bef12b6dde97ebe271c000/docs/api/turn-relevance.md)
covers the gate and launch artifact checks. Harness name mapping stays disabled.
The scoped DM trial is online on the released profile
with Discord READY and authenticated Remora capabilities verified; existing
conversation boundaries, memory facts and source receipts are preserved.
[remora-patch-request.json](spec/fixtures/remora-patch-request.json) is the archived
qualification request with Patch's actual persona and fictional history in the
original transcript format. The real TypeScript client smoke passed against the
isolated HF `gemma-reference-12288` service on 2026-10-16: both full-persona calls returned
nonempty replies, selected synthetic fact 1, and replayed an identical successful
write result while changing only the output allowance from 128 to 64 tokens.
[The recorded responses](spec/remora-http-smoke-2026-10-16.json) contain no credentials.
This proves transport and durable source replay; recall correctness is a separate
Remora check. The first run reported zero reused tokens. A second real run after
Remora added a native SYSTEM checkpoint reports **7,310 reused tokens and 1,601
evaluated tokens** on both calls, with nonempty replies and identical successful
source receipts. [The cache smoke responses](spec/remora-http-cache-smoke-2026-10-16.json)
verify persona-prefix reuse; they do not prove entire-history KV continuity or a
throughput improvement. The original HF integration was qualified on
[Remora `58626f9`](https://github.com/mia-cx/remora/commit/58626f9f5f67fe5061cb2ff92c7cc8f86cb3de7c),
before the later identity work. The current
[serving guide](https://github.com/mia-cx/remora/blob/242fae2c141a7d0c5ebf8ec8dcebaec6ffc1351c/docs/api/serving.md)
and [HF Patch handback](https://github.com/mia-cx/remora/blob/66f86295869a9c8ceb71195def08b14d67358a5c/docs/api/patch-handoff-2026-10-16.md)
cover launch/policy and the archival integration proof respectively.
The controlled HF trial uses one owner DM with
`DISCORD_TRIAL_DM_CHANNEL_ID` and separate SQLite settings. Existing global
Discord command registration is skipped in that mode.

The native `/context reset` command was published globally for the development bot
on 2026-10-17, preserving the other four commands. Guild commands cannot be invoked
in DMs. For another deployment, with a ready Discord client and Patch's default
action registry,
upsert only `getDiscordCommandRegistration(registry).find(command =>
command.name === "context")` through `client.application.commands.create(payload)`.
This uses Protocord's command payload, including DM availability, without replacing
the application's command catalog. Once Discord offers it in the slash picker,
invoke `/context reset` as an owner in the configured trial DM. Trial startup
continues to skip registration.

The [native CPU development profile](https://github.com/mia-cx/remora/blob/865ade5910022188c9b8313bb76a2a4d48ced4c5/docs/api/native-profile-2026-10-16.md)
is also selectable through this API on reviewed source `90c4970`, using its exact
BF16 assets and a memory frame of at most 448 tokens. Set
`LLM_TIMEOUT_MS=300000` for that profile. Remora's final rerun of the stock Patch
client returned matching nonempty replies and replayed the same successful
`saved: [1, 2]` receipt: cold 0 reused / 8,917 evaluated, then 7,310 reused / 1,607
evaluated. [The native HTTP proof](spec/remora-native-http-smoke-2026-10-16.json)
records those responses. Native remains CPU development support, without GPU,
quantization, throughput, or broad HF-parity claims; HF stays the DM trial backend.

The Gemma tokenizer renders this sample at 8,770 tokens before Remora framing and
128 output tokens. An 8,192-token profile cannot fit it. The tested service reports
a 12,288-token context, 256-token output limit, and eight read banks.

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
