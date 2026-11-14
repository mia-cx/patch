# Patch Onwards

Longer-term ideas that should not distract from v0/v1.

## Compaction

Goal: keep conversation state in Discord while managing long context windows.

Possible direction:

- `/compact` creates a Discord-visible summary message.
- Future context can start from that summary plus later messages.
- Summaries may use a visible prefix or marker, exact UX TBD.
- Avoid nagging with generic prompts like “this thread is getting chunky, want me to compact it?” until compaction behavior is designed deliberately.

Open design questions:

- How summaries are marked.
- Whether summaries should be edited/replaced or appended.
- How summaries interact with reply-chain reconstruction.
- Whether compaction should be explicit only or sometimes suggested.
- Whether exponential decay should prefer summaries over old raw messages.

## Context decay

Explore exponential decay by:

- age
- reply relevance
- mention relevance
- whether a compaction summary exists
- whether a message is from Patch
- whether a message is from the current author

## Multimodal attachments

V0/v1 can include placeholders:

```xml
<attachment filename="diagram.png" media_type="image/png" unavailable_for_v1="true" />
```

Future multimodal support can inspect images/files directly if the model/backend supports it.

## In-flight cancellation/rewrite

In fast conversations, Patch may eventually notice that a human already answered the question she was generating for, stop typing, cancel the pending response, or regenerate with newer context before posting.

This is useful for lively threads but requires careful queue and state management.

## Multi-target replies

Patch may eventually compose separate replies to different relevant neighbor messages instead of only replying to the latest trigger.

This needs a structured response protocol or bot-action channel so the model can select reply targets safely.

## Post-transformer burst splitting

V0/v1 only allow burst splitting when Patch emits `<|message_split|>` herself.

A future post-transformer might apply conversational burst splitting after generation, but only if it has enough semantic understanding to avoid mangling tone and meaning.

## Style training

Possible future style adaptation pipeline:

1. Request Discord data.
2. Use other people's messages only as context.
3. Use Mia's own messages as target style.
4. Scrub private data.
5. Curate high-quality examples.
6. Generate synthetic prompts/responses with a teacher model.
7. Use SFT + DPO, not full RLHF first.
8. Train a small LoRA/style adapter.
9. Quantize/serve via llama.cpp if useful.

Avoid letting the teacher model become the style source. Keep real curated Mia/Patch examples in the mix.

## Flarecord / Cloudflare runtime

Future infrastructure project:

- Cloudflare Workers + Durable Objects Discord gateway runtime.
- Use Discord's new allowance for Cloudflare egress IPs to connect to Gateway.
- Keep Patch's Discord adapter boundary so Flarecord can replace `discord.js` later.

Do not make this a v0/v1 blocker.

## Rich memory / “memory patches”

Patch could lean into Discord-visible memory:

- summaries as “Patch notes”
- visible context cards
- no hidden conversation database
- inspectable memory stored in Discord itself

Exact UX TBD.
