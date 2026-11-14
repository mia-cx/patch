import { createHash } from "node:crypto";
import type { ActionContext } from "../actions/context.js";
import { allowsConversation, isScopedTrial } from "../discord/scope.js";

/** Deliver one persisted occurrence; ambiguous sends pause their schedule without automatic retry. */
export async function deliverFollowups(context: ActionContext) {
  const store = context.harness?.store;
  if (!store) return;
  for (const job of store.due()) {
    if (
      isScopedTrial(context.config) &&
      job.scope !== context.config.discordTrialDmChannelId &&
      !context.config.discordTrialGuild?.channelIds.includes(job.scope)
    )
      continue;
    await context.queue.add(
      async () => {
        if (!store.claim(job.id, job.at)) return;
        try {
          const channel = await context.client.channels.fetch(job.scope);
          if (!channel?.isSendable())
            throw new Error("Follow-up channel is no longer sendable");
          if (
            !allowsConversation(context.config, {
              channelId: channel.id,
              guildId: "guildId" in channel ? channel.guildId : null,
            })
          )
            throw new Error("Follow-up is outside the scoped trial");
          if (!store.sending(job.id, job.at)) return;
          const message = await channel.send({
            content: job.text,
            allowedMentions: { parse: [], repliedUser: false },
            nonce: createHash("sha256")
              .update(`${job.id}:${job.at}`)
              .digest("hex")
              .slice(0, 25),
            enforceNonce: true,
          });
          store.finish(job.id, message.id, Date.now(), job.at);
        } catch (error) {
          store.finish(job.id, undefined, Date.now(), job.at);
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
