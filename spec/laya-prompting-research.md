# Laya prompting research for Patch

Research date: 2026-10-19. Parent-supplied baseline: the unchanged Gemma persona/JSON prompt is about 24k characters and passes 4/8 social cases on `laya-multilingual`. This research does not independently evaluate that result.

**Recommendation, inferred for Patch:** use one `choice` question, two short, self-contained action descriptions, and compact conversation evidence. Mark the latest message explicitly. Retain the social decision policy; remove instructions about writing Patch's reply and producing JSON. Treat the revised wording as a candidate for evaluation, with no promised accuracy gain.

The official [multilingual model card](https://huggingface.co/convaiinnovations/laya-multilingual#links) links to the [maintainer's documentation index](https://nandhakishorm.github.io/laya/). I followed that index's actual links to [Questions and answers](https://nandhakishorm.github.io/laya/questions-and-answers/), [Routing](https://nandhakishorm.github.io/laya/routing/), and [HTTP API](https://nandhakishorm.github.io/laya/http-api/). Repository code links below pin revision `ffc142012af63d015fa19f05f29f9c5ff329a2cc`, which was `main` when inspected. These facts do not establish Patch's deployed Laya version. Laya Studio is excluded as model-owner guidance because its [footer identifies an independent, unaffiliated service](https://laya.studio/docs).

## 1. Instructions, criteria, and token budgets

**Documented:** `choice.criteria` maps labels to descriptions in positional order. Descriptions are model input, and returned labels retain the caller's spelling. Reordering criteria changes the rendered question. [Questions and answers](https://nandhakishorm.github.io/laya/questions-and-answers/#choice-pick-one-of-a-set)

**Source behavior:** each rendered option first receives at most 48 tokens, including its label and description. The renderer can shorten it further. Instructions receive the remaining head budget, with an eight-token floor. State room is `max(0, max_len - actual_head_length - 1)`, rather than `max_len - head_max_len`. [Pinned renderer](https://github.com/NandhaKishorM/laya/blob/ffc142012af63d015fa19f05f29f9c5ff329a2cc/laya/common.py#L157)

**Documented defaults:** English uses `max_len=512`, `head_max_len=192`; multilingual uses `1024` and `256`. Raising `max_len` supports longer state; raising `head_max_len` changes the question budget. Wider budgets can change answers adversely even when labels already fit. [README budget mechanics](https://github.com/NandhaKishorM/laya#honest-limits), [LangChain budget guide](https://nandhakishorm.github.io/laya/langchain/#7-widening-the-token-budget-for-many-options)

**Patch implication, inferred:** place the decision target and latest-message scope first. Give both choices concrete meanings immediately. Keep each description within its 48-token ceiling. Increasing total context alone cannot preserve an oversized question. A compact policy in `state` avoids question-head trimming but still consumes state capacity. The official guidance does not prescribe an ideal prompt character count or policy sentence count.

The HTTP request accepts both budget overrides, capped by `LAYA_MAX_TOKEN_BUDGET` (default 8192). `usage.truncated`, `state_tokens_dropped`, and `truncated_questions` report **state** loss. They do not certify that the entire instruction or every option description survived head trimming. [HTTP controls and usage](https://nandhakishorm.github.io/laya/http-api/#response), [pinned option trimming](https://github.com/NandhaKishorM/laya/blob/ffc142012af63d015fa19f05f29f9c5ff329a2cc/laya/common.py#L226)

## 2. State, latest message, and history

**Source behavior:** strings pass through; objects and lists become JSON text. There is no chat-template or privileged system-role handling in this serialization path. [Pinned serialization](https://github.com/NandhaKishorM/laya/blob/ffc142012af63d015fa19f05f29f9c5ff329a2cc/laya/common.py#L95)

**Source behavior:** `Agent._encode_state` keeps the end of a top-level list when it exceeds the window. It keeps the beginning for other state shapes. The list check applies regardless of whether its contents are genuinely chronological turns. [Pinned agent](https://github.com/NandhaKishorM/laya/blob/ffc142012af63d015fa19f05f29f9c5ff329a2cc/laya/agent.py#L1133)

The LangChain integration defaults to the newest user message from `messages`. Full-conversation routing requires explicit selection of a chronological role/content list. The guide says overflowing lists preserve recent turns. This default belongs to the integration, not arbitrary HTTP `state` objects. [Official conversation example](https://nandhakishorm.github.io/laya/langchain/#routing-with-the-full-conversation)

**Patch implication, inferred:** represent the target separately from history. Include latest content, speaker identity, actual reply target, actual bot mention, bot names/aliases, location, and only relevant recent turns. A count of mentions cannot identify whom the author addresses. Preserve enough history to distinguish a short continuation from an ambient acknowledgement, and direct address from third-person discussion.

For an object state, put the latest message and essential identity/reply facts first. For a conversation list, keep chronological order and put the latest turn last. A nested history array inside an object does not trigger top-level list truncation. These placement recommendations follow the source behavior; they are not measured accuracy claims. Prefer fitting the compact state fully rather than depending on token-level clipping, which can cut through a turn.

The unchanged-prompt comparison sent a two-entry system/persona and user/transcript array. That array receives list-tail retention, while the transcript's internal XML-like messages remain text. Its long persona/policy was in `state`, not the question head, so the head cap alone does not explain 4/8. Those outer roles do not establish a generative chat instruction hierarchy. The revised implementation and measured comparisons are recorded in [the classifier guide](laya-classifier.md).

## 3. Label meaning, negation, and social policy

**Documented:** avoid boolean-word `choice` keys such as `true`/`false` and `yes`/`no`. The checkpoints can follow those words instead of the descriptions. The README suggests semantic or neutral keys, with validation on the exact checkpoint and states. [README label guidance](https://github.com/NandhaKishorM/laya#honest-limits)

The maintainer confirms that semantic labels still fail on some negated requests. Their October 11 report recommends explicit alternative outcomes and contextual wording. Both checkpoints still make confident negation errors. This is a mitigation, not a fix. [Maintainer's report](https://github.com/NandhaKishorM/laya/issues/377#issuecomment-6111586850)

**Patch implication, inferred:** the existing `respond` / `dont respond` wire labels can remain during the first comparison. Describe `dont respond` positively as staying silent or leaving the turn to humans. Define the action rather than referring to a hypothetical `shouldRespond` JSON field. Neutral `A`/`B` labels are an optional later comparison; official guidance does not establish that they outperform these action labels.

The concise policy must still distinguish invitation, continuation, correction, and a concrete social opening from discussion about Patch. Include explicit human-directed replies, ambient acknowledgements, serious stop requests, and uncertainty in the silent outcome. Keep the creative-interjection allowance if it remains product policy. Replacing all of this with a direct-mention rule would change the task. These are Patch requirements from its existing classifier policy, not Laya-authored rules.

## 4. Confidence and HTTP interpretation

**Documented:** for `choice`, `answer_confidence = max(p)` measures the returned label's probability. `confidence = 1 - H(p)/log(k)` measures distribution concentration. Calibration figures and temperature fitting use the former. It remains uncalibrated until fitted and validated for the checkpoint and option count. `noul` is a different question type, whose `confidence` equals `answer_confidence`. [Official confidence definitions](https://nandhakishorm.github.io/laya/questions-and-answers/#reading-confidence)

`action.act_probability` comes from a separate act/escalate head. It is not the probability of Patch's `respond` label. [Official action definition](https://nandhakishorm.github.io/laya/questions-and-answers/#action-and-act_probability)

**HTTP behavior:** `min_confidence` gates `answer_confidence` and retains the answer. Current docs report `abstention` as `passed`, `abstained`, or `unevaluated`, with `low_confidence` and the threshold. Ungated answers omit these fields. Strict Jev mode strips routing, `answer_confidence`, and truncation details. [HTTP contract](https://nandhakishorm.github.io/laya/http-api/#response)

**Patch implication, inferred:** distinguish the winning label's probability from `probabilities.respond`. If silence wins, high `answer_confidence` supports silence. Do not reuse an entropy-confidence threshold as a top-probability threshold. Confirm the deployed contract before changing decoding; the locally inspected schema expects optional boolean `abstention`, unlike current documentation. The existing 4/8 result does not establish a useful confidence cutoff.

## 5. Checkpoint choice and limits on conclusions

**Documented routing:** explicit `model` wins over language detection. Default routing sends English to English and other supported languages to multilingual. Uncertain language defaults to multilingual since 0.4.0. `typed-decisions` is not automatic by default; optional task detection matches exact known question-ID sets, not question wording. [Official routing order](https://nandhakishorm.github.io/laya/routing/#how-a-checkpoint-is-selected)

HTTP accepts `multilingual` and `convaiinnovations/laya-multilingual` as explicit checkpoint selections. The bundle ID `convaiinnovations/laya` permits automatic routing; it does not pin English. Inspect `routing.model` and the checkpoint revision when comparing results. [HTTP model selection](https://nandhakishorm.github.io/laya/http-api/#post-v1systemone)

The multilingual card describes a non-generative classifier with a default 1024-token window, configurable up to 8192. It reports overconfidence, weaker English results, and near-chance transfer to its typed-decisions benchmark before specialization. Long-context results become less reliable beyond roughly 4000 preceding tokens. Those measurements do not predict Patch's social decisions. [Official model card](https://huggingface.co/convaiinnovations/laya-multilingual#limits)

**Recommendation, inferred:** hold `laya-multilingual` fixed for the first prompt comparison so the result isolates wording/state changes. English can be a separate comparison for English conversations that fit its smaller window. The `typed-decisions` name does not establish fitness for Patch's social policy.

The parent can evaluate the compact candidate against the existing eight cases, then test held-out conversations, alternate option order, and negated stop/invitation pairs. Record exact state, question text, label order, checkpoint/runtime version, budgets, truncation, and both probabilities. Source guidance supports these controls; it promises no success rate. [Official evaluation cautions](https://nandhakishorm.github.io/laya/benchmarks/#reproduce-or-extend-a-result)

This research did not run a model. The parent separately measured the prompt and checkpoint comparisons in the classifier guide.
