# Quoted replies and missing web calls

On 2026-10-19, the installed `47f2fb8` caller emitted quoted chat and promised web actions without calling tools.
This investigation uses exact stored decoder preimages and reconstructed requests through that installed responder.
The reconstruction blocks Discord mutations and inference. It uses a private caller-database copy.
Historical context boundaries come from the original logs; reconstruction is not a live request capture.

## Findings and offline fixes

`ConversationObservations.assistantBody` applied `JSON.stringify` inside native assistant content.
Ordinary dialogue acquired literal surrounding quotes and escaped punctuation.
The fix appends the exact display text and uses literal source views.
It preserves genuine quotes, raw generated parents, display identities and revision ancestry.
The mixed exact/transformed-display regression fails before this change and passes afterward.
Existing quoted messages remain unchanged; there is no blanket quote stripper.

The actual request advertises both web tools and the tagged-call protocol.
The original Wikipedia turn selected no memories and emitted ordinary quoted text, with no tool call.
Later context rollover dropped the Wikipedia goal before the explicit fetch request.
That request retained neither a page nor a topic. Rollover and history boundaries are unchanged.

Read-only comparisons place a short protocol reminder beside current-human metadata.
Gemma then emits `<tool_call>web_search{query:article of the day wikipedia}</tool_call>`.
The parser now accepts one literal multiword string inside that existing leading envelope.
Complete schema validation, permissions, URL checks and the three-call budget still apply.
Bare function-looking text is not executable. The raw human message remains separate and unchanged.
The real SDK/responder regression dispatches this captured syntax, reads a fictional result and posts the answer.
It fakes inference and external web responses, so it proves caller mechanics rather than model selection.

## E2B comparison

Eight bounded E2B calls used read banks plus the same speaker, without observation batches or writable tuples.
Every response returned `writes:null` and no observation receipts. No Discord messages were sent.
The final two-call run used the actual dispatcher and actual DDG client.
Search succeeded, but Gemma stopped with a vague answer instead of calling `web_fetch`.
The page-fetch assertion failed. This result remains rejected as an end-to-end web-fetch fix.
Brief instructions improved initial call selection; literal history alone did not remove every generated quote.

Private captures and comparisons live under
`/home/mia/.cache/patch-remora-dm-trial/diagnosis/quotes-web-2026-10-19/`.
`verified/attempts.json` and `verified/result.json` preserve the actual search-only negative result.
This result remains an E2B failure; the later E4B qualification does not change it.

## Qualified E4B release

Mia approved the Unsloth NF4 E4B switch. The unchanged full-persona acceptance journey at
`209603b` completes 18 generations and 34 caller HTTP requests on isolated invented banks.
It executes `web_fetch`, uses the page's offline-until-sync detail, and recalls that detail after reset.
Plain and indirect preferences, later conversational correction, same-ID source edits, erasure/retry,
and the observed private/shared isolation checks pass their bounded gates with Laya resident.
Physical SQL review finds no Oolong plaintext after erasure and no unrelated-bank changes.
Revision and erasure also retire the useful independent correction through captured ancestry;
independent correction preservation remains unproved. This is conservative collateral erasure,
not a failure to read a surviving correction. General web and memory quality remain unqualified.

The scoped caller now runs immutable `209603b`/`51eb418` with
`gemma-4-e4b-it-unsloth-bnb-4bit`. Both the environment and persisted model setting use this alias.
The full capability document matches the previous release except for the model value.
Actual LlmClient negotiation, Discord READY in the existing DM and selected guild channel,
and Laya English CUDA health pass. Classifier gates stay off.
All other caller SQLite rows/schema, history, source IDs, cutoffs, persona, scopes and command objects remain unchanged.
Release verification uses startup and health only, with no inference, deletion or registration probes.

Private release proof lives under
`/home/mia/.cache/patch-remora-dm-trial/diagnosis/e4b-release-2026-10-19/`.
`resumed.json` binds the installed bundle, startup capabilities, model setting and preservation checks.
Backend qualification and the preserved rejected attempts live under
`/home/mia/.cache/ardm-runs/reviews/e4b-quant-port-2026-10-19/`.
