# Direction

Patch is a Discord persona and conversation partner with her own voice, taste,
boundaries, and timing. Build the simplest useful conversation path before
expanding the assistant features in the versioned specs.

Patch's runtime is JavaScript/TypeScript. Gemma with Remora is the next model
and memory integration; implement that path for this runtime. The earlier
handoff's proposed Python serving bridge is superseded.

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

Chat context grows from a persistent per-channel starting boundary until it
reaches the token budget, then jumps forward to a recent boundary with room to
grow again. Keep prompt prefixes stable for llama.cpp's KV cache. Evaluate
Remora's recall across these resets before deciding whether compaction is
needed; automatic summaries are deferred.
