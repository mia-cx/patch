# Explicit memory controls

`memory_save({})` stores the entire current human message as attributed evidence.
The message must start with a direct remember request, such as
`please remember that Sam's cat is Pepper`. `remember that` requires clarification.
The source author stays the authenticated speaker. Semantic subjects remain
unresolved, including when the speaker describes somebody else.

The Discord adapter chooses the source ID, revision, speaker, message time and
sole writable bank. Read banks cannot become write destinations. The new Remora
save API requires its own capability and existing full-bank read/write grants.
It admits the literal quotation without surprise scoring, extraction or atoms.
An independent explicit receipt can save a source rejected by passive admission.
Both paths share source declarations, revision retirement and erasure fences.

`memory_forget({scope, kind, id?})` uses existing management permissions and
exact-ID endpoints. `scope` is `personal`, `channel` or `server`; `kind` is
`fact` or `evidence`. A current human request must identify the namespace and ID,
such as `forget evidence #42`. Ambiguous requests return authorized candidates
and delete nothing. Channel/server deletion requires the same Discord management
permissions as `/memory`. Personal controls run in the requester's DM.

The caller durably freezes the deletion revision before its first attempt.
Retries reuse that revision and backend request ID, including after restarting.
The journal retains digests and revisions, never request or memory plaintext.
Deletion applies the existing caller privacy fence before the HTTP mutation.

Each memory action executes alone. The turn runner returns a validated
`memoryToolResult` and deterministic confirmation. The responder sends it without
another model call, prompt repair or reuse of erased context. A failed operation
returns `completed=false`; a clarification returns `completed=true` with
`status=clarification_required`. Neither confirms a mutation. A replayed save
whose memory was forgotten returns `status=forgotten`, with empty `active_ids`.

The runtime-derived schemas and synthetic examples are in
[`fixtures/memory-tools.json`](fixtures/memory-tools.json). They include the
dispatcher, tool-result and terminal-turn envelopes. Terminal memory controls
do not emit native `role=tool` or tagged continuation messages to the model.
The contract records implementation hashes and deployment status separately.

The cross-language test starts a temporary localhost Remora server with fictional
grants and an engine that rejects inference. Run it with
`REMORA_TEST_SOURCE=<Remora checkout> pnpm exec vitest run src/memory/tools.integration.test.ts`.
Set `MEMORY_CONTRACT_EXPORT=<path>` to regenerate a contract from those results.
The always-run fixture test compares exported schemas against the actual registry
and runtime output validators. The HTTP test also checks actor attribution,
durable retries, ambiguity, caller fencing and replay after erasure.

This implementation requires the paired Remora explicit-save change. Existing
servers hide `memory_save` unless they advertise support. No deployment or real
Discord operation forms part of this qualification.
