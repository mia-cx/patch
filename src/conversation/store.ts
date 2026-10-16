import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Persists where each chat's active context begins; Discord owns the messages. */
export class ConversationContextStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_contexts (
        channel_id TEXT PRIMARY KEY,
        start_message_id TEXT NOT NULL
      ) STRICT;
    `);
  }

  /** Returns the fixed starting message for a DM, channel, or thread. */
  getStart(channelId: string): string | undefined {
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
    this.db
      .prepare(`
      INSERT INTO conversation_contexts (channel_id, start_message_id) VALUES (?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET start_message_id = excluded.start_message_id
    `)
      .run(channelId, messageId);
  }

  close(): void {
    this.db.close();
  }
}
