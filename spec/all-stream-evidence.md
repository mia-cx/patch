# Offline evidence integration

This caller targets Remora `d3d1ee3`, with strict lineage validation at `a96f638`.
Patch remains offline. The installed bundle, environment, cutoff, commands,
services, policy and original banks are unchanged. Actual full-caller inference
qualification is pending. Offline proofs use invented responses only.

## Negotiation

The companion is [all-stream-evidence.json](fixtures/all-stream-evidence.json).
Its canonical source SHA256 is
`3d4760b113e65869f1d8cc5fceb3a4a81cf2d9f9eb85c48df03b5585ccc5b941`.
Require `all_stream_evidence:true`, `source_references:true`, both original scalar
bindings and `source_reference_binding:completed_generated_scalar_views_v1`.
Require all six observation limits, management support and `entity_identity:false`.
Inputs plus references share the 128-source ceiling. Their views share 512 slots.
The source scalar ceiling is 65,536; the complete input total is 262,144.
Readable context allows 16 sources. Complete digest ancestry is separate from
that readable context budget. No source is split to disguise a larger source.

Requests carry `read_banks`, scoped `speaker` and `observations`. Legacy `turn`,
`write_bank` and identity declarations are absent. Remora derives the principal.
The older base fact/search/name contract remains unchanged.

## Source identity and rendering

Actual SDK text supplies `discord:message:<id>` at its edited timestamp or zero.
Only human creations strictly after a durable bank cutoff become human inputs.
An old creation remains excluded even after an edit. Local actors preserve
authorship; source authors never imply fact subjects.

The current human message stays literal. Historical human bodies use reversible
JSON views. Author labels, participant rosters, reply references and tool protocol
syntax are distinct caller framing. Unknown legacy content, other bots,
attachments and unqualified assistant history remain explicitly uncovered.

Every final tool-loop message array compiles its own scalar offsets. Fresh web
titles, bodies, snippets and URLs retain tool/URL provenance. Duplicate citation
fields reuse those source declarations. Search-query echoes depend on their real
generated tool-call parent. Scratch results, recalled facts and truncated result
copies stay unknown. They are not independent external observations.

## Decoder output and displayed replies

`LlmClient` exposes the exact response before parsing, trimming or fallback.
Every actual attempt has its own backend-generated source ID. Sampling fallback
keeps the input batch immutable and records the new actual decoder attempt.
Only completed local outputs with qualified ancestry can become references.
Useful-rejected but complete outputs qualify; unknown or incomplete outputs do not.

The caller retains full raw preimages and digest-only consumed manifests in its
private SQLite store. References send that exact complete preimage. Exact display
substrings use scalar `source_start`/`source_end` views. A changed display uses its
actual Discord ID/revision as `unattributed_input`, without an actor. Its frozen
context names the raw generated parent, supplied as a context-only reference.
Emoji removal, citation appendices and output directives never become invented
exact spans. Formatting repair is a real separate attempt with its own parent.
An unqualified predecessor stays unknown in repair input; that attempt still gets
observations and exact raw capture, without gaining reference eligibility.

`sendChunks` records actual returned Discord IDs and exact bodies, including
reply fallback. Merged assistant chunks keep their individual display mappings.
Indirect human answers bind to the latest visible assistant question by rendered
position. Restoring an older frozen dependency cannot change that question.
Complete context manifests survive history rollover without rebinding a source.

## Edits and forgetting

Credential-local namespaces separate retained raw preimages. SQLite transactions
serialize epoch checks and plaintext commits across connections. Source revisions
retire local descendants, including when a trusted edited SDK body becomes blank
or loses its qualified display mapping. Later responses from retired attempts
cannot be sent, execute tools or refill retained plaintext.

Management keeps the exclusive generation queue through fencing, mutation and
confirmation. Before a POST, it purges raw outputs, display bodies, action receipt
payloads, notes, pending follow-ups and web caches, then persists the principal-wide
history reset. A durable replay also requires that fence. Late asynchronous writes
check the original epoch; redacted receipt IDs cannot restore old plaintext.

Facts and evidence retain separate numeric ID namespaces. Evidence list preserves
complete quotations, source actors, context and provenance, with a private JSON
export. Record forget and source forget are distinct operations. Clear covers
both kinds. Protocord enforces owner-only personal access and Discord shared-bank
permissions. New evidence command options remain unpublished. Fact-only search
does not enumerate evidence.

Local retirement does not itself notify Remora of a blank edit or Discord deletion.
This qualification uses a real nonblank source revision. Backend source erasure
uses the explicit management endpoint; no blank text or renamed source is forged.

## Proposed clean cutover

Ordinary rollover cannot repair incomplete lineage. A reply that consumes unknown
legacy history can produce another unqualified displayed reply indefinitely.
The eventual release must therefore review an explicit clean model-context boundary.
No boundary is applied by this offline work.

1. Qualify the exact assembled caller on isolated new banks and review its replies.
2. While generation is fenced, choose the creation-ID cutoff and persist it per bank.
3. Clear caller plaintext caches and set a pending clean context boundary for every
   memory-backed chat. The next new human message starts the new model context.
4. Preserve all old Discord/history records, bank data, source IDs and revisions.
   Do not re-extract, rename sources or import old replies as new observations.
5. Resume only after exact backend readiness, caller capability checks and the
   coordinated release handback. Command publication is a separate action.

## Prepared full-caller qualification

[qualify.ts](../test/full-caller/qualify.ts) is prepared but has not run. It requires
the future private `ready.json` and matching token-file path. It accepts only
`127.0.0.1:18789/v1`, model `private-gemma-full-caller-v1` and four explicitly
mapped `full-caller-v1-*` banks. It makes at most 24 completions and 63 caller HTTP
requests. All Discord transports are invented local SDK packets; actual WebClient
transports return invented page data. Other actions and network destinations fail.

The real responder assembles the full persona and available Protocord tool catalog.
Native tools, thinking and search stay disabled; tagged tools remain enabled.
The plan separately checks plain and indirect preference recall, web follow-up,
actual formatted-display re-entry, conversational correction after reset, then
source edit after a separate reset. It also checks record/source erasure, immutable
retries, unrelated sentinel preservation and private/shared isolation.
The post-erasure question separates the original source's tea from any surviving
editor correction. Same-fact answers alone do not prove source resurrection.

The runner holds the caller fence through each management request and replay.
Its release marker uses a completed private temporary file and exclusive atomic
link after closing the caller. Output reports remain unqualified pending semantic
hand review and backend physical-erasure snapshots. Wrong speaker, resurrection
or cross-bank disclosure fails qualification.

[prepare.ts](../test/full-caller/prepare.ts) runs only an invented-response audit.
It freezes exact complete persona bytes, the caller source/fixture closure and
observed source/view counts in `full-caller-contract-v1`. The audit includes 41
offered history pairs, three tagged tool rounds and actual formatting repair.
Observed maxima describe those fixtures; runtime validation uses negotiated
128/512 ceilings. No shortened persona or transport-only semantic claim is accepted.

Offline closure passes 328 tests, typecheck and build. Independent reviews found
and closed SQLite interleavings, visible-question ordering, omitted edit versions,
late presentation, repair capture and transport-failure cancellation gaps.
The final focused closure passes 81 checks and TypeScript with no remaining finding.
