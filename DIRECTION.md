# Patch

Patch is a Discord conversation partner with a local, replaceable LLM backend.
Discord history supplies context; generated replies pass harness checks before posting.

Outgoing HTTP(S) links are checked before any reply chunk is sent. Confirmed404s and definite DNS absence trigger at most two regenerations with private harness feedback. A404 from HEAD is confirmed using GET. Auth errors, server errors, timeouts and other inconclusive checks preserve the reply. Checks follow bounded redirects, avoid private networks and discard response bodies. Rejected drafts never post, including after retries run out.

The voice LoRA is evaluated separately. Changes here do not deploy adapters or restart the live bot.
