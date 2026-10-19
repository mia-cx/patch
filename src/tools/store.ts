import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletedGeneration } from "../llm/evidence.js";

type Note = { path: string; text: string; revision: string };
export type ObservationContext = {
  id: string;
  revision: number;
  digest: string;
  reference?: boolean;
};
type ObservationManifest = { digest: string; context: string };
export type ConsumedSource = {
  id: string;
  revision: number;
  reference?: boolean;
};
export type Followup = {
  id: string;
  scope: string;
  at: number;
  text: string;
  status: "pending" | "sending" | "delivered" | "uncertain" | "cancelled";
  message_id: string | null;
};
const MAX_NOTE_BYTES = 16_384;
const MAX_SCOPE_BYTES = 262_144;
const MAX_NOTES = 64;

/** Text documents, follow-ups and mutation receipts. Never opens model-selected host paths. */
export class HarnessStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS harness_notes (
        scope TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL,
        revision TEXT NOT NULL, PRIMARY KEY(scope, path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_calls (
        scope TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, PRIMARY KEY(scope, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_followups (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', message_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_observation_cutoffs (
        bank TEXT PRIMARY KEY, creation_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_observation_sources (
        bank TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, context TEXT NOT NULL,
        PRIMARY KEY(bank, id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_observation_sources_v2 (
        namespace TEXT NOT NULL, bank TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY(namespace, bank, id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_privacy_epoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO harness_privacy_epoch VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS harness_generations (
        namespace TEXT NOT NULL, bank TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, raw TEXT, eligible INTEGER NOT NULL, epoch INTEGER NOT NULL, manifest TEXT NOT NULL,
        PRIMARY KEY(namespace, bank, id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_source_revisions (
        namespace TEXT NOT NULL, bank TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(namespace, bank, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_generation_inputs (
        namespace TEXT NOT NULL, bank TEXT NOT NULL, generation_id TEXT NOT NULL, input_id TEXT NOT NULL,
        revision INTEGER NOT NULL, PRIMARY KEY(namespace, bank, generation_id, input_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS harness_displays (
        namespace TEXT NOT NULL, bank TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        digest TEXT NOT NULL, body TEXT, parent TEXT NOT NULL, epoch INTEGER NOT NULL,
        PRIMARY KEY(namespace, bank, id, revision)
      ) STRICT;
    `);
    // A process can disappear after Discord accepts a message. Never blindly resend it.
    this.db
      .prepare(
        "UPDATE harness_followups SET status = 'uncertain' WHERE status = 'sending'",
      )
      .run();
  }

  close() {
    this.db.close();
  }

  /** Serialize the fence check with its plaintext commit across SQLite connections. */
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The coordinated cutover excludes old creations permanently, including later edits. */
  observationCutoff(bank: string, creationId: string) {
    if (!/^\d{1,20}$/.test(creationId))
      throw new Error(
        "Evidence formation requires REMORA_OBSERVATION_START_ID",
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO harness_observation_cutoffs VALUES (?, ?)",
      )
      .run(bank, creationId);
    const existing = this.db
      .prepare(
        "SELECT creation_id FROM harness_observation_cutoffs WHERE bank = ?",
      )
      .get(bank);
    if (existing?.creation_id !== creationId)
      throw new Error(
        "Observation cutover conflicts with the durable bank boundary",
      );
    return BigInt(creationId);
  }

  /** Freeze only digests and context references. Source plaintext stays caller-owned. */
  freezeObservation(
    bank: string,
    id: string,
    revision: number,
    digest: string,
    context: readonly ObservationContext[],
    namespace = "",
  ): readonly ObservationContext[] {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO harness_observation_sources_v2 VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(namespace, bank, id, revision, digest, JSON.stringify(context));
    return this.observationContext(bank, id, revision, digest, namespace) ?? [];
  }

  /** Read the original context before selecting parents for a new source after rollover. */
  observationContext(
    bank: string,
    id: string,
    revision: number,
    digest: string,
    namespace = "",
  ): readonly ObservationContext[] | undefined {
    const existing = this.db
      .prepare(
        "SELECT digest, context FROM harness_observation_sources_v2 WHERE namespace = ? AND bank = ? AND id = ? AND revision = ?",
      )
      .get(namespace, bank, id, revision) as ObservationManifest | undefined;
    if (!existing) return;
    if (existing.digest !== digest)
      throw new Error(
        "Observation source conflicts with its original revision",
      );
    return JSON.parse(existing.context) as ObservationContext[];
  }

  /** One credential-local fence guards every later plaintext write, including asynchronous replies. */
  privacyEpoch() {
    return Number(
      this.db
        .prepare("SELECT epoch FROM harness_privacy_epoch WHERE id=1")
        .get()?.epoch,
    );
  }

  /** Revision retirement cancels consumers even when their output cannot become a reference. */
  sourcesCurrent(
    namespace: string,
    bank: string,
    consumed: readonly ConsumedSource[],
  ) {
    return consumed.every((source) => {
      const floor = this.db
        .prepare(
          "SELECT revision FROM harness_source_revisions WHERE namespace=? AND bank=? AND id=?",
        )
        .get(namespace, bank, source.id);
      return (
        (!floor || Number(floor.revision) <= source.revision) &&
        (!source.reference ||
          this.generation(namespace, bank, source.id, source.revision) !==
            undefined)
      );
    });
  }

  /** A revised source retires all locally retained descendants before old references can be sent. */
  advanceObservationRevision(
    namespace: string,
    bank: string,
    id: string,
    revision: number,
  ) {
    const row = this.db
      .prepare(
        "SELECT revision FROM harness_source_revisions WHERE namespace=? AND bank=? AND id=?",
      )
      .get(namespace, bank, id);
    if (row && Number(row.revision) >= revision) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO harness_source_revisions VALUES (?, ?, ?, ?) ON CONFLICT(namespace,bank,id) DO UPDATE SET revision=max(revision,excluded.revision)",
        )
        .run(namespace, bank, id, revision);
      const descendants = this.db
        .prepare(`WITH RECURSIVE affected(id) AS (
        SELECT generation_id FROM harness_generation_inputs WHERE namespace=? AND bank=? AND input_id=? AND revision<?
        UNION SELECT child.generation_id FROM harness_generation_inputs child JOIN affected parent ON child.input_id=parent.id WHERE child.namespace=? AND child.bank=?
      ) SELECT id FROM affected`)
        .all(namespace, bank, id, revision, namespace, bank);
      for (const source of descendants) {
        this.db
          .prepare(
            "UPDATE harness_generations SET raw=NULL,eligible=0 WHERE namespace=? AND bank=? AND id=?",
          )
          .run(namespace, bank, String(source.id));
        this.db
          .prepare(
            "UPDATE harness_displays SET body=NULL WHERE namespace=? AND bank=? AND parent=?",
          )
          .run(namespace, bank, String(source.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Retain the exact decoder preimage once; a redacted receipt never repopulates it. */
  captureGeneration(
    namespace: string,
    bank: string,
    source: CompletedGeneration,
    eligible: boolean,
    epoch: number,
    consumed: readonly ConsumedSource[] = [],
  ) {
    return this.transaction(() => {
      const current =
        epoch === this.privacyEpoch() &&
        this.sourcesCurrent(namespace, bank, consumed);
      const digest = createHash("sha256").update(source.text).digest("hex");
      const manifest = JSON.stringify(
        [...consumed].sort((a, b) => a.id.localeCompare(b.id)),
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO harness_generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          namespace,
          bank,
          source.id,
          source.revision,
          digest,
          current ? source.text : null,
          current && eligible ? 1 : 0,
          epoch,
          manifest,
        );
      const row = this.db
        .prepare(
          "SELECT digest,manifest FROM harness_generations WHERE namespace=? AND bank=? AND id=? AND revision=?",
        )
        .get(namespace, bank, source.id, source.revision);
      if (row?.digest !== digest || row.manifest !== manifest)
        throw new Error("Generated source preimage conflict");
      if (!current) {
        this.db
          .prepare(
            "UPDATE harness_generations SET raw=NULL, eligible=0 WHERE namespace=? AND bank=? AND id=? AND revision=?",
          )
          .run(namespace, bank, source.id, source.revision);
        return;
      }
      for (const parent of consumed)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO harness_generation_inputs VALUES (?, ?, ?, ?, ?)",
          )
          .run(namespace, bank, source.id, parent.id, parent.revision);
      return this.generation(namespace, bank, source.id, source.revision);
    });
  }

  /** Only complete current local sources are eligible as references; the backend verifies ancestry again. */
  generation(
    namespace: string,
    bank: string,
    id: string,
    revision = 0,
  ): CompletedGeneration | undefined {
    const row = this.db
      .prepare(
        "SELECT raw FROM harness_generations WHERE namespace=? AND bank=? AND id=? AND revision=? AND eligible=1 AND epoch=?",
      )
      .get(namespace, bank, id, revision, this.privacyEpoch());
    if (typeof row?.raw !== "string") return;
    return { id, revision, text: row.raw };
  }

  /** Record actual Discord IDs and body, rather than pretending formatted output is a raw generation. */
  associateDisplay(
    namespace: string,
    bank: string,
    id: string,
    revision: number,
    body: string,
    parent: CompletedGeneration,
    epoch: number,
  ) {
    return this.transaction(() => {
      if (
        epoch !== this.privacyEpoch() ||
        !this.generation(namespace, bank, parent.id, parent.revision)
      )
        return;
      const digest = createHash("sha256").update(body).digest("hex");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO harness_displays VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(namespace, bank, id, revision, digest, body, parent.id, epoch);
      const row = this.db
        .prepare(
          "SELECT digest, parent FROM harness_displays WHERE namespace=? AND bank=? AND id=? AND revision=?",
        )
        .get(namespace, bank, id, revision);
      if (row?.digest !== digest || row?.parent !== parent.id)
        throw new Error("Discord display source conflict");
    });
  }

  /** Equality with the fetched display is mandatory; stale edits and erased mappings stay unknown. */
  displayParent(
    namespace: string,
    bank: string,
    id: string,
    revision: number,
    body: string,
  ): CompletedGeneration | undefined {
    const row = this.db
      .prepare(
        "SELECT body, parent FROM harness_displays WHERE namespace=? AND bank=? AND id=? AND revision=? AND epoch=?",
      )
      .get(namespace, bank, id, revision, this.privacyEpoch());
    if (row?.body !== body || typeof row.parent !== "string") return;
    return this.generation(namespace, bank, row.parent);
  }

  listNotes(scope: string) {
    return this.db
      .prepare(
        "SELECT path, revision, length(CAST(text AS BLOB)) AS bytes FROM harness_notes WHERE scope = ? ORDER BY path",
      )
      .all(scope);
  }

  readNote(scope: string, path: string): Note {
    this.checkPath(path);
    const note = this.db
      .prepare(
        "SELECT path, text, revision FROM harness_notes WHERE scope = ? AND path = ?",
      )
      .get(scope, path) as Note | undefined;
    if (!note) throw new Error("Note not found in this conversation");
    return note;
  }

  writeNote(
    scope: string,
    path: string,
    text: string,
    expectedRevision: string | null,
  ) {
    this.checkPath(path);
    if (Buffer.byteLength(text) > MAX_NOTE_BYTES)
      throw new Error("Note exceeds 16 KiB");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT revision FROM harness_notes WHERE scope = ? AND path = ?",
        )
        .get(scope, path);
      if ((current?.revision ?? null) !== expectedRevision)
        throw new Error("Note revision conflict; read it again before editing");
      const totals = this.db
        .prepare(
          "SELECT count(*) AS count, coalesce(sum(length(CAST(text AS BLOB))), 0) AS bytes FROM harness_notes WHERE scope = ? AND path != ?",
        )
        .get(scope, path);
      if (
        Number(totals?.count) >= MAX_NOTES ||
        Number(totals?.bytes) + Buffer.byteLength(text) > MAX_SCOPE_BYTES
      )
        throw new Error("Conversation notebook is full");
      const revision = randomUUID();
      this.db
        .prepare(
          "INSERT INTO harness_notes VALUES (?, ?, ?, ?) ON CONFLICT(scope, path) DO UPDATE SET text = excluded.text, revision = excluded.revision",
        )
        .run(scope, path, text, revision);
      this.db.exec("COMMIT");
      return { path, revision, bytes: Buffer.byteLength(text) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteNote(scope: string, path: string, revision: string) {
    this.checkPath(path);
    const result = this.db
      .prepare(
        "DELETE FROM harness_notes WHERE scope = ? AND path = ? AND revision = ?",
      )
      .run(scope, path, revision);
    if (result.changes !== 1)
      throw new Error("Note revision conflict; read it again before deleting");
    return { path, deleted: true };
  }

  /** A conservative privacy fence prevents forgotten facts surviving in notes or queued text. */
  invalidateConversationData() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "UPDATE harness_privacy_epoch SET epoch=epoch+1 WHERE id=1; UPDATE harness_generations SET raw=NULL, eligible=0; UPDATE harness_displays SET body=NULL; UPDATE harness_calls SET result=NULL; DELETE FROM harness_notes; UPDATE harness_followups SET status = 'cancelled', text = '' WHERE status IN ('pending', 'sending', 'uncertain');",
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Persist intent before a side effect; completed retries reuse receipts, uncertain ones stop. */
  async mutate(
    scope: string,
    id: string,
    argumentsJson: string,
    execute: () => Promise<unknown>,
  ) {
    const epoch = this.privacyEpoch();
    const digest = createHash("sha256").update(argumentsJson).digest("hex");
    const prefix = `${id.split(":").slice(0, 2).join(":")}:`;
    const existing =
      this.db
        .prepare(
          "SELECT digest, status, result FROM harness_calls WHERE scope = ? AND id = ?",
        )
        .get(scope, id) ??
      this.db
        .prepare(
          "SELECT digest, status, result FROM harness_calls WHERE scope = ? AND substr(id, 1, ?) = ? AND digest = ? LIMIT 1",
        )
        .get(scope, prefix.length, prefix, digest);
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("Tool retry conflicts with the original call");
      if (existing.status !== "complete")
        throw new Error(
          "Previous action outcome is uncertain; it will not be repeated",
        );
      if (existing.result === null)
        throw new Error(
          "Previous action receipt was redacted by a memory fence",
        );
      return {
        result: JSON.parse(String(existing.result)) as unknown,
        replayed: true,
      };
    }
    this.db
      .prepare(
        "INSERT INTO harness_calls(scope, id, digest, status) VALUES (?, ?, ?, 'pending')",
      )
      .run(scope, id, digest);
    const result = await execute();
    this.transaction(() => {
      if (epoch !== this.privacyEpoch())
        throw new Error("Tool result invalidated by a memory fence");
      this.db
        .prepare(
          "UPDATE harness_calls SET status = 'complete', result = ? WHERE scope = ? AND id = ?",
        )
        .run(JSON.stringify(result ?? null), scope, id);
    });
    return { result, replayed: false };
  }

  schedule(scope: string, at: number, text: string, now = Date.now()) {
    if (!Number.isSafeInteger(at) || at <= now || at > now + 366 * 86_400_000)
      throw new Error("Follow-up must be within the next year");
    if (!text.trim() || text.length > 2000)
      throw new Error("Follow-up text must contain 1–2000 characters");
    const count = this.db
      .prepare(
        "SELECT count(*) AS count FROM harness_followups WHERE scope = ? AND status = 'pending'",
      )
      .get(scope);
    if (Number(count?.count) >= 20)
      throw new Error("This conversation already has 20 pending follow-ups");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO harness_followups(id, scope, at, text) VALUES (?, ?, ?, ?)",
      )
      .run(id, scope, at, text);
    return { id, at: new Date(at).toISOString(), status: "pending" };
  }

  followups(scope: string): Followup[] {
    return this.db
      .prepare(
        "SELECT * FROM harness_followups WHERE scope = ? AND status IN ('pending', 'sending', 'uncertain') ORDER BY at LIMIT 20",
      )
      .all(scope) as Followup[];
  }

  cancel(scope: string, id: string) {
    const result = this.db
      .prepare(
        "UPDATE harness_followups SET status = 'cancelled', text = '' WHERE scope = ? AND id = ? AND status IN ('pending', 'uncertain')",
      )
      .run(scope, id);
    if (result.changes !== 1)
      throw new Error("Pending follow-up not found in this conversation");
    return { id, cancelled: true };
  }

  due(now = Date.now()): Followup[] {
    return this.db
      .prepare(
        "SELECT * FROM harness_followups WHERE status = 'pending' AND at <= ? ORDER BY at LIMIT 20",
      )
      .all(now) as Followup[];
  }

  claim(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE harness_followups SET status = 'sending' WHERE id = ? AND status = 'pending'",
        )
        .run(id).changes === 1
    );
  }

  finish(id: string, messageId?: string) {
    this.db
      .prepare(
        "UPDATE harness_followups SET status = ?, message_id = ?, text = CASE WHEN ? IS NOT NULL THEN '' ELSE text END WHERE id = ? AND status = 'sending'",
      )
      .run(
        messageId ? "delivered" : "uncertain",
        messageId ?? null,
        messageId ?? null,
        id,
      );
  }

  private checkPath(path: string) {
    if (path.length > 128 || !/^[\w-]+(?:\/[\w-]+)*(?:\.md|\.txt)?$/.test(path))
      throw new Error(
        "Use a relative text document name, such as research/ideas.md",
      );
  }
}
