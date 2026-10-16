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

The existing in-app actions still use Patch's original dispatcher; migrate
them onto the shared runtime as a separate behavior change. Protocord's AI
extension is currently a scaffold.

Start Remora conversation trials in a single-human place. Wrong-person recall
and semantic forgetting collateral remain unresolved for shared places.
