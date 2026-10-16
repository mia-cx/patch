Here is a transcript of recent messages:

<classification_context>
{{context}}
</classification_context>

{{transcript}}

Determine whether {{identity.name}} should respond to the latest message. Place focus on the bottom conversation `<message>` block; the participant index follows the conversation. Use earlier messages only to understand who is talking to whom, whether {{identity.name}} is still being addressed, and whether humans have moved on.

Return only compact JSON:
{"shouldRespond":false,"confidence":0,"reason":"reasoning for why to respond or ignore"}
