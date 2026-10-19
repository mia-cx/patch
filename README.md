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

## Harness tools

Plain model output sends a normal message. A leading
`<reply to="MESSAGE_ID" />` opts into a reply to a visible message in the same
channel, without pinging its author. Only the first chunk replies.

Patch's Protocord actions now include:

- Reactions and removal of her own reactions; edits/deletion of her own messages.
- Starting/joining/leaving threads, native polls, poll results and server emoji/stickers.
- Durable fixed-text follow-ups: schedule, inspect and cancel, without another model call.
- DuckDuckGo search and readable public HTTPS pages, with real source links.
- Persistent conversation-scoped text notes: list, read, write and delete with revisions.

`LLM_TOOL_MODE=auto` uses native OpenAI tool calls when supported and tagged
text when Remora advertises `tools:false`. Other modes are `native`, `tagged`
and `off`. `MAX_TOOL_CALLS` defaults to three and is capped at eight per turn.
Results return to the model; only the initial request supplies a writable Remora
source. Tool continuations retain the current speaker and use read-only recall.

Web requests identify Patch, Protocord and Node.js HTTPS. Browser-style fallback
agents retain that identity. Every redirect resolves and pins a public IP;
requests have a 20-second bound and a 2 MB decoded limit. Reads return 4,000
characters with continuation offsets. No credentials or downloaded code execute.

Notes and follow-ups live in `SETTINGS_DB_PATH`, separate from Discord transcripts.
Notes allow 16 KiB each, 64 documents and 256 KiB per conversation. They expose
virtual text names, never host paths or a shell. Ordinary context resets retain
notes. A memory-deletion fence clears **all notes and queued follow-up text under
Patch's API credential**, conservatively preventing forgotten facts surviving there.
An uncertain Discord delivery is held for reconciliation rather than resent.

Games remain deferred. These paths are tested through the actual Discord SDK
with invented network responses; actual Remora tool selection is not yet qualified.
Mia enabled these tools in the scoped DM trial on the reviewed `58831ff` build.
Startup capabilities and Discord READY pass; the trial uses tagged calls, at most three per turn.
No command publication accompanies this implementation. See [v2](spec/v2.md).

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

## Saved memory controls

Protocord exposes private `/memory` commands backed by Remora's deterministic
management API:

- `/memory list [scope:personal|channel|server]` shows all readable records and
  their IDs. Long lists become a complete JSON attachment.
- `/memory forget ids:2,5 [scope:...]` deletes only the chosen IDs.
- `/memory clear confirm:true [scope:...]` clears the entire selected bank,
  including archived records and forgetting rules.

Scope defaults to personal in a DM and channel in a server. Personal scope always
resolves the invoking user's own DM, including when invoked privately in a server.
Channel and server inspection requires View Channel and Read Message History.
Forgetting channel memories requires Manage Messages; forgetting server memories
requires Manage Server. Bot ownership adds no memory permission override.

The service must advertise `features.memory_management: true` with all three
valid management limits. Its policy separately grants reading and forgetting:
`write_banks` is insufficient, and clearing requires full-bank read and forget
grants. Scope selection never provisions a bank or grants access.

Mutation commands drain active generations and durably reset all memory-backed
conversation histories under Patch's API credential before requesting deletion.
The reset is conservative: it survives a lost response even when deletion cannot
be confirmed. The private result says whether context was reset and reports actual
deletion receipts. Shared evidence conflicts leave saved facts intact. Discord
messages remain; new human assertions can teach a fact again. Existing source
receipts are retained by Remora.

The commands are published for the development bot. Their qualification used
Remora management runtime `4e95553` and contract `f00a364`.
That release passed 183 Patch tests and 14 isolated HTTP checks; the other five global
commands were preserved. See the [Remora management guide](https://github.com/mia-cx/remora/blob/54f7bd6/docs/api/memory-management.md).

## Remora DM integration

Active-recall support adds `memory_search(query, limit?, min_score?)`
through Protocord. It is hidden unless Remora advertises `memory_search` with all
four valid search limits and the conversation has an eligible selected bank
scope. The model cannot add banks. Returned subject identities and source voices
stay separate; similarity scores are rankings. No source or generation writes
come from search. Client runtime `87760e8` passed scoped-trial startup from `9240e41`.
Patch is now held offline for Remora training while the additional guild-channel
configuration is installed. Search stays hidden until the backend advertises support.
See [Remora's active-recall guide](https://github.com/mia-cx/remora/blob/28216a6/docs/api/active-recall.md).

`REMORA_DM_ENABLED=true` enables memory for text turns in one-to-one DMs. Point
the existing `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` at an isolated Remora
service. The validated profiles require `LLM_TEMPERATURE=0`, thinking disabled,
and activity updates disabled. Memory remains off by default.

Set `DISCORD_TRIAL_DM_CHANNEL_ID` for a trial confined to one DM. Patch then
subscribes only to DM events, confines conversation replies to that DM, and skips
automatic global command registration. `/memory` can still be invoked in other
places with the required permissions. Use a separate `SETTINGS_DB_PATH` to keep trial settings and context
boundaries apart from other runs.

Set both `DISCORD_TRIAL_GUILD_ID` and `DISCORD_TRIAL_GUILD_CHANNEL_ID` to add one
exact shared channel. This also enables its Remora integration. Guild events are
enabled, with handling restricted to that guild/channel pair and the existing
trial DM. Other channels and child threads stay excluded. Automatic command
registration remains disabled. Normal guild replies require a mention or reply
to Patch while the optional classifier is disabled.
Runtime `3e6ba7a` is installed while Patch stays offline for training. REST-only
verification confirms access to view, read history and send in the selected channel.

That shared channel reads `discord:channel:<channelId>` and
`discord:guild:<guildId>`, and writes only the channel bank. Personal banks and
`REMORA_READ_BANKS` extras never enter shared-channel requests. Remora must grant
both reads and channel writes; passive dreaming also needs full channel forget
authority. `/memory` still enforces Discord permissions for explicit deletion.
Current passive formation rejects guild-bank ancestry in a channel-bank write;
read grants do not authorize copying guild evidence into channel memories.

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
It matches Remora commit `28216a6` semantically, preserving the earlier management,
name and identity contracts. The canonical source SHA256 is
`f90ecb2120f1053da54e2d53239cc6ec873370b8fa709ba3aece329a5a9dd0e3`.
The companion [memory-search.json](spec/fixtures/memory-search.json) resolves its
contract references to the local snapshot filename; JSON formatting also differs.
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
Mia approved resuming the scoped trial on passive runtime `8770d95`, serving
HEAD `dfc09d9`, with profile
`gemma-reference-12288-native-cache-source-projected-turn-relevance-passive-formation-dreaming`.
The trial first resumed on Patch `7720cb3`, then Mia authorized the v2 tools
rollout on `58831ff` (runtime `0e22f88`). Actual startup capabilities and Discord
READY pass. Conversation boundaries, persona, source tuples, memory facts and
receipts are preserved; name mapping stays disabled.
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
The controlled HF trial uses an owner DM and one explicitly configured guild
channel with separate SQLite settings. Existing global command registration
stays disabled. Patch remains offline during Remora training.

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
