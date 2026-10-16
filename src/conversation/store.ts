import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type ResetBoundary = {
  cutoff: string;
  start: string | null;
};

/** Persists where each chat's active context begins; Discord owns the messages. */
export class ConversationContextStore {
  private readonly db: DatabaseSync;
  private readonly confirmingResets = new Map<string, string[]>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_contexts (
        channel_id TEXT PRIMARY KEY,
        start_message_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_resets (
        channel_id TEXT PRIMARY KEY,
        cutoff_message_id TEXT NOT NULL,
        start_message_id TEXT
      ) STRICT;
    `);
  }

  /** Returns the fixed starting message for a DM, channel, or thread. */
  getStart(channelId: string): string | undefined {
    const reset = this.getReset(channelId);
    if (reset) return reset.start ?? undefined;
    const value = this.db
      .prepare(
        "SELECT start_message_id FROM conversation_contexts WHERE channel_id = ?",
      )
      .get(channelId)?.start_message_id;
    if (value === undefined) return undefined;
    if (typeof value !== "string")
      throw new Error("Invalid conversation boundary");
    return value;
  }

  /** Records the active start after seeding, a budget reset, or message deletion. */
  setStart(channelId: string, messageId: string): void {
    if (this.getReset(channelId)) {
      this.db
        .prepare(
          "UPDATE conversation_resets SET start_message_id = ? WHERE channel_id = ?",
        )
        .run(messageId, channelId);
      return;
    }
    this.db
      .prepare(`
      INSERT INTO conversation_contexts (channel_id, start_message_id) VALUES (?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET start_message_id = excluded.start_message_id
    `)
      .run(channelId, messageId);
  }

  /** Observe human creates before classification, so even an unanswered turn can start a reset chat. */
  observeHumanMessage(channelId: string, messageId: string): boolean {
    this.confirmingResets.get(channelId)?.push(messageId);
    const reset = this.getReset(channelId);
    if (!reset) return true;
    if (BigInt(messageId) <= BigInt(reset.cutoff)) return false;
    if (reset.start) return BigInt(messageId) >= BigInt(reset.start);
    this.setStart(channelId, messageId);
    return true;
  }

  /** Suppress queued or edited pre-reset turns, without allowing them to seed history. */
  allowsMessage(channelId: string, messageId: string): boolean {
    const reset = this.getReset(channelId);
    return (
      !reset ||
      (reset.start !== null && BigInt(messageId) >= BigInt(reset.start))
    );
  }

  /** Run in the channel's queue; a fresh Discord confirmation ID defines successful reset ordering. */
  async resetAfterConfirmation(
    channelId: string,
    confirm: () => Promise<{ id: string; retract: () => Promise<unknown> }>,
  ): Promise<void> {
    // Check writable storage before posting success, but roll back immediately:
    // other channels and human arrivals must keep their old state until success.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeReset(channelId, {
        cutoff: "0",
        start: null,
      });
    } finally {
      this.db.exec("ROLLBACK");
    }
    const arrivals: string[] = [];
    this.confirmingResets.set(channelId, arrivals);
    try {
      const confirmation = await confirm();
      const cutoff = confirmation.id;
      // A human can see Discord's success and reply before the HTTP response
      // reaches us. Preserve that first arrival, including an unanswered turn.
      const start = arrivals.find((id) => BigInt(id) > BigInt(cutoff)) ?? null;
      try {
        this.writeReset(channelId, { cutoff, start });
      } catch (error) {
        // Storage can still fail after the preflight. Retract success before
        // the action runtime presents the failure; the old row stays intact.
        try {
          await confirmation.retract();
        } catch (retractError) {
          throw new AggregateError(
            [error, retractError],
            "Reset persistence and confirmation retraction failed",
          );
        }
        throw error;
      }
    } finally {
      this.confirmingResets.delete(channelId);
    }
  }

  private getReset(channelId: string): ResetBoundary | undefined {
    const row = this.db
      .prepare(
        "SELECT cutoff_message_id, start_message_id FROM conversation_resets WHERE channel_id = ?",
      )
      .get(channelId);
    if (!row) return undefined;
    if (
      typeof row.cutoff_message_id !== "string" ||
      (row.start_message_id !== null &&
        typeof row.start_message_id !== "string")
    )
      throw new Error("Invalid conversation reset boundary");
    return { cutoff: row.cutoff_message_id, start: row.start_message_id };
  }

  private writeReset(channelId: string, reset: ResetBoundary): void {
    this.db
      .prepare(`
      INSERT INTO conversation_resets (channel_id, cutoff_message_id, start_message_id) VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET cutoff_message_id = excluded.cutoff_message_id, start_message_id = excluded.start_message_id
    `)
      .run(channelId, reset.cutoff, reset.start);
  }

  close(): void {
    this.db.close();
  }
}
