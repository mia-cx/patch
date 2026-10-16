# Direction

Patch is a Discord persona and conversation partner with her own voice, taste,
boundaries, and timing. Build the simplest useful conversation path before
expanding the assistant features in the versioned specs.

Patch's runtime stays JavaScript/TypeScript. Remora provides an OpenAI-compatible
inference API with optional memory-bank selection and fact-level recall controls.
Remora can keep its Python core; Patch consumes the API and remains independent
of the inference backend. Bank selection and write destinations are distinct,
and Remora enforces which facts may enter recall. For service setup and supported
trial behavior, read the [final Remora serving guide](https://github.com/mia-cx/remora/blob/865ade5910022188c9b8313bb76a2a4d48ced4c5/docs/api/serving.md).

Protocord is the shared Discord action framework. Its canonical source is
`mia-cx/protocord`, extracted from Prod with the core, settings, permissions,
and AI scaffold. Patch consumes it as a pinned submodule at `vendor/protocord`
through pnpm workspace dependencies. Publishing packages is deferred.

Patch's commands and model actions use Protocord's shared validation,
availability, authorization, execution, and presentation lifecycle. Patch owns
the actions and a model tool-call trigger provider; Protocord owns Discord
triggers, autocomplete, and command registration. Its AI extension remains a
scaffold; Patch's provider uses the core extension contract directly.

Start Remora conversation trials in a single-human place. Wrong-person recall
and semantic forgetting collateral remain unresolved for shared places.

Patch's Remora client is opt-in for one-to-one DMs. Caller-owned rendered history
precedes one raw final user turn; stable source IDs and edit revisions survive
generation retries. Read-bank selection never adds write destinations or grants.
Runtime capabilities bound context/output; write receipts and observed cache reuse
are validated. Classifier, activity, and formatting calls have no memory access.
The shared contract and synthetic full-persona request are in `spec/fixtures`.
The real TypeScript HTTP smoke passes against the isolated HF 12,288-token
profile: full-persona replies are nonempty and generation retries replay the same
durable write result. A second real smoke with Remora's native SYSTEM checkpoint
reports 7,310 reused persona-prefix tokens and 1,601 evaluated tokens on each call.
That proves persona-prefix reuse, not entire-history KV continuity. Remora's
reviewed HF source `58626f9` remains the controlled single-human DM trial backend.
Final service/native docs are released at `865ade5`; the native CPU development
backend `90c4970` is selectable behind the same API for its exact BF16 profile.
Its final stock Patch HTTP proof has nonempty replies and durable receipt replay,
with a cold 0/8,917 reused/evaluated count followed by 7,310/1,607. Native needs
`LLM_TIMEOUT_MS=300000`; this does not establish GPU, quantized, or broad HF parity.
The controlled HF trial is running in Mia's one-to-one DM, restricted to that
channel with global command registration skipped. It uses separate trial SQLite
settings and a fresh context starting at the first new human message; subsequent
turns grow normally. Native qualification does not gate this HF trial.
The measured synthetic Patch request already uses 8,770 rendered Gemma tokens
before Remora framing/output, so an 8,192-token profile is insufficient.

Chat context grows from a persistent per-channel starting boundary until it
reaches the token budget, then jumps forward to a recent boundary with room to
grow again. Keep prompt prefixes stable for llama.cpp's KV cache. Evaluate
Remora's recall across these resets before deciding whether compaction is
needed; automatic summaries are deferred.
