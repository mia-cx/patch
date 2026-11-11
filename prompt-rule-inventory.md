# Prompt rule inventory

Purpose: abstract inventory for recomposing Patch's prompt rules. This is not a prompt component and is not assembled into runtime prompts.

## Rule buckets

| Bucket | What it is for | Current homes | Applies to | Notes for recomposition |
| --- | --- | --- | --- | --- |
| Identity | Establish Patch as herself: Discord presence/persona, she/her, not a generic assistant. | `system/identity.md` | response, classifier, leave | Keep short. Persona facts should be passive, not behavior templates. |
| Capability boundary | Tell the model what Patch can mechanically do in Discord. | `system/identity.md`, `system/output.md`, `system/splitting.md`, `system/mentions.md` | response, leave | Keep only mechanics that affect output. Too much capability text makes models overuse mentions/tools. |
| Output shape | Visible output only, Discord Markdown, no XML/JSON/emoji, code only on request. | `system/output.md` | response, leave | Good system-level mechanical rule. Code/emoji may also deserve code-side enforcement. |
| Transcript grammar | Explain XML-like blocks and metadata. | `system/transcript.md` | response, classifier, leave | Keep as factual legend. Avoid behavior advice here except ownership/focus essentials. |
| Speaker ownership | Text belongs to block author; mentions are address markers; first-person belongs to speaker. | `system/transcript.md`, `response-user.md` | response, classifier | Critical. Should stay close to transcript legend and latest-message task. |
| Current trigger focus | Bottom block is the current message; earlier blocks are context only. | `system/transcript.md`, `response-user.md`, `classifier-user.md` | response, classifier, leave | Critical. Repeated in user prompt because it is task-local. |
| Prior Patch replies | `<response>` is memory only; don't copy/revive/append. | `system/transcript.md`, `response-user.md` | response | Important because model copies stale replies. Could be shorter and task-local. |
| Metadata truth | Use participant metadata for names/pronouns; `missing` means unknown. | `system/transcript.md` | response, classifier | Keep. This is tribal/mechanical context the model cannot infer. |
| Addressee/reference resolution | Resolve `you`, pronouns, self-questions, action direction. | `system/transcript.md`, `response-user.md` | response, classifier | Keep, but split: transcript legend handles metadata; response task handles action direction. |
| Mention policy | Don't ping latest author; only mention when requested/needed; never everyone/here/roles. | `system/mentions.md` | response, leave | Mechanical Discord output constraint. Consider code enforcement for leading reply-target mentions. |
| Message splitting | `<\|message_split\|>` protocol. | `system/splitting.md` | response, leave | Mechanical output tool. Keep concise. |
| Safety/refusal | Serious harm/crime refusal; distress care; repair after hurt/boundary/wrong pronoun/name. | `system/safety.md` | response, leave | Keep compact and high-priority. Avoid mixing ordinary style criticism with serious harm. |
| Repair after bad response | If user critiques/corrects Patch, accept and answer fresh. | `system/safety.md`, `system/style.md`, `response-user.md` | response | Currently scattered. Make one repair bucket, probably response-task-local plus safety for harm/boundaries. |
| Casual style target | Short Discordy lines, sparse punctuation, no assistant voice. | `system/style.md` | response, leave | Keep positive examples. Avoid long lists of forbidden phrases; they become token soup. |
| Anti-echo / anti-mirror | Don't repeat latest line, swap names, or copy structure. | `system/style.md`, `response-user.md`, `system/transcript.md` | response | Important but over-repeated. One task-local final check may work better than many negatives. |
| Stock assistant avoidance | Avoid `What's on your mind?`, eager help endings, corporate phrasing. | `system/style.md` | response | Keep only highest-impact examples. Long banned-word lists are weak-model bait. |
| Greeting behavior | Fresh tiny beat for greetings; don't mirror. | `system/style.md`, `response-user.md` | response | Keep as positive examples (`heyyy`, `sup`, etc.). |
| `nah` opener | Avoid reflexive `nah ___` unless real disagreement/refusal. | currently absent after compaction | response | Add as positive rule: start with answer itself; use `nah` only for actual disagreement/refusal. |
| Humor / bite | Dry, sassy, lightly sarcastic; short interjections for light scenes. | `system/humor.md` | response, classifier | Shared with classifier because classifier needs interjection openings. Keep examples abstract. |
| Heavy-topic restraint | Don't joke/interject in heavy/support contexts. | `system/humor.md`, `system/safety.md`, `classifier.md` | response, classifier | Classifier needs this more than responder. Avoid duplicate wording. |
| Helpfulness posture | Friend first; practical help only when asked. | `system/helpfulness.md` | response | Keep. Important for persona-vs-assistant distinction. |
| Slang policy | Understand online/queer slang; mirror lightly. | `system/slang-policy.md` | response, classifier | Tiny and fine. Could merge into style. |
| Style presets | Named micro-styles for future planning/control. | `system/style-presets.md` | currently unused | Not assembled. Keep only if future planner uses it; otherwise archive. |
| Reasoning budget | Bound hidden thinking when enabled. | `system/reasoning.md` | response when thinking on | Keep separate and only assemble when thinking enabled. |
| Classifier decision criteria | Decide passive respond/decline. | `classifier.md`, `classifier-user.md` | classifier | Should not inherit full response style/output. Needs identity + transcript + humor openings only. |
| Passive direct address | Plain text `hi patch` counts as address even without Discord mention. | `classifier.md` | classifier | Keep. This fixed a concrete miss. |
| Leave behavior | Farewell after `/leave`, topical only if obvious. | `leave.md`, `leave-user.md` | leave | Should use minimal response stack; not all normal response rules. |
| Activity JSON | Generate Discord activity JSON only. | `activity.md` | activity | Standalone. Do not mix with Patch response stack. |

## Candidate recomposition

### Response system stack

Core response probably needs only:

1. `identity` — who Patch is, friend-first.
2. `transcript` — block grammar, metadata, ownership, bottom block.
3. `output` — visible Discord Markdown, no emoji/code unless asked.
4. `style` — short Discord voice, positive greeting/repair examples, avoid assistant sludge.
5. `humor` — bite/interjection posture.
6. `safety` — refusal/care/serious repair.
7. `mentions` — only because pings are mechanically risky.
8. `splitting` — output protocol.
9. mode file — DM/thread/guild shape.

Move most per-turn instructions out of system and into a shorter `response-user.md` task prompt.

### Classifier stack

Classifier should stay lean:

1. `identity` — enough to know Patch.
2. `transcript` — enough to resolve addressee and Patch responses.
3. `humor` — only for interjection openings and heavy-topic restraint.
4. `classifier` — criteria and JSON format.
5. mode file.

Do not include response style, mention policy, output code rules, splitting, or helpfulness unless the classifier demonstrably needs them.

### Leave stack

Leave should be minimal:

1. `identity`
2. `transcript`
3. `output`
4. `style`
5. `safety`
6. `splitting`
7. `leave`
8. `transcript-thread`

Probably omit general helpfulness, full humor, and mentions unless live failures show need.

### Activity stack

Standalone only. Keep JSON-only prompt.

## Rules likely better in code

| Rule | Why |
| --- | --- |
| Strip accidental leading mention of reply target | Mechanical Discord output constraint; models repeatedly fail it. |
| Block `@everyone`, `@here`, role mentions | Platform safety/mechanics. |
| No Unicode emoji | Already code-enforceable and easier than prompt. |
| Split/send chunks | Already code-owned. Prompt only exposes `<\|message_split\|>`. |
| Context window trimming per model | Runtime/mechanical; do not ask model to manage it. |
| Reserved transcript token neutralization | Already code-owned. Prompt only documents the format. |

## Rules to avoid expanding

- Long banned phrase lists.
- Repeated `do not copy` variants across many files.
- Persona facts as reply templates.
- Broad style adjectives without concrete examples.
- Rules explaining implementation internals unless the model must reason over visible transcript metadata.

## Concrete next edits to consider

1. Add one positive `nah` rule to `system/style.md`.
2. Cut `response-user.md` down to task-local focus/repair/anti-echo only.
3. Remove `system/slang-policy.md` as separate component by merging its one line into style.
4. Stop assembling `system/humor.md` into leave unless farewell failures need it.
5. Add code-side stripping for accidental leading latest-author mentions.
6. Add a tiny prompt/model eval set for greeting, no-ping, stop-copying, stale-context, pronouns, and no-code-unless-asked.
