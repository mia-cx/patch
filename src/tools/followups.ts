import type { ActionContext } from "../actions/context.js";

/** Deliver stored text once; an ambiguous send stays uncertain and is never blindly retried. */
export async function deliverFollowups(context: ActionContext) {
  const store = context.harness?.store;
  if (!store) return;
  for (const job of store.due()) {
    if (
      context.config.discordTrialDmChannelId &&
      job.scope !== context.config.discordTrialDmChannelId
    )
      continue;
    await context.queue.add(
      async () => {
        if (!store.claim(job.id)) return;
        try {
          const channel = await context.client.channels.fetch(job.scope);
          if (!channel?.isSendable())
            throw new Error("Follow-up channel is no longer sendable");
          const message = await channel.send({
            content: job.text,
            allowedMentions: { parse: [], repliedUser: false },
            nonce: job.id.replaceAll("-", "").slice(0, 25),
            enforceNonce: true,
          });
          store.finish(job.id, message.id);
        } catch (error) {
          store.finish(job.id);
          context.logger.warn(
            { error, channelId: job.scope, followupId: job.id },
            "follow-up outcome uncertain; automatic retry disabled",
          );
        }
      },
      { priority: "background", bucketKey: job.scope },
    );
  }
}

/** Starts a lightweight delivery timer, without additional model generation. */
export function startFollowups(context: ActionContext) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await deliverFollowups(context);
    } catch (error) {
      context.logger.error({ error }, "follow-up delivery failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
