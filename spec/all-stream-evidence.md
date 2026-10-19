# Offline evidence integration

This caller slice targets Remora runtime `e6d5754`, tests `8cae911`, final backend
handoff `b221800` and caller-limit clarification `372b6e1`. It is not installed.
Patch stays offline. The existing HF service, policy, banks and Discord commands
remain unchanged.

## Negotiation

The companion fixture is `spec/fixtures/all-stream-evidence.json`, canonical
`60cbdf5`, source SHA256
`c7b377b423a5f927f54245e59dbf6a9c173198eb5c0116c5e52741314fffd6da`.
Require `features.all_stream_evidence:true`, both source and observation bindings
`original_message_scalar_views_v1`, all six exact observation limits, management
support and `entity_identity:false`. Missing or incompatible advertisements fail
before observation HTTP. The older fact/search/identity fixture stays unchanged.

New-profile requests use `read_banks`, the current scoped `speaker` and
`observations`. They contain no `turn`, `write_bank` or identity declarations.
Source actors are local bank/role/ID references. Remora derives the principal;
author identity does not imply the semantic subject of a quotation.

## Cutover and source identity

Future activation requires a coordinated generation fence and an explicit
`REMORA_OBSERVATION_START_ID`. This is a Discord creation-ID cutoff, stored
immutably per destination bank in the caller's SQLite store. A changed configured
cutoff fails. Scoped startup checks known writable banks before Discord connects.
An unconfigured new profile fails startup. This slice sets no actual cutoff.

Only human messages created strictly after the cutoff become observations.
Earlier history remains in the prompt, including later edits to old messages.
There is no migration, source renaming, re-extraction or context reset at cutover.
Creation IDs remain `discord:message:<id>`; revisions are actual edited timestamps
or zero. Source actors remain `discord:user:<id>` within the destination bank.

The SDK adapter preserves original content before mention stripping or trimming.
The current human body remains a literal standard user message. Eligible human
history uses complete JSON string views that decode to that exact original text.
Names, pronouns, IDs, attachments and reply references stay outside those views.
Only the destination channel's human sources are declared. Other bots, foreign
channel history and caller metadata remain untracked.

The caller stores only source digests and frozen context IDs/revisions/digests.
A new human may use the preceding eligible human as context; web excerpts use
the current human when available. Retries and later history reuse that original
manifest. Missing or edited original context omits the dependent declaration.
A fresh turn after rollover chooses only available parents. It does not inherit
an omitted chain. The caller never changes a revision because history rolled.

## Tool continuations and outputs

`web_fetch` title/body and `web_search` result title/snippet values receive
individual JSON string views. JSON paths determine offsets, so identical text
from different URLs stays separate. Source IDs bind the originating turn,
result position, actual tool, URL and text digest. Tools never become human
assertions. Raw source text has no separate caller-side persistence here.

Every observation-capable tool continuation compiles views against its final
message array, after insertion. Input batch IDs exclude rendering positions and
sampling parameters; parameter retries retain the same input declarations.
Backend-owned attempt IDs identify independently generated output/reasoning.
Internal source annotations are stripped from outgoing OpenAI message objects.
Advertised source/view/scalar limits are checked before HTTP.

Truncated tool excerpts, fact-search hits and scratch/action receipts remain
untracked. Declaring recalled or replayable text as independent external evidence
could restore erased material. This wire has no qualified parent-reference route
for those caller-rendered results. Native tool message roles are not source views;
the current Remora text profile uses tagged tools. Legacy continuations stay read-only.

Patch modifies decoder output before Discord display through directives, emoji
removal, splits and citations. Displayed assistant history is therefore untracked.
Do not alias it to the raw generation or create a new independent observation.
Reasoning is authorized only through actual backend-generated channels; the
caller invents no hidden-reasoning stream.

**Full Patch reply retention does not work with this backend version.** Uncovered
nonblank persona/history/wrapper text produces `untracked_dependencies`. Covering
the complete persona instead exceeds the 4,096-scalar generated-source bound;
more than 16 declared sources also blocks generated retention. Chunking does not
repair missing parent linkage. Raw human and individual web admission decisions
remain separate. The backend's 35-call qualification used a short generic persona.

## Inspection and erasure

Facts and evidence have separate integer-ID namespaces. `/memory list` defaults
to both when negotiated, labeling each kind and preserving full source quotation,
context, origin and source actor. Legacy endpoints retain fact-only listing.
External tool/URL provenance appears for both main and supporting quotations.
Every nonempty evidence listing also exports full source IDs, revisions, spans
and context digests as private JSON, including lists that fit inline.
`/memory forget kind:evidence` erases explicit evidence records.
`/memory forget-source id:<evidence ID> [context:<index>]` resolves its source on
the server from a listed anchor. Clear covers both kinds. Source erasure and
record erasure are distinct; no model-generated semantic deletion is involved.

The existing Protocord owner/Discord access/Manage Messages/Manage Server checks
still apply. Mutations keep the exclusive generation barrier, durable principal-wide
history fence and note/follow-up invalidation. The new commands are not published.
Fact-only `memory_search` still does not enumerate evidence.

## Evidence and remaining qualification

Offline checks exercise the real Discord SDK, Protocord, LlmClient and SQLite
with invented HTTP responses. They cover source/view binding, immutable contexts,
cutoff persistence, JSON duplicate values, namespace/permission isolation and
record/source erasure. The rollover regression first failed by dropping a fresh
human source, then passed after unavailable parents were excluded before selection.
Independent review reproduced missing tool/URL provenance in short evidence
listings. The regression now proves inline provenance and a complete private export.

Actual new-profile HF behavior with the assembled Patch persona, shared-channel
ancestry and these JSON history wrappers remains unqualified. A separately
coordinated copied-bank candidate window is required before activation. No new
request is sent to the older running profile by this implementation.
