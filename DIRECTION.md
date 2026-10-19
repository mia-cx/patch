# Direction

Patch is a Discord persona and conversation partner with her own voice, taste,
boundaries, and timing. Build the simplest useful conversation path before
expanding the assistant features in the versioned specs.

Patch's runtime stays JavaScript/TypeScript. Remora provides an OpenAI-compatible
inference API with optional memory-bank selection and fact-level recall controls.
Remora can keep its Python core; Patch consumes the API and remains independent
of the inference backend. Bank selection and write destinations are distinct,
and Remora enforces which facts may enter recall. For service setup and supported
trial behavior, read the [final Remora serving guide](https://github.com/mia-cx/remora/blob/242fae2c141a7d0c5ebf8ec8dcebaec6ffc1351c/docs/api/serving.md)
and [entity identity handback](https://github.com/mia-cx/remora/blob/242fae2c141a7d0c5ebf8ec8dcebaec6ffc1351c/docs/api/entity-identity.md).

Protocord is the shared Discord action framework. Its canonical source is
`mia-cx/protocord`, extracted from Prod with the core, settings, permissions,
and AI scaffold. Patch consumes it as a pinned submodule at `vendor/protocord`
through pnpm workspace dependencies. Publishing packages is deferred.

Patch actions use Protocord's shared validation, authorization and trigger lifecycle.
Plain model text sends normally; optional reply metadata targets a visible message ID.
Reactions, own-message edits/deletion, threads, polls, stickers and fixed-text follow-ups are implemented.
DDG search/fetch identifies Patch/Protocord; persistent scoped notes offer no code execution.
All model inputs and outputs should be eligible for passive memory, preserving each source's origin.
Offline evidence transport targets Remora `a96f638`/`d3d1ee3`; see [caller mapping](spec/all-stream-evidence.md).
Raw human/web views and authenticated generated parents preserve exact origins and frozen ancestry.
Transformed Discord displays depend on their raw parent. Principal-wide erasure fences purge caller plaintext.
Release requires an explicit clean model-context boundary; rollover cannot repair an untracked reply chain.
Preserve all old Discord/history records and bank data, without re-extraction or source renaming.
Caller mechanics pass 351 offline tests; full-persona v4 source-edit recall and the later journey remain unqualified.
No evidence profile, cutoff, command update or rollout is installed; Patch stays offline pending coordinated qualification.
Causal tool exchanges and completed-read reuse keep the three-call ceiling; games remain deferred. See [v2](spec/v2.md).

Mia added only guild `1559060271404945512`, channel `1561529690953490442`, alongside the owner DM.
Read channel/server banks and write only the channel; runtime `3e6ba7a` is configured offline while Remora trains.

Patch's Remora client is opt-in for one-to-one DMs. Caller-owned history uses real
user/assistant roles. Incoming turns retain author IDs, names, pronouns, and reply
targets in readable labels; Patch replies remain plain assistant text. Separate
metadata retains Patch reply references and identifies the raw final user turn.
Stable source IDs and edit revisions survive generation retries. Read-bank
selection never adds write destinations or grants.
Runtime capabilities bound context/output; write receipts and observed cache reuse
are validated. Classifier and activity calls have no memory access.
Evidence-aware formatting observes its real dependency with an empty recall allowlist.
The shared contract and synthetic full-persona request are in `spec/fixtures`.
Initial HF/native TypeScript smokes establish durable retries and 7,310-token SYSTEM reuse,
not whole-history continuity. Native CPU qualification is limited to its exact BF16 assets;
see the released guides at `865ade5`. It does not establish GPU or broad HF parity.
The controlled HF trial is scoped to Mia's one-to-one DM, restricted to that
channel with global command registration skipped. It uses separate trial SQLite
settings and a fresh context starting at the first new human message; subsequent
turns grow normally. Attributed chat-role rendering now passes both real failed
follow-ups cold and cached, with durable receipts and bank rows preserved. Keep
assistant text plain and reference metadata beside its reply: XML assistant
wrappers leak into output, and cumulative metadata footers obscure recent
dialogue in Gemma's 512-token local attention. llama.cpp qualification does not
gate this HF trial.
Mia approved passive formation/dreaming (`8770d95`, serving `dfc09d9`) on the same HF API.
The scoped trial is held offline for training, with tagged tools (three calls per turn) retained for resumption.
Startup capabilities and Discord READY pass with unchanged persona/history/source tuple.
Earlier ownership leaks led to preserving source authorship separately from fact subjects.
Patch supports the optional `speaker: {bank, id}` attribution field and optional
speaker-binding capability from contract `193e295`. Writable turns infer identity
from their existing source tuple. Capabilities disclose optional `memory_delivery`.
The opt-in HF `native-cache` mode delivers recall through ordinary token/KV input;
the service default remains detached. Remora `ba87a90` adds an opt-in server-only
legacy-source projection for verified primary-human facts. A copied-bank read-only
TypeScript diagnostic on the source-projected profile now recalls the direct name,
attributes ownership to the human and denies assistant ownership. Repeated replies
agree, all eight calls reuse 7,310 SYSTEM tokens, and both bank copies and policies
remain unchanged. Reviewed source `ba87a90` and final guide `242fae2` are delivered;
R5/R6 are closed, with 732 parent CPU tests passing and three native-asset skips.
The validated flags are `--memory-delivery native-cache --entity-identity --legacy-source-projection`;
the profile is `gemma-reference-12288-native-cache-source-projected`.
It remains opt-in; detached is the default and llama.cpp entity support is unqualified.
A captured 2026-10-17 intrusion is causally tied to irrelevant Remora recall:
the reconstructed persona and 22 history messages contain no dog name, yet cold
and warm recall reproduce the off-topic dog reply. An empty fact allowlist and
bare Gemma both produce a relevant follow-up; restoring recall restores the
failure. All bank rows and policy bytes are unchanged.
The authorized fix is now live on `18787`: reviewed runtime `d0b8b52`, released
with release docs `70ba7c9`, adds the optional turn-start relevance gate using
frozen head C100/-5. The active profile is
`gemma-reference-12288-native-cache-source-projected-turn-relevance`.
Read the [turn relevance guide](https://github.com/mia-cx/remora/blob/70ba7c9c8a4a9c0cf7bef12b6dde97ebe271c000/docs/api/turn-relevance.md)
for the mechanism and launch artifact checks. Raw partial-reply refresh is
unchanged. The 27 behavioral checks, one-shot fresh64 gates, public HTTP checks
and eight actual TypeScript calls pass; the captured music reply stays relevant,
name and human ownership remain correct, and the assistant denies owning the dog.
All eight TS calls reuse 7,310 SYSTEM tokens with `writes:null`; bank rows,
cache files and policies are preserved. The release passed startup and Discord
READY before the offline hold. Caller, persona, source tuple and history stay unchanged. Names
remain separately gated. Coordinate any GPU window before changing the shared
model lease. No LoRA.
Memory inspection and forgetting belong to Protocord slash commands backed by
deterministic Remora management endpoints. Users control their personal DM bank;
shared channel/server banks follow Discord access and management permissions.
Show actual authorized records and storage receipts. Explicit forgetting must
invalidate memory caches and affected caller history; a model reply is not proof
of deletion. Keep Remora's API generic and require separate deletion grants.
The `/memory` commands are published against reviewed
Remora runtime `4e95553`, contract `f00a364` ([management guide](https://github.com/mia-cx/remora/blob/54f7bd6/docs/api/memory-management.md)).
Active-recall client `87760e8` is installed; `memory_search` stays hidden until Remora advertises support and four valid limits.
Canonical facts use explicit third-person statements bound to generic stable
entity references, keeping fact subjects separate
from source authors and preserving raw evidence and receipts. Names are optional
caller-supplied labels; Patch may resolve them through its Discord adapter or
Protocord. Core extraction, storage and recall must work without any harness or
platform SDK. Patch accepts the [entity identity semantics](https://github.com/mia-cx/remora/blob/e5670f158ede3a2781dc5f18e9fb2ddbde2484b2/docs/api/entity-identity-proposal.md):
the existing tuple identifies the local human; assistant identity is separate;
shared links are durable actor-scoped associations. Current labels are request-local.
Next, harness-supplied names should be retained as attributed details of the stable
actor/entity and available during recall, including after context resets. Patch
resolves names; Remora owns the generic association and its authorization. Renames
preserve identity, and equal names never merge people. Caller review accepts the
additive `identity.names` draft: separately negotiated support,
source-bound harness facts, frozen retries and a separate write acknowledgement.
Forgetting redacts name evidence while retaining retry digests; moving a local
actor to a shared entity creates a new name fact without rebinding old evidence.
The name contract is promoted at `6b5e18c`. Patch's low-level transport checks the
separate name capability and all six limits, preserves exact declarations, and
requires the sibling acknowledgement even if the model writer fails. Remora's
isolated name backend `2f64afd` is CPU-reviewed: 806 tests pass with three native
asset skips. Its [name guide](https://github.com/mia-cx/remora/blob/b2e8b8cf9cb4aabd7e11e2e1c687ae1c1046bc63/docs/api/harness-names.md)
records the implementation; separate model evidence is still required before
enabling the DM name mapping. The builder keeps its original tuple without name
observations. The client passes 145 tests plus typecheck and build smoke.
Wire review is closed at the [additive identity draft](https://github.com/mia-cx/remora/blob/ea060f25b03e6ad82cede9db6514a805a1e1ecf1/docs/api/entity-identity-wire-draft.json).
The canonical contract snapshot is `6b5e18c`. Low-level client identity transport
requires enabled support and all four valid advertised limits, then enforces those
limits without rewriting IDs or labels. The DM builder retains its original source
tuple. Stored facts and receipts remain unchanged. Remora serves the approved
profile on `18787`; coordinate any model or service restart while the trial runs.
The measured synthetic Patch request already uses 8,770 rendered Gemma tokens
before Remora framing/output, so an 8,192-token profile is insufficient.

Chat context grows from a persistent per-channel starting boundary until it
reaches the token budget, then jumps forward to a recent boundary with room to
grow again. Keep prompt prefixes stable for llama.cpp's KV cache. Evaluate
Remora's recall across these resets before deciding whether compaction is
needed; automatic summaries are deferred.
Owner-only `/context reset` waits for an active reply to finish, then confirms
success. The next new human arrival establishes an empty conversation's starting
boundary, even without a reply. Pending resets survive restarts; older queued
turns, edits and reply ancestors cannot restore history. Saved Remora memories
remain intact. The implementation is verified, and `/context reset` is published
globally for the development bot's DM use. Other commands were preserved; scoped
trial startup continues to skip automatic registration.
