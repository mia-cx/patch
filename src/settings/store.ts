import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LLM_MODEL_KEY = "llm_model";

type SettingRow = {
  value: string;
};

export class SettingsStore {
  private readonly db: DatabaseSync;

  constructor(path: string, defaults: { llmModel: string }) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);
    this.seed(LLM_MODEL_KEY, defaults.llmModel);
  }

  getLlmModel(): string {
    return this.get(LLM_MODEL_KEY);
  }

  setLlmModel(model: string): void {
    this.set(LLM_MODEL_KEY, model.trim());
  }

  /** The role whose access makes a channel public in this server; undefined means @everyone. */
  getMemberRole(guildId: string): string | undefined {
    return this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(memberRoleKey(guildId))?.value as string | undefined;
  }

  setMemberRole(guildId: string, roleId: string | undefined): void {
    if (roleId) this.set(memberRoleKey(guildId), roleId);
    else
      this.db
        .prepare("DELETE FROM settings WHERE key = ?")
        .run(memberRoleKey(guildId));
  }

  close(): void {
    this.db.close();
  }

  private seed(key: string, value: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  private get(key: string): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as SettingRow | undefined;
    if (!row) throw new Error(`Missing required setting ${key}`);
    return row.value;
  }

  private set(key: string, value: string): void {
    if (!value) throw new Error(`Setting ${key} cannot be empty`);
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
      )
      .run(key, value);
  }
}

export type ModelSettingProvider = Pick<SettingsStore, "getLlmModel">;

const memberRoleKey = (guildId: string) => `member_role:${guildId}`;
