# Remora API and inference integration handoff

The reviewed HF service and Patch client have been delivered. Use Remora's final
[serving guide](https://github.com/mia-cx/remora/blob/865ade5910022188c9b8313bb76a2a4d48ced4c5/docs/api/serving.md)
and [HF Patch handback](https://github.com/mia-cx/remora/blob/66f86295869a9c8ceb71195def08b14d67358a5c/docs/api/patch-handoff-2026-10-16.md)
for the controlled DM trial. A separately scoped
[native CPU development profile](https://github.com/mia-cx/remora/blob/865ade5910022188c9b8313bb76a2a4d48ced4c5/docs/api/native-profile-2026-10-16.md)
is now selectable through the same API; HF remains the trial backend. This
document preserves the original assignment below.

## Assignment and current decisions

Build Remora as an **OpenAI-compatible superset inference API** that Patch and
other ordinary model clients can call. Keep the existing Python memory core.
Optional request extensions select active memory banks and constrain recall.
Make the working core available first, then implement the llama.cpp inference
adapter behind the same interface. Deliver working code and executable proofs;
an HTTP wrapper alone does not complete the inference or caching work.

Mia's latest instructions supersede the earlier all-JavaScript interpretation:
Patch stays JavaScript/TypeScript; Remora may stay Python. Do not rewrite the
memory core in TypeScript. Patch owns Discord, Protocord, persona, and context
selection. Remora owns authorized memory retrieval, memory-aware inference,
automatic writes, and model/cache lifecycle. The inference backend is an internal
choice, not something every Patch call must orchestrate.

Mia specifically wants growing chat context: retain a fixed beginning until a
token budget is reached, then jump to a recent boundary and grow again. Evaluate
Remora recall across those resets before adding compaction. Preserve edits and
deletions in the active history; accept the resulting cache recomputation.

The requested bank-selection and fact-permission capability is decided. The
contract is now frozen in Remora's `docs/api/contract-v1.json`; Patch keeps a
test snapshot at `spec/fixtures/remora-contract-v1.json`. That fixture supersedes
the illustrative request below. It requires a raw final user message exactly
equal to `turn.text`, a stable `turn.id`, and an integer edit `turn.revision`.
Patch's opt-in DM client implements that contract; real backend validation is
still required. The remaining implementation assignment below belongs to Remora.

## Read before implementation

- Remora checkout: `/home/mia/mia-cx/ardm`, remote `mia-cx/remora`.
  Checked `main` is `2d69aef`; measured automatic-memory source is `067bddb`.
  Read its `AGENTS.md` if present, `DIRECTION.md`, and
  `docs/core-conversation-trial.md`. The recipient owns updates to Remora's direction.
- Core: `src/ardm/converse.py`, `kvmem.py`, `factchannel.py`, `retrieve.py`,
  `model.py`, `remember.py`, `ops.py`, and `store.py`. Follow the current
  coherent-zero conversation path, rather than archived residual-hook experiments.
- Existing behavior: `docs/development/automatic-saving-2026-10-16.json` and
  `tests/test_converse.py`, `test_remember.py`, `test_ops.py`, `test_store.py`.
  These development observations and CPU tests are a baseline, not a claim of
  held-out accuracy or backend equivalence.
- Patch workspace: `/home/mia/.t3/worktrees/patch/t3-4e037cc1`, branch
  `t3/audit-protocord-before-gemma`. Source baseline `af68e2d` is pushed.
  Read `DIRECTION.md`, `src/llm/client.ts`, `src/response/responder.ts`,
  `src/conversation/context.ts`, `src/conversation/store.ts`, and
  `src/prompts/response.ts`. Patch's context implementation passes 91 tests,
  lint, type checking, and build. Coordinate required client changes with its
  owning thread; do not silently edit its checkout from the Remora thread.
- The previous `/tmp/remora-patch-protocord-handoff-2026-10-16.md` is historical
  context. This handoff replaces its integration assignment and language boundary.

## What exists and what is missing

Current Remora runs Gemma 4 E2B-it through PyTorch/Transformers. It captures model
keys/values, supplies virtual memory columns to attention, and uses separate
turn-start and partial-reply retrievers. When new facts enter a partial reply,
coherent restart rebuilds the memory prefix and consumes the prompt and emitted
tokens again under that prefix. A stock llama.cpp chat-completion proxy does not
translate those PyTorch operations into native llama.cpp behavior.

`Conversation` explicitly says that no decoder cache survives a reply. Recent
history lives in that object and is not restored when it is recreated. The
prototype also evicts old turns and caps its total budget at **448 tokens**.
Those behaviors must be reconciled with caller-owned growing contexts and
persistent cache reuse; wrapping `Conversation.reply` unchanged is insufficient.

Patch currently sends complete OpenAI-shaped `messages` and `cache_prompt: true`.
Its history is an XML transcript inside a user message. That transcript is useful
generation context, but it is **not a new human utterance for automatic saving**.
Patch currently has no Remora bank selector or source-event identity on requests.

## Target request contract

Support the OpenAI-compatible paths Patch uses: `/v1/models` and
`/v1/chat/completions`. Preserve standard messages, responses, errors, and
streaming semantics for the supported feature set. Verify Patch's actual fields,
including tools, tool choice, thinking options, and output limits. Report
unsupported features explicitly rather than accepting and ignoring them.

Keep memory controls in one optional extension. A possible request is:

```json
{
  "model": "gemma-4-e2b-it",
  "messages": [
    {"role": "system", "content": "Caller-supplied persona and instructions."},
    {"role": "user", "content": "Caller-supplied conversation context."}
  ],
  "remora": {
    "read_banks": ["patch:self", "discord:dm:123"],
    "write_bank": "discord:dm:123",
    "turn": {
      "id": "discord:message:456",
      "speaker_id": "discord:user:789",
      "text": "My piano teacher is Elin."
    }
  }
}
```

The turn supplies the actual new source text separately from rendered history.
Bind it to the caller's generation input without duplicating it in the rendered
prompt, and validate that the source text matches its actual input segment.
Define how normal structured chat messages identify that source too.
The caller owns supplied history; Remora must not append an independent hidden
history to it. Requests without the extension work as ordinary model requests,
with memory access and automatic writes disabled unless an explicit authorized
server profile supplies them.

Active banks select retrieval candidates, not unconditional inclusion of every
fact in the model input. Use one explicit write destination initially; recalling
from several banks does not mean automatically writing into all of them. Fact
references must remain unambiguous across banks whose local numeric IDs overlap.

Fact-level recall permission means whether a stored fact is eligible to
influence this request. Enforce it before candidate selection and attention
injection. The server's authenticated policy grants access; a request can select
or narrow permitted access, but cannot grant itself privileges. Start with a
small enforceable policy, document its representation, and cover denial tests.
Treat `speaker_id` as source attribution, not authentication.
This is not a promise that the model can privately know a fact while being
prevented from mentioning it. It also cannot retract information the caller
already included directly in `messages`.

## Implementation sequence and done conditions

### 1. Expose the working Python core through the compatible API

Reuse the existing model, retrievers, calibrated profile, automatic writer, and
bank storage. Refactor history ownership and source handling as needed for the
contract above. Serialize the entire shared-model operation across all requests:
retrieval encodings, generation, extraction, memory mutations, and cache updates.
Per-chat serialization alone is insufficient with the current attention patches.

Deduplicate source events and completed writes across retries and process
restarts. Define what a changed body or source revision under an existing event
ID means. Do not save the entire supplied transcript again, save the same human
turn twice, or run automatic saving plus manual registration for the same turn.
Make accepted/rejected `Reply.writes` available through documented extension
metadata or an operation receipt. A verbal acknowledgement is not a write receipt.
Specify cancellation and streamed-response completion behavior relative to writes.

**Done:** a normal client can generate through the documented compatible subset;
a memory request saves one source event, and replaying it produces no duplicate
facts or reinforcement. The selected backend and unsupported fields are explicit.

### 2. Implement active-bank selection and fact recall authorization

Support multiple authorized read banks and an independently authorized write
bank. Retain per-place provenance even when reading a union of banks. Check
permissions at turn start and every mid-reply refresh; define a consistent policy
snapshot or invalidation strategy for changes during generation. Automatic
extraction must not publish private source facts or their derivations into a more
public bank merely because both banks were active. Keep permission scope with
derived data and server-held history that may copy recalled facts.

**Done:** allowed facts can be recalled; denied facts are absent from retrieval,
injected memory, protected diagnostics, and subsequent service-held reuse. An
unauthorized bank selection fails explicitly. Same local fact IDs in different
banks cannot be confused. Missing extensions do not pick an accidental global bank.

### 3. Implement a real llama.cpp inference adapter

Inspect current llama.cpp native interfaces and Python bindings. First prove the
specific operations Remora requires: retrieval-layer encodings, coherent prefix
capture, per-layer memory K/V access, Gemma's shared-K/V layer handling, virtual
positions/masks, and memory refresh during generation. Choose binding extensions
or native changes from that evidence. Keep tensors/model operations close to the
backend; the Patch HTTP interface should exchange messages/results, not tensors.

Adapt the current memory path to llama.cpp; ordinary chat responses, embeddings,
or slot save/restore alone are not proof of attention-memory support. Validate
checkpoint, tokenizer, frame, layer, and numerical compatibility. Begin with the
existing Gemma 4 E2B profile as the reference; changing base models or quantization
is a separate measured change. A Python wrapper does not make PyTorch tensors or
retriever assumptions portable automatically.

**Done:** the llama.cpp backend demonstrably uses the selected authorized memory
inside attention, refreshes it correctly, and has matched correctness checks
against the existing reference. It is selectable behind the same request contract.
If a required native operation is missing, identify it with a minimal executable
reproduction and implement that seam; do not report the proxy as completed support.

### 4. Integrate cache reuse and growing context correctly

Reuse unchanged token prefixes when inference state is compatible. Appended
turns should avoid whole-history prefill where the backend supports it. Corrections
or deletions in active history permit recomputation from the earliest affected
point, or a broader checkpoint/rebuild when required. No proactive global cache
wipe is needed for every Discord edit. Bank or permission changes can invalidate
state even when visible prompt tokens remain identical.

Cache identity/validation must cover the model/tokenizer/frame, authorized bank
and fact state, permission revisions, selected memory prefix, and real token
history. On memory refresh, preserve coherent restart semantics: discard real-token
state derived under the old memory, then consume history and emitted tokens under
the rebuilt prefix correctly. Revoke or rebuild state containing now-denied facts.

Honor caller context boundaries. When a caller jumps forward, do not resurrect
discarded turns from an internal conversation object. Count virtual memory,
instructions, real history, and generation allowance in the budget. Validate a
larger context and Patch's actual assembled persona; raising the `448` constant
or silently truncating the caller's history is not validation. State supported
profiles and reject unsupported sizes clearly until proven.

**Done:** traces show cached versus evaluated tokens for consecutive turns, a
history correction, a caller reset, a memory refresh, and a permission revocation.
Memory changes and cross-bank requests do not contaminate one another. Demonstrate
a supported growing-context profile and document its tested capacity and limits.

### 5. Deliver an isolated local trial and a Patch integration handback

Exercise automatic save, recall after service restart, correction, forgetting,
place isolation, and recall after a caller context reset through HTTP. Use a
single-human place first: existing wrong-person answers and semantic forgetting
collateral still block shared-place trials. Do not silently redefine banks as
per-speaker stores to hide those failures. Preserve the existing reference tests
and research results; do not reopen held-out studies just for this integration.

**Done:** commit/push the Remora implementation and return its launch command,
local endpoint, backend/support matrix, minimal requests, write receipts, cache
measurements, test evidence, remaining limits, and the exact Patch client changes
needed. Exercise a real supported Gemma backend, not only a fake completion stub.
Keep existing production/daily-driver bots, credentials, and model services intact.

## Existing local model setup

Use the current core guide's calibrated thresholds and checkpoint hashes. The
development runner `/home/mia/.cache/ardm-runs/reviews/automatic-saving-root-v1/run_conversations.py`
contains `SNAPSHOT`, `TURN`, `REFRESH`, and `LOCK` for the local model, both
retrievers, and shared GPU lock. It is a setup reference, not serving code.
The existing environment is
`/home/mia/mia-cx/ardm-wt/recall-while-writing/.venv/bin/python`; when using it,
set `PYTHONPATH=/home/mia/mia-cx/ardm/src` so imports resolve to current source.
Check current GPU ownership and use the shared lock before loading a model.
Root disk space is low; reuse the existing assets and do not clean up other work.

Do not add Discord-specific types to Remora's public contract, redesign Protocord,
build a permissions dashboard, add compaction, or claim complete privacy erasure
from the existing semantic forget operation. This assignment is the inference
service, its authorized memory interface, and its cache/context integration.
