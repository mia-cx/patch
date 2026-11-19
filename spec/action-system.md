# Action system

Patch owns concrete actions. [Protocord](https://github.com/mia-cx/protocord),
pinned at `vendor/protocord`, owns the registry, Discord trigger providers,
command registration, autocomplete, and action lifecycle.

`src/actions/registry.ts` composes the built-in Discord providers with Patch's
model tool-call provider. `src/actions/defaults.ts` registers the four actions.
`src/actions/context.ts` supplies application dependencies and adapts Effect
schemas to Protocord input parsers and JSON Schema. Tool schemas and runtime
validation therefore come from the same source.

Every command and tool call passes through trigger parsing, action input
validation, availability, authorization, execution, and presentation. The
responder never calls an action's `execute` method directly. Availability uses
the current invocation's channel; it is checked again when a tool is executed.

## Current actions

| Action | Discord command | Model tool | Access and behavior |
| --- | --- | --- | --- |
| `delete_messages` | `/delete count:1-100` | None | Owner anywhere, anyone in DMs, or Manage Messages in guilds; delete only Patch's messages |
| `model` | `/model [name]` | None | Owner only, including autocomplete; show or persist the response model |
| `reload_runtime` | `/reload` | None | Owner only; reload prompt and identity files |
| `leave_thread` | `/leave` | `leave_thread` | Thread only; send a farewell before leaving |

The first three commands defer and respond privately through Protocord. Their
permission checks run before execution. Model autocomplete returns no choices
and never queries the model catalog for a non-owner.

`/leave` generates a public farewell through the existing `leave` priority in
the global generation queue, using bounded recent thread context. Its custom
presentation preserves the public original response without adding a second
completion message. A failed generation or send keeps Patch in the thread and
reports the failure at the dispatch boundary.

## Model tools

`src/actions/tool-calls.ts` implements a Protocord trigger provider for Patch's
LLM tool-call format. Only explicitly registered tool triggers become model
tools; owner commands have no tool triggers.

The `leave_thread` tool requires a string `farewell`. It sends that exact text
after the existing emoji removal and split handling, with all mentions disabled,
then leaves. Tool calls run inside the responder's existing generation job and
must not enqueue another job for the same channel.

Malformed JSON, invalid arguments, unavailable actions, unknown tools, and
authorization failures cannot reach action side effects. Failed sends propagate
to the responder's existing failure handling. A model's choice of tool does not
bypass Protocord's checks.

Protocord's separate AI extension is still a scaffold. Patch uses the core
trigger-provider contract directly; completing Prod's AI triage is independent.

## Later actions

`summarize_context`, `debug_context`, and `debug_classify` remain future v1
actions. Add them as consumer actions using the shared runtime rather than
introducing another registry or dispatcher.
