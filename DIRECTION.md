# Direction

Patch is a Discord persona and conversation partner with her own voice, taste,
boundaries, and timing. Build the simplest useful conversation path before
expanding the assistant features in the versioned specs.

Patch's runtime stays JavaScript/TypeScript. Remora provides an OpenAI-compatible
inference API with optional memory-bank selection and fact-level recall controls.
Remora can keep its Python core; Patch consumes the API and remains independent
of the inference backend. Bank selection and write destinations are distinct,
and Remora enforces which facts may enter recall. Before implementing the client
integration, read [the Remora handoff](spec/remora-service-handoff.md).

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
